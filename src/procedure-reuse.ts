import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, retryWindowsFileOperation, safePath } from './storage.js';
import { listProcedures, validateProcedureParameters, validateProcedurePath, type ProcedureManifest } from './procedures.js';

/** Discovery is advisory: this module never imports or executes a retrieved script. */
export interface WorkPrepareInput {
  request: string;
  request_id?: string;
  intent_id?: string;
  parameters?: Record<string, unknown>;
  tags?: string[];
  outputs?: string[];
  procedure_id?: string;
  procedure_version?: string;
  environment?: {
    platform?: string;
    arch?: string;
    client?: string;
    node?: string;
    tools?: Record<string, string>;
  };
  scope?: {
    allowed_paths?: string[];
    network?: boolean;
    publication?: boolean;
    mode?: string;
    assurance?: string;
  };
  limit?: number;
}

export interface ProcedureMatchReason {
  code: string;
  message: string;
  kind: 'adaptation' | 'blocker';
}
export interface ProcedureReference {
  id: string;
  version: string;
  contract_hash: string;
  script_sha256: string;
}
export interface ProcedureCandidate extends ProcedureReference {
  title: string;
  status: ProcedureManifest['status'];
  score: number;
  compatible: boolean;
  reasons: ProcedureMatchReason[];
  prior_runs: { succeeded: number; failed: number; uncertain: number };
}
export interface WorkPreparation {
  request_id: string;
  original_request: string;
  intent_id: string;
  context_digest: string;
  decision: 'exact' | 'adapt' | 'new' | 'blocked';
  parameters: Record<string, unknown>;
  candidates: ProcedureCandidate[];
  selected_procedure?: ProcedureReference;
  manager_brief: string;
  next_action: string;
  execution_authorized: false;
}

