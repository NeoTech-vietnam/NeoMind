import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { compileFlow } from '../domain/compiler.js';
import { flowHashes } from '../domain/resolve.js';
import { flowSchema, type Flow, type ProjectPolicy } from '../domain/schema.js';

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(v => v !== '.' && v !== '..');
const metadataSchema = z.strictObject({ schemaVersion: z.literal(1), flowId: idSchema, name: z.string().min(1), archived: z.boolean() });
const versionSchema = flowSchema.extend({ semanticHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
export type FlowMetadata = z.infer<typeof metadataSchema>;
export type StoredFlowVersion = z.infer<typeof versionSchema>;

async function replaceJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new Error('Value is not JSON serializable');
  try { await writeFile(tmp, `${text}\n`, { encoding: 'utf8', flag: 'wx' }); await rename(tmp, file); }
  finally { await unlink(tmp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function rejectSymlink(file: string): Promise<void> {
  if ((await lstat(file)).isSymbolicLink()) throw new Error(`Symlink is not allowed in flow library: ${file}`);
}

/**
 * Project file store. Published version filenames are installed atomically and
 * never overwritten. Draft/metadata updates require caller serialization;
 * this class does not yet provide multi-process library locks.
 */
export class FlowLibrary {
  constructor(readonly root: string) {}
  private directory(id: string): string { return path.join(this.root, idSchema.parse(id)); }
  private metadataFile(id: string): string { return path.join(this.directory(id), 'metadata.json'); }
  private draftFile(id: string): string { return path.join(this.directory(id), 'draft.json'); }
  private versionFile(id: string, version: number): string {
    if (!Number.isInteger(version) || version < 1 || version > 999999) throw new Error('Invalid flow version');
    return path.join(this.directory(id), 'versions', `${String(version).padStart(6, '0')}.json`);
  }

  async create(flowId: string, name: string): Promise<FlowMetadata> {
    const metadata = metadataSchema.parse({ schemaVersion: 1, flowId, name, archived: false });
    await mkdir(this.root, { recursive: true });
    await mkdir(this.directory(flowId));
    await mkdir(path.join(this.directory(flowId), 'versions'));
    await replaceJson(this.metadataFile(flowId), metadata);
    return metadata;
  }
  async metadata(flowId: string): Promise<FlowMetadata> {
    await rejectSymlink(this.directory(flowId));
    await rejectSymlink(this.metadataFile(flowId));
    const metadata = metadataSchema.parse(JSON.parse(await readFile(this.metadataFile(flowId), 'utf8')));
    if (metadata.flowId !== flowId) throw new Error('Flow metadata ID mismatch');
    return metadata;
  }
  async list(): Promise<FlowMetadata[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: FlowMetadata[] = [];
    for (const name of names.sort()) {
      if (!idSchema.safeParse(name).success) continue;
      result.push(await this.metadata(name));
    }
    return result;
  }
  async rename(flowId: string, name: string): Promise<void> {
    const current = await this.metadata(flowId);
    await replaceJson(this.metadataFile(flowId), metadataSchema.parse({ ...current, name }));
  }
  async setArchived(flowId: string, archived: boolean): Promise<void> {
    const current = await this.metadata(flowId);
    await replaceJson(this.metadataFile(flowId), { ...current, archived });
  }
  async saveDraft(flowId: string, draft: unknown): Promise<void> {
    await this.metadata(flowId); // A draft may be incomplete, but must belong to an existing flow.
    await replaceJson(this.draftFile(flowId), draft);
  }
  async readDraft(flowId: string): Promise<unknown> {
    await this.metadata(flowId);
    await rejectSymlink(this.draftFile(flowId));
    return JSON.parse(await readFile(this.draftFile(flowId), 'utf8')) as unknown;
  }
  async versions(flowId: string): Promise<number[]> {
    await this.metadata(flowId);
    await rejectSymlink(path.join(this.directory(flowId), 'versions'));
    return (await readdir(path.join(this.directory(flowId), 'versions')))
      .filter(name => /^\d{6}\.json$/.test(name)).map(name => Number(name.slice(0, 6))).sort((a, b) => a - b);
  }
  async publish(flowId: string, policy: ProjectPolicy): Promise<StoredFlowVersion> {
    const metadata = await this.metadata(flowId);
    if (metadata.archived) throw new Error('Archived flow cannot be published');
    const draft = await this.readDraft(flowId);
    const compiled = compileFlow(draft, policy);
    if (!compiled.ok) throw new Error(`Invalid draft: ${compiled.diagnostics.map(d => d.code).join(', ')}`);
    if (compiled.flow.flowId !== flowId) throw new Error('Draft flow ID mismatch');
    const versions = await this.versions(flowId);
    const version = (versions.at(-1) ?? 0) + 1;
    const flow: Flow = { ...compiled.flow, flowId, version, name: metadata.name };
    const stored = versionSchema.parse({ ...flow, ...flowHashes(flow), createdAt: new Date().toISOString() });
    const destination = this.versionFile(flowId, version);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      // Hard-link installation is atomic and fails if a concurrent publish won the same version.
      await link(temporary, destination);
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    return stored;
  }
  async readVersion(flowId: string, version: number): Promise<StoredFlowVersion> {
    await this.metadata(flowId);
    await rejectSymlink(path.join(this.directory(flowId), 'versions'));
    await rejectSymlink(this.versionFile(flowId, version));
    const stored = versionSchema.parse(JSON.parse(await readFile(this.versionFile(flowId, version), 'utf8')));
    if (stored.flowId !== flowId || stored.version !== version) throw new Error('Flow version identity mismatch');
    const { semanticHash, contentHash, createdAt: _createdAt, ...flow } = stored;
    const actual = flowHashes(flow);
    if (actual.semanticHash !== semanticHash || actual.contentHash !== contentHash) throw new Error('Flow version hash mismatch');
    return stored;
  }
  async cloneDraft(sourceId: string, targetId: string, name: string): Promise<FlowMetadata> {
    const draft = await this.readDraft(sourceId);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Source draft is not a flow object');
    const metadata = await this.create(targetId, name);
    await this.saveDraft(targetId, { ...draft, flowId: targetId, name, version: 1 });
    return metadata;
  }
  async deletePermanently(flowId: string, confirmedName: string): Promise<void> {
    const metadata = await this.metadata(flowId);
    if (metadata.name !== confirmedName) throw new Error('Flow name confirmation does not match');
    await rm(this.directory(flowId), { recursive: true });
  }
}
