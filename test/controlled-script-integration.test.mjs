// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite, hash, loadRecords, safePath, getRecord, updateRecord } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus, controlledRepairBudget } from '../dist/controlled-workflow.js';
import { verify } from '../dist/engineering.js';
import { controlledProducerExecutionEvidence } from '../dist/controlled-execution-evidence.js';
import { controlledAcceptanceBudget, ControlledEvidenceScanTimeout } from '../dist/controlled-acceptance.js';
import { ownedContext } from '../dist/controlled-context.js';
import { ControlledToolError } from '../dist/controlled-tools.js';

// The Bridge, signatures, MCP tools, files and child processes are real. The
// model/editor responses below are deterministic fixtures, not account inference.
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = 'source/generate.mjs', product = 'source/value.json', checker = 'checks/check.cjs', wrong = 'checks/wrong.json';
const checkerHelper = 'checks/helper.cjs', generatedWrong = 'checks/generated-negative.json';
const title = 'Generate scalar JSON';
const preparedSource = 'prepared/generator-input.json';
const preservationInput = 'preserved/input.txt', preparedPlan = 'prepared/plan.json';
const alternatePreparedSource = 'prepared/same-content-other-source.json';
const preparedInput = { values: [1, 2, 3], description: 'A real Markdown paragraph\n\nSecond paragraph.', expected_stdout: '{"value":6}\n' };
const producer = `import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
let text=''; for await(const chunk of process.stdin) text+=chunk;
const input=JSON.parse(text);
writeFileSync('${product}',JSON.stringify({value:input.values.reduce((a,b)=>a+b,0)}),{flag:'wx'});
console.log('actual producer '+randomUUID());
if(input.fail) {console.error('requested partial-output failure');process.exit(7);}
if(input.slow) setInterval(()=>{},1000);
`;
const oracle = `const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.argv.length,3,'generic checker argv must stay exact');
assert.equal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).value,6);
console.log('independent scalar verified');\n`;
const helperOracle = `const fs=require('node:fs'),assert=require('node:assert/strict');
const expected=require('./helper.cjs').expected;
assert.equal(process.argv.length,3);
assert.equal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).value,expected);
console.log('independent helper verified scalar');\n`;
const generatingOracle = `const fs=require('node:fs'),assert=require('node:assert/strict');
const negative=process.argv[2]==='--negative-control';
const path=negative?'${generatedWrong}':process.argv[2];
assert.equal(JSON.parse(fs.readFileSync(path,'utf8')).value,6);
if(!negative) fs.writeFileSync('${generatedWrong}',JSON.stringify({value:7}));
console.log('positive check created the deliberately invalid fixture');\n`;
function plan() {
  return { title: 'Bounded JSON producer', objective: 'Generate scalar six from structured input and independently reject wrong output.',
    rationale: 'Use an actual scoped project script without automatic procedure qualification.',
    acceptance_criteria: ['The generated JSON scalar is six.', 'The independent checker rejects wrong JSON.'],
    allowed_paths: ['source'], verification_paths: ['checks'], outputs: [script, product], documentation_paths: [], risk: 'low',
    execution_steps: [{ title, command: [process.execPath, script], input_paths: [], output_paths: [product], timeout_ms: 60000 }],
    checks: [{ title: 'Independent JSON check', command: [process.execPath, checker, product],
      negative_controls: [{ title: 'Reject incorrect JSON', command: [process.execPath, checker, wrong], expected_exit_code: 1 }] }] };
}
const call = (name, input = {}, capture, expectedError) => ({ name, input, capture, expectedError });
const report = (stage, extra = {}) => call('assignment_report', { outcome: 'completed', summary: `Scoped ${stage} result saved.`,
  ...(stage === 'verification' || stage === 'review' ? { verdict: 'pass' } : {}), ...extra });
