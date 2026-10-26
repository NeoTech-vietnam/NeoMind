import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite, hash, initialize, loadRecords, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';
import { verify } from '../dist/engineering.js';

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
const title = 'Generate scalar JSON';
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
function plan() {
  return { title: 'Bounded JSON producer', objective: 'Generate scalar six from structured input and independently reject wrong output.',
    rationale: 'Use an actual scoped project script without automatic procedure qualification.',
    acceptance_criteria: ['The generated JSON scalar is six.', 'The independent checker rejects wrong JSON.'],
    allowed_paths: ['source'], verification_paths: ['checks'], outputs: [script, product], documentation_paths: [], risk: 'low',
    execution_steps: [{ title, command: [process.execPath, script], input_paths: [], output_paths: [product], timeout_ms: 60000 }],
    checks: [{ title: 'Independent JSON check', command: [process.execPath, checker, product],
      negative_controls: [{ title: 'Reject incorrect JSON', command: [process.execPath, checker, wrong], expected_exit_code: 1 }] }] };
}
const call = (name, input = {}, capture) => ({ name, input, capture });
const report = (stage, extra = {}) => call('assignment_report', { outcome: 'completed', summary: `Scoped ${stage} result saved.`,
  ...(stage === 'verification' || stage === 'review' ? { verdict: 'pass' } : {}), ...extra });
function actions(stage, attempt, mode) {
  if (stage === 'planning') return [call('runtime_context', {}, 'context'), call('runtime_context', {}, 'context-replay'), call('workflow_plan', plan()), report(stage)];
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
    return [call('project_read', { path: script }), call('task_file_write', { path: script, content: producer }),
      call('project_read', { path: script }), call('task_run', { title, input }, `execution-${attempt}`),
      call('task_run', { title, input }, `replay-${attempt}`),
      report(stage, failed ? { outcome: 'failed', failure_kind: 'implementation', findings: ['The real producer exited seven after creating its output.'] } : {})];
  }
  if (stage === 'verification') return [call('project_read', { path: checker }), call('task_file_write', { path: checker, content: oracle }),
    call('project_read', { path: wrong }), call('task_file_write', { path: wrong, content: '{"value":7}\n' }), call('check_run'), report(stage)];
  if (stage === 'review') return [call('check_evidence'), report(stage)];
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
  const conversations = new WeakMap(), counts = new Map(), captures = {}, errors = [], observed = [], progress = [];
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
          const tool = options.tools.find(tool => tool.name === 'task_run');
          const fields = Object.keys(tool?.inputSchema.properties ?? {}).sort();
          if (JSON.stringify(fields) !== JSON.stringify(['input', 'title'])) errors.push({ code: 'TASK_RUN_SCHEMA_MISMATCH', fields });
          assert.deepEqual(fields, ['input', 'title']);
        }
      }
      const prior = messages.at(-1)?.content?.[0];
      if (prior instanceof Result) {
        const response = JSON.parse(prior.content[0].value);
        if (response.isError) { errors.push(response); throw new Error('Rejected controlled integration input.'); }
        if (state.previous?.capture) captures[state.previous.capture] = JSON.parse(response.content[0].text);
      }
      const action = state.actions[state.round++]; state.previous = action;
      progress.push({ elapsed_ms: Math.round(performance.now() - started), stage: state.stage,
        round: state.round, tool: action?.name ?? 'final' });
      return { stream: (async function* () { yield action ? new Call(`direct-${state.round}`, action.name, action.input) : new Text('Typed scoped result persisted.'); })() };
    } }] } };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  const stop = async () => { await owner.close(); await shutdownNative(root); await bridge.close(); };
  t.after(async () => { await stop(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, captures, errors, observed, progress, started, closeOwner: () => owner.close(), restart: async () => {
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
