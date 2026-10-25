import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, opendirSync, readSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assertNoStorageMigration, atomicWrite, createRecord, getRecord, hash, loadRecords, now, safePath } from './storage.js';
import { captureEvidenceInputs, evidenceRecordFingerprint, validateEvidenceInputs } from './evidence-inputs.js';
import { readInvocation, routingProblems } from './routing.js';
import { validateCornellNote } from './notes.js';
import { resolveProcedure } from './procedures.js';
import { runCommand, type CommandResult } from './command-runner.js';
import type { ControlledContract, ControlledSnapshot, ControlledCheckReceipt } from './controlled-workflow.js';
import type { Gate, ProjectRecord, Verification } from './types.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const roots = '.neomind/controlled/workflows';
export interface ContinuationObligations { registration: boolean; intended_use: boolean; preservation: boolean;
  pilot_kind: 'leetcode-c11-cpp17' | 'unsupported-generic' | null }
export function continuationObligations(criteria: string[]): ContinuationObligations {
  const text = criteria.join('\n');
  const intended = /intended.use|pre.pilot|approved disposable exercise/i.test(text);
  const leetcode = /leet.?code/i.test(text) && /cornell/i.test(text) && /\bc11\b/i.test(text) && /c\+\+17|cpp17/i.test(text);
  return { registration: /register[^\n]*procedure|procedure[^\n]*regist/i.test(text), intended_use: intended,
    preservation: /preserv|byte.identical|pre.existing[^\n]*unchanged/i.test(text),
    pilot_kind: intended ? leetcode ? 'leetcode-c11-cpp17' : 'unsupported-generic' : null };
}
interface ControlledFingerprintLimits { max_files: number; max_entries: number; max_file_bytes: number; max_total_bytes: number; max_ms: number }
export const controlledFingerprintLimits: Readonly<ControlledFingerprintLimits> = Object.freeze({ max_files: 4096, max_entries: 8192,
  max_file_bytes: 8 * 1024 * 1024, max_total_bytes: 32 * 1024 * 1024, max_ms: 10000 });
interface FingerprintOptions { signal?: AbortSignal; limits?: Partial<typeof controlledFingerprintLimits> }
interface InventoryEntry { path: string; full: string; info: Stats | null; children?: string[] }
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
const sameStat = (a: Stats | null, b: Stats | null) => a === null || b === null ? a === b
  : a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs &&
    a.nlink === b.nlink && a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory() && a.isSymbolicLink() === b.isSymbolicLink();