const indexPath = '.neomind/cache/procedures.sqlite';
const indexVersion = '1';
const synonyms: [string, RegExp][] = [
  ['cornell', /\b(?:cornell|ghi chu nghien cuu|research notes?)\b/g],
  ['export', /\b(?:export|publish notes?|push notes?|xuat|day ghi chu)\b/g],
  ['exercise', /\b(?:exercises?|bai tap|practice problem|leetcode)\b/g],
  ['algorithm', /\b(?:algorithms?|thuat toan|data structures?|cau truc du lieu)\b/g],
  ['linked list', /\b(?:linked[ -]lists?|danh sach lien ket)\b/g],
  ['config', /\b(?:configurations?|config|cau hinh)\b/g],
  ['persistence', /\b(?:persistence|persistent|durable|luu ben vung|luu tru)\b/g],
  ['hysteresis', /\b(?:hysteresis|vung tre)\b/g],
  ['answers', /\b(?:answers?|solutions?|dap an|loi giai)\b/g],
];
const stopWords = new Set('a an the to for of in on with and or please create make generate another my me i want use from into new mot cac cho cua va voi hay tao them toi muon'.split(' '));

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
/** Only natural language passes through this normalizer, never parameters or executable arguments. */
export function normalizeProcedureQuery(value: string): string {
  let result = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  for (const [replacement, pattern] of synonyms) result = result.replace(pattern, replacement);
  return result.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function words(value: string): string[] {
  return [...new Set(normalizeProcedureQuery(value).split(' ').filter((word) => word && !stopWords.has(word)))].slice(0, 40);
}
function inferredIntent(request: string): string {
  const text = normalizeProcedureQuery(request);
  if (/\bexport\b/.test(text) && /\b(?:cornell|notes?|ghi chu)\b/.test(text)) return 'cornell-export';
  if (/\bexercise\b/.test(text) && /\b(?:algorithm|linked list|c11|cpp|c\+\+)\b/.test(text)) return 'algorithm-exercise';
  if (/\bcornell\b/.test(text)) return 'cornell-note';
  if (/\bconfig\b/.test(text) && /\bpersistence\b/.test(text)) return 'software-config-persistence';
  if (/\bhysteresis\b/.test(text)) return 'embedded-hysteresis-load-control';
  return 'unspecified';
}
function validateInput(input: WorkPrepareInput): void {
  if (!input || typeof input !== 'object' || typeof input.request !== 'string' || !input.request.trim() || input.request.length > 20000)
    throw new Error('Work preparation requires a nonempty request of at most 20000 characters.');
  for (const [key, value] of Object.entries(input)) {
    if (!['request', 'request_id', 'intent_id', 'parameters', 'tags', 'outputs', 'procedure_id', 'procedure_version', 'environment', 'scope', 'limit'].includes(key))
      throw new Error(`Unknown work preparation field: ${key}.`);
    if (value !== undefined && ['request_id', 'intent_id', 'procedure_id', 'procedure_version'].includes(key) &&
      (typeof value !== 'string' || !value.trim() || value.length > 200)) throw new Error(`Invalid ${key}.`);
  }
  if (input.procedure_version && !input.procedure_id) throw new Error('procedure_version requires procedure_id.');
  if (input.parameters && (typeof input.parameters !== 'object' || Array.isArray(input.parameters))) throw new Error('parameters must be an object.');
  for (const key of ['environment', 'scope'] as const)
    if (input[key] !== undefined && (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))) throw new Error(`${key} must be an object.`);
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    if (!['platform', 'arch', 'client', 'node', 'tools'].includes(key)) throw new Error(`Unknown environment field: ${key}.`);
    if (key !== 'tools' && (typeof value !== 'string' || !value.trim())) throw new Error(`environment.${key} must be a nonempty string.`);
  }
  if (input.environment?.tools !== undefined && (!input.environment.tools || typeof input.environment.tools !== 'object' || Array.isArray(input.environment.tools) || Object.values(input.environment.tools).some((item) => typeof item !== 'string' || !item.trim())))
    throw new Error('environment.tools must map tool names to observed versions.');
  for (const [key, value] of Object.entries(input.scope ?? {})) {
    if (!['allowed_paths', 'network', 'publication', 'mode', 'assurance'].includes(key)) throw new Error(`Unknown scope field: ${key}.`);
    if (['network', 'publication'].includes(key) && typeof value !== 'boolean') throw new Error(`scope.${key} must be boolean.`);
    if (['mode', 'assurance'].includes(key) && (typeof value !== 'string' || !value.trim())) throw new Error(`scope.${key} must be a nonempty string.`);
  }
  for (const [label, value] of [['tags', input.tags], ['outputs', input.outputs], ['scope.allowed_paths', input.scope?.allowed_paths]] as const)
    if (value !== undefined && (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim())))
      throw new Error(`${label} must be an array of nonempty strings.`);
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new Error('limit must be between 1 and 100.');
  // Reject unserializable inputs without normalizing strings inside the original parameter object.
  const serialized = JSON.stringify(input);
  if (serialized.length > 256000) throw new Error('Work preparation input is too large.');
}
function localIndexPath(root: string): string {
  const path = safePath(root, indexPath);
  let cursor = resolve(root);
  for (const part of relative(resolve(root), path).split(/[\\/]/)) {
    cursor = resolve(cursor, part);
    rejectLink(cursor);
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) rejectLink(path + suffix);
  return path;
}
function rejectLink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('Procedure paths must not follow symbolic links.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function fingerprint(manifests: ProcedureManifest[]): string {
  return hash(canonical(manifests));
}
function indexError(error: unknown): Error {
  if (/database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(error instanceof Error ? error.message : String(error))) {
    const result = new Error('Procedure index is busy; retry preparation after the active index operation completes.', { cause: error });
    Object.assign(result, { code: 'PROCEDURE_INDEX_UNAVAILABLE', retryable: true, next_action: 'retry preparation' });
    return result;
  }
  const result = new Error('Procedure index is unreadable or corrupt. Run the explicit procedure index rebuild operation; no reuse decision was made.', { cause: error });
  Object.assign(result, { code: 'PROCEDURE_INDEX_CORRUPT', next_action: 'rebuildProcedureIndex' });
  return result;
}
function createIndex(path: string, manifests: ProcedureManifest[], sourceHash: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE procedures(id TEXT NOT NULL,version TEXT NOT NULL,contract_hash TEXT NOT NULL,task_family TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE runs(id TEXT NOT NULL,procedure_id TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,PRIMARY KEY(procedure_id,version,id));
      CREATE VIRTUAL TABLE procedure_search USING fts5(id UNINDEXED,version UNINDEXED,title,description,keywords);
      CREATE VIRTUAL TABLE run_search USING fts5(id UNINDEXED,procedure_id UNINDEXED,version UNINDEXED,narrative);
      BEGIN IMMEDIATE;`);
    const row = db.prepare('INSERT INTO procedures VALUES(?,?,?,?,?)');
    const search = db.prepare('INSERT INTO procedure_search VALUES(?,?,?,?,?)');
    const run = db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)');
    const runSearch = db.prepare('INSERT INTO run_search VALUES(?,?,?,?)');
    for (const manifest of manifests) {
      const { runs, ...metadata } = manifest;
      row.run(manifest.id, manifest.version, manifest.contract_hash, manifest.task_family ?? '', JSON.stringify(metadata));
      search.run(manifest.id, manifest.version, normalizeProcedureQuery(manifest.title), normalizeProcedureQuery(manifest.description), normalizeProcedureQuery(manifest.keywords.join(' ')));
      for (const prior of runs) {
        // Keep diagnostic outcome/provenance, not potentially sensitive stdout, stderr, or parameter values.
        const summary = { id: prior.id, status: prior.status, request_id: prior.request_id, contract_hash: prior.contract_hash,
          parameters_hash: prior.parameters_hash, actor: prior.actor, client: prior.client, observation: prior.observation,
          started_at: prior.started_at, finished_at: prior.finished_at, error: prior.error };
        run.run(prior.id, manifest.id, manifest.version, prior.status, JSON.stringify(summary));
        runSearch.run(prior.id, manifest.id, manifest.version, normalizeProcedureQuery(`${prior.status} ${prior.observation} ${prior.client} ${prior.error ?? ''}`));
      }
    }
    db.prepare('INSERT INTO meta VALUES(?,?)').run('source_hash', sourceHash);
    db.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version', indexVersion);
    db.exec('COMMIT;');
  } finally { db.close(); }
}
/** Explicit repair replaces only the disposable projection; authoritative manifests remain untouched. */
export function rebuildProcedureIndex(root: string): { procedures: number; runs: number; source_hash: string } {
  const manifests = listProcedures(root);
  const path = localIndexPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const sourceHash = fingerprint(manifests);
  try {
    createIndex(temporary, manifests, sourceHash);
    retryWindowsFileOperation(() => renameSync(temporary, path));
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) rmSync(path + suffix);
  } finally { if (existsSync(temporary)) rmSync(temporary); }
  return { procedures: manifests.length, runs: manifests.reduce((sum, item) => sum + item.runs.length, 0), source_hash: sourceHash };
}
function retrieve(root: string, manifests: ProcedureManifest[], request: string): Map<string, number> {
  const path = localIndexPath(root);
  if (!existsSync(path)) rebuildProcedureIndex(root);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').get();
    if (check?.quick_check !== 'ok') throw new Error('SQLite integrity check failed.');
    const meta = db.prepare('SELECT value FROM meta WHERE key=?');
    if (meta.get('schema_version')?.value !== indexVersion) throw new Error('Unsupported procedure index schema.');
    const current = new Set(manifests.map((item) => `${item.id}@${item.version}`));
    const missing = db.prepare('SELECT id,version FROM procedures').all().filter((row) => !current.has(`${row.id}@${row.version}`));
    if (missing.length) {
      const error = new Error('Previously indexed procedure sources are missing. Restore their authoritative manifests or explicitly rebuild the index after reviewing their removal.');
      Object.assign(error, { code: 'PROCEDURE_SOURCE_MISSING', next_action: 'restore sources or rebuildProcedureIndex' });
      throw error;
    }
    if (meta.get('source_hash')?.value !== fingerprint(manifests)) {
      db.close(); db = undefined;
      rebuildProcedureIndex(root);
      db = new DatabaseSync(path, { readOnly: true });
    }
    const query = words(request).map((word) => `"${word.replaceAll('"', '""')}"`).join(' OR ');
    if (!query) return new Map();
    const rows = db.prepare('SELECT id,version,bm25(procedure_search) AS rank FROM procedure_search WHERE procedure_search MATCH ? ORDER BY rank LIMIT 100').all(query);
    const matches = new Map(rows.map((row) => [`${row.id}@${row.version}`, 10 + Math.min(9, Math.max(0, -Number(row.rank)))]));
    const history = db.prepare('SELECT procedure_id,version FROM run_search WHERE run_search MATCH ? ORDER BY bm25(run_search) LIMIT 100').all(query);
    for (const row of history) if (!matches.has(`${row.procedure_id}@${row.version}`)) matches.set(`${row.procedure_id}@${row.version}`, 1);
    return matches;
  } catch (error) {
    if ((error as { code?: string }).code === 'PROCEDURE_SOURCE_MISSING') throw error;
    throw indexError(error);
  }
  finally { db?.close(); }
}
function platform(value: string): string {
  return ({ windows: 'win32', win: 'win32', macos: 'darwin', mac: 'darwin' } as Record<string, string>)[value.toLowerCase()] ?? value.toLowerCase();
}
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.replace(/\/$/, '') + '/');
}
function projectPath(root: string, value: string): string {
  validateProcedurePath(root, value);
  return value;
}
function expand(value: string, parameters: Record<string, unknown>): string | undefined {
  let missing = false;
  const result = value.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, key: string) => {
    const item = parameters[key];
    if (item === undefined || item === null || (typeof item !== 'string' && typeof item !== 'number')) { missing = true; return ''; }
    return String(item);
  });
  return missing ? undefined : result;
}
function inspect(root: string, manifest: ProcedureManifest, input: WorkPrepareInput, intent: string, score: number): { candidate: ProcedureCandidate; parameters: Record<string, unknown> } {
  const reasons: ProcedureMatchReason[] = [];
  const reason = (code: string, message: string, kind: ProcedureMatchReason['kind'] = 'adaptation') => reasons.push({ code, message, kind });
  let parameters = structuredClone(input.parameters ?? {});
  try { parameters = validateProcedureParameters(root, manifest, parameters); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /Missing procedure parameter/.test(message) ? 'MISSING_PARAMETER' : /Unknown procedure parameter/.test(message) ? 'UNSUPPORTED_PARAMETER' : 'INVALID_PARAMETER';
    reason(code, message, 'blocker');
  }
  if (!manifest.task_family || intent === 'unspecified') reason('INTENT_UNCONFIRMED', 'Confirm the task family before exact reuse.');
  else if (manifest.task_family !== intent) reason('INTENT_MISMATCH', `Procedure supports ${manifest.task_family}; request intent is ${intent}.`);
  const env = manifest.environment;
  const supplied = input.environment ?? {};
  if (!env.platforms.map(platform).includes(platform(supplied.platform ?? process.platform))) reason('PLATFORM_MISMATCH', 'The current platform is outside the reviewed environments.');
  if (!supplied.client) reason('CLIENT_UNCONFIRMED', 'Supply the native client to check compatibility.', 'blocker');
  else if (!env.clients.some((client) => client === supplied.client)) reason('CLIENT_MISMATCH', 'The requested client is outside the reviewed environments.');
  if (env.archs?.length && !env.archs.includes(supplied.arch ?? process.arch)) reason('ARCH_MISMATCH', 'The current architecture is outside the reviewed environments.');
  if (env.node_major_min !== undefined) {
    const major = Number((supplied.node ?? process.versions.node).replace(/^v/, '').split('.')[0]);
    if (!Number.isSafeInteger(major) || major < env.node_major_min) reason('NODE_VERSION_MISMATCH', `Node.js ${env.node_major_min} or newer is required.`);
  }
  for (const [name, version] of Object.entries(env.tools ?? {})) {
    if (!supplied.tools?.[name]) reason('MISSING_TOOL', `Supply the observed version of required tool ${name}.`, 'blocker');
    else if (supplied.tools[name] !== version) reason('TOOL_VERSION_MISMATCH', `Tool ${name} differs from its reviewed version.`);
  }
  if (env.modes?.length && !env.modes.includes(input.scope?.mode ?? '')) reason('MODE_MISMATCH', 'The saved or requested workflow mode is outside this contract.');
  if (env.assurance?.length && !env.assurance.includes(input.scope?.assurance ?? '')) reason('ASSURANCE_MISMATCH', 'The saved or requested assurance is outside this contract.');
  const allowed: string[] = [];
  for (const item of input.scope?.allowed_paths ?? []) try { allowed.push(projectPath(root, item)); } catch { reason('SCOPE_DENIED', `Invalid authorized path ${item}.`, 'blocker'); }
  for (const template of manifest.effects.write_roots) {
    const path = expand(template, parameters);
    if (path === undefined) continue;
    try {
      projectPath(root, path);
      if (!allowed.some((authorized) => within(path, authorized))) reason('SCOPE_DENIED', `Write root ${path} is not inside the authorized paths.`, 'blocker');
    } catch { reason('SCOPE_DENIED', 'An expanded write root is outside a canonical visible project path.', 'blocker'); }
  }
  if (manifest.effects.network && input.scope?.network !== true) reason('NETWORK_DENIED', 'This procedure requires network authorization.', 'blocker');
  if (manifest.effects.publication && input.scope?.publication !== true) reason('PUBLICATION_DENIED', 'This procedure requires publication authorization.', 'blocker');
  const providedOutputs = manifest.outputs.map((item) => expand(item.path, parameters)).filter((item): item is string => item !== undefined);
  const declaredWrites = manifest.effects.write_roots.map((item) => expand(item, parameters)).filter((item): item is string => item !== undefined);
  for (const path of providedOutputs) {
    try {
      projectPath(root, path);
      if (!declaredWrites.some((writeRoot) => within(path, writeRoot))) reason('SCOPE_DENIED', `Output ${path} is outside the declared write roots.`, 'blocker');
      if (existsSync(safePath(root, path))) reason('OUTPUT_CONFLICT', `Output ${path} already exists; authored content must be preserved.`, 'blocker');
      if (path === manifest.script || path === manifest.verification_script) reason('SCOPE_DENIED', 'A procedure cannot overwrite its executable scripts.', 'blocker');
    } catch { reason('SCOPE_DENIED', 'An expanded output is outside a canonical visible project path.', 'blocker'); }
  }
  for (const expected of input.outputs ?? []) if (!providedOutputs.includes(expected)) reason('OUTPUT_MISMATCH', `The procedure does not declare required output ${expected}.`);
  if (manifest.status === 'suspended') reason('PROCEDURE_SUSPENDED', manifest.reason ?? 'This procedure is suspended.', 'blocker');
  else if (manifest.status !== 'eligible') reason('NOT_QUALIFIED', `Procedure is ${manifest.status}; reviewed qualifying real runs are required for automatic selection.`);
  const priorRuns = { succeeded: 0, failed: 0, uncertain: 0 };
  for (const run of manifest.runs) if (run.status in priorRuns) priorRuns[run.status as keyof typeof priorRuns]++;
  const latest = manifest.runs.at(-1);
  if (manifest.status === 'eligible' && latest && ['failed', 'uncertain', 'running'].includes(latest.status)) reason('LATEST_RUN_UNRESOLVED', 'The latest run is unsuccessful or unresolved; reassess qualification.', 'blocker');
  return { parameters, candidate: { id: manifest.id, version: manifest.version, contract_hash: manifest.contract_hash,
    script_sha256: manifest.script_sha256, title: manifest.title, status: manifest.status, score,
    compatible: reasons.length === 0, reasons, prior_runs: priorRuns } };
}

