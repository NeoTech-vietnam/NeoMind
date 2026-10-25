import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initialize, atomicWrite, createRecord, getRecord, hash, safePath, updateRecord, saveStatus } from '../dist/storage.js';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';
import { controlledContractForTask, continuationObligations, prepareControlledCheckEvidence, materializeControlledEvidence,
  verifyControlledTask, executeControlledPilot, controlledPrimaryCornellArtifactPaths } from '../dist/controlled-acceptance.js';
import { verify } from '../dist/engineering.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { runCommand } from '../dist/command-runner.js';
import { cornellFixture } from './cornell-fixture.mjs';
import { controlledRisk } from '../dist/controlled-workflow.js';
import { startControlledWorkflow, startControlledHost, controlledStatus } from '../dist/controlled-workflow.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { researchFixture } from './cornell-research-fixture.mjs';
import { beginWorkflow, nativeAutomationPolicy } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment } from '../dist/assignment-runtime.js';
import { planNativeSoftware } from '../dist/native-software.js';

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
      original_contract_sha256: hash(readFileSync(safePath(root, originalContractPath))), obligations: { registration: true, intended_use: true, preservation: true, pilot_kind: 'unsupported-generic' } } } : {}) };
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

// Actual signed Bridge/MCP and independent Node processes; model responses are
// deterministic fixtures, not real provider inference evidence.
async function primaryCornell(t, withStarter = false) {
  const seed = researchFixture(t).input;
  const { schema_version, requirement_id, expected_requirement_revision, workflow_id, output_dir, ...research } = seed;
  research.sources = [{ id: 'S1', title: 'Finite ordered-pair source', uri: 'reference.md' }];
  research.practice = { ...research.practice }; delete research.practice.solution_path; delete research.practice.starter;
  if (withStarter) research.practice.starter = '# My ordered-pair worksheet\nRecord the pairs and your own reasoning here.\n';
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-primary-cornell-')));
  initialize(root, { project_id: 'PRIMARY-CORNELL', platforms: ['copilot'], repair_attempts: 1 });
  atomicWrite(safePath(root, 'reference.md'), '# Finite ordered pairs\nThree letters and two digits have six ordered pairs.\n');
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: policy.worker_models.map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const directory = 'docs/primary', paths = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
  if (withStarter) paths.push(`${directory}/practice-solution.md`);
  const plan = { title: 'Primary Cornell documentation', objective: 'Explain and independently check six finite ordered pairs.',
    rationale: 'The note is a primary product checked after its expected-only preparation.', acceptance_criteria: ['The Cornell bundle explains six pairs and wrong documentation fails.'],
    allowed_paths: [directory], verification_paths: ['checks'], outputs: paths, documentation_paths: paths,
    cornell_output_dir: directory, preservation_paths: ['reference.md'], risk: 'high',
    checks: [{ title: 'Inspect primary Cornell', command: [process.execPath, 'checks/check.cjs', paths[0]],
      negative_controls: [{ title: 'Reject corrupt documentation', command: [process.execPath, 'checks/check.cjs', 'checks/bad.md'], expected_exit_code: 1 }] }] };
  const checker = "const assert=require('node:assert/strict'),fs=require('node:fs');assert.match(fs.readFileSync(process.argv[2],'utf8'),/six ordered pairs/);console.log('primary Cornell checked');\n";
  class Text { constructor(value) { this.value = value; } }
  class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
  const conversations = new WeakMap(), errors = [], stages = [], call = (name, input = {}) => ({ name, input });
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result, LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async messages => {
      let state = conversations.get(messages);
      if (!state) {
        const prompt = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const stage = /Your stage: (planning|implementation|verification|review)/.exec(prompt)?.[1];
        assert.ok(stage); stages.push(stage);
        const report = call('assignment_report', { outcome: 'completed', summary: `Independent ${stage} result retained.`,
          ...(['verification', 'review'].includes(stage) ? { verdict: 'pass' } : {}) });
        state = { round: 0, actions: stage === 'planning' ? [call('workflow_plan', plan), report]
          : stage === 'implementation' ? [call('cornell_research_compile', research), report]
            : stage === 'verification' ? [call('task_file_write', { path: 'checks/check.cjs', content: checker }),
              call('task_file_write', { path: 'checks/bad.md', content: '# Wrong product\nThere are 999 pairs.\n' }), call('check_run'), report]
              : [call('check_evidence'), report] };
        conversations.set(messages, state);
      }
      const previous = messages.at(-1)?.content?.[0];
      if (previous instanceof Result) { const result = JSON.parse(previous.content[0].value);
        if (result.isError) { errors.push(result); throw new Error('Primary Cornell fixture received rejected semantic input.'); } }
      const action = state.actions[state.round++];
      return { stream: (async function* () { yield action ? new Call(`cornell-${state.round}`, action.name, action.input) : new Text('Typed result saved.'); })() };
    } }] } };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const initial = await startControlledWorkflow(root, { requirement: 'Deliver independently verified primary Cornell documentation.', request_id: 'primary-cornell' });
  const deadline = Date.now() + 120000; let run;
  do { run = controlledStatus(root, initial.workflow_id);
    if (run.status === 'completed') break;
    if (['blocked', 'uncertain'].includes(run.status)) assert.fail(JSON.stringify({ blocker: run.blocker, phase: run.phase, stages,
      checks: run.checks.map(check => ({ negative: check.negative, passed: check.passed, exit_code: check.exit_code })),
      note_count: run.cornell_note_ids?.length, errors }));
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(run.status, 'completed', JSON.stringify({ phase: run.phase, errors }));
  assert.deepEqual(errors, []); assert.deepEqual(stages, ['planning', 'implementation', 'verification', 'review']);
  const contractPath = safePath(root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.${run.epoch_id}.contract.json`);
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  return { root, run, contract, paths, task: getRecord(root, contract.task_id), statePath: safePath(root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.json`) };
}

