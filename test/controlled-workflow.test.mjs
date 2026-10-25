import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialize, atomicWrite, createRecord, getRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { executionModes } from '../dist/execution-mode.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';
import { setRoleModel } from '../dist/model-control.js';
import { readAgentMap } from '../dist/agent-map.js';
import { verify } from '../dist/engineering.js';
import { ownedContext } from '../dist/controlled-context.js';
import { beginWorkflow } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment } from '../dist/assignment-runtime.js';
import { planNativeSoftware, readNativeSoftwareContract } from '../dist/native-software.js';
import { controlledContractForTask, verifyControlledTask } from '../dist/controlled-acceptance.js';

// These tests exercise the actual signed local Bridge, MCP, filesystem and child runner.
// The language model and editor API are deterministic fixtures, not actual Copilot/Codex inference.
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (name, input) => ({ name, input });
const prohibited = new Set(['workflow_id', 'task_id', 'invocation_id', 'reported_assignment', 'claim_token', 'access_token', 'operation_id', 'expected_hash']);
function assertSemanticSchemas(tools) {
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const name of Object.keys(value.properties ?? {})) assert.ok(!prohibited.has(name), `model must not construct ${name}`);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  for (const tool of tools) {
    assert.ok(!['assignment_open', 'assignment_claim', 'assignment_progress', 'record_create', 'record_update', 'manager_run', 'native_dispatch', 'run_in_terminal'].includes(tool.name));
    visit(tool.inputSchema);
  }
}
function lastToolResult(messages) {
  const result = messages.at(-1)?.content?.[0];
  if (!(result instanceof Result)) return;
  let decoded = JSON.parse(result.content[0].value);
  return decoded;
}
function semanticToolValue(messages) {
  const result = lastToolResult(messages), content = result?.content?.[0];
  return content?.type === 'text' ? JSON.parse(content.text) : result;
}
function planFor(name, options = {}) {
  const output = `${name}/src/value.txt`, checker = `${name}/verify/check.cjs`, bad = `${name}/verify/bad.txt`;
  const baseline = [output, checker];
  return { title: `Produce ${name} scalar`, objective: 'Persist a scalar equal to one with independent positive and negative verification.',
    rationale: 'A bounded test artifact demonstrates actual workflow transitions and execution evidence.',
    acceptance_criteria: ['The delivered scalar is one.', 'The independent checker rejects a scalar equal to two.'],
    allowed_paths: [output], verification_paths: [`${name}/verify`], outputs: [output], documentation_paths: [],
    checks: [{ title: 'Validate scalar', command: [process.execPath, checker, output], baseline_paths: baseline,
      negative_controls: [{ title: 'Reject incorrect scalar', command: [process.execPath, checker, bad], baseline_paths: [checker, bad], expected_exit_code: 1 }] }],
    risk: options.highRisk ? 'high' : 'low' };
}
function scriptFor(name, stage, attempt, options, held) {
  const plan = planFor(name, options), output = plan.outputs[0], checker = plan.checks[0].command[1], bad = plan.checks[0].negative_controls[0].command[2];
  const report = (extra = {}) => call('assignment_report', { outcome: 'completed', summary: `${stage} completed with actual scoped artifacts.`,
    findings: [`Independent ${stage} result recorded.`], ...extra });
  if (stage === 'planning') return [call('project_list', { path: '.' }), call('workflow_plan', plan), report()];
  if (stage === 'implementation') {
    const value = options.precheckProductFailure || options.productFailure && attempt === 1 ? '2\n' : '1\n';
    return [call('project_read', { path: output }), call('task_file_write', { path: output, content: value }),
      ...(options.holdImplementation && attempt === 1 ? [async ({ token }) => {
        held.entered = true;
        while (!token.isCancellationRequested && !held.release) await delay(10);
        return held.release ? new Call('fixture-held-resume', 'project_read', { path: output })
          : new Text('Canceled deterministic model fixture.');
      }] : []), report({ artifacts: [output] })];
  }
  if (stage === 'verification') {
    const wrongChecker = options.checkerFailure && attempt === 1;
    const content = options.unsafeChecker ? "require('node:fs').writeFileSync(require('node:path').join(__dirname,'../../escape.txt'),'outside assigned scope');\n"
      : options.exitZeroChecker ? 'process.exit(0);\n'
      : `const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(Number(fs.readFileSync(process.argv[2],'utf8')),${wrongChecker ? 2 : 1}); console.log('scalar validated');\n`;
    const defect = wrongChecker || options.productFailure && attempt === 1;
    return [call('project_read', { path: output }), call('project_read', { path: checker }), call('task_file_write', { path: checker, content }),
      call('project_read', { path: bad }), call('task_file_write', { path: bad, content: '2\n' }), call('check_run', {}),
      ...(options.reviewScope && attempt > 1 ? [async ({ token, messages }) => {
        held.postCheckEvidence = semanticToolValue(messages); held.postChecksEntered = true;
        while (!token.isCancellationRequested && !held.postChecksRelease) await delay(10);
        return new Text('Actual diagnostic check checkpoint; no product acceptance is claimed.');
      }] : []),
      report({ outcome: defect ? 'failed' : 'completed', verdict: defect ? 'fail' : 'pass', artifacts: [output, checker, bad],
        negative_controls: ['The prescribed incorrect scalar fixture must exit one.'],
        ...(defect ? { failure_kind: wrongChecker ? 'checker' : 'implementation' } : {}) })];
  }
  if (stage === 'review') {
    const scopeReview = options.reviewScope || options.unsafeChecker;
    const result = report({ verdict: options.unsafeChecker ? 'fail' : 'pass', artifacts: [output, checker, bad],
      ...(options.unsafeChecker ? { failure_kind: 'checker', findings: ['Checker writes escape.txt outside its assigned/disposable execution scope; do not execute it.'] }
        : options.reviewScope ? { findings: ['The product scalar is two; the sound independent checker will safely diagnose that product defect by rejecting it.'],
          limitations: ['Pre-execution checker readiness is separate from product acceptance; no execution evidence exists yet.'] } : {}) });
    return [call('project_read', { path: output }), call('project_read', { path: checker }),
      ...(scopeReview || options.holdFinalReview ? [call('check_evidence', {})] : []),
      ...(options.reviewScope || options.holdFinalReview ? [async ({ token, messages }) => {
        held.reviewEvidence = semanticToolValue(messages); held.reviewEntered = true;
        while (!token.isCancellationRequested && !held.reviewRelease) await delay(10);
        return held.reviewRelease ? new Call('fixture-review-result', result.name, result.input) : new Text('Canceled held review fixture.');
      }] : [result])];
  }
  if (stage === 'diagnosis') return [call('project_read', { path: checker }), report({ failure_kind: 'checker' })];
  throw new Error(`Unexpected fixture stage ${stage}`);
}