function actions(stage, attempt, mode) {
  if (mode.startsWith('regeneration-')) {
    const taskInput = { title, input: { values: [1, 2, 3] } };
    if (stage === 'planning') return [call('workflow_plan', plan()), report(stage)];
    if (stage === 'implementation') {
      const code = attempt === 1 ? producer.replace('a+b,0', 'a+b+1,0') : producer;
      const legacyRejection = mode.startsWith('regeneration-resume') && attempt === 2;
      return [call('project_read', { path: script }), call('task_file_write', { path: script, content: code }),
        call('task_run', taskInput, `regenerate-${attempt}`, legacyRejection || mode === 'regeneration-external-output' && attempt > 1 ? 'INPUT_CHANGED' : undefined),
        ...(legacyRejection || mode === 'regeneration-external-output' && attempt > 1 ? [] : [call('task_run', taskInput, `regenerate-replay-${attempt}`)]),
        report(stage, legacyRejection ? { outcome: 'blocked', failure_kind: 'unknown', summary: 'The old producer replay boundary rejected an authenticated changed script with INPUT_CHANGED; outputs remain untouched.' }
          : mode === 'regeneration-external-output' && attempt > 1
          ? { outcome: 'blocked', failure_kind: 'protocol', summary: 'External output edit was preserved; regeneration was not authorized.' } : {})];
    }
    if (stage === 'verification') return [call('project_read', { path: checker }), call('task_file_write', { path: checker, content: oracle }),
      call('project_read', { path: wrong }), call('task_file_write', { path: wrong, content: '{"value":7}\n' }),
      call('check_run', {}, `regeneration-check-${attempt}`), report(stage, attempt === 1
        ? { verdict: 'fail', ...(mode.startsWith('regeneration-resume') ? {} : { failure_kind: 'implementation' }),
          summary: 'The independent oracle rejects the generated value; diagnose and repair its owning implementation.' } : {})];
    if (stage === 'diagnosis') return [report(stage, { failure_kind: 'implementation', summary: 'The checker correctly rejects the produced scalar; fix its generating implementation.' })];
  }
  if (stage === 'planning' && mode.startsWith('checker-scope-')) {
    const proposed = plan();
    if (mode === 'checker-scope-generated') proposed.checks[0].negative_controls[0].command =
      [process.execPath, checker, '--negative-control', 'generated-fixture'];
    return [call('workflow_plan', proposed), report(stage)];
  }
  if (stage === 'planning' && mode.startsWith('plan-scan-')) return [
    call('workflow_plan', mode === 'plan-scan-stale-source' ? { input_path: preparedPlan }
      : { ...plan(), preservation_paths: [preservationInput] }, 'plan-capture'), report(stage),
  ];
  if (stage === 'planning') return [call('runtime_context', {}, 'context'), call('runtime_context', {}, 'context-replay'),
    call('workflow_plan', { ...plan(), ...(mode === 'producer-evidence' ? { risk: 'elevated' } : {}) }), report(stage)];
  if (stage === 'implementation') {
    if (mode === 'optional-toolchains' && attempt === 1) return [call('runtime_context', { executables: {
      python: join(tmpdir(), 'neomind-nonexistent-context', 'python.exe'),
      c11: join(tmpdir(), 'neomind-nonexistent-context', 'gcc.exe'),
      cpp17: join(tmpdir(), 'neomind-nonexistent-context', 'g++.exe'),
    } }, 'optional-context'),
      report(stage, { outcome: 'blocked', failure_kind: 'environment',
        summary: 'Optional Python and C/C++ toolchains are missing, allegedly preventing this Node-only assignment.' })];
    const failed = mode === 'repair' && attempt === 1;
    const input = { values: failed ? [100, 2] : [1, 2, 3], ...(failed ? { fail: true } : {}),
      ...(mode === 'close' && attempt === 1 ? { slow: true } : {}) };
    const taskInput = mode === 'prepared-input' ? { title, input_path: preparedSource } : { title, input };
    const producerContent = mode === 'producer-evidence' ? `${producer}\nconsole.log('api_key="fixture-credential-123" .neomind/controlled/private.json');\n` : producer;
    return [call('project_read', { path: script }), call('task_file_write', { path: script, content: producerContent }),
      call('project_read', { path: script }),
      ...(mode === 'producer-evidence' ? [call('check_evidence', { title }, 'producer-proof-pending')] : []),
      call('task_run', taskInput, `execution-${attempt}`),
      call('task_run', taskInput, `replay-${attempt}`),
      ...(mode === 'prepared-input' ? [call('task_run', { title, input_path: alternatePreparedSource }, 'different-source-replay', 'OUTPUT_EXISTS')] : []),
      report(stage, failed ? { outcome: 'failed', failure_kind: 'implementation', findings: ['The real producer exited seven after creating its output.'] } : {})];
  }
  if (stage === 'verification' && mode === 'checker-scope-edit') return [
    call('project_read', { path: checker }), call('task_file_write', { path: checker, content: helperOracle }),
    call('project_read', { path: checkerHelper }), call('task_file_write', { path: checkerHelper, content: 'module.exports={expected:6};\n' }),
    call('project_read', { path: wrong }), call('task_file_write', { path: wrong, content: '{"value":7}\n' }),
    call('check_run', {}, 'checker-first-run'), call('check_evidence', {}, 'checker-before-edit'),
    call('project_read', { path: checkerHelper }), call('task_file_write', { path: checkerHelper, content: 'module.exports={expected:6}; // reviewed helper revision\n' }),
    call('check_evidence', {}, 'checker-after-edit'),
    call('assignment_report', { outcome: 'completed', verdict: 'pass', summary: 'An old pass must not borrow the changed checker helper.' }, 'checker-stale-report', 'INPUT_CHANGED'),
    call('check_run', {}, 'checker-fresh-run'), call('check_evidence', {}, 'checker-fresh-evidence'), report(stage),
  ];
  if (stage === 'verification' && mode === 'checker-scope-generated') return [
    call('project_read', { path: checker }), call('task_file_write', { path: checker, content: generatingOracle }),
    call('project_read', { path: generatedWrong }, 'checker-generated-before'),
    call('check_run', {}, 'checker-generated-group'), call('check_evidence', {}, 'checker-generated-evidence'), report(stage),
  ];
  if (stage === 'verification') return [...(mode === 'producer-evidence' ? [
    call('check_evidence', { title }, 'producer-proof-verifier'),
    call('check_evidence', { title: 'Not a canonical evidence selector' }, 'unknown-producer-selector', 'INVALID_CHECK'),
  ] : []), call('project_read', { path: checker }), call('task_file_write', { path: checker, content: oracle }),
    ...(mode === 'missing-check-fixture' ? [call('check_run', {}, 'missing-check-input', 'CHECK_INPUT_MISSING')] : []),
    call('project_read', { path: wrong }), call('task_file_write', { path: wrong, content: '{"value":7}\n' }), call('check_run'), report(stage)];
  if (stage === 'review') return mode === 'producer-evidence' ? [call('check_evidence', { title }, 'producer-proof-reviewer'),
    call('check_evidence', {}, 'producer-proof-all'), report(stage)] : [call('check_evidence'), report(stage)];
  if (stage === 'diagnosis' && mode === 'optional-toolchains') return [report(stage, { failure_kind: 'implementation',
    findings: ['The frozen producer and checks require only Node. Complete that assignment without inventing optional language prerequisites.'] })];
  throw new Error(`Unexpected integration fixture stage: ${stage}`);
}
async function fixture(t, mode = 'normal') {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-direct-integration-')));
  initialize(root, { project_id: 'DIRECT', name: 'Controlled direct script integration', platforms: ['copilot'], repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: policy.worker_models.map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  if (mode === 'prepared-input') for (const path of [preparedSource, alternatePreparedSource])
    atomicWrite(safePath(root, path), `${JSON.stringify(preparedInput, null, 2)}\n`);
  const conversations = new WeakMap(), counts = new Map(), captures = {}, errors = [], observed = [], progress = [];
  const scan = { injected: 0, reads: 0, retryEntered: false, releaseRetry() {} };
  if (mode.startsWith('plan-scan-')) {
    atomicWrite(safePath(root, preservationInput), 'Keep every preserved byte.\n');
    atomicWrite(safePath(root, preparedPlan), JSON.stringify({ ...plan(), preservation_paths: [preservationInput] }));
    const original = fs.promises.lstat, originalOpen = fs.openSync, target = join(root, preservationInput);
    let lockEdit = false;
    fs.openSync = function(path, ...args) {
      const descriptor = Reflect.apply(originalOpen, this, [path, ...args]);
      const normalized = String(path).replaceAll('\\', '/');
      if (mode === 'plan-scan-lock-requirement' && !lockEdit && normalized.startsWith(root.replaceAll('\\', '/') + '/.neomind/operations/') &&
          /\/controlled-plan-[a-f0-9]{32}\.lock$/.test(normalized)) {
        lockEdit = true;
        const [current] = controlledStatus(root), parent = getRecord(root, current.workflow_id), requirement = getRecord(root, parent.meta.data.requirement_id);
        updateRecord(root, requirement.meta.id, {}, requirement.body + '\nExternal edit after outer pending check, during retry lock acquisition.\n');
        captures['requirement-edited-at-claim'] = true;
      }
      return descriptor;
    };
    fs.promises.lstat = async function(path, ...args) {
      if (String(path).replaceAll('\\', '/') === target.replaceAll('\\', '/')) {
        scan.reads++;
        if (scan.injected < (mode === 'plan-scan-repeat' ? 2 : 1)) {
          scan.injected++; throw new ControlledEvidenceScanTimeout(10000);
        }
        if (mode === 'plan-scan-retry-requirement' && !captures['requirement-edited-during-retry']) {
          captures['requirement-edited-during-retry'] = true;
          const [current] = controlledStatus(root), parent = getRecord(root, current.workflow_id), requirement = getRecord(root, parent.meta.data.requirement_id);
          updateRecord(root, requirement.meta.id, {}, requirement.body + '\nExternal edit during the claimed asynchronous preservation retry.\n');
        }
        if (mode === 'plan-scan-restart' && !scan.retryEntered) {
          scan.retryEntered = true;
          await new Promise(resolve => { scan.releaseRetry = resolve; });
        }
      }
      return Reflect.apply(original, this, [path, ...args]);
    };
    syncBuiltinESMExports();
    t.after(() => { scan.releaseRetry(); fs.promises.lstat = original; fs.openSync = originalOpen; syncBuiltinESMExports(); });
  }
  const started = performance.now();
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (messages, options) => {
      let state = conversations.get(messages);
      if (!state) {
        const prompt = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const stage = /Your stage: (planning|implementation|verification|review|diagnosis)/.exec(prompt)?.[1];
        assert.ok(stage, 'backend supplies the actual stage');
        const attempt = (counts.get(stage) ?? 0) + 1; counts.set(stage, attempt);
        state = { stage, actions: actions(stage, attempt, mode), round: 0 }; conversations.set(messages, state); observed.push(stage);
        if (stage === 'implementation') {
          if (mode === 'regeneration-external-output' && attempt === 2) atomicWrite(safePath(root, product), '{"value":"USER_EDIT"}\n');
          if (mode.startsWith('regeneration-resume') && attempt === 2) {
            const [run] = controlledStatus(root), active = run.attempts.at(-1), context = ownedContext(root, active.request_id);
            assert.ok(context, 'Legacy compatibility test uses the actual bound backend context.');
            context.callbacks.runTask = () => { throw new ControlledToolError('INPUT_CHANGED', 'Local execution inputs or outputs changed after the saved result. Inspect the current artifacts before continuing.'); };
          }
          const tool = options.tools.find(tool => tool.name === 'task_run');
          const fields = Object.keys(tool?.inputSchema.properties ?? {}).sort();
          if (JSON.stringify(fields) !== JSON.stringify(['input', 'input_path', 'title'])) errors.push({ code: 'TASK_RUN_SCHEMA_MISMATCH', fields });
          assert.deepEqual(fields, ['input', 'input_path', 'title']);
        }
      }
      const prior = messages.at(-1)?.content?.[0];
      if (prior instanceof Result) {
        const response = JSON.parse(prior.content[0].value);
        if (response.isError) {
          const diagnostic = JSON.parse(response.content[0].text);
          if (state.previous?.expectedError !== diagnostic.code) { errors.push(response); throw new Error('Rejected controlled integration input.'); }
          if (state.previous.capture) captures[state.previous.capture] = diagnostic;
          if (mode === 'missing-check-fixture' && state.previous.capture === 'missing-check-input') {
            const [current] = controlledStatus(root);
            captures['before-fixture-execution-counts'] = { checks: current.checks.length, intents: current.check_intents?.length ?? 0 };
          }
        } else {
          if (state.previous?.expectedError) throw new Error('A different prepared source unexpectedly borrowed the first execution result.');
          if (state.previous?.capture) captures[state.previous.capture] = JSON.parse(response.content[0].text);
          if (state.previous?.capture === 'plan-capture') {
            const [current] = controlledStatus(root);
            captures['pending-side-effects'] = { tasks: loadRecords(root).filter(record => record.meta.type === 'task').length,
              frozen: !!current.contract_hash, environment: current.repair_budget?.environment ?? 0 };
            if (mode === 'plan-scan-stale-source') atomicWrite(safePath(root, preparedPlan), readFileSync(join(root, preparedPlan), 'utf8') + ' ');
            if (mode === 'plan-scan-stale-requirement') {
              const parent = getRecord(root, current.workflow_id), requirement = getRecord(root, parent.meta.data.requirement_id);
              updateRecord(root, requirement.meta.id, {}, requirement.body + '\nExternal requirement edit before retry.\n');
            }
          }
        }
      }
      const action = state.actions[state.round++]; state.previous = action;
      progress.push({ elapsed_ms: Math.round(performance.now() - started), stage: state.stage,
        round: state.round, tool: action?.name ?? 'final' });
      return { stream: (async function* () { yield action ? new Call(`direct-${state.round}`, action.name, action.input) : new Text('Typed scoped result persisted.'); })() };
    } }] } };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  const stop = async () => { await owner.close(); await shutdownNative(root); await bridge.close(); };
  t.after(async () => { await stop(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, captures, errors, observed, progress, started, scan, closeOwner: () => owner.close(), restart: async () => {
    await stop(); bridge = await enableVSCodeHost(api, root); owner = await startControlledHost(root);
  } };
}
function diagnosticState(env, id, run = controlledStatus(env.root, id)) {
  return { elapsed_ms: Math.round(performance.now() - env.started), status: run.status, phase: run.phase,
    revision: run.revision, repair_budget: run.repair_budget, blocker: run.blocker ? { kind: run.blocker.kind, code: run.blocker.code } : undefined,
    observed: env.observed, errors: env.errors.map(item => ({ code: item.code, isError: item.isError })),
    attempts: run.attempts.map(item => {
      let invocation;
      try {
        const native = item.invocation_id ? readInvocation(env.root, item.invocation_id) : undefined;
        if (native) invocation = { state: native.state, inference_completed: native.inference_completed,
          created_at: native.created_at, updated_at: native.updated_at, error_present: Boolean(native.error) };
      } catch { invocation = { readable: false }; }
      return { stage: item.stage, state: item.state, outcome: item.report?.outcome,
        failure_kind: item.report?.failure_kind, checked: item.checked, invocation };
    }),
    executions: (run.local_executions ?? []).map(item => ({ title: item.title, state: item.state, passed: item.passed })),
    checks: run.checks.map(item => ({ title: item.title, negative: item.negative, passed: item.passed, exit_code: item.exit_code })),
    events: run.events.slice(-12).map(item => ({ at: item.at, kind: item.kind, stage: item.stage })),
    progress: env.progress.slice(-32) };
}
async function until(env, id, predicate) {
  const deadline = Date.now() + 90000;
  do {
    const run = controlledStatus(env.root, id);
    if (predicate(run)) return run;
    if (['blocked', 'uncertain'].includes(run.status)) assert.fail(JSON.stringify(diagnosticState(env, id, run)));
    // Status verifies signed receipts and reads durable files. Polling every
    // 20ms competes with those same persistence operations on Windows.
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail(`Controlled direct script did not reach its expected durable state: ${JSON.stringify(diagnosticState(env, id))}`);
}
const savedResult = (env, entry) => JSON.parse(readFileSync(safePath(env.root, entry.result_path), 'utf8'));
const savedContract = (env, run) => JSON.parse(readFileSync(safePath(env.root,
  `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`), 'utf8'));
function producerEvidence(env, run, selected = title) {
  const budget = controlledAcceptanceBudget(env.root);
  return controlledProducerExecutionEvidence(env.root, run, savedContract(env, run), selected,
    { fingerprints: budget.fingerprints, checkBudget: budget.check });
}

test('Verifier and Reviewer read an exact producer operation through real MCP instead of receiving an empty check list', async t => {
  const env = await fixture(t, 'producer-evidence'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six, independently check it and explicitly review the actual bounded producer execution.', request_id: 'direct-producer-evidence' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []); assert.deepEqual(env.observed, ['planning', 'implementation', 'verification', 'review']);
  const pending = env.captures['producer-proof-pending'];
  assert.equal(pending.length, 1); assert.equal(pending[0].evidence_kind, 'producer-execution');
  assert.equal(pending[0].state, 'pending'); assert.equal(pending[0].passed, false);
  const operation = done.local_executions[0];
  for (const key of ['producer-proof-verifier', 'producer-proof-reviewer']) {
    const observations = env.captures[key]; assert.equal(observations.length, 1, key);
    const proof = observations[0]; assert.equal(proof.evidence_kind, 'producer-execution'); assert.equal(proof.title, title);
    assert.equal(proof.state, 'completed'); assert.equal(proof.operation_id, operation.id);
    assert.equal(proof.passed, true); assert.equal(proof.current_baseline, true); assert.equal(proof.observed_passed, true);
    assert.equal(proof.exit_code, 0); assert.match(proof.stdout, /actual producer/);
    assert.equal(proof.stdout.includes('fixture-credential-123'), false);
    assert.equal(proof.stdout.includes('.neomind/'), false);
    assert.deepEqual(proof.command, plan().execution_steps[0].command);
    assert.equal(proof.output_hashes[product], hash(readFileSync(join(env.root, product))));
    for (const field of ['intent_path', 'result_path', 'stdin', 'input', 'guarded_before', 'guarded_after'])
      assert.equal(Object.hasOwn(proof, field), false, `Private durable material is not model input: ${field}`);
  }
  assert.ok(env.captures['producer-proof-all'].some(item => item.evidence_kind === 'producer-execution'));
  assert.ok(env.captures['producer-proof-all'].some(item => item.evidence_kind === 'independent-check'));
  const unknown = env.captures['unknown-producer-selector']; assert.equal(unknown.code, 'INVALID_CHECK');
  assert.ok(JSON.stringify(unknown).includes(title), 'An unknown selector tells the caller the actual available operation.');
  const contract = savedContract(env, done); assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
  const original = readFileSync(join(env.root, product));
  try {
    atomicWrite(safePath(env.root, product), '{"value":999}\n');
    const stale = producerEvidence(env, done)[0];
    assert.equal(stale.passed, false); assert.equal(stale.current_baseline, false); assert.equal(stale.observed_passed, true);
    assert.equal(verify(env.root, contract.task_id, 'accepted').ok, false);
  } finally { atomicWrite(safePath(env.root, product), original); }
  assert.equal(producerEvidence(env, done)[0].passed, true); assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
  const originalResult = readFileSync(safePath(env.root, operation.result_path));
  try {
    atomicWrite(safePath(env.root, operation.result_path), Buffer.concat([originalResult, Buffer.from(' ')]));
    assert.throws(() => producerEvidence(env, done), /local execution result changed/);
    assert.equal(verify(env.root, contract.task_id, 'accepted').ok, false);
  } finally { atomicWrite(safePath(env.root, operation.result_path), originalResult); }
  assert.equal(producerEvidence(env, done)[0].passed, true);
});

test('bound task_run consumes JSON, replays without another effect, and passes independent positive/negative checks', async t => {
  const env = await fixture(t), initial = await startControlledWorkflow(env.root, { requirement: 'Generate JSON scalar six through the existing Node runtime and independently verify it.', request_id: 'direct-json' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []); assert.deepEqual(env.observed, ['planning', 'implementation', 'verification']);
  const context = env.captures.context;
  assert.equal(context.context, 'backend-owned-worker'); assert.equal(context.transport, 'vscode-lm');
  assert.equal(context.bridge.exact_project_owner, true); assert.equal(context.model.current_owned_tool_request_observed, true);
  assert.equal(context.guide.source, 'trusted-installed-runtime'); assert.equal(context.guide.project_private_file_read, false);
  assert.equal(context.preflight_complete, true); assert.equal(context.guide.text, undefined);
  assert.match(context.next_action, /plan/);
  assert.equal(env.captures['context-replay'].replayed, true);
  assert.equal(env.captures['context-replay'].observed_at, context.observed_at, 'Repeated facts reuse the original snapshot.');
  const node = context.toolchain.observations.find(item => item.program === 'node');
  assert.equal(node.available, true); assert.equal(node.exit_code, 0); assert.match(node.stdout, /^v\d+\./);
  assert.equal(env.captures['execution-1'].replayed, false); assert.equal(env.captures['execution-1'].passed, true);
  assert.equal(env.captures['replay-1'].replayed, true); assert.equal(env.captures['replay-1'].stdout, env.captures['execution-1'].stdout);
  assert.equal(done.local_executions.length, 1); assert.equal(savedResult(env, done.local_executions[0]).execution.input_sha256, hash(JSON.stringify({ values: [1, 2, 3] })));
  assert.deepEqual(JSON.parse(readFileSync(join(env.root, product), 'utf8')), { value: 6 });
  assert.deepEqual(done.checks.map(item => [item.negative, item.exit_code, item.passed]), [[false, 0, true], [true, 1, true]]);
  assert.deepEqual(done.checks[0].command, plan().checks[0].command);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === initial.workflow_id);
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
  for (const attempt of done.attempts) assert.equal(readInvocation(env.root, attempt.invocation_id).inference_completed, true);
});

test('a successful producer can regenerate only its unchanged owned outputs after an authenticated implementation repair', async t => {
  const env = await fixture(t, 'regeneration-repair'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six with a local producer, repair an independently found implementation error and verify the final result.', request_id: 'owned-regeneration' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []);
  assert.deepEqual(env.observed, ['planning', 'implementation', 'verification', 'implementation', 'verification']);
  assert.equal(done.local_executions.length, 2); assert.ok(done.local_executions.every(entry => entry.passed));
  assert.equal(done.local_executions[0].request_hash, done.local_executions[1].request_hash, 'Professional operation stays the same; backend revision owns new effects.');
  assert.equal(env.captures['regenerate-replay-1'].replayed, true); assert.equal(env.captures['regenerate-replay-2'].replayed, true);
  const first = savedResult(env, done.local_executions[0]), second = savedResult(env, done.local_executions[1]);
  assert.equal(first.execution.passed, true, 'The actual successful process result is never rewritten into a failed result.');
  assert.ok(second.regeneration); const archived = second.regeneration.files.find(file => file.path === product);
  assert.equal(hash(readFileSync(safePath(env.root, archived.archive_path))), first.execution.output_hashes[product]);
  assert.deepEqual(JSON.parse(readFileSync(safePath(env.root, archived.archive_path), 'utf8')), { value: 9 });
  assert.deepEqual(JSON.parse(readFileSync(safePath(env.root, product), 'utf8')), { value: 6 });
  for (const entry of done.local_executions) assert.equal(hash(readFileSync(safePath(env.root, entry.result_path))), entry.result_sha256);
  assert.equal(done.repairs, 1); assert.ok(done.checks.some(check => !check.negative && !check.passed));
  assert.ok(done.checks.slice(-2).every(check => check.passed));
  assert.equal(verify(env.root, savedContract(env, done).task_id, 'accepted').ok, true);
});

test('producer regeneration refuses an outside output edit without deleting or archiving the user bytes', async t => {
  const env = await fixture(t, 'regeneration-external-output'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six and independently verify it; preserve any external edits during a repair.', request_id: 'refuse-external-regeneration' });
  const deadline = Date.now() + 90000; let done;
  do { done = controlledStatus(env.root, initial.workflow_id); if (['blocked', 'uncertain'].includes(done.status)) break; await delay(200); } while (Date.now() < deadline);
  assert.ok(['blocked', 'uncertain'].includes(done.status));
  assert.equal(env.captures['regenerate-2'].code, 'INPUT_CHANGED');
  assert.equal(readFileSync(safePath(env.root, product), 'utf8'), '{"value":"USER_EDIT"}\n');
  assert.equal(done.local_executions.length, 1, 'No replacement operation or output removal occurs.');
  assert.equal(verify(env.root, savedContract(env, done).task_id, 'accepted').ok, false);
  assert.deepEqual(env.errors, []);
});

for (const externalEdit of [false, true]) test(`explicit resume of an already charged producer repair ${externalEdit ? 'refuses changed user output' : 'uses the same budget and completes with fresh verification'}`, async t => {
  const env = await fixture(t, externalEdit ? 'regeneration-resume-user-edit' : 'regeneration-resume'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six and independently verify it, preserving the same workflow through an authenticated producer repair.', request_id: `resume-owned-repair-${externalEdit}` });
  let stopped;const deadline=Date.now()+90000;
  do { stopped=controlledStatus(env.root,initial.workflow_id);if(stopped.status==='blocked')break;await delay(200); } while(Date.now()<deadline);
  assert.equal(stopped.status,'blocked');assert.equal(stopped.phase,'implementation');
  assert.equal(stopped.repair_budget.product,1);assert.equal(stopped.diagnosis_sources.length,1);
  const priorBytes=readFileSync(safePath(env.root,stopped.local_executions[0].result_path));
  const budget=structuredClone(stopped.repair_budget), contractBytes=readFileSync(safePath(env.root,
    `.neomind/controlled/workflows/${hash(stopped.workflow_id)}.${stopped.epoch_id}.contract.json`));
  if(externalEdit)atomicWrite(safePath(env.root,product),'{"value":"USER_EDIT"}\n');
  const resumed=await controlControlledWorkflow(env.root,{workflow_id:initial.workflow_id,action:'resume'});
  if(externalEdit){
    assert.equal(resumed.status,'blocked');assert.equal(readFileSync(safePath(env.root,product),'utf8'),'{"value":"USER_EDIT"}\n');
    assert.equal(resumed.local_executions.length,1);assert.deepEqual(resumed.repair_budget,budget);
  }else{
    const done=await until(env,initial.workflow_id,run=>run.status==='completed');
    assert.deepEqual(done.repair_budget,budget);assert.equal(done.repairs,1);
    assert.equal(done.local_executions.length,2);assert.ok(done.local_executions[1].passed);
    assert.equal(done.attempts.filter(a=>a.stage==='diagnosis').length,1);
    assert.ok(done.checks.slice(-2).every(check=>check.passed));
    assert.equal(verify(env.root,savedContract(env,done).task_id,'accepted').ok,true);
  }
  assert.deepEqual(readFileSync(safePath(env.root,stopped.local_executions[0].result_path)),priorBytes);
  assert.deepEqual(readFileSync(safePath(env.root,`.neomind/controlled/workflows/${hash(stopped.workflow_id)}.${stopped.epoch_id}.contract.json`)),contractBytes);
  assert.deepEqual(env.errors,[]);
});

test('a missing negative fixture preflights the whole group before any checker runs, then the Verifier prepares it and closes', async t => {
  const env = await fixture(t, 'missing-check-fixture'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate JSON scalar six and independently check both the correct result and a deliberately wrong fixture.',
    request_id: 'whole-check-group-preflight',
  });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []);
  assert.equal(env.captures['missing-check-input'].code, 'CHECK_INPUT_MISSING');
  assert.equal(env.captures['missing-check-input'].target_owner, 'verifier');
  assert.deepEqual(env.captures['missing-check-input'].missing_paths, [wrong]);
  assert.deepEqual(env.captures['before-fixture-execution-counts'], { checks: 0, intents: 0 });
  assert.equal(done.checks.length, 2);
  assert.deepEqual(done.checks.map(check => ({ negative: check.negative, passed: check.passed })),
    [{ negative: false, passed: true }, { negative: true, passed: true }]);
  assert.equal(done.check_intents.length, 2);
  assert.deepEqual(done.repair_budget, { schema_version: 1, product: 0, protocol: 0, environment: 0 });
  const contract = savedContract(env, done);
  assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
});

test('a changed imported checker helper invalidates old observed passes until the same prescribed group runs freshly', async t => {
  const env = await fixture(t, 'checker-scope-edit'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six and independently verify it with an imported checker helper and a deliberately wrong fixture.',
    request_id: 'checker-helper-freshness',
  });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []);
  const checks = name => env.captures[name].filter(item => item.evidence_kind === 'independent-check');
  assert.equal(checks('checker-before-edit').length, 2);
  assert.ok(checks('checker-before-edit').every(item => item.observed_passed && item.passed && item.checker_scope_current));
  assert.ok(checks('checker-after-edit').every(item => item.observed_passed === true && item.passed === false && item.checker_scope_current === false));
  assert.equal(env.captures['checker-stale-report'].code, 'INPUT_CHANGED');
  assert.ok(checks('checker-fresh-evidence').every(item => item.observed_passed && item.passed && item.checker_scope_current));
  assert.equal(done.checks.length, 4, 'Fresh positive and negative commands are retained alongside both original observations.');
  assert.equal(done.attempts.filter(item => item.stage === 'verification').length, 1);
  assert.deepEqual(done.repair_budget, { schema_version: 1, product: 0, protocol: 0, environment: 0 });
  const contract = savedContract(env, done);
  assert.ok(contract.plan.checks.every(check => !check.baseline_paths.includes(checkerHelper) &&
    check.negative_controls.every(control => !control.baseline_paths.includes(checkerHelper))), 'The helper was covered by the approved scope, without changing the frozen explicit baseline.');
  for (const [index, check] of done.checks.entries()) {
    const expected = hash(index < 2 ? 'module.exports={expected:6};\n' : 'module.exports={expected:6}; // reviewed helper revision\n');
    assert.equal(check.checker_scope.files[checkerHelper], expected);
    const bytes = readFileSync(safePath(env.root, check.log_path));
    assert.equal(hash(bytes), check.log_sha256, 'Old actual logs were never refreshed against new helper bytes.');
    assert.deepEqual(JSON.parse(bytes.toString('utf8')).checker_scope, check.checker_scope);
    assert.deepEqual(getRecord(env.root, check.evidence_id).meta.data.checker_scope, check.checker_scope);
  }
  assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
});

test('positive-generated verifier fixture is sealed after execution and the negative checker only reads it before closure', async t => {
  const env = await fixture(t, 'checker-scope-generated'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six; let its independent positive checker prepare an invalid verifier fixture, then reject it with the same checker.',
    request_id: 'checker-post-execution-seal',
  });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []);
  assert.equal(env.captures['checker-generated-before'].exists, false);
  assert.equal(done.checks.length, 2);
  assert.ok(done.checks.every(check => check.passed));
  const generated = readFileSync(join(env.root, generatedWrong)), checksum = hash(generated);
  assert.equal(JSON.parse(generated.toString('utf8')).value, 7);
  assert.equal(done.checks[0].checker_scope.files[generatedWrong], checksum, 'The positive receipt seals its newly generated fixture after the command finishes.');
  assert.deepEqual(done.checks[1].checker_scope, done.checks[0].checker_scope, 'The negative command only reads the now sealed verifier fixture.');
  const evidence = env.captures['checker-generated-evidence'].filter(item => item.evidence_kind === 'independent-check');
  assert.ok(evidence.every(check => check.observed_passed && check.passed && check.checker_scope_current));
  assert.deepEqual(done.repair_budget, { schema_version: 1, product: 0, protocol: 0, environment: 0 });
  const contract = savedContract(env, done);
  assert.ok(contract.plan.checks.every(check => !check.baseline_paths.includes(generatedWrong) &&
    check.negative_controls.every(control => !control.baseline_paths.includes(generatedWrong))));
  assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
});

