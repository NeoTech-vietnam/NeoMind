// Real domain/command evidence with synthetic native professional outcomes.
// These are not desktop/provider acceptance tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as domain from '../dist/native-request.js';
import { nativeLocalRequestSchema, nativeWorkerProfiles } from '../dist/native-local-contract.js';
import { initialize, loadRecords, getRecord, requestFolderForWorkflow } from '../dist/storage.js';
const { createLocalRequestRunner } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/local-request.cjs');
const compiler = process.platform === 'win32' ? 'C:/msys64/mingw64/bin/gcc.exe' : '/usr/bin/gcc';
const pass = { summary: 'The assigned current product has been inspected.', verdict: 'pass', findings: [] };

function fixture(t, kind, { failDiagnostic = false, unresolved = false, legacyFirst = false, waitDiagnostic = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-evidence-first-'));
  initialize(root, { project_id: 'WF-EVIDENCE-FIRST', repair_attempts: 1 });
  let runner, implementations = 0, reviewers = 0, testers = 0;
  const calls = [], retained = [];
  t.after(async () => { await runner?.dispose(); rmSync(root, { recursive: true, force: true }); });
  const executable = process.platform === 'win32' ? 'app.exe' : 'app';
  const output = kind === 'node' ? 'product.txt' : 'main.c';
  if (kind === 'node') writeFileSync(join(root, 'check.cjs'),
    "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('product.txt','utf8'),'hello');" +
    "const p='.workforce/diagnostic-count';fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1));console.log('ACTUAL_HOST_CHECK_PASSED');\n" +
    (waitDiagnostic ? 'setInterval(()=>{},1000);\n' : ''));
  const plan = { summary: 'Deliver a product and run committed checks directly.', requirements: ['The product satisfies the exact hello contract.'],
    design: 'Use existing Node or native C tools without shell wrappers.', outputs: [output], checks: kind === 'node'
      ? [{ title: 'Actual Node assertion', level: 'acceptance', command: [process.execPath, 'check.cjs'] }]
      : [{ title: 'Actual GCC compilation', level: 'integration', command: [compiler, '-std=c11', 'main.c', '-o', executable] },
        { title: 'Actual generated executable', level: 'acceptance', command: [join(root, executable)] }] };
  const host = { CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }, lm: { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['agentName', 'prompt', 'description'],
    properties: Object.fromEntries(['agentName', 'prompt', 'description'].map(key => [key, { type: 'string' }])) } }],
    async invokeTool(_name, { input }) {
      const role = input.agentName.replace(/ Worker$/, ''); calls.push(role);
      let professional = pass;
      if (role === 'WF.FnD') {
        implementations++;
        const wrong = implementations === 1 || failDiagnostic;
        writeFileSync(join(root, output), kind === 'node' ? wrong ? 'wrong' : 'hello'
          : wrong ? 'int main(void){return 1;}\n' : '#include <stdio.h>\nint main(void){puts("hello");return 0;}\n');
        if (implementations === 1) professional = { summary: 'Implementation requires the configured repair.', verdict: 'findings', findings: ['The hello behavior is incomplete.'] };
      } else if (role === 'WF.Reviewer') reviewers++;
      else {
        testers++;
        if (testers > 1) {
          assert.match(input.prompt, /native\/checks\/[^\s"]+\.log/, 'Fresh Tester receives retained actual host check evidence');
          const owner = loadRecords(root).find(record => record.meta.data.kind === 'workforce-request');
          const state = domain.getNativeRequest(root, owner.meta.id);
          assert.ok(state.checks.every(check => check.state === 'passed' && check.result?.exit_code === 0));
          for (const check of state.checks) retained.push({ path: check.log_path, bytes: readFileSync(join(root, check.log_path)), execution_id: check.execution_id });
        }
        if (testers === 1 || unresolved) professional = { summary: 'The native terminal environment differs from the host execution environment.',
          verdict: 'findings', findings: ['Native terminal PATH cannot establish the required tool execution; inspect actual committed host evidence.'] };
      }
      return { content: [{ value: JSON.stringify(professional) }] };
    },
  } };
  const create = legacy => createLocalRequestRunner(host, { ...domain, nativeLocalRequestSchema, nativeWorkerProfiles,
    ...(legacy ? { reassessNativeTesterFindings: undefined } : {}) }, root);
  runner = create(legacyFirst);
  return { root, runner, plan, calls, retained, counts: () => ({ implementations, reviewers, testers }),
    async restart() { await runner.dispose(); runner = create(false); return runner; } };
}

