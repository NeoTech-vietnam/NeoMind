import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ProjectRecord, RecordType } from './types.js';

export const workforceRoot = '.workforce';
export const storageAliases = ['.neomind', '.taskforces', '.verythinker'] as const;
export interface RequestFolder {
  display_id: string; request_id: string; workflow_id: string; title: string; directory: string;
}
export interface StorageLayout {
  schema_version: 1;
  requests: RequestFolder[];
  relocations: Array<{ from: string; to: string; record_id: string }>;
}
export const emptyStorageLayout = (): StorageLayout => ({ schema_version: 1, requests: [], relocations: [] });
const recordDirectories: Record<RecordType, string> = {
  requirement: 'requirements', design: 'design', task: 'tasks', check: 'checks', evidence: 'evidence',
  review: 'reviews', change: 'changes', problem: 'problems', knowledge: 'knowledge',
};
export function canonicalManagedPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.(?:neomind|taskforces|verythinker)(?=\/|$)/, workforceRoot);
}
function ordinaryWithin(root: string, path: string): void {
  const parts = relative(root, path).split(/[\\/]/);
  if (parts.some(part => part === '..') || !parts.length) throw new Error('Invalid managed layout location.');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      throw new Error('Storage layout requires ordinary unlinked paths.');
  }
  if (existsSync(path) && !realpathSync(path).startsWith(realpathSync(root)))
    throw new Error('Storage layout escapes its managed root.');
}
/** Catalog paths are always canonical; historical record bytes are never rewritten. */
export function readStorageLayout(root: string, physicalRoot: string): StorageLayout {
  const base = resolve(root, physicalRoot), path = join(base, 'storage-layout.json');
  if (!existsSync(path)) return emptyStorageLayout();
  ordinaryWithin(base, path);
  if (lstatSync(path).size > 8 * 1024 * 1024) throw new Error('Storage relocation catalog is too large.');
  const value = JSON.parse(readFileSync(path, 'utf8')) as StorageLayout;
  if (value?.schema_version !== 1 || !Array.isArray(value.requests) || !Array.isArray(value.relocations))
    throw new Error('Invalid storage relocation catalog.');
  const keys = new Set<string>(), destinations = new Set<string>(), owners = new Set<string>(), displayIds = new Set<string>();
  for (const item of value.requests) {
    if (!item || typeof item.request_id !== 'string' || typeof item.workflow_id !== 'string' ||
        typeof item.title !== 'string' || !/^WF-R\d{4,}$/.test(item.display_id) ||
        !new RegExp(`^requests/${item.display_id}--[a-z0-9][a-z0-9-]{0,79}$`).test(item.directory) ||
        owners.has(item.workflow_id) || displayIds.has(item.display_id) || destinations.has(item.directory)) throw new Error('Invalid request folder catalog.');
    owners.add(item.workflow_id); displayIds.add(item.display_id); destinations.add(item.directory);
  }
  for (const item of value.relocations) {
    if (!item || !/^\.(?:workforce|neomind|taskforces|verythinker)\/records\/(?:[A-Za-z0-9_-]+\/)*[A-Z0-9-]+\.md$/.test(item.from) ||
        !/^\.workforce\/(?:requests\/WF-R\d{4,}--[a-z0-9-]+\/records|shared\/records|legacy-unassigned\/records)\/[a-z-]+\/[A-Z0-9-]+\.md$/.test(item.to) ||
        !/^[A-Z][A-Z0-9-]+$/.test(item.record_id) || !item.from.endsWith(`/${item.record_id}.md`) ||
        !item.to.endsWith(`/${item.record_id}.md`) || keys.has(canonicalManagedPath(item.from)) || destinations.has(item.to))
      throw new Error('Invalid record relocation catalog.');
    keys.add(canonicalManagedPath(item.from)); destinations.add(item.to);
  }
  return value;
}
export function layoutPath(root: string, physicalRoot: string, logical: string): string {
  const normalized = canonicalManagedPath(logical);
  // Only historical flat record identities can have relocations. Avoid reading
  // the catalog for every current record, blob and ordinary configuration file.
  const moved = normalized.startsWith(`${workforceRoot}/records/`)
    ? readStorageLayout(root, physicalRoot).relocations.find(item => canonicalManagedPath(item.from) === normalized)
    : undefined;
  return (moved?.to ?? normalized).replace(/^\.workforce(?=\/|$)/, physicalRoot);
}
export function recordIdentityPath(layout: StorageLayout, physical: string): string {
  return layout.relocations.find(item => item.to === canonicalManagedPath(physical))?.from ?? physical;
}
function slug(title: string): string {
  return title.replace(/^Workflow:\s*/i, '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70).replace(/-$/, '') || 'request';
}
export function ensureRequestInLayout(layout: StorageLayout, record: ProjectRecord): RequestFolder {
  const existing = layout.requests.find(item => item.workflow_id === record.meta.id);
  if (existing) return existing;
  const next = Math.max(0, ...layout.requests.map(item => Number(item.display_id.slice(4)))) + 1;
  const display_id = `WF-R${String(next).padStart(4, '0')}`;
  const item: RequestFolder = { display_id, request_id: String(record.meta.data.request_id ?? record.meta.id),
    workflow_id: record.meta.id, title: record.meta.title.replace(/^Workflow:\s*/i, ''), directory: `requests/${display_id}--${slug(record.meta.title)}` };
  layout.requests.push(item); return item;
}
export function recordRequest(layout: StorageLayout, record: ProjectRecord, records: ProjectRecord[]): RequestFolder | undefined {
  const explicit = [record.meta.data.workflow_id, record.meta.data.intake_workflow_id];
  const direct = layout.requests.filter(item => item.workflow_id === record.meta.id || explicit.includes(item.workflow_id));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const visited = new Set<string>();
  const memberships = new Set<string>();
  const visit = (value: ProjectRecord) => {
    if (visited.has(value.meta.id)) return;
    visited.add(value.meta.id);
    const own = layout.requests.filter(item => item.workflow_id === value.meta.id ||
      [value.meta.data.workflow_id, value.meta.data.intake_workflow_id].includes(item.workflow_id));
    own.forEach(item => memberships.add(item.workflow_id));
    for (const link of value.meta.links) {
      const linked = records.find(item => item.meta.id === link.target);
      if (linked) visit(linked);
    }
  };
  visit(record);
  return memberships.size === 1 ? layout.requests.find(item => memberships.has(item.workflow_id)) : undefined;
}
export function groupedRecordPath(record: ProjectRecord, request?: RequestFolder, unassigned = false): string {
  const directory = request ? `${request.directory}/records` : `${unassigned ? 'legacy-unassigned' : 'shared'}/records`;
  return `${workforceRoot}/${directory}/${recordDirectories[record.meta.type]}/${record.meta.id}.md`;
}
/** Called only inside the storage write lock or offline migration gate. */
export function writeRequestFolder(root: string, physicalRoot: string, request: RequestFolder): void {
  const base = resolve(root, physicalRoot), directory = join(base, request.directory);
  ordinaryWithin(base, directory); mkdirSync(directory, { recursive: true });
  for (const [name, content] of [
    ['request.json', JSON.stringify({ schema_version: 1, ...request }, null, 2) + '\n'],
    ['README.md', `# ${request.display_id} — ${request.title}\n\nRequest: ${request.request_id}\n\nEngineering history: ${request.workflow_id}\n\nRecords are grouped in [records](records/). Product files remain at their assigned project destinations. This folder does not establish that the request is completed.\n`],
  ] as const) {
    const path = join(directory, name); ordinaryWithin(base, path);
    if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
  }
}
export function managedRecordDirectories(root: string, physicalRoot: string): string[] {
  const directories = [`${physicalRoot}/records`, `${physicalRoot}/shared/records`, `${physicalRoot}/legacy-unassigned/records`];
  const requests = join(root, physicalRoot, 'requests');
  if (existsSync(requests)) {
    ordinaryWithin(join(root, physicalRoot), requests);
    for (const item of readdirSync(requests, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Request folders cannot be links.');
      if (item.isDirectory()) directories.push(`${physicalRoot}/requests/${item.name}/records`);
    }
  }
  return directories;
}