test('a preservation timeout retains one professional plan and the backend retries its complete scope once before full closure', async t => {
  const env = await fixture(t, 'plan-scan-once'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate scalar six while preserving the complete existing input unchanged, then independently verify it.',
    request_id: 'plan-scan-backend-retry',
  });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []);
  assert.equal(env.captures['plan-capture'].runtime_capture_pending, true);
  assert.equal(env.captures['plan-capture'].owner, 'runtime');
  assert.deepEqual(env.captures['pending-side-effects'], { tasks: 0, frozen: false, environment: 0 });
  assert.equal(env.progress.filter(item => item.tool === 'workflow_plan').length, 1);
  assert.equal(env.scan.injected, 1);
  assert.deepEqual(done.repair_budget, { schema_version: 1, product: 0, protocol: 0, environment: 1 });
  assert.deepEqual(controlledRepairBudget({ ...done, repair_budget: undefined }), done.repair_budget,
    'Existing exact repair-event reconciliation must retain the charged environment allowance.');
  assert.equal(done.pending_plan, undefined);
  const contract = savedContract(env, done);
  assert.deepEqual(contract.plan.preservation_paths, [preservationInput]);
  assert.equal(contract.preserved_hashes[preservationInput], hash('Keep every preserved byte.\n'));
  assert.equal(loadRecords(env.root).filter(record => record.meta.type === 'task').length, 1);
  assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
});