for (const kind of ['node', 'gcc']) test(`evidence-first ${kind} checks resolve a Tester environment finding after code repair budget is spent`,
  { skip: kind === 'gcc' && !existsSync(compiler), timeout: 180000 }, async t => {
    const work = fixture(t, kind), result = await work.runner.run({ requirement: 'Deliver the checked hello product.', plan: work.plan }, {});
    assert.equal(result.request.accepted, true, 'Actual host evidence must reach a fresh Tester instead of stopping before committed checks');
    assert.equal(result.error, undefined);
    assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 2 });
    const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
    const saved = domain.getNativeRequest(work.root, owner.meta.id);
    assert.equal(saved.repair_attempts, 1, 'Evidence reassessment does not reset or spend the existing implementation allowance');
    assert.equal(saved.assignments.filter(job => job.agentName === 'WF.Tester')[0].state, 'findings');
    assert.equal(getRecord(work.root, saved.assignments.filter(job => job.agentName === 'WF.Tester')[0].report_record_id).meta.status, 'draft');
    assert.ok(saved.checks.every(check => check.state === 'passed'));
    for (const retained of work.retained) {
      assert.deepEqual(readFileSync(join(work.root, retained.path)), retained.bytes);
      assert.ok(saved.checks.some(check => check.execution_id === retained.execution_id), 'Valid actual diagnostic evidence is reused without another execution');
    }
    if (kind === 'node') assert.equal(readFileSync(join(work.root, '.workforce/diagnostic-count'), 'utf8'), '1');
  });

test('failed diagnostic host checks retain real failure without waiving Tester findings or adding model calls', async t => {
  const work = fixture(t, 'node', { failDiagnostic: true });
  const result = await work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {});
  assert.equal(result.request.accepted, false);
  const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
  const state = domain.getNativeRequest(work.root, owner.meta.id);
  assert.equal(state.checks[0].state, 'failed'); assert.notEqual(state.checks[0].result.exit_code, 0);
  assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 1 });
  assert.equal(state.assignments.at(-1).state, 'findings');
});

test('passing diagnostic evidence never waives unresolved fresh Tester findings or repeats the same evidence epoch', async t => {
  const work = fixture(t, 'node', { unresolved: true });
  const result = await work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {});
  assert.equal(result.request.accepted, false);
  assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 2 });
  const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
  const state = domain.getNativeRequest(work.root, owner.meta.id);
  assert.equal(state.assignments.at(-1).state, 'findings');
  assert.equal(state.final_report_id, undefined);
  assert.equal(readFileSync(join(work.root, '.workforce/diagnostic-count'), 'utf8'), '1');
});

test('a saved findings request resumes through joined and lost-ack host evidence before any generic FnD budget reset', { timeout: 180000 }, async t => {
  const work = fixture(t, 'node', { legacyFirst: true });
  assert.equal((await work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {})).request.accepted, false);
  const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
  const previous = domain.getNativeRequest(work.root, owner.meta.id), oldTester = previous.assignments.at(-1);
  assert.equal(previous.repair_attempts, 1);
  await assert.rejects(domain.runNativeChecks(work.root, owner.meta.id, { purpose: 'tester-diagnostic' }), /Current independent/,
    'A diagnostic purpose without the backend-owned intent cannot bypass the normal gate');
  const first = domain.reassessNativeTesterFindings(work.root, owner.meta.id);
  const duplicate = domain.reassessNativeTesterFindings(work.root, owner.meta.id);
  assert.equal(first, duplicate, 'Concurrent acknowledgements join the actual owned diagnostic operation');
  const [ready, same] = await Promise.all([first, duplicate]);
  assert.equal(ready.outcome, 'tester'); assert.equal(same.outcome, 'tester');
  const count = loadRecords(work.root).length, execution = ready.state.checks[0].execution_id;
  const replay = await domain.reassessNativeTesterFindings(work.root, owner.meta.id);
  assert.equal(replay.outcome, 'tester');
  assert.equal(replay.state.checks[0].execution_id, execution);
  assert.equal(loadRecords(work.root).length, count);
  const runner = await work.restart(), result = await runner.resume(owner.meta.id, {});
  assert.equal(result.request.accepted, true);
  const saved = domain.getNativeRequest(work.root, owner.meta.id);
  assert.equal(saved.repair_attempts, 1);
  assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 2 });
  assert.equal(readFileSync(join(work.root, '.workforce/diagnostic-count'), 'utf8'), '1');
  assert.equal(loadRecords(work.root).filter(record => record.meta.data.kind === 'workforce-request').length, 1);
  const late = { request_ref: owner.meta.id, assignment_ref: oldTester.assignment_ref, invocation: oldTester.invocation, raw_result: oldTester.raw_text };
  assert.equal(domain.recordNativeResult(work.root, late).accepted, true, 'A duplicate old callback preserves current accepted evidence');
  assert.throws(() => domain.recordNativeResult(work.root, { ...late, raw_result: JSON.stringify(pass) }), /different retained outcome/);
  assert.equal(domain.getNativeRequest(work.root, owner.meta.id).tester_evidence.status, 'completed');
});