async function setup(t, scenarios) {
  // The owner canonicalizes native roots; direct private callback lookup must use
  // that same identity when Windows TEMP is exposed through an 8.3 alias.
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-controlled-flow-')));
  initialize(root, { project_id: 'CONTROLLED', name: 'Controlled Bridge fixture', platforms: ['codex', 'copilot'], max_workers: 3, repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: [...policy.worker_models, 'next-worker'].map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const conversations = new WeakMap(), counts = new Map(), observed = [], errors = [], held = { entered: false };
  const api = {
    version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (messages, options, token) => {
      assertSemanticSchemas(options.tools);
      let conversation = conversations.get(messages);
      if (!conversation) {
        const text = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const name = /Scenario: ([a-z0-9-]+)/.exec(text)?.[1], stage = /Your stage: (planning|implementation|verification|review|diagnosis)/.exec(text)?.[1];
        assert.ok(name && stage, 'controller must provide meaningful stage/request context');
        const key = `${name}:${stage}`, attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
        conversation = { name, stage, attempt, actions: scriptFor(name, stage, attempt, scenarios[name] ?? {}, held), round: 0 };
        conversations.set(messages, conversation);
        observed.push({ name, stage, attempt, tools: options.tools.map(tool => tool.name),
          promptLayers: messages.filter(message => typeof message.content === 'string').map(message => message.content) });
      }
      const prior = lastToolResult(messages);
      if (prior?.isError) {
        errors.push({ name: conversation.name, stage: conversation.stage, round: conversation.round, result: prior });
        throw new Error('Deterministic fixture encountered a failed semantic MCP call.');
      }
      const action = conversation.actions[conversation.round++];
      let part = action ? typeof action === 'function' ? await action({ token, messages })
        : new Call(`fixture-call-${conversation.round}`, action.name, action.input) : new Text('Typed result persisted; deterministic fixture session complete.');
      return { stream: (async function* () { yield part; })() };
    } }] },
  };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, observed, errors, held, restart: async () => {
    await owner.close(); await shutdownNative(root); await bridge.close();
    bridge = await enableVSCodeHost(api, root); owner = await startControlledHost(root);
  } };
}
async function until(root, workflow, predicate, message, errors = []) {
  const deadline = Date.now() + (process.platform === 'win32' ? 180000 : 60000);
  let snapshot;
  do {
    snapshot = controlledStatus(root, workflow);
    if (predicate(snapshot)) return snapshot;
    if (snapshot.status === 'blocked') assert.fail(`${message}: ${JSON.stringify({ blocker: snapshot.blocker, phase: snapshot.phase,
      attempts: snapshot.attempts.map(attempt => ({ stage: attempt.stage, state: attempt.state, outcome: attempt.report?.outcome })),
      checks: snapshot.checks.map(check => ({ title: check.title, passed: check.passed, exit_code: check.exit_code })), events: snapshot.events.slice(-5), errors })}`);
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify({ status: snapshot.status, phase: snapshot.phase, errors })}`);
}
const submit = (root, name) => startControlledWorkflow(root, { requirement: `Scenario: ${name}\nCreate and independently verify the requested scalar.`, request_id: `fixture-${name}` });
async function submitContinuation(root, name) {
  const workflow = beginWorkflow(root, { requirement: `Scenario: ${name}\nCreate and independently verify the requested scalar.`, execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: `legacy-${name}`, objective: 'Freeze the original scalar contract before its controlled continuation.' });
  const handle = openAssignment(root, packet.open_input).handle;
  const { risk, checks, ...plan } = planFor(name);
  planNativeSoftware(root, handle, { ...plan, process: 'software-tools', checks: checks.map(({ negative_controls, ...check }) => check) });
  return startControlledWorkflow(root, { workflow_id: workflow.meta.id });
}

function countRecordReads(root, action) {
  const original = fs.readFileSync, prefix = safePath(root, '.neomind/records').replaceAll('\\', '/').toLowerCase() + '/', seen = new Map();
  fs.readFileSync = function (path, ...args) {
    if (typeof path === 'string' && path.replaceAll('\\', '/').toLowerCase().startsWith(prefix)) seen.set(path, (seen.get(path) ?? 0) + 1);
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: action(), reads: [...seen.values()].reduce((a, b) => a + b, 0), maximum: Math.max(0, ...seen.values()) }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

test('controlled execution mode is explicit and distinct from unsigned native modes', () => {
  assert.ok(executionModes.includes('neomind-controlled'));
});

test('both real Bridge prompt layers scope readiness to safe checker execution before any diagnostic evidence exists', async t => {
  const env = await setup(t, { readiness: { reviewScope: true, precheckProductFailure: true } });
  const initial = await submitContinuation(env.root, 'readiness');
  const preparing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'the frozen continuation must request independent checker readiness', env.errors);
  assert.equal(preparing.attempts.at(-1).purpose, 'check-review');
  assert.equal(preparing.checks.length, 0);
  assert.deepEqual(env.held.reviewEvidence, []);
  const prompts = env.observed.find(item => item.name === 'readiness' && item.stage === 'review').promptLayers;
  assert.equal(prompts.length, 2, 'Inspect both bound role instructions and the controller request actually delivered to the Bridge.');
  for (const prompt of prompts) {
    assert.match(prompt, /Review purpose: checker-readiness/);
    assert.match(prompt, /negative controls/);
    assert.match(prompt, /safe bounded execution/);
    assert.match(prompt, /not-yet-run evidence is expected/);
    assert.doesNotMatch(prompt, /Independently inspect the delivered artifacts and actual verification evidence|Review the actual change, acceptance criteria and current checks independently/);
  }
  env.held.reviewRelease = true;
  const diagnosed = await until(env.root, initial.workflow_id, () => env.held.postChecksEntered,
    'approved checker readiness must permit actual diagnostic execution', env.errors);
  assert.ok(diagnosed.attempts.some(attempt => attempt.purpose === 'check-review' && attempt.report?.verdict === 'pass'));
  assert.ok(diagnosed.checks.some(check => !check.negative && !check.passed), 'Actual checks diagnose the deliberately incorrect product.');
  assert.ok(diagnosed.checks.some(check => check.negative && check.passed));
  assert.notEqual(diagnosed.status, 'completed');
  assert.equal(diagnosed.final_report_id, undefined);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === diagnosed.epoch_id);
  assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, false, 'Readiness approval cannot substitute for independent passing checks and final review.');
});

test('unsafe checker readiness can still fail without executing any prescribed command', async t => {
  const env = await setup(t, { unsafe: { unsafeChecker: true } });
  const initial = await submitContinuation(env.root, 'unsafe');
  const blocked = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'an unsafe checker must retain the pre-execution gate', env.errors);
  assert.equal(blocked.checks.length, 0);
  assert.ok(blocked.attempts.filter(attempt => attempt.purpose === 'check-review').every(attempt =>
    attempt.report?.verdict === 'fail' && attempt.report.failure_kind === 'checker'));
  assert.ok(blocked.attempts.some(attempt => attempt.purpose === 'check-review'));
  assert.equal(existsSync(safePath(env.root, 'escape.txt')), false, 'The scope-escaping checker was never executed.');
  assert.equal(blocked.final_report_id, undefined);
});

test('final-product review still requires fresh execution evidence and cannot accept a missing-evidence journal', async t => {
  const env = await setup(t, { finalscope: { highRisk: true, holdFinalReview: true } });
  const initial = await submit(env.root, 'finalscope');
  const reviewing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'risk-based final review must follow actual passing verification', env.errors);
  assert.ok(reviewing.checks.length >= 2);
  assert.ok(env.held.reviewEvidence.length >= 2);
  const prompts = env.observed.find(item => item.name === 'finalscope' && item.stage === 'review').promptLayers;
  for (const prompt of prompts) {
    assert.match(prompt, /Review purpose: final-product/);
    assert.match(prompt, /fresh positive and negative execution evidence/);
    assert.match(prompt, /intended-use/);
    assert.match(prompt, /Cornell/);
    assert.doesNotMatch(prompt, /not-yet-run evidence is expected/);
  }
  const path = safePath(env.root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.json`);
  const missing = JSON.parse(readFileSync(path, 'utf8')); missing.checks = [];
  atomicWrite(path, JSON.stringify(missing));
  env.held.reviewRelease = true;
  const blocked = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'a final pass report cannot override lost current check evidence', env.errors);
  assert.equal(blocked.attempts.at(-1).report.verdict, 'pass');
  assert.equal(blocked.final_report_id, undefined);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === blocked.epoch_id);
  assert.notEqual(task.meta.status, 'accepted');
  const validation = verifyControlledTask(env.root, task, 'accepted');
  assert.equal(validation.ok, false);
  assert.ok(validation.findings.some(finding => /execution evidence is missing/.test(finding.message)));
});