test('a repeated preservation timeout blocks as runtime environment failure without another Planner or task identity', async t => {
  const env = await fixture(t, 'plan-scan-repeat'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Preserve all existing input bytes while generating and independently checking scalar six.', request_id: 'plan-scan-repeat',
  });
  const blocked = await until(env, initial.workflow_id, run => run.status === 'blocked');
  assert.deepEqual(env.errors, []);
  assert.equal(blocked.blocker.code, 'EVIDENCE_SCAN_TIMEOUT');
  assert.equal(blocked.blocker.kind, 'environment');
  assert.equal(blocked.blocker.owner, 'runtime');
  assert.match(blocked.blocker.next_action, /Do not resubmit.*narrow.*increase limits/);
  assert.equal(blocked.pending_plan.capture_failure.retry_started, true);
  assert.equal(blocked.contract_hash, undefined);
  assert.equal(env.scan.injected, 2);
  assert.deepEqual(blocked.repair_budget, { schema_version: 1, product: 0, protocol: 0, environment: 1 });
  assert.equal(env.progress.filter(item => item.tool === 'workflow_plan').length, 1);
  assert.equal(blocked.attempts.filter(item => item.stage === 'planning').length, 1);
  assert.equal(blocked.attempts[0].state, 'completed');
  assert.equal(loadRecords(env.root).filter(record => record.meta.type === 'task').length, 0);
});