for (const kind of ['log', 'generated-executable']) test(`changed diagnostic ${kind} prevents fresh Tester delegation and acceptance`,
  { skip: kind === 'generated-executable' && !existsSync(compiler), timeout: 180000 }, async t => {
    const work = fixture(t, kind === 'log' ? 'node' : 'gcc', { legacyFirst: true });
    await work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {});
    const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
    const prepared = await domain.reassessNativeTesterFindings(work.root, owner.meta.id);
    assert.equal(prepared.outcome, 'tester');
    const path = kind === 'log' ? prepared.state.checks[0].log_path : process.platform === 'win32' ? 'app.exe' : 'app';
    writeFileSync(join(work.root, path), 'Concurrent changed evidence');
    assert.equal(domain.nextNativeAssignment(work.root, owner.meta.id), undefined);
    const state = domain.getNativeRequest(work.root, owner.meta.id);
    assert.equal(state.status, 'uncertain'); assert.equal(state.accepted, false);
    assert.equal(state.tester_evidence.status, 'uncertain');
    assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 1 });
    assert.equal(readFileSync(join(work.root, path), 'utf8'), 'Concurrent changed evidence');
    const count = loadRecords(work.root).length;
    assert.notEqual((await domain.reassessNativeTesterFindings(work.root, owner.meta.id)).outcome, 'tester');
    assert.equal(loadRecords(work.root).length, count, 'Changed evidence is not silently replaced with another diagnostic run');
  });

test('a changed checker invalidates the actual inspection tuple before diagnostic execution', async t => {
  const work = fixture(t, 'node', { legacyFirst: true });
  await work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {});
  const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
  writeFileSync(join(work.root, 'check.cjs'), 'process.exit(0); // user changed the checker\n');
  const result = await domain.reassessNativeTesterFindings(work.root, owner.meta.id);
  assert.equal(result.outcome, 'unchanged');
  assert.equal(existsSync(join(work.root, '.workforce/diagnostic-count')), false);
  assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 1 });
});

test('closing the runner aborts and drains a real diagnostic checker without dispatching another Tester', { timeout: 90000 }, async t => {
  const work = fixture(t, 'node', { waitDiagnostic: true });
  const run = work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {});
  const started = (async () => {
    const deadline = Date.now() + 40000;
    while (!existsSync(join(work.root, '.workforce/diagnostic-count'))) {
      assert.ok(Date.now() < deadline, 'The actual diagnostic child did not start within the fixture bound');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  await Promise.race([started, run.then(() => assert.fail('The request ended before its diagnostic process started'))]);
  await work.runner.dispose();
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.category, 'cancellation');
  assert.equal(result.request.accepted, false);
  const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
  const state = domain.getNativeRequest(work.root, owner.meta.id);
  assert.equal(state.checks[0].result.cancelled, true);
  assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 1 });
});

test('an unknown saved check checkpoint persists uncertainty without repeating a command or model', async t => {
  const work = fixture(t, 'node', { legacyFirst: true });
  await work.runner.run({ requirement: 'Deliver exact hello.', plan: work.plan }, {});
  const owner = loadRecords(work.root).find(record => record.meta.data.kind === 'workforce-request');
  const folder = requestFolderForWorkflow(work.root, owner.meta.id).directory;
  const path = join(work.root, '.workforce', folder, 'native/execution.json');
  const interrupted = JSON.parse(readFileSync(path, 'utf8')), executionId = randomUUID();
  // A host restart retained the committed operation identity but no actual
  // process outcome. The fixture claims neither a live process nor completion.
  interrupted.checks[0].execution_id = executionId;
  interrupted.checks[0].state = 'running';
  delete interrupted.checks[0].result;
  writeFileSync(path, JSON.stringify(interrupted, null, 2) + '\n');
  const result = await domain.reassessNativeTesterFindings(work.root, owner.meta.id);
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.code, 'CHECK_EFFECTS_UNCONFIRMED');
  assert.equal(result.state.status, 'uncertain');
  const saved = domain.getNativeRequest(work.root, owner.meta.id);
  assert.equal(saved.historical_status, 'uncertain', 'The result is durable, not just a returned diagnostic label');
  assert.equal(saved.checks[0].state, 'uncertain');
  assert.equal(saved.checks[0].execution_id, executionId);
  assert.equal(saved.checks[0].result, undefined);
  assert.equal(existsSync(join(work.root, '.workforce/diagnostic-count')), false);
  assert.deepEqual(work.counts(), { implementations: 2, reviewers: 1, testers: 1 });
});
