import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { runCommand } from './command-runner.js';
import { safePath, withOperationLock } from './storage.js';

/** Local execution is a reviewed host process, not a filesystem or network sandbox. */
export const procedureExecutionLimitations = [
  'Node procedures run as the current operating-system user; declared effects are authorization metadata, not a sandbox.',
  'Review identities and local execution observations are unsigned; they do not establish native-client invocation identity.',
  'Entry scripts and explicitly declared dependency files are pinned; arbitrary imports and tool behavior require reviewed declarations.',
];
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const text = z.string().trim().min(1).max(10000);
const actor = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const procedureParameterSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  required: z.boolean().optional(), default: scalar.optional(), enum: z.array(scalar).min(1).max(100).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
  pattern: z.string().max(200).optional(), path: z.boolean().optional(),
}).strict();
export const procedureEffectsSchema = z.object({
  write_roots: z.array(z.string().min(1)).max(30), network: z.boolean(), publication: z.boolean(),
}).strict();
export const registerProcedureSchema = z.object({
  id: identifier, version, title: text, description: text, task_family: text.optional(),
  keywords: z.array(z.string().min(1).max(200)).max(100).default([]), author: actor,
  script: z.string().min(1), verification_script: z.string().min(1),
  dependencies: z.array(z.string().min(1)).max(100).default([]),
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), procedureParameterSchema),
  outputs: z.array(z.object({ path: z.string().min(1), min_bytes: z.number().int().min(0).optional(), sha256: digest.optional() }).strict()).min(1).max(100),
  environment: z.object({
    platforms: z.array(z.enum(['win32', 'linux', 'darwin'])).min(1),
    clients: z.array(z.enum(['codex', 'copilot', 'cli'])).min(1),
    node_major_min: z.number().int().min(24).optional(),
    archs: z.array(z.string().min(1)).min(1).optional(), modes: z.array(z.string().min(1)).min(1).optional(),
    assurance: z.array(z.string().min(1)).min(1).optional(), tools: z.record(z.string(), z.string()).optional(),
  }).strict(),
  effects: procedureEffectsSchema,
  timeout_ms: z.number().int().min(50).max(600000).default(60000),
  max_output_bytes: z.number().int().min(256).max(10 * 1024 * 1024).default(1024 * 1024),
}).strict();
export type RegisterProcedureInput = z.input<typeof registerProcedureSchema>;
export type ProcedureParameter = z.infer<typeof procedureParameterSchema>;
export type ProcedureEffects = z.infer<typeof procedureEffectsSchema>;
export type ProcedureStatus = 'candidate' | 'reviewed' | 'eligible' | 'suspended';
export interface ProcedureProcessResult {
  exit_code: number | null; stdout: string; stderr: string; timed_out: boolean; output_limited: boolean;
}
/** Public subprocess input contract. Identity values are supplied by the runner. */
export interface ProcedureInputPacket {
  schema_version: 1; request_id: string; procedure_id: string; version: string;
  parameters: Record<string, unknown>; outputs: string[];
}
export function createProcedureInputPacket(input: Omit<ProcedureInputPacket, 'schema_version'>): ProcedureInputPacket {
  return { schema_version: 1, request_id: input.request_id, procedure_id: input.procedure_id, version: input.version,
    parameters: input.parameters, outputs: input.outputs };
}
export function serializeProcedureInputPacket(packet: ProcedureInputPacket): string {
  return JSON.stringify(createProcedureInputPacket(packet)) + '\n';
}
/** Generated from the actual packet constructor; no private records or identity values. */
export function procedureInputContractHint(): string {
  const example = createProcedureInputPacket({ request_id: '<backend-issued request identity>',
    procedure_id: '<registered procedure id>', version: '<registered procedure version>',
    parameters: { example_parameter: '<validated parameter value>' }, outputs: ['<resolved project-relative output path>'] });
  return `Procedure subprocess stdin contract: ${JSON.stringify(example)}\n` +
    'The runtime sends one UTF-8 JSON object followed by a newline, closes stdin, and supplies the identical packet to the generator and independent verification script. Read all stdin and JSON.parse it; task values live in packet.parameters and resolved output paths in packet.outputs. The outer object is not the flat task-parameter object.\n' +
    'schema_version is 1. request_id, procedure_id and version are backend-owned metadata, not model inputs: consume their supplied values without hardcoding the illustrative placeholders, generating IDs or asking for credentials. Workers invoke the bound procedure_run tool with its saved parameters (or omit parameters); the runtime creates this envelope. An adapter that also supports direct CLI JSON must distinguish that direct input from this procedure envelope instead of requiring callers to fabricate envelope metadata.\n';
}
export interface ProcedureRun {
  id: string; request_id: string; procedure_id: string; version: string; contract_hash: string;
  parameters_hash: string; parameters: Record<string, unknown>; actor: string; client: string;
  observation: 'local-process' | 'fixture'; status: 'running' | 'succeeded' | 'failed' | 'uncertain';
  started_at: string; finished_at?: string; owner_pid: number; payload_hash: string;
  generator?: ProcedureProcessResult; verification?: ProcedureProcessResult;
  outputs?: Array<{ path: string; sha256: string; bytes: number }>; error?: string;
  /** Transport metadata only: this call returned durable history without starting another process. */
  replayed?: boolean;
}
export interface ProcedureReview {
  id: string; reviewer: string; verdict: 'pass' | 'fail'; rationale: string; created_at: string;
  contract_hash: string; identity_assurance: 'unsigned-local-declaration';
  negative_cases: Array<{ name: string; evidence_path: string; sha256: string }>;
}
interface StoredManifest extends z.infer<typeof registerProcedureSchema> {
  schema_version: 1; script_sha256: string; verification_sha256: string; dependency_sha256: Record<string, string>; contract_hash: string; created_at: string;
}
export interface ProcedureManifest extends StoredManifest {
  status: ProcedureStatus; reason?: string; reviews: ProcedureReview[]; runs: ProcedureRun[];
}
interface StateEvent { id: string; at: string; status: ProcedureStatus; actor: string; reason: string; contract_hash: string }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
/** Reject links even when their destination stays inside the project. */
function checkedPath(root: string, path: string, internal = false): string {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || /^[a-z]:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':') || /[.\s]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error('Procedure paths must be canonical project-relative forward-slash paths.');
  if (!internal && ['.git', '.neomind', '.taskforces', '.verythinker'].includes(path.split('/')[0]!.toLowerCase())) throw new Error('Procedure effects cannot target Git or NeoMind managed storage.');
  const base = resolve(root), target = internal ? safePath(root, path) : resolve(base, path), rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Procedure path escapes the project.');
  let cursor = base;
  for (const part of rel.split(/[\\/]/)) {
    cursor = resolve(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('Procedure paths cannot traverse symbolic links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
/** Return a checked absolute path; shared intake/runner validation has one path contract. */
export function validateProcedurePath(root: string, path: string): string { return checkedPath(root, path); }
function basePath(id: string, release: string): string { identifier.parse(id); version.parse(release); return `.neomind/procedures/${id}/${release}`; }
function readJson<T>(root: string, path: string): T { return JSON.parse(readFileSync(checkedPath(root, path, true), 'utf8')) as T; }
function createJson(root: string, path: string, value: unknown): void {
  const full = checkedPath(root, path, true); mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function jsonFiles(root: string, path: string): string[] {
  const full = checkedPath(root, path, true);
  if (!existsSync(full)) return [];
  return readdirSync(full).filter(name => name.endsWith('.json')).sort().map(name => `${path}/${name}`);
}
function scriptHash(root: string, path: string): string {
  if (!/\.(mjs|cjs)$/.test(path)) throw new Error('Only explicit Node .mjs/.cjs procedure scripts are supported.');
  const full = checkedPath(root, path);
  if (!statSync(full).isFile()) throw new Error('Procedure script must be a regular file.');
  return sha(readFileSync(full));
}
function dependencyHashes(root: string, paths: string[]): Record<string, string> {
  if (new Set(paths).size !== paths.length) throw new Error('Procedure dependency paths must be unique.');
  return Object.fromEntries(paths.map(path => {
    const full = checkedPath(root, path);
    if (!statSync(full).isFile()) throw new Error('Procedure dependencies must be regular files.');
    return [path, sha(readFileSync(full))];
  }));
}
function substitute(template: string, parameters: Record<string, unknown>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, key: string) => {
    const value = parameters[key];
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Path template requires scalar parameter ${key}.`);
    return String(value);
  });
}
export function validateProcedureParameters(root: string, manifest: Pick<ProcedureManifest, 'parameters'>, input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Procedure parameters must be an object.');
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(input)) if (!Object.hasOwn(manifest.parameters, key)) throw new Error(`Unknown procedure parameter ${key}.`);
  for (const [key, rule] of Object.entries(manifest.parameters)) {
    const value = Object.hasOwn(input, key) ? input[key] : rule.default;
    if (value === undefined) { if (rule.required !== false) throw new Error(`Missing procedure parameter ${key}.`); continue; }
    if (rule.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== rule.type) throw new Error(`Invalid type for procedure parameter ${key}.`);
    if (typeof value === 'number' && (!Number.isFinite(value) || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))) throw new Error(`Procedure parameter ${key} is outside its bounds.`);
    if (typeof value === 'string' && ((rule.min !== undefined && value.length < rule.min) || (rule.max !== undefined && value.length > rule.max) || (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)))) throw new Error(`Procedure parameter ${key} does not match its contract.`);
    if (rule.enum && !rule.enum.some(item => item === value)) throw new Error(`Procedure parameter ${key} is outside its enum.`);
    if (rule.path) { if (typeof value !== 'string') throw new Error(`Path parameter ${key} must be a string.`); checkedPath(root, value); }
    values[key] = value;
  }
  return values;
}
function validateDefinition(root: string, definition: z.infer<typeof registerProcedureSchema>): void {
  for (const [key, rule] of Object.entries(definition.parameters)) {
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) throw new Error(`Invalid bounds for ${key}.`);
    if (rule.type === 'boolean' && (rule.min !== undefined || rule.max !== undefined)) throw new Error('Boolean parameters cannot have numeric bounds.');
    if (rule.pattern) { if (rule.type !== 'string') throw new Error('Patterns require string parameters.'); new RegExp(rule.pattern, 'u'); }
    if (rule.path && rule.type !== 'string') throw new Error('Path parameters require string type.');
    if (rule.default !== undefined) validateProcedureParameters(root, { parameters: { [key]: rule } }, { [key]: rule.default });
  }
  for (const template of [...definition.outputs.map(output => output.path), ...definition.effects.write_roots]) {
    for (const match of template.matchAll(/\{([^{}]+)\}/g)) if (!Object.hasOwn(definition.parameters, match[1]!)) throw new Error(`Undeclared path template parameter ${match[1]}.`);
    checkedPath(root, template.replace(/\{[^{}]+\}/g, 'parameter'));
  }
  if (definition.script === definition.verification_script) throw new Error('Generation and verification must use distinct scripts.');
}
export function registerProcedure(root: string, input: RegisterProcedureInput): ProcedureManifest {
  const definition = registerProcedureSchema.parse(input); validateDefinition(root, definition);
  const script_sha256 = scriptHash(root, definition.script), verification_sha256 = scriptHash(root, definition.verification_script);
  const dependency_sha256 = dependencyHashes(root, definition.dependencies);
  const contract_hash = sha(canonical({ ...definition, script_sha256, verification_sha256, dependency_sha256 }));
  const path = `${basePath(definition.id, definition.version)}/manifest.json`;
  return withOperationLock(root, `procedure-${definition.id}`, () => {
    if (existsSync(checkedPath(root, path, true))) {
      const current = resolveProcedure(root, definition.id, definition.version);
      if (current.contract_hash !== contract_hash) throw new Error('Procedure version is immutable; register a new version for changed code or contract.');
      return current;
    }
    createJson(root, path, { ...definition, schema_version: 1, script_sha256, verification_sha256, dependency_sha256, contract_hash, created_at: new Date().toISOString() });
    return resolveProcedure(root, definition.id, definition.version);
  });
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function runsFor(root: string, base: string): ProcedureRun[] {
  const directory = checkedPath(root, `${base}/runs`, true);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort().map(name => {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('Corrupt procedure run directory.');
    const result = `${base}/runs/${name}/result.json`;
    const run = readJson<ProcedureRun>(root, existsSync(checkedPath(root, result, true)) ? result : `${base}/runs/${name}/started.json`);
    if (!['running', 'succeeded', 'failed', 'uncertain'].includes(run.status) || run.request_id === undefined) throw new Error('Corrupt procedure run record.');
    return run.status === 'running' && !alive(run.owner_pid) ? { ...run, status: 'uncertain' as const, error: 'Execution owner exited before its result was committed; effects require inspection.' } : run;
  }).sort((a, b) => a.started_at.localeCompare(b.started_at));
}
function checkRunOutputs(root: string, run: ProcedureRun): void {
  if (!run.outputs?.length) throw new Error('Successful procedure run is missing its output evidence.');
  for (const output of run.outputs) {
    const full = checkedPath(root, output.path), info = statSync(full);
    if (!info.isFile() || info.size !== output.bytes || sha(readFileSync(full)) !== output.sha256)
      throw new Error('Saved procedure output evidence changed or is unavailable; the historical result cannot establish current success.');
  }
}
function latestVersion(root: string, id: string): string {
  identifier.parse(id); const directory = checkedPath(root, `.neomind/procedures/${id}`, true);
  if (!existsSync(directory)) throw new Error(`Procedure ${id} is unavailable.`);
  const versions = readdirSync(directory).filter(item => version.safeParse(item).success).sort((a, b) => {
    const av = a.split('.').map(Number), bv = b.split('.').map(Number);
    return (bv[0]! - av[0]!) || (bv[1]! - av[1]!) || (bv[2]! - av[2]!);
  });
  if (!versions[0]) throw new Error(`Procedure ${id} is unavailable.`); return versions[0];
}
export function resolveProcedure(root: string, id: string, release?: string): ProcedureManifest {
  const base = basePath(id, release ?? latestVersion(root, id));
  const stored = readJson<StoredManifest>(root, `${base}/manifest.json`);
  const { schema_version, script_sha256, verification_sha256, dependency_sha256, contract_hash, created_at, ...rawDefinition } = stored;
  const definition = registerProcedureSchema.parse(rawDefinition);
  if (schema_version !== 1 || stored.id !== id || base !== basePath(stored.id, stored.version) || !digest.safeParse(script_sha256).success || !digest.safeParse(verification_sha256).success || !z.record(z.string(), digest).safeParse(dependency_sha256).success || sha(canonical({ ...definition, script_sha256, verification_sha256, dependency_sha256 })) !== contract_hash)
    throw new Error('Corrupt or mismatched procedure manifest.');
  const reviews = jsonFiles(root, `${base}/reviews`).map(path => readJson<ProcedureReview>(root, path));
  const events = jsonFiles(root, `${base}/history`).map(path => readJson<StateEvent>(root, path));
  const runs = runsFor(root, base);
  const latest = events.at(-1);
  let status: ProcedureStatus = latest?.status ?? 'candidate', reason = latest?.reason;
  try {
    if (scriptHash(root, stored.script) !== script_sha256 || scriptHash(root, stored.verification_script) !== verification_sha256) throw new Error('Procedure code hash drifted; register and review a new version.');
    if (canonical(dependencyHashes(root, stored.dependencies)) !== canonical(dependency_sha256)) throw new Error('Procedure dependency hash drifted; register and review a new version.');
    for (const review of reviews) for (const item of review.negative_cases) if (sha(readFileSync(checkedPath(root, item.evidence_path))) !== item.sha256) throw new Error('Procedure review evidence changed or is unavailable.');
    if (runs.some(run => run.status === 'uncertain')) throw new Error('Interrupted execution has uncertain effects; inspect it before further execution.');
    if (runs.at(-1)?.status === 'failed') throw new Error('The latest execution failed; reassess the procedure before reuse.');
    for (const run of runs.filter(item => item.status === 'succeeded')) checkRunOutputs(root, run);
    if (status === 'eligible') {
      const successful = runs.filter(run => run.status === 'succeeded' && run.observation === 'local-process');
      const lastReview = reviews.at(-1);
      if (!lastReview || lastReview.verdict !== 'pass' || lastReview.reviewer === stored.author || successful.some(run => run.actor === lastReview.reviewer)) throw new Error('Independent passing contract review is unavailable.');
    }
  } catch (error) { status = 'suspended'; reason = error instanceof Error ? error.message : String(error); }
  return { ...stored, status, ...(reason ? { reason } : {}), reviews, runs };
}
export function listProcedures(root: string): ProcedureManifest[] {
  const directory = checkedPath(root, '.neomind/procedures', true);
  if (!existsSync(directory)) return [];
  const result: ProcedureManifest[] = [];
  for (const id of readdirSync(directory).sort()) {
    identifier.parse(id);
    for (const release of readdirSync(checkedPath(root, `.neomind/procedures/${id}`, true)).sort()) {
      version.parse(release); result.push(resolveProcedure(root, id, release));
    }
  }
  return result;
}
function event(root: string, manifest: ProcedureManifest, status: ProcedureStatus, who: string, reason: string): void {
  const at = new Date().toISOString(), id = randomUUID();
  const base = `${basePath(manifest.id, manifest.version)}/history`;
  const sequence = String(jsonFiles(root, base).length).padStart(8, '0');
  createJson(root, `${base}/${sequence}-${id}.json`, { id, at, status, actor: who, reason, contract_hash: manifest.contract_hash });
}
export interface ReviewProcedureInput {
  procedure_id: string; version?: string; reviewer: string; verdict: 'pass' | 'fail'; rationale: string;
  negative_cases: Array<{ name: string; evidence_path: string; sha256?: string }>;
}
export function reviewProcedure(root: string, input: ReviewProcedureInput): ProcedureManifest {
  const value = z.object({ procedure_id: identifier, version: version.optional(), reviewer: actor, verdict: z.enum(['pass', 'fail']), rationale: text,
    negative_cases: z.array(z.object({ name: text, evidence_path: z.string().min(1), sha256: digest.optional() }).strict()).min(1).max(50),
  }).strict().parse(input);
  return withOperationLock(root, `procedure-${value.procedure_id}`, () => {
    const manifest = resolveProcedure(root, value.procedure_id, value.version);
    if (value.reviewer === manifest.author || manifest.runs.some(run => run.actor === value.reviewer)) throw new Error('Procedure review must be independent of its author and execution actors.');
    if (manifest.status === 'suspended') throw new Error(`Suspended procedures require a new reviewed version: ${manifest.reason}`);
    const negative_cases = value.negative_cases.map(item => {
      const actual = sha(readFileSync(checkedPath(root, item.evidence_path)));
      if (item.sha256 && item.sha256 !== actual) throw new Error('Review evidence hash does not match.');
      return { name: item.name, evidence_path: item.evidence_path, sha256: actual };
    });
    const review: ProcedureReview = { id: randomUUID(), reviewer: value.reviewer, verdict: value.verdict, rationale: value.rationale, created_at: new Date().toISOString(), contract_hash: manifest.contract_hash, identity_assurance: 'unsigned-local-declaration', negative_cases };
    const reviewBase = `${basePath(manifest.id, manifest.version)}/reviews`;
    createJson(root, `${reviewBase}/${String(jsonFiles(root, reviewBase).length).padStart(8, '0')}-${review.id}.json`, review);
    event(root, manifest, value.verdict === 'pass' ? 'reviewed' : 'suspended', value.reviewer, value.rationale);
    return resolveProcedure(root, manifest.id, manifest.version);
  });
}
export function suspendProcedure(root: string, input: { procedure_id: string; version?: string; actor: string; reason: string }): ProcedureManifest {
  const value = z.object({ procedure_id: identifier, version: version.optional(), actor, reason: text }).strict().parse(input);
  return withOperationLock(root, `procedure-${value.procedure_id}`, () => {
    const manifest = resolveProcedure(root, value.procedure_id, value.version); event(root, manifest, 'suspended', value.actor, value.reason); return resolveProcedure(root, manifest.id, manifest.version);
  });
}
export function qualifyProcedure(root: string, input: { procedure_id: string; version?: string; actor: string }): ProcedureManifest {
  const value = z.object({ procedure_id: identifier, version: version.optional(), actor }).strict().parse(input);
  return withOperationLock(root, `procedure-${value.procedure_id}`, () => {
    const manifest = resolveProcedure(root, value.procedure_id, value.version);
    if (manifest.status !== 'reviewed') throw new Error('Only a reviewed, unsuspended procedure can qualify.');
    const runs = manifest.runs.filter(run => run.status === 'succeeded' && run.observation === 'local-process' && run.contract_hash === manifest.contract_hash);
    const review = manifest.reviews.at(-1);
    if (!review || review.verdict !== 'pass' || review.reviewer === manifest.author || runs.some(run => run.actor === review.reviewer)) throw new Error('Independent passing contract review is required.');
    const destinationParameters = new Set(
      [...manifest.outputs.map(output => output.path), ...manifest.effects.write_roots]
        .flatMap(template => [...template.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map(match => match[1]!))
        .filter(key => manifest.parameters[key]?.path),
    );
    const variants = runs.map(run => sha(canonical(Object.fromEntries(Object.entries(run.parameters).filter(([key]) => !destinationParameters.has(key))))));
    if (runs.length < 3 || new Set(variants).size < 2) throw new Error('Qualification requires three successful local-process runs across at least two parameter sets excluding destination-only path parameters; fixture runs do not qualify.');
    for (const run of runs) checkRunOutputs(root, run);
    event(root, manifest, 'eligible', value.actor, 'Independent review and three real successful executions across at least two parameter sets are current.');
    return resolveProcedure(root, manifest.id, manifest.version);
  });
}
export interface RunProcedureInput {
  procedure_id: string; version?: string; parameters: Record<string, unknown>; request_id: string; actor: string;
  client: 'codex' | 'copilot' | 'cli'; mode: 'pilot' | 'automatic'; authorized_effects: ProcedureEffects;
  observation?: 'local-process' | 'fixture'; workflow_mode?: string; assurance?: string; tool_versions?: Record<string, string>;
}
const runSchema = z.object({
  procedure_id: identifier, version: version.optional(), parameters: z.record(z.string(), z.unknown()), request_id: z.string().min(1).max(200), actor,
  client: z.enum(['codex', 'copilot', 'cli']), mode: z.enum(['pilot', 'automatic']), authorized_effects: procedureEffectsSchema,
  observation: z.enum(['local-process', 'fixture']).default('local-process'), workflow_mode: z.string().optional(), assurance: z.string().optional(), tool_versions: z.record(z.string(), z.string()).optional(),
}).strict();
function within(path: string, parent: string): boolean { return path === parent || path.startsWith(`${parent}/`); }
function authorize(root: string, manifest: ProcedureManifest, input: z.infer<typeof runSchema>, parameters: Record<string, unknown>): void {
  const environment = manifest.environment;
  if (!environment.platforms.includes(process.platform as 'win32' | 'linux' | 'darwin') || !environment.clients.includes(input.client) || Number(process.versions.node.split('.')[0]) < (environment.node_major_min ?? 24) || (environment.archs && !environment.archs.includes(process.arch))) throw new Error('Procedure environment is incompatible.');
  if (environment.modes && !environment.modes.includes(input.workflow_mode ?? '')) throw new Error('Procedure workflow mode is incompatible.');
  if (environment.assurance && !environment.assurance.includes(input.assurance ?? '')) throw new Error('Procedure assurance is incompatible.');
  for (const [tool, required] of Object.entries(environment.tools ?? {})) if (input.tool_versions?.[tool] !== required) throw new Error(`Procedure tool version is incompatible: ${tool}.`);
  if ((manifest.effects.network && !input.authorized_effects.network) || (manifest.effects.publication && !input.authorized_effects.publication)) throw new Error('Procedure effects exceed request authorization.');
  const declared = manifest.effects.write_roots.map(path => substitute(path, parameters));
  for (const path of [...declared, ...input.authorized_effects.write_roots]) checkedPath(root, path);
  for (const path of declared) if (!input.authorized_effects.write_roots.some(parent => within(path, parent))) throw new Error('Procedure write scope exceeds request authorization.');
  const outputs = manifest.outputs.map(output => substitute(output.path, parameters));
  if (new Set(outputs).size !== outputs.length) throw new Error('Procedure outputs overlap.');
  for (const path of outputs) {
    checkedPath(root, path);
    if (!declared.some(parent => within(path, parent))) throw new Error('Procedure output lies outside declared write scope.');
    if (existsSync(checkedPath(root, path))) throw new Error(`Procedure output already exists; authored content is preserved: ${path}`);
    if (path === manifest.script || path === manifest.verification_script) throw new Error('Procedure cannot overwrite its executable scripts.');
  }
}
async function execute(root: string, script: string, input: ProcedureInputPacket, timeout: number, cap: number, signal?: AbortSignal): Promise<ProcedureProcessResult> {
  const node = process.versions.electron ? (await import('./adapters.js')).adapterNodeCommand(root) : process.execPath;
  const stdin = serializeProcedureInputPacket(input);
  if (signal) {
    const result = await runCommand({ command: [node, checkedPath(root, script)], cwd: resolve(root),
      stdin, timeout_ms: timeout, max_output_bytes: cap, signal });
    return { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr,
      timed_out: result.timed_out || result.cancelled, output_limited: result.output_limited };
  }
  return await new Promise(resolveResult => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timed_out = false, output_limited = false, settled = false;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(node, [checkedPath(root, script)], { cwd: resolve(root), shell: false, windowsHide: true, detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      if (child.pid && process.platform === 'win32') {
        const killer = spawn(resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
      } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      // Descendants may retain inherited handles. Preserve a bounded result even then.
      const lastResort = setTimeout(() => finish(null), 1000); lastResort.unref();
    };
    const timer = setTimeout(() => { timed_out = true; stop(); }, timeout);
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const available = Math.max(0, cap - stdout.length - stderr.length), kept = chunk.subarray(0, available);
      if (stream === 'stdout') stdout = Buffer.concat([stdout, kept]); else stderr = Buffer.concat([stderr, kept]);
      if (chunk.length > available) { output_limited = true; stop(); }
    };
    child.stdout.on('data', chunk => collect(Buffer.from(chunk), 'stdout')); child.stderr.on('data', chunk => collect(Buffer.from(chunk), 'stderr'));
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolveResult({ exit_code: code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timed_out, output_limited }); };
    child.on('error', error => { collect(Buffer.from(error.message), 'stderr'); finish(null); }); child.on('close', code => finish(code));
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
}
/** New output paths only. A repeated request returns its durable result; uncertain attempts are never replayed. */
export async function runProcedure(root: string, input: RunProcedureInput, options: { signal?: AbortSignal } = {}): Promise<ProcedureRun> {
  const value = runSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(value.parameters)) > 1024 * 1024) throw new Error('Procedure parameter payload exceeds one MiB.');
  const prepared = withOperationLock(root, `procedure-${value.procedure_id}`, () => {
    const manifest = resolveProcedure(root, value.procedure_id, value.version);
    const parameters = validateProcedureParameters(root, manifest, value.parameters);
    const payload_hash = sha(canonical({ ...value, version: manifest.version, parameters, contract_hash: manifest.contract_hash }));
    const base = basePath(manifest.id, manifest.version), key = sha(value.request_id), prior = manifest.runs.find(run => sha(run.request_id) === key);
    if (prior) {
      if (prior.payload_hash !== payload_hash) throw new Error('Procedure request idempotency key has a different payload.');
      if (prior.status === 'succeeded') checkRunOutputs(root, prior);
      return { manifest, run: prior, execute: false, base, key };
    }
    if ((value.mode === 'automatic' && manifest.status !== 'eligible') || (value.mode === 'pilot' && !['reviewed', 'eligible'].includes(manifest.status))) throw new Error(`Procedure is not eligible for ${value.mode} execution: ${manifest.status}${manifest.reason ? ` (${manifest.reason})` : ''}.`);
    if (manifest.runs.some(run => run.status === 'running' || run.status === 'uncertain')) throw new Error('A previous execution is active or uncertain; effects must be reconciled before another run.');
    if (manifest.reviews.some(review => review.reviewer === value.actor)) throw new Error('A procedure reviewer cannot execute that procedure; review independence must be preserved.');
    authorize(root, manifest, value, parameters);
    const run: ProcedureRun = { id: randomUUID(), request_id: value.request_id, procedure_id: manifest.id, version: manifest.version, contract_hash: manifest.contract_hash, parameters_hash: sha(canonical(parameters)), parameters, actor: value.actor, client: value.client, observation: value.observation, status: 'running', started_at: new Date().toISOString(), owner_pid: process.pid, payload_hash };
    createJson(root, `${base}/runs/${key}/started.json`, run);
    return { manifest, run, execute: true, base, key };
  });
  if (!prepared.execute) return { ...prepared.run, replayed: true };
  const { manifest, run, base, key } = prepared;
  try {
    const packet = createProcedureInputPacket({ request_id: run.request_id, procedure_id: manifest.id, version: manifest.version,
      parameters: run.parameters, outputs: manifest.outputs.map(output => substitute(output.path, run.parameters)) });
    if (scriptHash(root, manifest.script) !== manifest.script_sha256 || scriptHash(root, manifest.verification_script) !== manifest.verification_sha256 || canonical(dependencyHashes(root, manifest.dependencies)) !== canonical(manifest.dependency_sha256)) throw new Error('Procedure code or dependencies changed before execution.');
    run.generator = await execute(root, manifest.script, packet, manifest.timeout_ms, manifest.max_output_bytes, options.signal);
    if (run.generator.exit_code !== 0 || run.generator.timed_out || run.generator.output_limited) throw new Error('Procedure generation failed, timed out, or exceeded its output limit.');
    if (scriptHash(root, manifest.verification_script) !== manifest.verification_sha256 || canonical(dependencyHashes(root, manifest.dependencies)) !== canonical(manifest.dependency_sha256)) throw new Error('Verification script or dependencies changed during execution.');
    run.verification = await execute(root, manifest.verification_script, packet, manifest.timeout_ms, manifest.max_output_bytes, options.signal);
    if (run.verification.exit_code !== 0 || run.verification.timed_out || run.verification.output_limited) throw new Error('Procedure verification failed, timed out, or exceeded its output limit.');
    run.outputs = manifest.outputs.map(output => {
      const path = substitute(output.path, run.parameters), full = checkedPath(root, path), info = statSync(full);
      if (!info.isFile() || info.size < (output.min_bytes ?? 0)) throw new Error(`Procedure output is missing, non-regular, or too small: ${path}`);
      const sha256 = sha(readFileSync(full)); if (output.sha256 && output.sha256 !== sha256) throw new Error(`Procedure output hash is incorrect: ${path}`);
      return { path, sha256, bytes: info.size };
    });
    if (scriptHash(root, manifest.script) !== manifest.script_sha256 || scriptHash(root, manifest.verification_script) !== manifest.verification_sha256 || canonical(dependencyHashes(root, manifest.dependencies)) !== canonical(manifest.dependency_sha256)) throw new Error('Procedure code or dependencies changed during execution.');
    const current = resolveProcedure(root, manifest.id, manifest.version);
    if (current.status === 'suspended') throw new Error(`Procedure was suspended during execution: ${current.reason}`);
    run.status = 'succeeded';
  } catch (error) { run.status = options.signal?.aborted ? 'uncertain' : 'failed'; run.error = error instanceof Error ? error.message : String(error); }
  run.finished_at = new Date().toISOString();
  withOperationLock(root, `procedure-${manifest.id}`, () => {
    createJson(root, `${base}/runs/${key}/result.json`, run);
    if (run.status === 'failed') event(root, manifest, 'suspended', run.actor, run.error ?? 'Execution failed.');
  });
  return { ...run, replayed: false };
}
export function discoverProcedureScripts(root: string): { scripts: Array<{ path: string; sha256: string }>; package_commands: Array<{ name: string; command: string }>; issues: string[] } {
  const scripts: Array<{ path: string; sha256: string }> = [], issues: string[] = [];
  let visited = 0;
  function visit(path: string): void {
    if (++visited > 10000) { if (!issues.includes('Discovery stopped at 10000 entries.')) issues.push('Discovery stopped at 10000 entries.'); return; }
    const full = path ? checkedPath(root, path) : resolve(root);
    for (const item of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || ['node_modules', 'dist', 'build', 'target', 'coverage'].includes(item.name)) continue;
      const child = path ? `${path}/${item.name}` : item.name;
      if (item.isSymbolicLink()) { issues.push(`Skipped symbolic link: ${child}`); continue; }
      if (item.isDirectory()) { visit(child); if (visited > 10000) return; }
      else if (item.isFile() && /\.(mjs|cjs)$/.test(item.name)) { if (scripts.length >= 500) { issues.push('Discovery stopped at 500 scripts.'); return; } scripts.push({ path: child, sha256: scriptHash(root, child) }); }
    }
  }
  visit('');
  const package_commands: Array<{ name: string; command: string }> = [];
  if (existsSync(checkedPath(root, 'package.json'))) {
    const parsed = JSON.parse(readFileSync(checkedPath(root, 'package.json'), 'utf8')) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) for (const [name, command] of Object.entries(parsed.scripts)) if (typeof command === 'string') package_commands.push({ name, command });
  }
  return { scripts, package_commands, issues };
}