function fingerprintBudget(options: FingerprintOptions, synchronous: boolean) {
  const limits = { ...controlledFingerprintLimits, max_ms: synchronous ? 2000 : controlledFingerprintLimits.max_ms };
  for (const name of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = options.limits?.[name];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new Error('Controlled evidence limits may only be tightened.');
      limits[name] = value;
    }
  }
  const deadline = performance.now() + limits.max_ms;
  let files = 0, bytes = 0, entries = 0, listed = 0, path = '';
  const location = () => path ? ` at ${JSON.stringify(path.slice(0, 300))}` : '';
  const check = (current?: string) => {
    if (current !== undefined) path = current;
    options.signal?.throwIfAborted();
    if (performance.now() > deadline) throw new Error(`Controlled evidence exceeded its bounded scan time (${limits.max_ms} ms)${location()}; select narrower preservation inputs.`);
  };
  return { limits, check, listed: () => { check(); if (++listed > limits.max_entries) throw new Error(`Controlled evidence exceeds its directory entry limit (${limits.max_entries})${location()}.`); },
    add: (info: Stats | null, current: string) => {
      check(current);
      if (++entries > limits.max_entries) throw new Error(`Controlled evidence exceeds its directory entry limit (${limits.max_entries})${location()}.`);
      if (info?.isSymbolicLink()) throw new Error('Controlled evidence cannot follow links.');
      if (info && !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error('Controlled evidence requires ordinary unlinked files.');
      if (!info || info.isFile()) {
        if (++files > limits.max_files) throw new Error(`Controlled evidence exceeds its file count limit (${limits.max_files})${location()}.`);
        if ((info?.size ?? 0) > limits.max_file_bytes) throw new Error(`Controlled evidence exceeds its per-file byte limit (${limits.max_file_bytes})${location()}.`);
        bytes += info?.size ?? 0;
        if (bytes > limits.max_total_bytes) throw new Error(`Controlled evidence exceeds its total byte limit (${limits.max_total_bytes})${location()}.`);
      }
    } };
}
function fingerprintPaths(paths: string[]) {
  if (paths.length > controlledFingerprintLimits.max_files) throw new Error('Controlled evidence exceeds its file count limit.');
  for (const path of paths) if (!path || isAbsolute(path) || /[\\:\x00-\x1f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Controlled evidence needs canonical project-relative paths.');
  return [...new Set(paths)];
}
function changed(): never { throw new Error('Controlled evidence inputs changed while their baseline was captured; retry after edits finish.'); }
/** Public input fingerprints keep the existing hash map format, with bounded synchronous replay. */
export function controlledFingerprints(root: string, paths: string[], options: FingerprintOptions = {}): Record<string, string> {
  const selected = fingerprintPaths(paths), budget = fingerprintBudget(options, true), base = realpathSync.native(root);
  assertNoStorageMigration(base);
  const entries = new Map<string, InventoryEntry>(), leaves = new Map<string, InventoryEntry>();
  const stat = (full: string) => { budget.check(); try { return lstatSync(full); } catch (error) { if (absent(error)) return null; throw error; } };
  const observe = (path: string) => {
    let entry = entries.get(path);
    if (!entry) { budget.check(path); const full = resolve(base, path), info = stat(full); budget.add(info, path); entry = { path, full, info }; entries.set(path, entry); }
    return entry;
  };
  const names = (full: string) => {
    budget.check(); const dir = opendirSync(full), result: string[] = [];
    try { for (let item; (item = dir.readSync());) { budget.listed(); result.push(item.name); } }
    finally { dir.closeSync(); }
    return result.sort();
  };
  const visit = (path: string) => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const ancestor = observe(parts.slice(0, index).join('/'));
      if (ancestor.info && !ancestor.info.isDirectory()) throw new Error('Controlled evidence ancestor is not an ordinary directory.');
    }
    const entry = observe(path);
    if (entry.info?.isDirectory()) {
      if (entry.children) return;
      entry.children = names(entry.full);
      for (const name of entry.children) visit(`${path}/${name}`);
    } else leaves.set(path, entry);
  };
  for (const path of selected) visit(path); // Inventory and all byte/count checks precede file content reads.
  const result: Record<string, string> = {}, buffer = Buffer.allocUnsafe(64 * 1024);
  for (const entry of leaves.values()) {
    budget.check();
    if (!entry.info) { result[entry.path] = 'missing'; continue; }
    const fd = openSync(entry.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameStat(entry.info, fstatSync(fd))) changed();
      const digest = createHash('sha256'); let bytes = 0;
      for (let count; (count = readSync(fd, buffer, 0, buffer.length, null));) {
        budget.check(); bytes += count; if (bytes > entry.info.size) changed(); digest.update(buffer.subarray(0, count));
      }
      if (bytes !== entry.info.size || !sameStat(entry.info, fstatSync(fd))) changed();
      result[entry.path] = digest.digest('hex');
    } finally { closeSync(fd); }
  }
  for (const entry of entries.values()) if (!sameStat(entry.info, stat(entry.full))) changed();
  budget.check(); return result;
}
/** Yielding plan preflight: metadata/quotas first, chunked hashing, then identity reconciliation. */
export async function controlledFingerprintsAsync(root: string, paths: string[], options: FingerprintOptions = {}): Promise<Record<string, string>> {
  const selected = fingerprintPaths(paths), budget = fingerprintBudget(options, false), base = await realpath(root);
  budget.check(); assertNoStorageMigration(base);
  const entries = new Map<string, InventoryEntry>(), leaves = new Map<string, InventoryEntry>();
  const stat = async (full: string) => { budget.check(); try { const info = await lstat(full); budget.check(); return info; }
    catch (error) { if (absent(error)) return null; throw error; } };
  const observe = async (path: string) => {
    let entry = entries.get(path);
    if (!entry) { budget.check(path); const full = resolve(base, path), info = await stat(full); budget.add(info, path); entry = { path, full, info }; entries.set(path, entry); }
    return entry;
  };
  const names = async (full: string) => {
    budget.check(); const result: string[] = [];
    for await (const item of await opendir(full)) { budget.listed(); result.push(item.name); }
    return result.sort();
  };
  const visit = async (path: string): Promise<void> => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const ancestor = await observe(parts.slice(0, index).join('/'));
      if (ancestor.info && !ancestor.info.isDirectory()) throw new Error('Controlled evidence ancestor is not an ordinary directory.');
    }
    const entry = await observe(path);
    if (entry.info?.isDirectory()) {
      if (entry.children) return;
      entry.children = await names(entry.full);
      for (const name of entry.children) await visit(`${path}/${name}`);
    } else leaves.set(path, entry);
  };
  for (const path of selected) await visit(path);
  const result: Record<string, string> = {}, buffer = Buffer.allocUnsafe(64 * 1024);
  for (const entry of leaves.values()) {
    budget.check();
    if (!entry.info) { result[entry.path] = 'missing'; continue; }
    const fd = await open(entry.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameStat(entry.info, await fd.stat())) changed();
      const digest = createHash('sha256'); let bytes = 0;
      for (;;) {
        budget.check(); const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead; if (bytes > entry.info.size) changed(); digest.update(buffer.subarray(0, bytesRead));
      }
      if (bytes !== entry.info.size || !sameStat(entry.info, await fd.stat())) changed();
      result[entry.path] = digest.digest('hex');
    } finally { await fd.close(); }
  }
  for (const entry of entries.values()) if (!sameStat(entry.info, await stat(entry.full))) changed();
  budget.check(); return result;
}