/** Prepare a new request or retry. The supplied request ID remains stable; every execution gets its own runner-owned run ID. */
export function prepareWork(root: string, input: WorkPrepareInput): WorkPreparation {
  validateInput(input);
  const manifests = listProcedures(root); // Always reload authoritative artifacts; SQLite does not establish eligibility.
  const retrieval = retrieve(root, manifests, input.request);
  const requested = input.procedure_id ? manifests.filter((item) => item.id === input.procedure_id && (!input.procedure_version || item.version === input.procedure_version)) : undefined;
  const inferred = inferredIntent(input.request);
  const intent = input.intent_id ?? (inferred !== 'unspecified' ? inferred : requested?.[0]?.task_family ?? 'unspecified');
  const tags = new Set((input.tags ?? []).map(normalizeProcedureQuery));
  const candidates = (requested ?? manifests.filter((item) => retrieval.has(`${item.id}@${item.version}`) || item.task_family === intent || item.keywords.some((word) => tags.has(normalizeProcedureQuery(word)))))
    .map((manifest) => {
      const tagScore = manifest.keywords.filter((word) => tags.has(normalizeProcedureQuery(word))).length * 5;
      const score = (retrieval.get(`${manifest.id}@${manifest.version}`) ?? 0) + tagScore + (manifest.task_family === intent ? 100 : 0);
      return inspect(root, manifest, input, intent, score);
    }).sort((a, b) => Number(b.candidate.compatible) - Number(a.candidate.compatible) || b.candidate.score - a.candidate.score || compareVersion(b.candidate.version, a.candidate.version));
  const selected = candidates[0];
  let decision: WorkPreparation['decision'] = !selected ? (input.procedure_id ? 'blocked' : 'new') : selected.candidate.compatible ? 'exact' : selected.candidate.reasons.some((reason) => reason.kind === 'blocker') ? 'blocked' : 'adapt';
  // A text-only false friend is a new task, not an approved adaptation of a different task family.
  if (!input.procedure_id && selected?.candidate.reasons.some((reason) => reason.code === 'INTENT_MISMATCH')) decision = 'new';
  const nextAction = decision === 'exact' ? 'Prepare a fresh authorized procedure run, then execute its current verification; historical success is not current evidence.'
    : decision === 'adapt' ? 'Assign the contract differences to the relevant expert; qualify a new version or obtain the missing confirmation before reuse.'
    : decision === 'blocked' ? 'Resolve the listed prerequisites or select a supported procedure; do not repeat unchanged execution attempts.'
    : 'Use the scoped expert workflow, search existing tools, and capture an automation candidate after validated work.';
  const selectedRef = selected && decision !== 'new' ? { id: selected.candidate.id, version: selected.candidate.version, contract_hash: selected.candidate.contract_hash, script_sha256: selected.candidate.script_sha256 } : undefined;
  const parameters = selectedRef ? selected!.parameters : structuredClone(input.parameters ?? {});
  const context = { original_request: input.request, intent_id: intent, parameters, outputs: input.outputs ?? [], environment: { platform: process.platform, arch: process.arch, node: process.versions.node, ...input.environment }, scope: input.scope ?? {}, procedure: selectedRef ?? null };
  const limitations = selected?.candidate.reasons.map((reason) => `${reason.code}: ${reason.message}`).join(' ') ?? (input.procedure_id ? 'Requested procedure/version is unavailable.' : 'No applicable saved procedure was found.');
  return { request_id: input.request_id ?? `request-${randomUUID()}`, original_request: input.request, intent_id: intent,
    context_digest: hash(canonical(context)), decision, parameters,
    candidates: candidates.slice(0, input.limit ?? 10).map((item) => item.candidate),
    ...(selectedRef ? { selected_procedure: selectedRef } : {}), execution_authorized: false,
    manager_brief: `Intent: ${intent}. Decision: ${decision}. ${selectedRef ? `Procedure: ${selectedRef.id}@${selectedRef.version} (${selectedRef.contract_hash}).` : ''} ${limitations} ${nextAction}`.trim(), next_action: nextAction };
}
function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) { const difference = (left[index] ?? 0) - (right[index] ?? 0); if (difference) return difference; }
  return 0;
}