test('actual final Reviewer receives only latest Verifier evidence while identical-title failure history remains saved', async t => {
  const env = await setup(t, { evidenceview: { highRisk: true, productFailure: true, holdFinalReview: true } });
  const initial = await submit(env.root, 'evidenceview');
  const reviewing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'final review must observe the separately repaired current verification', env.errors);
  assert.equal(reviewing.checks.length, 4);
  assert.ok(reviewing.checks.some(check => !check.passed), 'The earlier genuine product failure must remain in the journal.');
  assert.equal(env.held.reviewEvidence.length, 2, 'Current evidence must not mix earlier receipts with identical check titles.');
  assert.ok(env.held.reviewEvidence.every(check => check.passed));
  env.held.reviewRelease = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'a sound current review can close without deleting old failed observations', env.errors);
  assert.equal(done.checks.length, 4);
});

test('real signed Bridge/MCP drives normal and risk-based workflows with actual command evidence', async t => {
  const env = await setup(t, { ordinary: {}, sensitive: { highRisk: true } });
  for (const name of ['ordinary', 'sensitive']) {
    const initial = await submit(env.root, name);
    assert.ok(initial.workflow_id); assert.equal(initial.process_contract, 'software-tools/v2');
    const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'workflow should complete', env.errors);
    assert.deepEqual(done.attempts.map(attempt => attempt.stage), name === 'ordinary'
      ? ['planning', 'implementation', 'verification'] : ['planning', 'implementation', 'verification', 'review']);
    assert.equal(new Set(done.attempts.map(attempt => attempt.invocation_id)).size, done.attempts.length);
    for (const attempt of done.attempts) {
      const receipt = readInvocation(env.root, attempt.invocation_id);
      assert.equal(receipt.issuer, 'neomind-vscode-lm'); assert.equal(receipt.inference_completed, true);
      assert.ok(!receipt.native_tool_scope.some(name => ['assignment_open', 'assignment_progress', 'record_update'].includes(name)));
    }
    assert.ok(done.checks.length >= 2, 'actual positive and negative command receipts are required');
    assert.ok(done.checks.every(check => check.passed));
    assert.ok(done.checks.some(check => check.exit_code === 1), 'negative control must execute and reject the bad fixture');
    for (const check of done.checks) assert.equal(hash(readFileSync(join(env.root, check.log_path))), check.log_sha256);
    assert.equal(getRecord(env.root, done.workflow_id).meta.data.phase, 'completed');
    assert.equal(getRecord(env.root, done.final_report_id).meta.data.assurance, 'invocation-bound-local');
    const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === done.workflow_id && record.meta.data.epoch_id === done.epoch_id);
    assert.ok(task, 'The completed epoch needs its own bound execution task.');
    assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true, 'Public task verification must agree with controller acceptance.');
    for (const check of done.checks) {
      const evidence = getRecord(env.root, check.evidence_id);
      assert.equal(evidence.meta.type, 'evidence');
      assert.equal(evidence.meta.data.kind, 'controlled-execution-evidence');
      assert.equal(evidence.meta.data.workflow_id, done.workflow_id);
      assert.equal(evidence.meta.data.controlled_epoch_id, done.epoch_id);
      assert.equal(evidence.meta.data.task_id, task.meta.id);
      assert.equal(evidence.meta.data.execution_invocation_id, check.invocation_id);
      assert.equal(evidence.meta.data.controlled_check_id, check.id);
      assert.ok(evidence.meta.links.some(link => link.type === 'evidence-for' && link.target === check.evidence_input.check_id));
    }
    const output = safePath(env.root, planFor(name).outputs[0]), prior = readFileSync(output);
    try {
      atomicWrite(output, '2\n');
      const stale = verify(env.root, task.meta.id, 'accepted');
      assert.equal(stale.ok, false, 'An accepted flag cannot preserve evidence against changed implementation bytes.');
      assert.ok(stale.findings.some(finding => finding.code === 'controlled-acceptance'));
    } finally { atomicWrite(output, prior); }
    assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true, 'Restoring the exact bound bytes restores current acceptance.');
    const journalPath = safePath(env.root, `.neomind/controlled/workflows/${hash(done.workflow_id)}.json`), journalBytes = readFileSync(journalPath);
    const unresolved = [
      ['producer after Verifier', journal => {
        const producer = journal.attempts.find(attempt => attempt.stage === 'implementation');
        journal.attempts = [...journal.attempts.filter(attempt => attempt !== producer), producer];
      }],
      ...['starting', 'running'].map(state => [`unfinished ${state} invocation`, journal => {
        journal.attempts.push({ id: 'unresolved-attempt', request_id: 'unresolved-request', stage: 'implementation', role: 'developer', state });
      }]),
      ['unresolved command intent', journal => {
        journal.check_intents ??= [];
        journal.check_intents.push({ id: 'unresolved-check', attempt_id: journal.attempts.find(attempt => attempt.stage === 'verification').id,
          title: 'Unreconciled command', baseline: {}, state: 'running', pid: process.pid });
      }],
    ];
    for (const [reason, change] of unresolved) {
      try {
        const journal = JSON.parse(journalBytes.toString('utf8')); change(journal);
        atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
        const rejected = verify(env.root, task.meta.id, 'accepted');
        assert.equal(rejected.ok, false, `Genuine completed receipts cannot override ${reason}.`);
        assert.ok(rejected.findings.some(finding => finding.code === 'controlled-acceptance'));
      } finally { atomicWrite(journalPath, journalBytes); }
    }
    assert.deepEqual(readFileSync(journalPath), journalBytes);
    assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true, 'Exact journal restoration recovers the valid signed execution.');
    const repeated = await submit(env.root, name);
    assert.equal(repeated.workflow_id, done.workflow_id); assert.equal(repeated.attempts.length, done.attempts.length);
  }
  assert.equal(env.errors.length, 0);
});