export function controlledContractForTask(root: string, task: ProjectRecord, checkBudget: () => void = () => {}): { run: ControlledSnapshot; contract: ControlledContract } {
  checkBudget();
  const id = String(task.meta.data.workflow_id), epoch = String(task.meta.data.epoch_id);
  if (!/^[a-f0-9-]{36}$/.test(epoch)) throw new Error('Controlled execution epoch is invalid.');
  const run = JSON.parse(readFileSync(safePath(root, `${roots}/${hash(id)}.json`), 'utf8')) as ControlledSnapshot;
  const bytes = readFileSync(safePath(root, `${roots}/${hash(id)}.${epoch}.contract.json`), 'utf8');
  const contract = JSON.parse(bytes) as ControlledContract;
  if (run.schema_version !== 1 || run.workflow_id !== id || run.epoch_id !== epoch || run.process_contract !== 'software-tools/v2' ||
      contract.schema_version !== 2 || contract.workflow_id !== id || contract.epoch_id !== epoch || contract.task_id !== task.meta.id ||
      hash(bytes) !== run.contract_hash || contract.plan_hash !== hash(JSON.stringify(contract.plan)) || task.meta.data.controlled_contract_hash !== run.contract_hash)
    throw new Error('Controlled task, journal and immutable contract do not match.');
  const parent = getRecord(root, id);
  if (parent.meta.data.controlled_epoch_id !== epoch || parent.meta.data.controlled_contract_hash !== run.contract_hash)
    throw new Error('Workflow does not point to this controlled execution.');
  for (const key of ['acceptance_criteria', 'allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'] as const)
    if (!same(task.meta.data[key], contract.plan[key])) throw new Error(`Controlled task ${key} changed after planning.`);
  if (!same(task.meta.links.filter(link => link.type === 'satisfies').map(link => link.target).sort(), [...contract.requirement_ids].sort()))
    throw new Error('Controlled execution must retain all requirement links.');
  for (const [id, fingerprint] of Object.entries(contract.requirement_fingerprints)) {
    checkBudget();
    if (evidenceRecordFingerprint(getRecord(root, id)) !== fingerprint) throw new Error('Controlled requirement baseline changed.');
  }
  if (contract.continuation) {
    checkBudget();
    const prior = contract.continuation, oldTask = getRecord(root, prior.original_task_id);
    if (prior.original_task_id === task.meta.id || hash(JSON.stringify(oldTask)) !== prior.original_task_fingerprint ||
        hash(readFileSync(safePath(root, prior.original_contract_path))) !== prior.original_contract_sha256 ||
        !task.meta.links.some(link => link.type === 'derives-from' && link.target === prior.original_task_id))
      throw new Error('Continuation must retain its separate, unchanged legacy task and contract.');
  }
  checkBudget();
  return { run, contract };
}

