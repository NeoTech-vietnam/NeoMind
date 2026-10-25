import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initialize, atomicWrite, createRecord, getRecord, hash, safePath, updateRecord, saveStatus } from '../dist/storage.js';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';
import { controlledContractForTask, continuationObligations, prepareControlledCheckEvidence, materializeControlledEvidence,
  verifyControlledTask, executeControlledPilot } from '../dist/controlled-acceptance.js';
import { verify } from '../dist/engineering.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { runCommand } from '../dist/command-runner.js';
import { cornellFixture } from './cornell-fixture.mjs';
import { controlledRisk } from '../dist/controlled-workflow.js';

// Structural backend fixtures do not claim actual model or signed-session acceptance.
function fixture(t, continuation = false) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-controlled-acceptance-')));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { force: true, recursive: true }); });
  initialize(root, { project_id: 'CONTROLLED-ACCEPTANCE', profile: 'software', platforms: ['copilot'] });
  const requirement = createRecord(root, { type: 'requirement', title: 'Preserve an independently checked scalar.', owner: 'manager',
    data: { acceptance_criteria: ['The scalar is one and preserves prior inputs.'] } });
  const workflow = createRecord(root, { type: 'knowledge', title: 'Workflow: scalar', owner: 'manager', status: 'in-progress',
    data: { kind: 'manager-workflow', requirement_id: requirement.meta.id, execution_mode: continuation ? 'copilot-native' : 'neomind-controlled' } });
  const old = continuation ? createRecord(root, { type: 'task', title: 'Historical task', owner: 'developer', status: 'submitted',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['source/value.txt'] }, body: '# Historical incomplete result\nPreserve this evidence.\n' }) : null;
  const epoch = randomUUID(), check = { title: 'Independent scalar assertion', command: [process.execPath, 'checks/verify.cjs', 'source/value.txt'],
    baseline_paths: ['source/value.txt', 'checks/verify.cjs'], expected_exit_code: 0,
    negative_controls: [{ title: 'Reject wrong scalar', command: [process.execPath, 'checks/verify.cjs', 'checks/bad.txt'],
      baseline_paths: ['checks/verify.cjs', 'checks/bad.txt'], expected_exit_code: 1 }] };
  const plan = { title: 'Scalar', objective: 'Export a scalar equal to integer one.', rationale: 'A small bounded scalar behavior.',
    acceptance_criteria: ['The scalar is one and preserves prior inputs.'], allowed_paths: ['source/value.txt'], verification_paths: ['checks'],
    outputs: ['source/value.txt'], documentation_paths: [], checks: [check], risk: 'low' };
  const task = createRecord(root, { type: 'task', title: 'Controlled execution', owner: 'developer', status: 'submitted',
    links: [{ type: 'satisfies', target: requirement.meta.id }, ...(old ? [{ type: 'derives-from', target: old.meta.id }] : [])],
    data: { workflow_id: workflow.meta.id, epoch_id: epoch, process_contract: 'software-tools/v2',
      ...Object.fromEntries(['acceptance_criteria', 'allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'].map(key => [key, plan[key]])) } });
  atomicWrite(safePath(root, 'source/value.txt'), '1\n');
  atomicWrite(safePath(root, 'checks/verify.cjs'), "const fs = require('node:fs'); process.exit(Number(fs.readFileSync(process.argv[2], 'utf8')) === 1 ? 0 : 1);\n");
  atomicWrite(safePath(root, 'checks/bad.txt'), '2\n');
  atomicWrite(safePath(root, 'preserved.txt'), 'original\n');
  const originalContractPath = `.neomind/native/software-workflows/${hash(workflow.meta.id)}.contract.json`;
  if (old) atomicWrite(safePath(root, originalContractPath), JSON.stringify({ task_id: old.meta.id, purpose: 'immutable historical fixture' }));
  const contract = { schema_version: 2, process: 'software-tools', workflow_id: workflow.meta.id, epoch_id: epoch, plan, plan_hash: hash(JSON.stringify(plan)),
    task_id: task.meta.id, requirement_ids: [requirement.meta.id], requirement_fingerprints: { [requirement.meta.id]: evidenceRecordFingerprint(requirement) },
    preserved_hashes: { 'preserved.txt': hash('original\n') }, reviewer_required: false, risk_reasons: [], precheck_review: false,
    ...(old ? { continuation: { original_task_id: old.meta.id, original_task_fingerprint: hash(JSON.stringify(old)), original_contract_path: originalContractPath,
      original_contract_sha256: hash(readFileSync(safePath(root, originalContractPath))), obligations: { registration: true, intended_use: true, preservation: true } } } : {}) };
  const bytes = JSON.stringify(contract, null, 2) + '\n', contractHash = hash(bytes);
  atomicWrite(safePath(root, `.neomind/controlled/workflows/${hash(workflow.meta.id)}.${epoch}.contract.json`), bytes);
  updateRecord(root, task.meta.id, { data: { controlled_contract_hash: contractHash } });
  updateRecord(root, workflow.meta.id, { data: { controlled_epoch_id: epoch, controlled_contract_hash: contractHash } });
  const run = { schema_version: 1, workflow_id: workflow.meta.id, epoch_id: epoch, status: 'queued', phase: 'implementation', process_contract: 'software-tools/v2',
    contract_hash: contractHash, attempts: [], checks: [], events: [], active_invocations: [], repairs: 0 };
  const statePath = safePath(root, `.neomind/controlled/workflows/${hash(workflow.meta.id)}.json`);
  atomicWrite(statePath, JSON.stringify(run));
  return { root, task: getRecord(root, task.meta.id), workflow, requirement, old, contract, run, check, statePath };
}