test('product and checker defects route repairs to the correct bounded stage', async t => {
  const env = await setup(t, { product: { productFailure: true }, checker: { checkerFailure: true } });
  for (const name of ['product', 'checker']) {
    const initial = await submit(env.root, name);
    const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'repair should complete', env.errors);
    assert.equal(done.repairs, 1);
    assert.deepEqual(done.attempts.map(attempt => attempt.stage), name === 'product'
      ? ['planning', 'implementation', 'verification', 'implementation', 'verification']
      : ['planning', 'implementation', 'verification', 'verification']);
    assert.ok(done.checks.some(check => !check.passed));
    const lastVerifier = done.attempts.filter(attempt => attempt.stage === 'verification').at(-1);
    assert.ok(done.checks.filter(check => check.attempt_id === lastVerifier.id).every(check => check.passed));
  }
  assert.equal(env.errors.length, 0);
});

test('prose claims and an always-exit-zero checker cannot close a controlled workflow', async t => {
  const env = await setup(t, { falseproof: { exitZeroChecker: true } });
  const initial = await submit(env.root, 'falseproof');
  const done = await until(env.root, initial.workflow_id, run => ['blocked', 'uncertain'].includes(run.status), 'false evidence must be rejected', env.errors);
  assert.notEqual(done.status, 'completed'); assert.equal(done.final_report_id, undefined);
  assert.ok(done.checks.some(check => !check.passed));
  assert.notEqual(getRecord(env.root, initial.workflow_id).meta.data.phase, 'completed');
});