export function prepareControlledCheckEvidence(root: string, run: ControlledSnapshot, contract: ControlledContract,
  check: { title: string; command: string[]; baseline_paths: string[]; expected_exit_code?: number }, baseline: Record<string, string>, invocation: string | null) {
  const existing = loadRecords(root).find(record => record.meta.type === 'check' && record.meta.data.controlled_epoch_id === run.epoch_id &&
    record.meta.data.task_id === contract.task_id && record.meta.data.controlled_check_title === check.title);
  const record = existing ?? createRecord(root, { type: 'check', title: check.title, owner: 'verifier', status: 'ready',
    links: contract.requirement_ids.map(target => ({ type: 'verifies', target })),
    data: { kind: 'controlled-check', workflow_id: run.workflow_id, task_id: contract.task_id, controlled_epoch_id: run.epoch_id,
      controlled_contract_hash: run.contract_hash, controlled_check_title: check.title, command: check.command,
      baseline_paths: check.baseline_paths, expected_exit_code: check.expected_exit_code ?? 0 }, body: '# Independent executable check\nBound to the immutable controlled execution contract.\n' });
  if (!same(record.meta.data.command, check.command) || !same(record.meta.data.baseline_paths, check.baseline_paths)) throw new Error('Controlled check definition changed.');
  const records = [getRecord(root, contract.task_id), ...contract.requirement_ids.map(id => getRecord(root, id)), record];
  const record_baseline = Object.fromEntries(records.map(record => [record.meta.id, evidenceRecordFingerprint(record)]));
  return { check_id: record.meta.id, check_fingerprint: evidenceRecordFingerprint(record), record_baseline,
    input_snapshot: captureEvidenceInputs(root, { files: baseline, records, record_fingerprints: record_baseline, invocation_id: invocation }) };
}
export function materializeControlledEvidence(root: string, run: ControlledSnapshot, contract: ControlledContract, receipt: ControlledCheckReceipt): string {
  if (!receipt.evidence_input) throw new Error('Controlled check lacks its captured pre-execution input.');
  const existing = loadRecords(root).find(record => record.meta.type === 'evidence' && record.meta.data.controlled_check_id === receipt.id);
  if (existing) return existing.meta.id;
  const path = `.neomind/controlled/checks/${receipt.id}.receipt.json`, input = receipt.evidence_input;
  const data = { schema_version: 1, kind: 'controlled-execution-evidence', controlled_check_id: receipt.id,
    workflow_id: run.workflow_id, task_id: contract.task_id, controlled_epoch_id: run.epoch_id, controlled_contract_hash: run.contract_hash,
    execution_invocation_id: receipt.invocation_id, check_id: input.check_id, check_fingerprint: input.check_fingerprint,
    record_baseline: input.record_baseline, input_snapshot: input.input_snapshot, file_baseline: receipt.baseline,
    command: receipt.command, result: receipt.passed ? 'pass' : 'fail', exit_code: receipt.exit_code,
    expected_exit_code: receipt.expected_exit_code, negative: receipt.negative, purpose: receipt.purpose ?? 'self-check',
    log_path: receipt.log_path, log_hash: receipt.log_sha256, at: receipt.at };
  atomicWrite(safePath(root, path), JSON.stringify(data, null, 2) + '\n');
  return createRecord(root, { type: 'evidence', title: `${data.result}: ${receipt.title}`, owner: 'verifier', status: receipt.passed ? 'verified' : 'failed',
    links: [{ type: 'evidence-for', target: input.check_id }, { type: 'documents', target: contract.task_id }],
    data: { ...data, receipt_path: path }, body: '# Actual execution\nBackend-owned command execution; source/check/input hashes and signed Verifier identity are retained.\n' }).meta.id;
}