test('primary expected-only Cornell accepts actual current check coverage and rejects stale, foreign, missing or unproved bundles', async t => {
  const a = await primaryCornell(t), note = getRecord(a.root, a.run.cornell_note_ids[0]);
  const check = () => verifyControlledTask(a.root, a.task, 'accepted');
  assert.equal(a.contract.knowledge_directory, undefined); assert.equal(a.contract.plan.cornell_output_dir, 'docs/primary');
  assert.equal(note.meta.data.demonstration.observed, undefined);
  assert.deepEqual(note.meta.data.demonstration.evidence_ids, []);
  assert.equal(check().ok, true); assert.equal(verify(a.root, a.task.meta.id, 'accepted').ok, true);
  const positives = a.run.checks.filter(item => !item.negative);
  for (const path of a.paths) assert.ok(positives.some(item => item.baseline[path] === hash(readFileSync(safePath(a.root, path)))));
  const file = safePath(a.root, a.paths[0]), bytes = readFileSync(file);
  writeFileSync(file, Buffer.concat([bytes, Buffer.from('\nUnexpected authored modification.\n')])); assert.equal(check().ok, false);
  writeFileSync(file, bytes); unlinkSync(file); assert.equal(check().ok, false); writeFileSync(file, bytes);
  const recordPath = safePath(a.root, note.path), recordBytes = readFileSync(recordPath);
  updateRecord(a.root, note.meta.id, { data: { workflow_id: 'FOREIGN-WORKFLOW' } }); assert.equal(check().ok, false); writeFileSync(recordPath, recordBytes);
  const stateBytes = readFileSync(a.statePath);
  for (const mutate of [run => { run.cornell_note_ids = []; }, run => { run.cornell_results = []; },
    run => { run.cornell_results[0].input_hash = 'f'.repeat(64); },
    run => { run.checks = run.checks.filter(item => item.negative); },
    run => { run.checks.find(item => !item.negative).passed = false; },
    run => { run.checks.find(item => !item.negative).baseline[a.paths[0]] = 'f'.repeat(64); }]) {
    const changed = JSON.parse(stateBytes.toString('utf8')); mutate(changed); writeFileSync(a.statePath, JSON.stringify(changed));
    assert.equal(check().ok, false); writeFileSync(a.statePath, stateBytes);
  }
  assert.equal(check().ok, true, 'Restoring exact fixture bytes restores acceptance without refreshing any evidence.');
});