test('parallel receipts and an owner restart cannot refund or repeat a claimed preservation retry', async t => {
  const env = await fixture(t, 'plan-scan-restart'), initial = await startControlledWorkflow(env.root, {
    requirement: 'Keep existing input bytes and generate independently checked scalar six.', request_id: 'plan-scan-restart',
  });
  const claimed = await until(env, initial.workflow_id, () => env.scan.retryEntered);
  assert.equal(claimed.pending_plan.capture_failure.retry_started, true);
  assert.equal(claimed.repair_budget.environment, 1);
  const receipts = await Promise.all([0, 1].map(() => startControlledWorkflow(env.root, { workflow_id: initial.workflow_id })));
  assert.ok(receipts.every(receipt => receipt.workflow_id === initial.workflow_id));
  const reads = env.scan.reads;
  const closing = env.closeOwner(); env.scan.releaseRetry(); await closing;
  await env.restart();
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const blocked = await until(env, initial.workflow_id, run => run.status === 'blocked');
  assert.equal(blocked.blocker.code, 'EVIDENCE_SCAN_TIMEOUT');
  assert.equal(env.scan.reads, reads, 'Restart may not start another scan after the durable allowance was claimed.');
  assert.equal(blocked.repair_budget.environment, 1);
  assert.equal(env.progress.filter(item => item.tool === 'workflow_plan').length, 1);
  assert.equal(loadRecords(env.root).filter(record => record.meta.type === 'task').length, 0);
});