/** One absolute budget spans every artifact group; trusted callers may only tighten it. */
export function controlledAcceptanceBudget(root: string, maxMs = 8000) {
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 8000) throw new Error('Controlled acceptance budget may only be tightened.');
  const deadline = performance.now() + maxMs;
  const check = () => { if (performance.now() >= deadline) throw new Error(`Controlled acceptance exceeded its shared ${maxMs} ms verification budget; evidence remains unaccepted.`); };
  return { check, fingerprints: (paths: string[]) => {
    check();
    const result = controlledFingerprints(root, paths, { limits: { max_ms: Math.max(1, Math.min(2000, Math.floor(deadline - performance.now()))) } });
    check(); return result;
  } };
}
function evidenceProblems(root: string, run: ControlledSnapshot, contract: ControlledContract, receipt: ControlledCheckReceipt,
  budget: ReturnType<typeof controlledAcceptanceBudget>): void {
  budget.check();
  const input = receipt.evidence_input;
  if (!input || !receipt.evidence_id) throw new Error('Actual check needs a materialized evidence record.');
  const record = getRecord(root, receipt.evidence_id), data = record.meta.data;
  if (record.meta.type !== 'evidence' || data.controlled_check_id !== receipt.id || data.controlled_epoch_id !== run.epoch_id ||
      data.task_id !== contract.task_id || data.workflow_id !== run.workflow_id || data.result !== 'pass' ||
      data.execution_invocation_id !== receipt.invocation_id || !same(data.file_baseline, receipt.baseline) ||
      !same(data.command, receipt.command) || data.log_hash !== receipt.log_sha256 || data.log_path !== receipt.log_path ||
      data.check_fingerprint !== evidenceRecordFingerprint(getRecord(root, input.check_id))) throw new Error('Typed check evidence no longer matches its actual receipt.');
  if (!receipt.passed || receipt.cancelled || receipt.exit_code !== receipt.expected_exit_code ||
      hash(readFileSync(safePath(root, receipt.log_path))) !== receipt.log_sha256 ||
      !same(receipt.baseline, budget.fingerprints(Object.keys(receipt.baseline)))) throw new Error('Check evidence is failed, stale or incomplete.');
  const log = JSON.parse(readFileSync(safePath(root, receipt.log_path), 'utf8'));
  if (!same(log.command, receipt.command) || !same(log.baseline, receipt.baseline) || log.result?.exit_code !== receipt.exit_code ||
      log.result?.cancelled || log.result?.timed_out || log.result?.output_limited || log.result?.error || log.pilot_error)
    throw new Error('Check outcome does not match the backend command result.');
  budget.check();
  validateEvidenceInputs(root, input.input_snapshot, { files: receipt.baseline, record_fingerprints: input.record_baseline,
    check_id: input.check_id, check_fingerprint: input.check_fingerprint });
  budget.check();
  for (const [id, digest] of Object.entries(input.record_baseline)) {
    budget.check();
    if (evidenceRecordFingerprint(getRecord(root, id)) !== digest) throw new Error('Check evidence record baseline changed.');
  }
  const saved = JSON.parse(readFileSync(safePath(root, String(data.receipt_path)), 'utf8'));
  if (!same(saved.file_baseline, data.file_baseline) || saved.result !== data.result || saved.log_hash !== data.log_hash ||
      saved.execution_invocation_id !== data.execution_invocation_id || saved.controlled_check_id !== receipt.id)
    throw new Error('Materialized execution receipt changed.');
  budget.check();
}

