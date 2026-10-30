import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { compileFlow } from '../domain/compiler.js';
import { flowHashes } from '../domain/resolve.js';
import { flowSchema, type Flow, type ProjectConfig, type ProjectPolicy } from '../domain/schema.js';
import { canvasToFlow, flowToCanvas, type CanvasImportReport } from '../domain/flow-canvas.js';
import { RevisionConflict, revisionOf, withLibraryLock } from './library-lock.js';
import { replaceJson } from './atomic-json.js';

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(v => v !== '.' && v !== '..');
const metadataSchema = z.strictObject({ schemaVersion: z.literal(1), flowId: idSchema, name: z.string().min(1), archived: z.boolean() });
const versionSchema = flowSchema.extend({ semanticHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
export type FlowMetadata = z.infer<typeof metadataSchema>;
export type StoredFlowVersion = z.infer<typeof versionSchema>;

async function rejectSymlink(file: string): Promise<void> {
  if ((await lstat(file)).isSymbolicLink()) throw new Error(`Symlink is not allowed in flow library: ${file}`);
}

/**
 * Project file store. Published version filenames are installed atomically and
 * never overwritten. Mutations are serialized across processes by a library lock;
 * drafts carry content revisions so a stale editor cannot overwrite newer work.
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

  create(flowId: string, name: string): Promise<FlowMetadata> { return withLibraryLock(this.root, () => this.createUnlocked(flowId, name)); }
  private async createUnlocked(flowId: string, name: string): Promise<FlowMetadata> {
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
  rename(flowId: string, name: string): Promise<void> {
    return withLibraryLock(this.root, async () => {
      const current = await this.metadata(flowId);
      await replaceJson(this.metadataFile(flowId), metadataSchema.parse({ ...current, name }));
    });
  }
  setArchived(flowId: string, archived: boolean): Promise<void> {
    return withLibraryLock(this.root, async () => {
      const current = await this.metadata(flowId);
      await replaceJson(this.metadataFile(flowId), { ...current, archived });
    });
  }
  /** Save a draft. With `expectedRevision`, refuse to overwrite a draft someone else changed since it was read. */
  saveDraft(flowId: string, draft: unknown, expectedRevision?: string | null): Promise<string> {
    return withLibraryLock(this.root, () => this.saveDraftUnlocked(flowId, draft, expectedRevision));
  }
  private async saveDraftUnlocked(flowId: string, draft: unknown, expectedRevision?: string | null): Promise<string> {
    await this.metadata(flowId); // A draft may be incomplete, but must belong to an existing flow.
    if (expectedRevision !== undefined && await this.draftRevision(flowId) !== expectedRevision) throw new RevisionConflict('Draft đã bị sửa ở nơi khác (editor khác hoặc CLI); tải lại trước khi lưu');
    await replaceJson(this.draftFile(flowId), draft);
    return (await this.draftRevision(flowId))!;
  }
  /** Content revision of the stored draft, or null when there is none. */
  async draftRevision(flowId: string): Promise<string | null> {
    try { await rejectSymlink(this.draftFile(flowId)); return revisionOf(await readFile(this.draftFile(flowId))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async readDraft(flowId: string): Promise<unknown> { return (await this.readDraftWithRevision(flowId)).draft; }
  async readDraftWithRevision(flowId: string): Promise<{ draft: unknown; revision: string }> {
    await this.metadata(flowId);
    await rejectSymlink(this.draftFile(flowId));
    const bytes = await readFile(this.draftFile(flowId));
    return { draft: JSON.parse(bytes.toString('utf8')) as unknown, revision: revisionOf(bytes) };
  }
  async versions(flowId: string): Promise<number[]> {
    await this.metadata(flowId);
    await rejectSymlink(path.join(this.directory(flowId), 'versions'));
    return (await readdir(path.join(this.directory(flowId), 'versions')))
      .filter(name => /^\d{6}\.json$/.test(name)).map(name => Number(name.slice(0, 6))).sort((a, b) => a - b);
  }
  /** Publish the stored draft; with `expectedRevision`, only the draft revision the caller has seen. */
  publish(flowId: string, policy: ProjectPolicy, expectedRevision?: string): Promise<StoredFlowVersion> {
    return withLibraryLock(this.root, () => this.publishUnlocked(flowId, policy, expectedRevision));
  }
  private async publishUnlocked(flowId: string, policy: ProjectPolicy, expectedRevision?: string): Promise<StoredFlowVersion> {
    const metadata = await this.metadata(flowId);
    if (metadata.archived) throw new Error('Archived flow cannot be published');
    const { draft, revision } = await this.readDraftWithRevision(flowId);
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new RevisionConflict('Draft đã bị sửa ở nơi khác; tải lại trước khi publish');
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
  cloneDraft(sourceId: string, targetId: string, name: string): Promise<FlowMetadata> {
    return withLibraryLock(this.root, async () => {
      const draft = await this.readDraft(sourceId);
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Source draft is not a flow object');
      const metadata = await this.createUnlocked(targetId, name);
      await this.saveDraftUnlocked(targetId, { ...draft, flowId: targetId, name, version: 1 });
      return metadata;
    });
  }
  /** Default location of a flow's JSON Canvas board, next to its draft. */
  canvasFile(flowId: string): string { return path.join(this.directory(flowId), 'flow.canvas'); }
  /** Write the draft as a JSON Canvas board (Nimbalyst, Obsidian); the project config resolves which agent runs each step. */
  exportCanvas(flowId: string, file = this.canvasFile(flowId), project?: ProjectConfig): Promise<{ file: string }> {
    return withLibraryLock(this.root, async () => {
      const { draft, revision } = await this.readDraftWithRevision(flowId);
      const flow = flowSchema.safeParse(draft);
      if (!flow.success) throw new Error('Draft chưa đúng cấu trúc flow nên chưa xuất ra canvas được');
      await replaceJson(file, flowToCanvas(flow.data, revision, project));
      return { file };
    });
  }
  /** Apply a JSON Canvas board to the draft; refuses if the draft changed while the board was being applied. */
  importCanvas(flowId: string, file = this.canvasFile(flowId)): Promise<{ draft: Flow; revision: string; report: CanvasImportReport }> {
    return withLibraryLock(this.root, async () => {
      if (file === this.canvasFile(flowId)) await rejectSymlink(file);
      const canvas: unknown = JSON.parse(await readFile(file, 'utf8'));
      const { draft, revision } = await this.readDraftWithRevision(flowId);
      const current = flowSchema.safeParse(draft);
      const { flow, report } = canvasToFlow(canvas, current.success ? current.data : undefined, revision);
      if (flow.flowId !== flowId) throw new Error('Canvas thuộc flow khác');
      return { draft: flow, revision: await this.saveDraftUnlocked(flowId, flow, revision), report };
    });
  }
  deletePermanently(flowId: string, confirmedName: string): Promise<void> {
    return withLibraryLock(this.root, async () => {
      const metadata = await this.metadata(flowId);
      if (metadata.name !== confirmedName) throw new Error('Flow name confirmation does not match');
      await rm(this.directory(flowId), { recursive: true });
    });
  }
}