test('pause and owner restart retain checkpoint artifacts and resume the same workflow', async t => {
  const env = await setup(t, { resumed: { holdImplementation: true } });
  const initial = await submit(env.root, 'resumed');
  await until(env.root, initial.workflow_id, () => env.held.entered, 'implementation should reach the controlled pause point', env.errors);
  const paused = await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'pause' });
  assert.equal(paused.status, 'paused');
  assert.equal(readFileSync(join(env.root, 'resumed/src/value.txt'), 'utf8'), '1\n');
  assert.equal(paused.final_report_id, undefined);
  await env.restart();
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'checkpoint should resume', env.errors);
  assert.equal(done.workflow_id, initial.workflow_id);
  assert.equal(done.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.ok(done.attempts.some(attempt => attempt.state === 'interrupted'));
  assert.equal(loadRecords(env.root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
});

test('parallel workflows retain their own tasks, artifacts, reports and receipt correlations', async t => {
  const env = await setup(t, { left: {}, right: {} });
  const initial = await Promise.all([submit(env.root, 'left'), submit(env.root, 'right')]);
  assert.notEqual(initial[0].workflow_id, initial[1].workflow_id);
  const done = await Promise.all(initial.map(run => until(env.root, run.workflow_id, value => value.status === 'completed', 'parallel workflow should complete', env.errors)));
  for (const run of done) for (const attempt of run.attempts) {
    assert.equal(readInvocation(env.root, attempt.invocation_id).workflow_id, run.workflow_id);
    assert.equal(getRecord(env.root, attempt.report_id).meta.data.workflow_id, run.workflow_id);
  }
  assert.notEqual(done[0].final_report_id, done[1].final_report_id);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === done[0].workflow_id && record.meta.data.epoch_id === done[0].epoch_id);
  const journalPath = safePath(env.root, `.neomind/controlled/workflows/${hash(done[0].workflow_id)}.json`), original = readFileSync(journalPath);
  const foreign = done[1].attempts.find(attempt => attempt.stage === 'verification');
  assert.equal(readInvocation(env.root, foreign.invocation_id).state, 'completed', 'The substituted receipt is genuine and signed, not corrupt JSON.');
  try {
    const journal = JSON.parse(original.toString('utf8')), verifier = journal.attempts.find(attempt => attempt.stage === 'verification');
    verifier.invocation_id = foreign.invocation_id; verifier.request_id = foreign.request_id; verifier.report_id = foreign.report_id;
    atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
    const swapped = verify(env.root, task.meta.id, 'accepted');
    assert.equal(swapped.ok, false, 'A completed signed Verifier from another workflow/epoch cannot satisfy this task.');
    assert.ok(swapped.findings.some(finding => finding.code === 'controlled-acceptance' && /signed task, epoch, stage and request/.test(finding.message)));
  } finally { atomicWrite(journalPath, original); }
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
  assert.equal(env.errors.length, 0);
});

