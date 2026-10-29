import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hashJson } from '../domain/resolve.js';
import { profileSchema, type Profile } from '../domain/schema.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const metadataSchema = z.strictObject({ schemaVersion: z.literal(1), profileId: identifier, name: z.string().min(1), archived: z.boolean() });
const storedSchema = profileSchema.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
export type StoredProfile = z.infer<typeof storedSchema>;

async function rejectLink(file: string): Promise<void> {
  if ((await lstat(file)).isSymbolicLink()) throw new Error('Symlink is not allowed in profile library');
}
async function replaceJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) throw new Error('Value is not JSON serializable');
  try { await writeFile(temporary, `${json}\n`, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Metadata/draft mutations require external serialization, like FlowLibrary. */
export class ProfileLibrary {
  constructor(readonly root: string) {}
  private directory(profileId: string): string { return path.join(this.root, identifier.parse(profileId)); }
  private metaFile(profileId: string): string { return path.join(this.directory(profileId), 'metadata.json'); }
  private draftFile(profileId: string): string { return path.join(this.directory(profileId), 'draft.json'); }
  private versionFile(profileId: string, version: number): string {
    if (!Number.isInteger(version) || version < 1 || version > 999999) throw new Error('Invalid profile version');
    return path.join(this.directory(profileId), 'versions', `${String(version).padStart(6, '0')}.json`);
  }
  async create(profileId: string, name: string) {
    const metadata = metadataSchema.parse({ schemaVersion: 1, profileId, name, archived: false });
    await mkdir(this.root, { recursive: true }); await mkdir(this.directory(profileId));
    await mkdir(path.join(this.directory(profileId), 'versions')); await replaceJson(this.metaFile(profileId), metadata);
    return metadata;
  }
  async metadata(profileId: string) {
    await rejectLink(this.directory(profileId)); await rejectLink(this.metaFile(profileId));
    const metadata = metadataSchema.parse(JSON.parse(await readFile(this.metaFile(profileId), 'utf8')));
    if (metadata.profileId !== profileId) throw new Error('Profile metadata ID mismatch');
    return metadata;
  }
  async list() {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: z.infer<typeof metadataSchema>[] = [];
    for (const name of names.sort()) if (identifier.safeParse(name).success) records.push(await this.metadata(name));
    return records;
  }
  async rename(profileId: string, name: string): Promise<void> {
    await replaceJson(this.metaFile(profileId), metadataSchema.parse({ ...await this.metadata(profileId), name }));
  }
  async setArchived(profileId: string, archived: boolean): Promise<void> {
    await replaceJson(this.metaFile(profileId), { ...await this.metadata(profileId), archived });
  }
  async saveDraft(profileId: string, draft: unknown): Promise<void> {
    await this.metadata(profileId); await replaceJson(this.draftFile(profileId), draft);
  }
  async readDraft(profileId: string): Promise<unknown> {
    await this.metadata(profileId); await rejectLink(this.draftFile(profileId));
    return JSON.parse(await readFile(this.draftFile(profileId), 'utf8')) as unknown;
  }
  async versions(profileId: string): Promise<number[]> {
    await this.metadata(profileId); const folder = path.join(this.directory(profileId), 'versions'); await rejectLink(folder);
    return (await readdir(folder)).filter(name => /^\d{6}\.json$/.test(name)).map(name => Number(name.slice(0, 6))).sort((a, b) => a - b);
  }
  async publish(profileId: string): Promise<StoredProfile> {
    const metadata = await this.metadata(profileId);
    if (metadata.archived) throw new Error('Archived profile cannot be published');
    const draft = profileSchema.parse(await this.readDraft(profileId));
    if (draft.profileId !== profileId) throw new Error('Draft profile ID mismatch');
    const version = ((await this.versions(profileId)).at(-1) ?? 0) + 1;
    const profile: Profile = { ...draft, profileId, name: metadata.name, version };
    const stored = storedSchema.parse({ ...profile, contentHash: hashJson(profile), createdAt: new Date().toISOString() });
    const destination = this.versionFile(profileId, version);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await link(temporary, destination);
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    return stored;
  }
  async readVersion(profileId: string, version: number): Promise<StoredProfile> {
    await this.metadata(profileId); await rejectLink(path.join(this.directory(profileId), 'versions'));
    await rejectLink(this.versionFile(profileId, version));
    const stored = storedSchema.parse(JSON.parse(await readFile(this.versionFile(profileId, version), 'utf8')));
    if (stored.profileId !== profileId || stored.version !== version) throw new Error('Profile version identity mismatch');
    const { contentHash, createdAt: _createdAt, ...profile } = stored;
    if (hashJson(profile) !== contentHash) throw new Error('Profile version hash mismatch');
    return stored;
  }
  async cloneDraft(sourceId: string, targetId: string, name: string) {
    const draft = await this.readDraft(sourceId);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Source draft is not a profile object');
    const metadata = await this.create(targetId, name);
    await this.saveDraft(targetId, { ...draft, profileId: targetId, name, version: 1 });
    return metadata;
  }
  async deletePermanently(profileId: string, confirmedName: string): Promise<void> {
    const metadata = await this.metadata(profileId);
    if (metadata.name !== confirmedName) throw new Error('Profile name confirmation does not match');
    await rm(this.directory(profileId), { recursive: true });
  }
}
