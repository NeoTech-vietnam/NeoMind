import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hashJson } from '../domain/resolve.js';
import { profileSchema, type Profile } from '../domain/schema.js';
import { RevisionConflict, revisionOf, withLibraryLock } from './library-lock.js';
import { replaceJson } from './atomic-json.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const metadataSchema = z.strictObject({ schemaVersion: z.literal(1), profileId: identifier, name: z.string().min(1), archived: z.boolean() });
const storedSchema = profileSchema.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
export type StoredProfile = z.infer<typeof storedSchema>;

async function rejectLink(file: string): Promise<void> {
  if ((await lstat(file)).isSymbolicLink()) throw new Error('Symlink is not allowed in profile library');
}

/** Mutations are serialized across processes by a library lock; drafts carry content revisions, like FlowLibrary. */
export class ProfileLibrary {
  constructor(readonly root: string) {}
  private directory(profileId: string): string { return path.join(this.root, identifier.parse(profileId)); }
  private metaFile(profileId: string): string { return path.join(this.directory(profileId), 'metadata.json'); }
  private draftFile(profileId: string): string { return path.join(this.directory(profileId), 'draft.json'); }
  private versionFile(profileId: string, version: number): string {
    if (!Number.isInteger(version) || version < 1 || version > 999999) throw new Error('Invalid profile version');
    return path.join(this.directory(profileId), 'versions', `${String(version).padStart(6, '0')}.json`);
  }
  create(profileId: string, name: string) { return withLibraryLock(this.root, () => this.createUnlocked(profileId, name)); }
  private async createUnlocked(profileId: string, name: string) {
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
  rename(profileId: string, name: string): Promise<void> {
    return withLibraryLock(this.root, async () => { await replaceJson(this.metaFile(profileId), metadataSchema.parse({ ...await this.metadata(profileId), name })); });
  }
  setArchived(profileId: string, archived: boolean): Promise<void> {
    return withLibraryLock(this.root, async () => { await replaceJson(this.metaFile(profileId), { ...await this.metadata(profileId), archived }); });
  }
  /** Save a draft. With `expectedRevision`, refuse to overwrite a draft someone else changed since it was read. */
  saveDraft(profileId: string, draft: unknown, expectedRevision?: string | null): Promise<string> {
    return withLibraryLock(this.root, () => this.saveDraftUnlocked(profileId, draft, expectedRevision));
  }
  private async saveDraftUnlocked(profileId: string, draft: unknown, expectedRevision?: string | null): Promise<string> {
    await this.metadata(profileId);
    if (expectedRevision !== undefined && await this.draftRevision(profileId) !== expectedRevision) throw new RevisionConflict('Draft profile đã bị sửa ở nơi khác (editor khác hoặc CLI); tải lại trước khi lưu');
    await replaceJson(this.draftFile(profileId), draft);
    return (await this.draftRevision(profileId))!;
  }
  async draftRevision(profileId: string): Promise<string | null> {
    try { await rejectLink(this.draftFile(profileId)); return revisionOf(await readFile(this.draftFile(profileId))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async readDraft(profileId: string): Promise<unknown> { return (await this.readDraftWithRevision(profileId)).draft; }
  async readDraftWithRevision(profileId: string): Promise<{ draft: unknown; revision: string }> {
    await this.metadata(profileId); await rejectLink(this.draftFile(profileId));
    const bytes = await readFile(this.draftFile(profileId));
    return { draft: JSON.parse(bytes.toString('utf8')) as unknown, revision: revisionOf(bytes) };
  }
  async versions(profileId: string): Promise<number[]> {
    await this.metadata(profileId); const folder = path.join(this.directory(profileId), 'versions'); await rejectLink(folder);
    return (await readdir(folder)).filter(name => /^\d{6}\.json$/.test(name)).map(name => Number(name.slice(0, 6))).sort((a, b) => a - b);
  }
  publish(profileId: string, expectedRevision?: string): Promise<StoredProfile> {
    return withLibraryLock(this.root, () => this.publishUnlocked(profileId, expectedRevision));
  }
  private async publishUnlocked(profileId: string, expectedRevision?: string): Promise<StoredProfile> {
    const metadata = await this.metadata(profileId);
    if (metadata.archived) throw new Error('Archived profile cannot be published');
    const current = await this.readDraftWithRevision(profileId);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new RevisionConflict('Draft profile đã bị sửa ở nơi khác; tải lại trước khi publish');
    const draft = profileSchema.parse(current.draft);
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
  cloneDraft(sourceId: string, targetId: string, name: string) {
    return withLibraryLock(this.root, async () => {
      const draft = await this.readDraft(sourceId);
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Source draft is not a profile object');
      const metadata = await this.createUnlocked(targetId, name);
      await this.saveDraftUnlocked(targetId, { ...draft, profileId: targetId, name, version: 1 });
      return metadata;
    });
  }
  deletePermanently(profileId: string, confirmedName: string): Promise<void> {
    return withLibraryLock(this.root, async () => {
      const metadata = await this.metadata(profileId);
      if (metadata.name !== confirmedName) throw new Error('Profile name confirmation does not match');
      await rm(this.directory(profileId), { recursive: true });
    });
  }
}