test('duplicate reports save once and retained late callbacks cannot alter an advanced workflow', async t => {
  const env = await setup(t, { callbacks: { holdImplementation: true } });
  const initial = await submit(env.root, 'callbacks');
  const held = await until(env.root, initial.workflow_id, () => env.held.entered, 'producer should remain active for callback replay', env.errors);
  const attempt = held.attempts.at(-1), context = ownedContext(env.root, attempt.request_id);
  assert.ok(context, 'Only the actual owned attempt supplies its private backend callback.');
  const payload = { outcome: 'completed', summary: 'implementation completed with actual scoped artifacts.',
    findings: ['Independent implementation result recorded.'], artifacts: planFor('callbacks').outputs };
  const saveReport = context.callbacks.saveReport;
  await saveReport(payload);
  const records = () => loadRecords(env.root).filter(record => record.meta.data.kind === 'controlled-work-record' && record.meta.data.invocation_id === attempt.invocation_id);
  assert.equal(records().length, 1);
  assert.deepEqual(await saveReport(payload), { saved: true, outcome: 'completed' });
  assert.equal(records().length, 1, 'A response retry must reuse its durable report.');
  await assert.rejects(async () => saveReport({ ...payload, summary: 'A different result cannot replace the saved report.' }), /already saved a different report/);
  assert.equal(records().length, 1);
  env.held.release = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'the model should finish using its already-saved identical report', env.errors);
  const journalPath = safePath(env.root, `.neomind/controlled/workflows/${hash(done.workflow_id)}.json`), before = readFileSync(journalPath), count = loadRecords(env.root).length;
  await assert.rejects(async () => saveReport(payload), /ended or changed owner/);
  assert.deepEqual(readFileSync(journalPath), before, 'A late result cannot append events or alter accepted state.');
  assert.equal(loadRecords(env.root).length, count, 'A late result cannot create another report or evidence record.');
  assert.deepEqual(env.errors, [], 'A replay must not force a model-facing protocol error and repair.');
});