test('accepted metadata cannot replace actual completed signed stage and execution evidence', t => {
  const a = fixture(t);
  assert.equal(verifyControlledTask(a.root, a.task, 'ready').ok, true);
  saveStatus(a.root, a.task.meta.id, 'accepted');
  const result = verify(a.root, a.task.meta.id, 'accepted');
  assert.equal(result.ok, false); assert.match(result.findings[0].message, /Required independently completed result/);
});

test('continuation identity binds a distinct execution task and preserves the entire historical task and contract', t => {
  const a = fixture(t, true), before = readFileSync(safePath(a.root, a.old.path));
  assert.notEqual(a.task.meta.id, a.old.meta.id);
  assert.equal(controlledContractForTask(a.root, a.task).contract.continuation.original_task_id, a.old.meta.id);
  assert.deepEqual(readFileSync(safePath(a.root, a.old.path)), before);
  saveStatus(a.root, a.old.meta.id, 'accepted');
  assert.throws(() => controlledContractForTask(a.root, a.task), /unchanged legacy task/);
});

test('missing journal, wrong task binding and changed requirements fail closed even at ready', t => {
  const a = fixture(t), original = readFileSync(a.statePath);
  writeFileSync(a.statePath, JSON.stringify({ ...a.run, epoch_id: randomUUID() }));
  assert.equal(verifyControlledTask(a.root, a.task, 'ready').ok, false);
  writeFileSync(a.statePath, original);
  updateRecord(a.root, a.requirement.meta.id, { data: { acceptance_criteria: ['A changed acceptance requirement.'] } });
  assert.equal(verifyControlledTask(a.root, a.task, 'ready').ok, false);
});

test('actual positive command receipt materializes Cornell-compatible evidence; stale source invalidates it', async t => {
  const a = fixture(t), baseline = Object.fromEntries(a.check.baseline_paths.map(path => [path, hash(readFileSync(safePath(a.root, path)))]));
  const input = prepareControlledCheckEvidence(a.root, a.run, a.contract, a.check, baseline, null);
  const result = await runCommand({ command: a.check.command, cwd: a.root, timeout_ms: 5000 });
  assert.equal(result.exit_code, 0);
  const id = randomUUID(), logPath = `.neomind/controlled/checks/${id}.log`, log = JSON.stringify({ command: a.check.command, baseline, result }) + '\n';
  atomicWrite(safePath(a.root, logPath), log);
  const receipt = { id, attempt_id: 'fixture-attempt', invocation_id: 'structural-fixture-executor', title: a.check.title, command: a.check.command,
    baseline, log_path: logPath, log_sha256: hash(log), exit_code: result.exit_code, expected_exit_code: 0,
    negative: false, passed: true, cancelled: false, at: new Date().toISOString(), evidence_input: input };
  const evidenceId = materializeControlledEvidence(a.root, a.run, a.contract, receipt);
  assert.equal(materializeControlledEvidence(a.root, a.run, a.contract, receipt), evidenceId, 'Same receipt does not duplicate evidence.');
  const note = cornellFixture(a.workflow.meta.id, a.requirement.meta.id);
  note.demonstration.observed = 'The actual independent scalar command exited zero against the recorded source hash.';
  note.demonstration.evidence_ids = [evidenceId];
  const saved = createCornellNote(a.root, note);
  assert.equal(validateCornellNote(a.root, saved.meta.id).ok, true);
  atomicWrite(safePath(a.root, 'source/value.txt'), '2\n');
  assert.equal(validateCornellNote(a.root, saved.meta.id).ok, false);
});

test('continuation obligations retain registration, intended-use and preservation independently', () => {
  assert.deepEqual(continuationObligations(['Register actual versioned procedure.', 'Intended-use pilot uses an approved disposable exercise.', 'Preserve all existing exercises.']),
    { registration: true, intended_use: true, preservation: true });
  assert.deepEqual(continuationObligations(['Return the integer one.']), { registration: false, intended_use: false, preservation: false });
});