/** One evaluator is used by controller closure and public task verification. No accepted flag is proof. */
export function verifyControlledTask(root: string, task: ProjectRecord, gate: Gate = 'accepted'): Verification | null {
  if (task.meta.data.process_contract !== 'software-tools/v2') return null;
  const findings: Verification['findings'] = [];
  const add = (code: string, message: string) => findings.push({ code, record: task.meta.id, message });
  const budget = controlledAcceptanceBudget(root);
  try {
    const { run, contract } = controlledContractForTask(root, task, budget.check);
    if (['cancelled', 'uncertain', 'interrupted'].includes(run.status)) throw new Error('Controlled effects require reconciliation before acceptance.');
    if (['ready', 'design-ready'].includes(gate)) return { ok: true, gate, findings, checked_at: now() };
    if (run.attempts.some(attempt => ['starting', 'running'].includes(attempt.state)) || run.check_intents?.some(intent => intent.state !== 'completed'))
      throw new Error('An active replacement session or unresolved check effect still needs reconciliation.');
    const latest = (stage: string) => [...run.attempts].reverse().find(item => item.stage === stage && item.purpose !== 'check-review' && item.state === 'completed');
    const producer = latest('implementation'), verifier = latest('verification'), reviewer = latest('review'), synthesis = latest('synthesis');
    const required = [producer, verifier, ...(gate === 'accepted' && contract.reviewer_required ? [reviewer] : []),
      ...(gate === 'accepted' && contract.knowledge_directory ? [synthesis] : [])];
    for (const attempt of required) {
      budget.check();
      if (!attempt?.invocation_id || !attempt.report_id || attempt.report?.outcome !== 'completed') throw new Error('Required independently completed result is missing.');
      const receipt = readInvocation(root, attempt.invocation_id), report = getRecord(root, attempt.report_id);
      if (routingProblems(root, attempt.role, receipt.id, { workflow_id: run.workflow_id, task_id: contract.task_id, require_completed: true }).length ||
          receipt.issuer !== 'neomind-vscode-lm' || !receipt.inference_completed || receipt.state !== 'completed' || receipt.task_id !== contract.task_id ||
          receipt.request_id !== attempt.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id || receipt.controlled_execution.stage !== attempt.stage ||
          report.meta.data.invocation_id !== receipt.id || report.meta.data.epoch_id !== run.epoch_id || report.meta.data.task_id !== contract.task_id ||
          report.meta.data.workflow_id !== run.workflow_id || report.meta.owner !== attempt.role || !same(report.meta.data.artifact_hashes, attempt.bound_hashes))
        throw new Error('Required result does not match its signed task, epoch, stage and request.');
      if (attempt.report_fingerprint !== evidenceRecordFingerprint(report)) throw new Error('The independently saved work result changed.');
      if (!same(attempt.bound_hashes, budget.fingerprints(Object.keys(attempt.bound_hashes ?? {})))) throw new Error('Reported artifacts changed after the result.');
    }
    if (producer!.invocation_id === verifier!.invocation_id || reviewer?.invocation_id === producer!.invocation_id || reviewer?.invocation_id === verifier!.invocation_id)
      throw new Error('Verification and review must use independent sessions.');
    if (run.attempts.indexOf(verifier!) <= run.attempts.indexOf(producer!)) throw new Error('Independent verification must follow the latest producer result.');
    if (verifier!.report?.verdict !== 'pass' || gate === 'accepted' && contract.reviewer_required && reviewer?.report?.verdict !== 'pass') throw new Error('Independent verification or required review did not pass.');
    const checks = run.checks.filter(item => item.attempt_id === verifier!.id);
    for (const planned of contract.plan.checks) for (const selected of [{ ...planned, negative: false }, ...(planned.negative_controls ?? []).map(value => ({ ...value, negative: true }))]) {
      budget.check();
      const result = checks.find(item => item.title === selected.title && item.negative === selected.negative &&
        same(item.planned_command ?? item.command, selected.command) && item.expected_exit_code === (selected.expected_exit_code ?? 0));
      if (!result || result.invocation_id !== verifier!.invocation_id) throw new Error('Actual prescribed positive/negative execution evidence is missing.');
      evidenceProblems(root, run, contract, result, budget);
    }
    if (contract.precheck_review) {
      const precheck = [...run.attempts].reverse().find(item => item.purpose === 'check-review' && item.state === 'completed' && item.report?.verdict === 'pass');
      const hashes = budget.fingerprints(contract.plan.verification_paths);
      if (!precheck?.invocation_id || !Object.entries(hashes).every(([path, digest]) => precheck.bound_hashes?.[path] === digest))
        throw new Error('Exact current checker bytes require independent pre-execution review.');
      const receipt = readInvocation(root, precheck.invocation_id);
      if (!precheck.report_id || precheck.report_fingerprint !== evidenceRecordFingerprint(getRecord(root, precheck.report_id)))
        throw new Error('The independently saved checker review changed.');
      if (receipt.controlled_execution?.epoch_id !== run.epoch_id || receipt.controlled_execution.stage !== 'review' || receipt.task_id !== contract.task_id ||
          receipt.request_id !== precheck.request_id || routingProblems(root, 'reviewer', receipt.id, { workflow_id: run.workflow_id, task_id: contract.task_id, require_completed: true }).length)
        throw new Error('Pre-execution approval does not match this execution.');
      if (checks.some(check => Date.parse(check.at) < Date.parse(receipt.updated_at))) throw new Error('A check ran before its current independent approval.');
    }
    if (Object.values(budget.fingerprints(contract.plan.outputs)).some(value => value === 'missing')) throw new Error('Delivered output is missing.');
    if (!same(contract.preserved_hashes, budget.fingerprints(Object.keys(contract.preserved_hashes)))) throw new Error('Protected pre-existing files changed.');
    if (contract.continuation?.obligations.intended_use) {
      if (contract.continuation.obligations.pilot_kind !== 'leetcode-c11-cpp17')
        throw new Error('This continuation needs a reviewed intended-use adapter for its original task family; a LeetCode C11/C++17 pilot cannot replace generic acceptance.');
      const pilot = checks.find(item => item.purpose === 'intended-use' && !item.negative);
      if (!pilot?.pilot_receipt_path || !pilot.pilot_receipt_hash || hash(readFileSync(safePath(root, pilot.pilot_receipt_path))) !== pilot.pilot_receipt_hash)
        throw new Error('Original acceptance requires a separately executed intended-use pilot; fixture self-checks cannot replace it.');
      const proof = JSON.parse(readFileSync(safePath(root, pilot.pilot_receipt_path), 'utf8')) as PilotProof;
      if (proof.kind !== 'intended-use' || proof.check_id !== pilot.id || proof.workflow_id !== run.workflow_id || proof.epoch_id !== run.epoch_id ||
          !proof.validation.passed || proof.solutions.length !== 2 || proof.solutions.some(solution => !solution.compile.passed || !solution.run.passed))
        throw new Error('Intended-use pilot lacks actual independent Cornell/C11/C++17 execution.');
      for (const artifact of proof.artifacts) { budget.check(); if (hash(readFileSync(safePath(root, artifact.path))) !== artifact.sha256) throw new Error('Retained intended-use artifacts changed.'); }
    }
    if (gate === 'accepted') {
      if (!['submitted', 'accepted'].includes(task.meta.status)) throw new Error('Controlled execution has not submitted its actual producer result.');
      if (contract.continuation?.obligations.registration && !contract.plan.procedure_candidate) throw new Error('Original acceptance requires registration of actual scripts.');
      if (contract.plan.procedure_candidate) {
        budget.check();
        if (!run.procedure_candidate_id) throw new Error('Actual reusable candidate was not registered.');
        const procedure = resolveProcedure(root, run.procedure_candidate_id, run.procedure_candidate_version ?? '1.0.0');
        if (procedure.script !== contract.plan.procedure_candidate.script || procedure.verification_script !== contract.plan.procedure_candidate.verification_script ||
            procedure.script_sha256 !== hash(readFileSync(safePath(root, procedure.script))) || procedure.verification_sha256 !== hash(readFileSync(safePath(root, procedure.verification_script))))
          throw new Error('Registered candidate does not match current producer and independent verifier scripts.');
      }
      if (contract.knowledge_directory || contract.plan.cornell_output_dir) {
        const positive = checks.filter(check => !check.negative).map(check => check.evidence_id!);
        if (!run.cornell_note_ids?.length) throw new Error('Requested evidence-derived Cornell note is missing.');
        for (const id of run.cornell_note_ids) {
          budget.check();
          const note = getRecord(root, id), evidence = (note.meta.data.demonstration as { evidence_ids?: string[] })?.evidence_ids ?? [];
          if (!validateCornellNote(root, id).ok || note.meta.data.workflow_id !== run.workflow_id || !positive.every(id => evidence.includes(id)))
            throw new Error('Final Cornell output must reference every current passing positive execution.');
        }
      }
      if (contract.reviewer_required && run.attempts.indexOf(reviewer!) < Math.max(run.attempts.indexOf(verifier!), synthesis ? run.attempts.indexOf(synthesis) : -1))
        throw new Error('Independent final review must follow verification and requested synthesis.');
    }
    budget.check();
  } catch (error) { add('controlled-acceptance', error instanceof Error ? error.message : 'Controlled acceptance could not be reconciled.'); }
  return { ok: !findings.length, gate, findings, checked_at: now() };
}