test('controlled continuation creates separate execution lineage and preserves legacy task, contract and evidence bytes', async t => {
  const env = await setup(t, { legacy: { holdImplementation: true } }), fixturePlan = planFor('legacy');
  const workflow = beginWorkflow(env.root, { requirement: 'Scenario: legacy\nCreate and independently verify the requested scalar.', execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(env.root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: 'legacy-continuation-fixture', objective: 'Define the actual bounded software contract before its controlled execution continuation.' });
  const handle = openAssignment(env.root, packet.open_input).handle;
  const { risk, checks, ...semantic } = fixturePlan;
  const original = planNativeSoftware(env.root, handle, { ...semantic, process: 'software-tools',
    checks: checks.map(({ negative_controls, ...check }) => check) });
  const legacyContract = readNativeSoftwareContract(env.root, workflow.meta.id);
  const oldEvidence = createRecord(env.root, { type: 'evidence', title: 'Historical failed check retained for continuation lineage', owner: 'verifier', status: 'failed',
    links: [{ type: 'evidence-for', target: original.check_ids[0] }, { type: 'documents', target: original.task_id }],
    data: { workflow_id: workflow.meta.id, task_id: original.task_id, result: 'fail' },
    body: '# Historical observation\nNo successful verification is claimed for this legacy evidence.\n' });
  const historicalPaths = [getRecord(env.root, original.task_id).path, oldEvidence.path,
    `.neomind/native/software-workflows/${hash(workflow.meta.id)}.contract.json`];
  const historical = historicalPaths.map(path => ({ path, bytes: readFileSync(safePath(env.root, path)) }));
  await startControlledWorkflow(env.root, { workflow_id: workflow.meta.id, request_id: 'controlled-legacy-lineage-fixture' });
  const running = await until(env.root, workflow.meta.id, () => env.held.entered, 'continuation should reach its separately bound producer', env.errors);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === workflow.meta.id && record.meta.data.epoch_id === running.epoch_id);
  assert.ok(task); assert.notEqual(task.meta.id, original.task_id);
  assert.ok(task.meta.links.some(link => link.type === 'derives-from' && link.target === original.task_id));
  for (const id of legacyContract.requirement_ids) assert.ok(task.meta.links.some(link => link.type === 'satisfies' && link.target === id), id);
  for (const criterion of legacyContract.plan.acceptance_criteria) assert.ok(task.meta.data.acceptance_criteria.includes(criterion), criterion);
  assert.equal(readInvocation(env.root, running.attempts.at(-1).invocation_id).task_id, task.meta.id);
  const paused = await controlControlledWorkflow(env.root, { workflow_id: workflow.meta.id, action: 'pause' });
  assert.equal(paused.status, 'paused');
  for (const { path, bytes } of historical) assert.deepEqual(readFileSync(safePath(env.root, path)), bytes, path);
  assert.notEqual(getRecord(env.root, original.task_id).meta.status, 'accepted');
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, false, 'Lineage and an implementation artifact alone cannot accept the continuation.');
  assert.equal(env.errors.length, 0);
});