test('minimum review risk retains the original English and Vietnamese user intent despite an innocuous low-risk plan', t => {
  const a = fixture(t), plan = a.contract.plan;
  assert.equal(controlledRisk(plan).reviewer_required, false);
  for (const request of ['Change authentication and authorization.', 'Cải thiện xác thực và phân quyền.', 'Sửa quyền truy cập và mật khẩu.', 'Thay đổi điều phối hoặc lưu trữ.'])
    assert.equal(controlledRisk(plan, request).reviewer_required, true, request);
});

test('fixture outcome and wrong pilot nonce cannot create intended-use proof', async t => {
  const a = fixture(t), pilotRoot = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'neomind-pilot-rejection-')));
  t.after(() => { assert.equal(dirname(pilotRoot), realpathSync.native(tmpdir())); rmSync(pilotRoot, { force: true, recursive: true }); });
  atomicWrite(join(pilotRoot, 'pilot-input.json'), JSON.stringify({ schema_version: 1, kind: 'fixture', nonce: 'wrong', solutions: [] }));
  await assert.rejects(executeControlledPilot(a.root, a.run, randomUUID(), pilotRoot, 'backend-nonce', new AbortController().signal), /backend nonce/);
  assert.equal(a.run.checks.length, 0);
});

test('intended-use backend executes its validator and fresh C11/C++17 builds instead of trusting checker prose', async t => {
  const compiler = name => [...(process.env.PATH ?? '').split(delimiter), ...(process.platform === 'win32' ? ['C:/msys64/mingw64/bin'] : ['/usr/bin'])]
    .map(path => join(path.replace(/^"|"$/g, ''), `${name}${process.platform === 'win32' ? '.exe' : ''}`)).find(path => existsSync(path));
  const gcc = compiler('gcc'), gpp = compiler('g++');
  let python;
  for (const command of ['python3', 'python', 'D:/ESP-IDF/Espressif/tools/idf-python/3.11.2/python.exe']) {
    const result = spawnSync(command, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.status === 0 && existsSync(result.stdout.trim())) { python = result.stdout.trim(); break; }
  }
  if (!gcc || !gpp || !python) { t.skip('This host does not have the actual Python/GCC/G++ toolchain for the pilot process test.'); return; }
  const a = fixture(t), pilotRoot = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'neomind-pilot-build-')));
  t.after(() => { assert.equal(dirname(pilotRoot), realpathSync.native(tmpdir())); rmSync(pilotRoot, { force: true, recursive: true }); });
  atomicWrite(safePath(a.root, '.agents/skills/leetcode-notes/scripts/validate_notes.py'),
    'import pathlib, sys\nraise SystemExit(0 if "CORRECT" in pathlib.Path(sys.argv[1]).read_text() else 1)\n');
  atomicWrite(join(pilotRoot, 'note.md'), '# CORRECT intended-use example\n');
  atomicWrite(join(pilotRoot, 'solution.c'), '#include <assert.h>\nint main(void) { for(int i=0;i<10;i++) { assert(i+1>i); } return 0; }\n');
  atomicWrite(join(pilotRoot, 'solution.cpp'), '#include <cassert>\nint main() { for(int i=0;i<10;i++) { assert(i+1>i); } return 0; }\n');
  const manifest = { schema_version: 1, kind: 'intended-use', nonce: 'backend-nonce', note: 'note.md', python,
    case_classes: Array.from({ length: 10 }, (_, index) => `Independent bound case ${index}`),
    solutions: [{ language: 'c11', source: 'solution.c', compiler: gcc, local_test: false },
      { language: 'cpp17', source: 'solution.cpp', compiler: gpp, local_test: false }] };
  atomicWrite(join(pilotRoot, 'pilot-input.json'), JSON.stringify(manifest));
  const proof = await executeControlledPilot(a.root, a.run, randomUUID(), pilotRoot, 'backend-nonce', new AbortController().signal);
  const saved = JSON.parse(readFileSync(safePath(a.root, proof.path), 'utf8'));
  assert.equal(saved.validation.passed, true); assert.equal(saved.solutions.length, 2);
  for (const solution of saved.solutions) {
    assert.equal(solution.compile.result.exit_code, 0); assert.equal(solution.run.result.exit_code, 0);
    assert.ok(solution.compile.command.includes('-Werror')); assert.ok(solution.compile.command.includes('-pedantic'));
  }
  assert.equal(saved.solutions[0].compile.command.includes('-std=c11'), true);
  assert.equal(saved.solutions[1].compile.command.includes('-std=c++17'), true);
  assert.equal(hash(readFileSync(safePath(a.root, proof.path))), proof.sha256);
  for (const artifact of saved.artifacts) assert.equal(hash(readFileSync(safePath(a.root, artifact.path))), artifact.sha256);
});