interface PilotCommand { command: string[]; result: CommandResult; passed: boolean }
interface PilotProof { schema_version: 1; kind: 'intended-use'; workflow_id: string; epoch_id: string; check_id: string;
  validation: PilotCommand; solutions: { language: string; compile: PilotCommand; run: PilotCommand }[]; artifacts: { path: string; sha256: string }[] }
function pilotFile(root: string, relativePath: unknown): string {
  if (typeof relativePath !== 'string' || isAbsolute(relativePath) || !relativePath || relativePath.includes('\\') ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) throw new Error('Pilot artifacts need bounded relative paths.');
  const full = resolve(root, relativePath), rel = relative(root, full);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Pilot artifact escaped its owned root.');
  const info = lstatSync(full);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || realpathSync.native(full) !== full)
    throw new Error('Pilot artifacts must be ordinary bounded unlinked files.');
  return full;
}
/** Checker prepares a disposable intended-use bundle; runtime executes validation and both fresh builds itself. */
export async function executeControlledPilot(root: string, run: ControlledSnapshot, checkId: string, pilotRoot: string, nonce: string, signal: AbortSignal, deadline = Date.now() + 600000): Promise<{ path: string; sha256: string }> {
  const manifest = JSON.parse(readFileSync(pilotFile(pilotRoot, 'pilot-input.json'), 'utf8'));
  if (manifest.schema_version !== 1 || manifest.nonce !== nonce || manifest.kind !== 'intended-use' ||
      !Array.isArray(manifest.case_classes) || new Set(manifest.case_classes).size < 10 || manifest.case_classes.some((value: unknown) => typeof value !== 'string' || value.trim().length < 8) ||
      !Array.isArray(manifest.solutions) || manifest.solutions.length !== 2 ||
      !same(manifest.solutions.map((solution: { language: string }) => solution.language).sort(), ['c11', 'cpp17']))
    throw new Error('Intended-use pilot needs its backend nonce, ten meaningful classes and both C11/C++17 targets.');
  const note = pilotFile(pilotRoot, manifest.note), validator = safePath(root, '.agents/skills/leetcode-notes/scripts/validate_notes.py');
  if (typeof manifest.python !== 'string' || !isAbsolute(manifest.python)) throw new Error('Pilot must name its configured Python executable.');
  const captured: { path: string; bytes: Buffer }[] = [{ path: 'pilot-input.json', bytes: readFileSync(pilotFile(pilotRoot, 'pilot-input.json')) }, { path: manifest.note, bytes: readFileSync(note) }];
  const execute = async (command: string[], compiler?: string): Promise<PilotCommand> => {
    const remaining = Math.min(60000, deadline - Date.now());
    if (remaining < 1) throw new Error('Intended-use pilot exhausted its declared total check timeout.');
    const result = await runCommand({ command, cwd: pilotRoot, signal, timeout_ms: remaining,
      ...(compiler ? { env: { PATH: `${dirname(compiler)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` } } : {}) });
    return { command, result, passed: result.exit_code === 0 && !result.cancelled && !result.timed_out && !result.output_limited && !result.error };
  };
  const validation = await execute([manifest.python, validator, note]);
  const solutions: PilotProof['solutions'] = [];
  for (const solution of manifest.solutions) {
    const source = pilotFile(pilotRoot, solution.source), bytes = readFileSync(source);
    if (typeof solution.compiler !== 'string' || !isAbsolute(solution.compiler) || typeof solution.local_test !== 'boolean') throw new Error('Pilot needs explicit compiler and LOCAL_TEST selection.');
    captured.push({ path: solution.source, bytes });
    const output = resolve(pilotRoot, `neomind-${solution.language}${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(output)) throw new Error('Pilot fresh executable already exists.');
    const command = [solution.compiler, `-std=${solution.language === 'c11' ? 'c11' : 'c++17'}`, '-Wall', '-Wextra', '-Werror', '-pedantic',
      ...(solution.local_test ? ['-DLOCAL_TEST'] : []), source, '-o', output];
    const compile = await execute(command, solution.compiler);
    const result = compile.passed ? await execute([output], solution.compiler) : { command: [output], result: compile.result, passed: false };
    if (hash(readFileSync(source)) !== hash(bytes)) throw new Error('Pilot source changed while compiled.');
    solutions.push({ language: solution.language, compile, run: result });
  }
  if (hash(readFileSync(note)) !== hash(captured[1]!.bytes)) throw new Error('Pilot note changed during validation.');
  const base = `.neomind/controlled/pilots/${checkId}`, artifacts = captured.map(({ path, bytes }) => {
    const target = `${base}/artifacts/${path}`; atomicWrite(safePath(root, target), bytes); return { path: target, sha256: hash(bytes) };
  });
  const proof: PilotProof = { schema_version: 1, kind: 'intended-use', workflow_id: run.workflow_id, epoch_id: run.epoch_id, check_id: checkId, validation, solutions, artifacts };
  const path = `${base}/receipt.json`, bytes = JSON.stringify(proof, null, 2) + '\n'; atomicWrite(safePath(root, path), bytes);
  if (!validation.passed || solutions.some(solution => !solution.compile.passed || !solution.run.passed)) throw new Error('Actual intended-use note validation or fresh C11/C++17 execution failed.');
  return { path, sha256: hash(bytes) };
}