test('changing a controlled role model affects the next invocation without invalidating current receipt evidence', async t => {
  const env = await setup(t, { frozen: { holdImplementation: true } });
  const initial = await submit(env.root, 'frozen');
  const running = await until(env.root, initial.workflow_id, () => env.held.entered, 'producer should be active', env.errors);
  const old = readInvocation(env.root, running.attempts.at(-1).invocation_id);
  setRoleModel(env.root, { role: 'developer', model: 'next-worker', provider: 'fixture-worker' });
  const map = readAgentMap(env.root), current = map.nodes.find(node => node.invocation_id === old.id);
  assert.equal(current.source, 'controlled-runtime'); assert.equal(current.state, 'running');
  assert.ok(map.edges.some(edge => edge.kind === 'handoff' && edge.to === current.id && edge.source === 'controlled-runtime'));
  env.held.release = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'policy update must preserve active provenance', env.errors);
  assert.equal(readInvocation(env.root, old.id).requested_model, old.requested_model);
  assert.equal(done.status, 'completed');
});

test('completed signed verification uses one fresh record inventory and observes next-call evidence or requirement edits', async t => {
  const env = await setup(t, { metadata: {} });
  const initial = await submit(env.root, 'metadata');
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'real signed fixture must complete before authority snapshot checks', env.errors);
  for (let index = 0; index < 64; index++) {
    const at = new Date().toISOString(), meta = { schema_version: 1, id: `CONTROLLED-KNW-${9000 + index}`, type: 'knowledge', title: `Unrelated history ${index}`,
      owner: 'manager', status: 'draft', revision: 1, created_at: at, updated_at: at, links: [], data: {} };
    atomicWrite(safePath(env.root, `.neomind/records/${meta.id}.md`), `---\n${JSON.stringify(meta)}\n---\n# Independent unrelated history\n`);
  }
  const records = loadRecords(env.root), task = records.find(record => record.meta.type === 'task' && record.meta.data.epoch_id === done.epoch_id);
  assert.ok(task); assert.ok(done.checks.length >= 2);
  const contract = countRecordReads(env.root, () => controlledContractForTask(env.root, task));
  assert.equal(contract.reads, records.length); assert.equal(contract.maximum, 1);
  const accepted = countRecordReads(env.root, () => verifyControlledTask(env.root, task, 'accepted'));
  assert.equal(accepted.result.ok, true, JSON.stringify(accepted.result.findings));
  assert.equal(accepted.reads, records.length, 'All contract/report/check/evidence metadata lookups share one freshly read store.');
  assert.equal(accepted.maximum, 1);
  const rewrite = record => atomicWrite(safePath(env.root, record.path), `---\n${JSON.stringify(record.meta)}\n---\n${record.body}`);
  const requirement = getRecord(env.root, contract.result.contract.requirement_ids[0]), requirementPath = safePath(env.root, requirement.path), originalRequirement = readFileSync(requirementPath);
  try {
    requirement.body += '\nUser changed the accepted requirement after the previous call.\n'; rewrite(requirement);
    const changed = verifyControlledTask(env.root, task, 'accepted');
    assert.equal(changed.ok, false); assert.match(changed.findings[0].message, /requirement baseline changed/);
  } finally { fs.writeFileSync(requirementPath, originalRequirement); }
  assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, true);
  const evidence = getRecord(env.root, done.checks[0].evidence_id), evidencePath = safePath(env.root, evidence.path), originalEvidence = readFileSync(evidencePath);
  try {
    evidence.meta.data.result = 'fail'; rewrite(evidence);
    assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, false, 'An earlier accepted read cannot cache a passing evidence value.');
    fs.writeFileSync(evidencePath, originalEvidence); fs.unlinkSync(evidencePath);
    const deleted = verifyControlledTask(env.root, task, 'accepted'); assert.equal(deleted.ok, false); assert.match(deleted.findings[0].message, /Record not found/);
  } finally { fs.writeFileSync(evidencePath, originalEvidence); }
  const duplicate = safePath(env.root, '.neomind/records/duplicate-evidence.md');
  try {
    fs.writeFileSync(duplicate, originalEvidence);
    const changed = verifyControlledTask(env.root, task, 'accepted'); assert.equal(changed.ok, false); assert.match(changed.findings[0].message, /Duplicate record ID/);
    assert.throws(() => controlledContractForTask(env.root, task), /Duplicate record ID/);
  } finally { fs.unlinkSync(duplicate); }
  const signed = done.attempts.find(attempt => attempt.stage === 'verification'), receiptPath = safePath(env.root, `.neomind/native/receipts/${signed.invocation_id}.json`), originalReceipt = readFileSync(receiptPath);
  try {
    const receipt = JSON.parse(originalReceipt); receipt.signature = 'invalid-current-signature'; atomicWrite(receiptPath, JSON.stringify(receipt));
    assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, false, 'Signed receipt files are re-read rather than included in the metadata snapshot.');
  } finally { fs.writeFileSync(receiptPath, originalReceipt); }
  assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, true);
});
