import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { normalizeProcedureQuery } from './procedure-reuse.js';
import { hash, loadRecords, requestFolderForWorkflow, safePath } from './storage.js';

const cachePath = '.workforce/cache/request-experience.sqlite';
const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
const observation = z.number().int().nonnegative();
const experienceSchema = z.strictObject({
  workflow_id: identifier,
  task_family: identifier,
  // A backend-selected brief and tags. Raw conversations and check output are
  // kept in the source request, outside the searchable projection.
  summary: z.string().trim().min(1).max(4_000),
  keywords: z.array(identifier).max(40).default([]),
  acceptance: z.strictObject({ record_id: identifier, revision }),
  procedures: z.array(z.strictObject({
    id: identifier, version: identifier, contract_hash: digest, script_sha256: digest,
  })).max(30).default([]),
  parameters_sha256: digest.optional(),
  environment: z.strictObject({
    platform: identifier, arch: identifier, client: identifier, node: identifier.optional(),
    tools: z.record(identifier, identifier).optional(),
  }).optional(),
  scope: z.strictObject({
    allowed_paths: z.array(z.string().min(1).max(1_024)).max(100),
    network: z.boolean(), publication: z.boolean(),
  }).optional(),
  artifact_paths: z.array(z.string().min(1).max(1_024)).max(100).default([]),
  evidence_record_ids: z.array(identifier).max(100).default([]),
  capability_plan_record_ids: z.array(identifier).max(30).default([]),
  usage: z.strictObject({
    duration_ms: observation.optional(), model_calls: observation.optional(),
    input_tokens: observation.optional(), output_tokens: observation.optional(),
  }).optional(),
});

export type AcceptedRequestExperienceInput = z.input<typeof experienceSchema>;
const storedExperienceSchema = experienceSchema.extend({
  request_id: identifier,
  request_key: z.string().regex(/^WF-R\d{4,}$/),
  record_snapshot_sha256: digest,
  accepted_at: z.iso.datetime(),
});
export type RequestExperience = z.output<typeof storedExperienceSchema>;

const querySchema = z.strictObject({
  request: z.string().trim().min(1).max(20_000),
  task_family: identifier.optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

function ordinaryPath(path: string, directory: boolean): boolean {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)) {
    throw new Error('Request experience index requires ordinary unlinked paths.');
  }
  return true;
}

function indexLocation(root: string): { path: string; exists: boolean } {
  const path = safePath(root, cachePath);
  let parent = resolve(root);
  for (const segment of relative(parent, dirname(path)).split(/[\\/]/)) {
    parent = resolve(parent, segment);
    ordinaryPath(parent, true);
  }
  for (const suffix of ['-journal', '-wal', '-shm']) ordinaryPath(path + suffix, false);
  return { path, exists: ordinaryPath(path, false) };
}

/** Project-local historical search data. Call after the backend commits acceptance. */
export function saveAcceptedRequestExperience(root: string, input: AcceptedRequestExperienceInput): void {
  const experience = experienceSchema.parse(input);
  const folder = requestFolderForWorkflow(root, experience.workflow_id);
  const records = loadRecords(root);
  const request = records.find(record => record.meta.id === experience.workflow_id);
  const record = records.find(item => item.meta.id === experience.acceptance.record_id);
  const related = [record?.meta.id, record?.meta.data.workflow_id, record?.meta.data.intake_workflow_id];
  if (!folder || request?.meta.status !== 'accepted' || !related.includes(experience.workflow_id) || record?.meta.status !== 'accepted' ||
      record.meta.revision !== experience.acceptance.revision) {
    throw new Error('Request experience requires an accepted request and an accepted record at the specified revision in the same request.');
  }
  for (const path of [...experience.artifact_paths, ...(experience.scope?.allowed_paths ?? [])]) safePath(root, path);
  const saved = storedExperienceSchema.parse({
    ...experience, request_id: folder.request_id, request_key: folder.display_id,
    record_snapshot_sha256: hash(JSON.stringify({ meta: record.meta, body: record.body })), accepted_at: record.meta.updated_at,
  });
  const payload = JSON.stringify(saved);
  if (Buffer.byteLength(payload) > 128 * 1_024) throw new Error('Request experience metadata is too large.');
  const { path } = indexLocation(root);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=1000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS experiences(
        id INTEGER PRIMARY KEY, workflow_id TEXT NOT NULL UNIQUE, task_family TEXT NOT NULL,
        record_id TEXT NOT NULL, record_revision INTEGER NOT NULL, accepted_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS experience_search USING fts5(narrative);`);
    // Idempotent repair after a lost write acknowledgment. An older acceptance
    // snapshot cannot replace a newer one for the same request.
    const row = db.prepare(`INSERT INTO experiences(workflow_id,task_family,record_id,record_revision,accepted_at,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(workflow_id) DO UPDATE SET task_family=excluded.task_family,
        record_id=excluded.record_id,record_revision=excluded.record_revision,
        accepted_at=excluded.accepted_at,payload=excluded.payload
      WHERE (excluded.record_id=experiences.record_id AND excluded.record_revision>=experiences.record_revision)
        OR (excluded.record_id<>experiences.record_id AND excluded.accepted_at>experiences.accepted_at)
      RETURNING id`).get(saved.workflow_id, saved.task_family, saved.acceptance.record_id,
      saved.acceptance.revision, saved.accepted_at, payload);
    if (row) {
      db.prepare('DELETE FROM experience_search WHERE rowid=?').run(row.id!);
      db.prepare('INSERT INTO experience_search(rowid,narrative) VALUES(?,?)').run(row.id!,
        normalizeProcedureQuery([saved.task_family, saved.summary, ...saved.keywords].join(' ')));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Historical candidates only. Procedure eligibility and fresh checks still belong to the runner. */
export function findRequestExperiences(root: string, input: z.input<typeof querySchema>): {
  state: 'available' | 'unavailable'; candidates: RequestExperience[];
} {
  const { request, task_family, limit } = querySchema.parse(input);
  const words = [...new Set(normalizeProcedureQuery(request).match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 40);
  const query = words.map(word => `"${word}"`).join(' OR ');
  let db: DatabaseSync | undefined;
  try {
    const { path, exists } = indexLocation(root);
    if (!exists || !query) return { state: 'available', candidates: [] };
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT e.payload FROM experience_search JOIN experiences e ON e.id=experience_search.rowid
      WHERE experience_search MATCH ? AND (? IS NULL OR e.task_family=?)
      ORDER BY bm25(experience_search), e.accepted_at DESC, e.workflow_id LIMIT ?`)
      .all(query, task_family ?? null, task_family ?? null, limit);
    return { state: 'available', candidates: rows.map(row => storedExperienceSchema.parse(JSON.parse(String(row.payload)))) };
  } catch {
    return { state: 'unavailable', candidates: [] };
  } finally { db?.close(); }
}