for (const mode of ['plan-scan-stale-source', 'plan-scan-stale-requirement', 'plan-scan-lock-requirement', 'plan-scan-retry-requirement'])
  test(`pending capture refuses ${mode} before any task commit`, async t => {
    const env = await fixture(t, mode), initial = await startControlledWorkflow(env.root, {
      requirement: 'Preserve the requested input and independently check scalar six.', request_id: mode,
    });
    const stopped = await until(env, initial.workflow_id, run => ['uncertain', 'blocked', 'completed'].includes(run.status));
    assert.notEqual(stopped.status, 'completed', 'A changed original obligation must never be adopted by an older retained professional plan.');
    assert.deepEqual(env.errors, []);
    assert.ok(['INPUT_CHANGED', 'STATE_UNCERTAIN'].includes(stopped.blocker.code));
    assert.equal(stopped.contract_hash, undefined);
    assert.equal(stopped.repair_budget.environment, mode === 'plan-scan-retry-requirement' ? 1 : 0);
    assert.equal(env.scan.injected, 1);
    assert.equal(env.progress.filter(item => item.tool === 'workflow_plan').length, 1);
    assert.equal(loadRecords(env.root).filter(record => record.meta.type === 'task').length, 0);
    if (mode === 'plan-scan-lock-requirement') assert.equal(env.captures['requirement-edited-at-claim'], true);
    if (mode === 'plan-scan-retry-requirement') assert.equal(env.captures['requirement-edited-during-retry'], true);
  });

