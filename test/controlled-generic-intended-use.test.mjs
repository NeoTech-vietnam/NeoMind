import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialize, atomicWrite, getRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';
import { verify } from '../dist/engineering.js';
import { beginWorkflow } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment } from '../dist/assignment-runtime.js';
import { planNativeSoftware } from '../dist/native-software.js';

// Actual signed local Bridge, scoped MCP tools and Node processes; model/editor
// responses are deterministic fixtures, not real account inference evidence.
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
const product = 'source/value.txt', checker = 'checks/check.cjs', wrong = 'checks/wrong.txt';
function check(title, purpose) {
  return { title, ...(purpose ? { purpose } : {}), command: [process.execPath, checker, product],
    baseline_paths: [product, checker], timeout_ms: 10000,
    negative_controls: [{ title: `${title}: reject wrong output`, command: [process.execPath, checker, wrong],
      baseline_paths: [checker, wrong], expected_exit_code: 1 }] };
}
function plan(legacy, options = {}) {
  const pilot = { ...check('Explicit legacy pilot', 'intended-use'),
    command: [process.execPath, checker, product, '--intended-use'] };
  if (options.pilotContextCase) pilot.negative_controls[0].command = [process.execPath, checker, wrong,
    '--intended-use', '--negative-control', options.pilotContextCase];
  return { title: 'Bounded scalar intended-use evidence', objective: 'Create one scalar and independently validate its actual value.',
    rationale: 'A typed evidence purpose must not select a language-specific runtime adapter.',
    acceptance_criteria: [legacy ? 'LeetCode Cornell C11 and C++17 intended-use is independently checked.' : 'The scalar is one and wrong output fails.'],
    allowed_paths: [product], verification_paths: ['checks'], outputs: [product], documentation_paths: [], risk: 'low',
    checks: legacy ? [check('Original independent self-check'), pilot]
      : [check('Generic Node intended-use', 'intended-use')] };
}
async function setup(t, legacy, options = {}) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-generic-purpose-')));
  initialize(root, { project_id: 'GENERIC-PURPOSE', name: 'Generic purpose regression', platforms: ['copilot'], repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: policy.worker_models.map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const conversations = new WeakMap(), errors = [], observed = [];
  const api = {
    version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async messages => {
      let state = conversations.get(messages);
      if (!state) {
        const prompt = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const stage = /Your stage: (planning|implementation|verification|review)/.exec(prompt)?.[1];
        assert.ok(stage, 'runtime supplies the bound stage');
        const report = call('assignment_report', { outcome: 'completed', summary: `Independent ${stage} result retained.`,
          ...(stage === 'verification' || stage === 'review' ? { verdict: 'pass' } : {}) });
        const contents = options.pilotContextCase ? `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(process.argv.includes('--intended-use')) {
 const root=process.argv[process.argv.indexOf('--neomind-pilot-root')+1],nonce=process.argv[process.argv.indexOf('--neomind-pilot-nonce')+1];
 if(!process.argv.includes('--neomind-pilot-root')||!process.argv.includes('--neomind-pilot-nonce')||!path.isAbsolute(root)||!fs.statSync(root).isDirectory()||! /^[a-f0-9-]{36}$/.test(nonce)){console.error('missing runtime pilot context');process.exit(2);}
 console.log('runtime pilot context valid');
 if(process.argv.includes('pilot-unexpected-zero')) process.exit(0);
}
assert.equal(Number(fs.readFileSync(process.argv[2],'utf8')),1); console.log('actual scalar verified');\n`
          : legacy
          ? "const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.equal(Number(fs.readFileSync(process.argv[2],'utf8')),1); console.log('actual scalar verified');\n"
          : "const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.equal(process.argv.length,3,'declared argv must stay exact'); assert.equal(Number(fs.readFileSync(process.argv[2],'utf8')),1); console.log('actual scalar verified with exact argv');\n";
        const actions = stage === 'planning' ? [call('workflow_plan', plan(legacy, options)), report]
          : stage === 'implementation' ? [call('project_read', { path: product }), call('task_file_write', { path: product, content: '1\n' }), report]
            : stage === 'verification' ? [call('project_read', { path: checker }), call('task_file_write', { path: checker, content: contents }),
              call('project_read', { path: wrong }), call('task_file_write', { path: wrong, content: '2\n' }), call('check_run', {}), report]
              : [call('project_read', { path: checker }), report];
        state = { stage, actions, round: 0 }; conversations.set(messages, state); observed.push(stage);
      }
      const prior = messages.at(-1)?.content?.[0];
      if (prior instanceof Result) {
        const result = JSON.parse(prior.content[0].value);
        if (result.isError) { errors.push(result); throw new Error('Fixture received rejected semantic input.'); }
      }
      const action = state.actions[state.round++];
      return { stream: (async function* () {
        yield action ? new Call(`call-${state.round}`, action.name, action.input) : new Text('Scoped result saved.');
      })() };
    } }] },
  };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, observed, errors };
}
async function until(root, id, predicate, errors) {
  const deadline = Date.now() + 180000;
  do {
    const run = controlledStatus(root, id);
    if (predicate(run)) return run;
    if (run.status === 'blocked') assert.fail(JSON.stringify({ blocker: run.blocker, phase: run.phase, checks: run.checks, errors }));
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail('Workflow did not reach its expected durable observation.');
}

test('generic intended-use runs declared Node argv unchanged and closes with actual positive and negative evidence', async t => {
  const env = await setup(t, false);
  const initial = await startControlledWorkflow(env.root, { requirement: 'Create and independently verify a bounded Node scalar.', request_id: 'generic-intended-use' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', env.errors);
  assert.deepEqual(env.observed, ['planning', 'implementation', 'verification']);
  assert.equal(env.errors.length, 0);
  assert.equal(done.checks.length, 2);
  const positive = done.checks.find(item => !item.negative), negative = done.checks.find(item => item.negative);
  assert.equal(positive.purpose, 'intended-use'); assert.equal(positive.passed, true); assert.equal(positive.exit_code, 0);
  assert.deepEqual(positive.command, plan(false).checks[0].command);
  assert.equal(negative.passed, true); assert.equal(negative.exit_code, 1);
  assert.equal(positive.pilot_receipt_path, undefined);
  assert.ok(done.check_intents.every(intent => intent.pilot_root === undefined && intent.pilot_nonce === undefined));
  const log = JSON.parse(readFileSync(safePath(env.root, positive.log_path), 'utf8'));
  assert.deepEqual(log.command, log.planned_command); assert.equal(log.pilot, undefined); assert.equal(log.pilot_error, undefined);
  assert.match(log.result.stdout, /exact argv/);
  const failed = JSON.parse(readFileSync(safePath(env.root, negative.log_path), 'utf8'));
  assert.match(failed.result.stderr, /2 !== 1/);
  for (const attempt of done.attempts) {
    const receipt = readInvocation(env.root, attempt.invocation_id);
    assert.equal(receipt.issuer, 'neomind-vscode-lm'); assert.equal(receipt.inference_completed, true);
  }
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === initial.workflow_id);
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
});

test('explicit LeetCode continuation still requires runtime pilot proof even when its Node checker exits zero', async t => {
  const env = await setup(t, true), proposed = plan(true);
  const workflow = beginWorkflow(env.root, { requirement: 'Deliver LeetCode Cornell C11 and C++17 intended-use validation.', execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(env.root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: 'legacy-pilot-proof-fixture', objective: 'Retain a bounded original LeetCode intended-use contract.' });
  const handle = openAssignment(env.root, packet.open_input).handle;
  const { risk, checks, ...semantic } = proposed;
  planNativeSoftware(env.root, handle, { ...semantic, process: 'software-tools',
    checks: [(({ negative_controls, ...original }) => original)(checks[0])] });
  await startControlledWorkflow(env.root, { workflow_id: workflow.meta.id, request_id: 'legacy-required-pilot' });
  const run = await until(env.root, workflow.meta.id, current => current.checks.some(item => item.purpose === 'intended-use' && !item.negative), env.errors);
  const pilot = run.checks.find(item => item.purpose === 'intended-use' && !item.negative);
  assert.equal(pilot.exit_code, 0); assert.equal(pilot.passed, false); assert.equal(pilot.pilot_receipt_path, undefined);
  assert.ok(pilot.command.includes('--neomind-pilot-root')); assert.ok(pilot.command.includes('--neomind-pilot-nonce'));
  const log = JSON.parse(readFileSync(safePath(env.root, pilot.log_path), 'utf8'));
  assert.match(log.pilot_error, /intended-use pilot did not produce/);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === run.epoch_id);
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, false);
  assert.notEqual(getRecord(env.root, task.meta.id).meta.status, 'accepted');
});

async function contextContinuation(env, contextCase) {
  const proposed = plan(true, { pilotContextCase: contextCase });
  const workflow = beginWorkflow(env.root, { requirement: 'Deliver LeetCode Cornell C11 and C++17 intended-use validation.', execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(env.root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: `legacy-${contextCase}`, objective: 'Preserve the original checked self-test before the isolated intended-use pilot.' });
  const handle = openAssignment(env.root, packet.open_input).handle;
  const { risk, checks, ...semantic } = proposed;
  planNativeSoftware(env.root, handle, { ...semantic, process: 'software-tools',
    checks: [(({ negative_controls, ...original }) => original)(checks[0])] });
  await startControlledWorkflow(env.root, { workflow_id: workflow.meta.id });
  const title = proposed.checks[1].negative_controls[0].title;
  const run = await until(env.root, workflow.meta.id, current => current.checks.some(item => item.negative && item.title === title), env.errors);
  return { proposed, run, negative: run.checks.find(item => item.negative && item.title === title),
    positive: run.checks.find(item => !item.negative && item.purpose === 'intended-use') };
}

test('associated intended-use negative gets server pilot context and rejects wrong output rather than missing context', async t => {
  const env = await setup(t, true, { pilotContextCase: 'pilot-wrong-result' });
  const { proposed, run, positive, negative } = await contextContinuation(env, 'pilot-wrong-result');
  assert.equal(negative.exit_code, 1, 'The independent checker must reject actual wrong output, not exit two for missing backend context.');
  assert.equal(negative.passed, true);
  assert.deepEqual(negative.planned_command, proposed.checks[1].negative_controls[0].command);
  assert.ok(negative.command.includes('--neomind-pilot-root'));
  assert.ok(negative.command.includes('--neomind-pilot-nonce'));
  const log = JSON.parse(readFileSync(safePath(env.root, negative.log_path), 'utf8'));
  assert.match(log.result.stdout, /runtime pilot context valid/);
  assert.match(log.result.stderr, /2 !== 1/);
  assert.doesNotMatch(log.result.stderr, /missing runtime pilot context/);
  assert.equal(log.pilot, undefined); assert.equal(log.pilot_error, undefined);
  assert.equal(negative.pilot_receipt_path, undefined);
  const positiveIntent = run.check_intents.find(intent => intent.id === positive.id), negativeIntent = run.check_intents.find(intent => intent.id === negative.id);
  assert.ok(positiveIntent.pilot_root && negativeIntent.pilot_root);
  assert.notEqual(positiveIntent.pilot_root, negativeIntent.pilot_root);
  assert.notEqual(positiveIntent.pilot_nonce, negativeIntent.pilot_nonce);
  assert.equal(positive.exit_code, 0); assert.equal(positive.passed, false, 'Valid context and exit zero still require independent canonical pilot proof.');
  assert.equal(positive.pilot_receipt_path, undefined);
  assert.notEqual(run.status, 'completed');
});

test('an unexpected zero from a negative pilot never creates positive proof or claims a passing negative control', async t => {
  const env = await setup(t, true, { pilotContextCase: 'pilot-unexpected-zero' });
  const { negative } = await contextContinuation(env, 'pilot-unexpected-zero');
  assert.equal(negative.exit_code, 0);
  assert.equal(negative.passed, false);
  assert.equal(negative.pilot_receipt_path, undefined);
  const log = JSON.parse(readFileSync(safePath(env.root, negative.log_path), 'utf8'));
  assert.match(log.result.stdout, /runtime pilot context valid/);
  assert.equal(log.pilot, undefined); assert.equal(log.pilot_error, undefined,
    'Negative commands must never invoke the positive-only canonical pilot collector.');
});