test('primary learner worksheets are authorized only as the fixed explicitly planned output', () => {
  const directory = 'docs/primary', rendered = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
  const solution = `${directory}/practice-solution.md`, plan = { cornell_output_dir: directory, outputs: rendered };
  assert.deepEqual(controlledPrimaryCornellArtifactPaths(plan), { rendered, all: rendered });
  assert.throws(() => controlledPrimaryCornellArtifactPaths(plan, solution), /fixed declared/);
  assert.throws(() => controlledPrimaryCornellArtifactPaths({ ...plan, outputs: [...rendered, 'docs/other.md'] }, 'docs/other.md'), /fixed declared/);
  assert.deepEqual(controlledPrimaryCornellArtifactPaths({ ...plan, outputs: [...rendered, solution] }, solution),
    { rendered, all: [...rendered, solution] });
});

test('an explicitly planned fourth primary Cornell worksheet has actual producer and current positive baseline coverage', async t => {
  const a = await primaryCornell(t, true), note = getRecord(a.root, a.run.cornell_note_ids[0]);
  const solution = 'docs/primary/practice-solution.md', producer = a.run.attempts.findLast(attempt => attempt.stage === 'implementation');
  assert.equal(note.meta.data.practice.solution_path, solution);
  assert.equal(Object.keys(note.meta.data.artifact_hashes).length, 3, 'Rendered bundle hashes intentionally exclude the learner-editable worksheet.');
  const digest = hash(readFileSync(safePath(a.root, solution)));
  assert.equal(producer.bound_hashes[solution], digest);
  assert.ok(a.run.checks.some(check => !check.negative && check.passed && check.baseline[solution] === digest));
  assert.equal(verifyControlledTask(a.root, a.task, 'accepted').ok, true);
});

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
    { registration: true, intended_use: true, preservation: true, pilot_kind: 'unsupported-generic' });
  assert.deepEqual(continuationObligations(['Return the integer one.']), { registration: false, intended_use: false, preservation: false, pilot_kind: null });
  assert.equal(continuationObligations(['LeetCode Cornell note with C11 and C++17 solutions.', 'Run an intended-use pilot.']).pilot_kind, 'leetcode-c11-cpp17');
  assert.equal(continuationObligations(['Run an intended-use pilot for the JavaScript CLI.']).pilot_kind, 'unsupported-generic');
});

test('minimum review risk retains the original English and Vietnamese user intent despite an innocuous low-risk plan', t => {
  const a = fixture(t), plan = a.contract.plan;
  assert.equal(controlledRisk(plan).reviewer_required, false);
  for (const request of ['Change authentication and authorization.', 'Cải thiện xác thực và phân quyền.', 'Sửa quyền truy cập và mật khẩu.', 'Thay đổi điều phối hoặc lưu trữ.'])
    assert.equal(controlledRisk(plan, request).reviewer_required, true, request);
});

test('public continuation preflight preserves an actionable unsupported-family error before host lookup or model dispatch', async t => {
  const a = fixture(t);
  atomicWrite(safePath(a.root, '.neomind/automation.json'), JSON.stringify(nativeAutomationPolicy()));
  const workflow = beginWorkflow(a.root, { execution_mode: 'copilot-native', requirement: 'Implement a JavaScript scalar CLI with an explicitly required intended-use pilot.' });
  const packet = prepareReportedAssignment(a.root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: 'generic-pilot-preflight-fixture', objective: 'Save the actual generic software contract without authorizing a language-specific replacement pilot.' });
  const handle = openAssignment(a.root, packet.open_input).handle;
  const { checks, risk, ...plan } = a.contract.plan;
  planNativeSoftware(a.root, handle, { ...plan, title: 'Generic JavaScript CLI intended-use pilot', process: 'software-tools',
    rationale: 'This JavaScript software contract needs its own intended-use proof and has no Cornell or C/C++ outputs.',
    acceptance_criteria: [...plan.acceptance_criteria, 'Run an intended-use pilot for the JavaScript CLI.'],
    checks: checks.map(({ negative_controls, ...check }) => check) });
  await assert.rejects(startControlledWorkflow(a.root, { workflow_id: workflow.meta.id }), error => {
    assert.equal(error.code, 'CONTINUATION_PILOT_UNSUPPORTED');
    assert.match(error.message, /reviewed runtime adapter/);
    assert.doesNotMatch(error.message, /re-enable|descriptor|credential|token/i);
    return true;
  });
  assert.equal(existsSync(safePath(a.root, `.neomind/controlled/workflows/${hash(workflow.meta.id)}.json`)), false);
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