test('backend derives a prepared JSON read baseline without requiring planner bookkeeping or widening write scope', async t => {
  const env = await fixture(t, 'prepared-input');
  const sourceBefore = readFileSync(safePath(env.root, preparedSource)), sourceHash = hash(sourceBefore);
  const initial = await startControlledWorkflow(env.root, {
    requirement: 'Generate and independently verify scalar six from the readable prepared JSON source, preserving its exact bytes.', request_id: 'derived-prepared-input' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []); assert.deepEqual(env.observed, ['planning', 'implementation', 'verification']);
  const contract = JSON.parse(readFileSync(safePath(env.root,
    `.neomind/controlled/workflows/${hash(initial.workflow_id)}.${done.epoch_id}.contract.json`), 'utf8'));
  assert.deepEqual(contract.plan.execution_steps[0].input_paths, [], 'Immutable declarations do not acquire model-derived source bookkeeping.');
  assert.deepEqual(contract.plan.allowed_paths, ['source']); assert.deepEqual(contract.plan.verification_paths, ['checks']);
  assert.equal(contract.plan.outputs.includes(preparedSource), false);
  assert.deepEqual(readFileSync(safePath(env.root, preparedSource)), sourceBefore);
  assert.equal(done.local_executions.length, 1); assert.equal(done.local_executions[0].passed, true);
  assert.equal(env.captures['execution-1'].replayed, false); assert.equal(env.captures['replay-1'].replayed, true);
  assert.equal(env.captures['different-source-replay'].code, 'OUTPUT_EXISTS', 'Different source identity cannot borrow a prior successful result or overwrite its output.');
  const entry = done.local_executions[0], intent = JSON.parse(readFileSync(safePath(env.root, entry.intent_path), 'utf8'));
  const result = savedResult(env, entry);
  assert.deepEqual(intent.declaration.input_paths, []);
  assert.equal(intent.payload_source.path, preparedSource); assert.equal(intent.payload_source.sha256, sourceHash);
  assert.equal(intent.payload_source.size_bytes, sourceBefore.length);
  assert.deepEqual(result.payload_source, intent.payload_source);
  assert.equal(result.execution.baseline[preparedSource], sourceHash);
  assert.equal(result.execution.input_sha256, hash(JSON.stringify(preparedInput)));
  assert.deepEqual(result.execution.command, [process.execPath, script]);
  assert.deepEqual(JSON.parse(readFileSync(safePath(env.root, product), 'utf8')), { value: 6 });
  assert.deepEqual(done.checks.map(check => [check.negative, check.exit_code, check.passed]), [[false, 0, true], [true, 1, true]]);
  assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
  const statePath = safePath(env.root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.json`);
  const originalState = readFileSync(statePath), originalIntent = readFileSync(safePath(env.root, entry.intent_path));
  const originalResult = readFileSync(safePath(env.root, entry.result_path));
  for (const mutate of [
    (_intent, result) => { result.payload_source.sha256 = 'f'.repeat(64); },
    (intent, result) => { intent.payload_source.path = result.payload_source.path = alternatePreparedSource; },
    (_intent, result) => { result.execution.baseline[preparedSource] = 'f'.repeat(64); },
  ]) {
    const tamperedIntent = JSON.parse(originalIntent.toString('utf8')), tamperedResult = JSON.parse(originalResult.toString('utf8'));
    const tamperedState = JSON.parse(originalState.toString('utf8')); mutate(tamperedIntent, tamperedResult);
    const intentBytes = `${JSON.stringify(tamperedIntent, null, 2)}\n`, resultBytes = `${JSON.stringify(tamperedResult, null, 2)}\n`;
    const operation = tamperedState.local_executions.find(operation => operation.id === entry.id);
    operation.intent_sha256 = hash(intentBytes); operation.result_sha256 = hash(resultBytes);
    try {
      atomicWrite(safePath(env.root, entry.intent_path), intentBytes); atomicWrite(safePath(env.root, entry.result_path), resultBytes);
      atomicWrite(statePath, `${JSON.stringify(tamperedState, null, 2)}\n`);
      const invalid = verify(env.root, contract.task_id, 'accepted');
      assert.equal(invalid.ok, false, 'Recomputed envelope hashes cannot hide inconsistent prepared-source provenance.');
      assert.ok(invalid.findings.some(finding => /Prepared JSON source differs/.test(finding.message)));
    } finally {
      atomicWrite(safePath(env.root, entry.intent_path), originalIntent); atomicWrite(safePath(env.root, entry.result_path), originalResult);
      atomicWrite(statePath, originalState);
    }
  }
  assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
  for (const mutateSource of [
    () => atomicWrite(safePath(env.root, preparedSource), Buffer.concat([sourceBefore, Buffer.from(' \n')])),
    () => unlinkSync(safePath(env.root, preparedSource)),
  ]) {
    try {
      mutateSource();
      const stale = verify(env.root, contract.task_id, 'accepted');
      assert.equal(stale.ok, false, 'A completed execution must not silently accept edited or deleted current prepared data.');
      assert.ok(stale.findings.some(finding => /current prepared JSON source changed/.test(finding.message)));
      const observation = producerEvidence(env, done)[0];
      assert.equal(observation.passed, false); assert.equal(observation.current_baseline, false); assert.equal(observation.observed_passed, true);
    } finally { atomicWrite(safePath(env.root, preparedSource), sourceBefore); }
    assert.equal(verify(env.root, contract.task_id, 'accepted').ok, true);
    assert.equal(producerEvidence(env, done)[0].passed, true);
  }
});

test('a partial-output failure is retained and corrected structured input succeeds in the bounded repair', async t => {
  const env = await fixture(t, 'repair'), initial = await startControlledWorkflow(env.root, { requirement: 'Generate scalar six, retaining an observed producer failure before a bounded corrected-input retry.', request_id: 'direct-repair' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.deepEqual(env.errors, []); assert.equal(done.attempts.filter(item => item.stage === 'implementation').length, 2);
  assert.equal(done.local_executions.length, 2);
  const failed = savedResult(env, done.local_executions[0]), success = savedResult(env, done.local_executions[1]);
  assert.equal(failed.execution.result.exit_code, 7); assert.equal(failed.execution.passed, false);
  assert.equal(failed.execution.output_hashes[product], hash('{"value":102}'));
  assert.equal(env.captures['replay-1'].replayed, true); assert.equal(env.captures['replay-1'].exit_code, 7);
  assert.equal(success.execution.passed, true); assert.equal(env.captures['replay-2'].replayed, true);
  assert.equal(hash(readFileSync(safePath(env.root, done.local_executions[0].result_path))), done.local_executions[0].result_sha256);
  assert.deepEqual(JSON.parse(readFileSync(join(env.root, product), 'utf8')), { value: 6 });
  assert.ok(done.checks.every(item => item.passed));
  const observation = producerEvidence(env, done)[0];
  assert.equal(observation.operation_id, done.local_executions[1].id); assert.equal(observation.passed, true);
  assert.equal(hash(readFileSync(safePath(env.root, done.local_executions[0].result_path))), done.local_executions[0].result_sha256,
    'Historical failed execution remains unchanged and validated while the latest successful result is shown.');
});

test('owner close waits for cancelled direct-process persistence and the same workflow resumes with fresh execution', async t => {
  const env = await fixture(t, 'close'), initial = await startControlledWorkflow(env.root, { requirement: 'Generate and independently verify scalar six with owned direct-process cancellation.', request_id: 'direct-close' });
  await until(env, initial.workflow_id, run => run.local_executions?.some(item => item.pid) && existsSync(join(env.root, product)));
  await env.closeOwner();
  const stopped = controlledStatus(env.root, initial.workflow_id);
  assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.local_executions.length, 1);
  const entry = stopped.local_executions[0], cancelled = savedResult(env, entry);
  assert.equal(entry.state, 'completed'); assert.equal(entry.passed, false); assert.equal(cancelled.execution.result.cancelled, true);
  assert.equal(stopped.final_report_id, undefined);
  await env.restart(); await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  assert.equal(done.workflow_id, initial.workflow_id); assert.equal(done.local_executions.length, 2);
  assert.equal(done.local_executions[0].result_sha256, entry.result_sha256);
  assert.equal(savedResult(env, done.local_executions[0]).execution.result.cancelled, true);
  assert.equal(savedResult(env, done.local_executions[1]).execution.passed, true);
  assert.equal(done.attempts.filter(item => item.stage === 'planning').length, 1);
});

test('missing optional toolchains cannot charge environment repair or block a Node-only workflow', async t => {
  const previousPath = process.env.PATH;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const env = await fixture(t, 'optional-toolchains');
  // Establish the host's private transport with normal OS tools before limiting
  // the worker observation environment to the actual Node installation.
  process.env.PATH = dirname(process.execPath);
  const initial = await startControlledWorkflow(env.root, {
    requirement: 'Use only Node to generate scalar six and independently verify JSON; no Python or compiler is required.', request_id: 'node-only-optional-tools' });
  const done = await until(env, initial.workflow_id, run => run.status === 'completed');
  t.diagnostic(`Node-only optional-toolchain stage timings: ${JSON.stringify(env.progress)}`);
  assert.deepEqual(env.errors, []);
  assert.deepEqual(env.observed, ['planning', 'implementation', 'diagnosis', 'implementation', 'verification']);
  const observations = env.captures['optional-context'].toolchain.observations;
  assert.equal(env.captures['optional-context'].context, 'backend-owned-worker');
  assert.equal(env.captures['optional-context'].guide.source, 'trusted-installed-runtime');
  assert.equal(observations.find(item => item.program === 'node').available, true);
  for (const program of ['python', 'c11', 'cpp17']) {
    const observation = observations.find(item => item.program === program);
    assert.equal(observation.available, false, program);
    assert.ok(observation.rejected_candidate, `${program} retains the invalid optional-path diagnostic`);
  }
  assert.equal(done.repair_budget.environment, 0); assert.equal(done.repair_budget.product, 1);
  assert.equal(done.local_executions.length, 1); assert.equal(done.local_executions[0].passed, true);
  assert.equal(done.attempts.find(item => item.stage === 'implementation').report.failure_kind, 'environment');
  assert.ok(done.checks.every(item => item.passed));
});
