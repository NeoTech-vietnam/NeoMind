import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initialize, createRecord } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { startNative, waitNative, shutdownNative } from '../dist/native.js';

class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }

async function fixture(t, actions, evidenceForRead = title => [{ title, passed: true, exit_code: 0 }]) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-observation-host-')));
  initialize(root, { project_id: 'OBSERVATION-HOST' });
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify({ ...ensureRoutingPolicy(root), strong_provider: 'fixture-vendor', vscode_effort_policy: 'allow-unavailable' }));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/value.txt'), 'Existing checked artifact.\n');
  const workflow = createRecord(root, { type: 'knowledge', title: 'Owned observation-loop fixture', owner: 'manager', data: { kind: 'manager-workflow', phase: 'review' } });
  const request = randomUUID(), events = [], reports = [], observedResults = [];
  let requests = 0, reads = 0;
  const binding = { workflow_id: workflow.meta.id, role: 'reviewer', stage: 'review', implementation_paths: ['src/value.txt'], verification_paths: ['checks'], read_paths: ['.'] };
  const unregister = registerControlledContext(root, request, { epoch_id: randomUUID(), binding, bindInvocation() {}, callbacks: {
    assertActive() {}, saveReport(report) { reports.push(report); return { saved: true }; },
    readEvidence(title) { return evidenceForRead(title, ++reads); }, trace(event) { events.push(event); },
  } });
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async messages => {
      const previous = messages.at(-1)?.content;
      if (Array.isArray(previous)) for (const part of previous)
        if (part instanceof Result) observedResults.push(JSON.parse(part.content[0].value));
      const round = ++requests, action = actions[round - 1] ?? { name: 'check_evidence', input: { title: 'check-A' } };
      const batch = Array.isArray(action) ? action : [action];
      return { stream: (async function* () { for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        yield item.name ? new Call(`observation-${round}-${index}`, item.name, item.input) : new Text(item.text);
      } })() };
    } }] } };
  const host = await enableVSCodeHost(api, root);
  t.after(async () => { await shutdownNative(root); await host.close(); unregister(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  let done = await startNative(root, { role: 'reviewer', prompt: 'Inspect bounded existing evidence and save an honest result.', workflow_id: workflow.meta.id, request_id: request });
  const deadline = Date.now() + 30000;
  while (['starting', 'running'].includes(done.state) && Date.now() < deadline) done = await waitNative(root, done.id, 100);
  assert.ok(!['starting', 'running'].includes(done.state), 'Owned fixture must finish without unbounded model requests.');
  return { root, done, events, reports, observedResults, requests, reads };
}
const read = title => ({ name: 'check_evidence', input: { title } });

test('owned host bounds alternating successful reads after backend notices without inventing acceptance', async t => {
  const result = await fixture(t, [read('check-A'), read('check-B'), read('check-A'), read('check-B'), read('check-A')]);
  assert.equal(result.done.state, 'blocked'); assert.match(result.done.error, /^CONTROLLED_OBSERVATION_LOOP:/);
  assert.equal(result.done.inference_completed, false);
  assert.equal(result.requests, 5); assert.equal(result.reads, 5, 'Every observation used a fresh actual read.');
  assert.equal(result.reports.length, 0, 'The host cannot manufacture a professional verdict.');
  assert.equal(result.events.filter(event => event.event === 'observation-repeat-notice').length, 2);
  assert.equal(result.events.filter(event => event.event === 'observation-loop-stopped').length, 1);
  const repeat = result.observedResults.find(packet => packet.content.length === 2);
  assert.deepEqual(JSON.parse(repeat.content[0].text), [{ title: 'check-A', passed: true, exit_code: 0 }]);
  assert.equal(JSON.parse(repeat.content[1].text).backend_observation.code, 'CONTROLLED_OBSERVATION_REPEAT');
  assert.equal(readFileSync(join(result.root, 'src/value.txt'), 'utf8'), 'Existing checked artifact.\n');
  assert.match(readInvocation(result.root, result.done.id).error, /existing protocol recovery/);
});

test('an honest blocked partial report remains savable after an unchanged-evidence notice', async t => {
  const report = { outcome: 'blocked', summary: 'The assigned evidence is readable but the independent review has an unresolved professional finding.', findings: ['Required intended-use proof is absent.'] };
  const result = await fixture(t, [read('check-A'), read('check-A'), { name: 'assignment_report', input: report }, { text: 'Saved unresolved review findings without a verdict.' }]);
  assert.equal(result.done.state, 'completed'); assert.equal(result.reads, 2); assert.equal(result.requests, 4);
  assert.deepEqual(result.reports, [report]); assert.equal(result.reports[0].verdict, undefined);
  assert.equal(result.events.some(event => event.event === 'observation-loop-stopped'), false);
});

test('a pending repeat notice does not stop other reads already in the same model response', async t => {
  const report = { outcome: 'blocked', summary: 'The reviewer needs an actual missing fact.', findings: ['No independent intended-use receipt is present.'] };
  const result = await fixture(t, [[read('check-A'), read('check-A'), read('check-A')],
    { name: 'assignment_report', input: report }, { text: 'Partial professional report saved.' }]);
  assert.equal(result.done.state, 'completed'); assert.equal(result.reads, 3); assert.equal(result.requests, 3);
  assert.deepEqual(result.reports, [report]);
  assert.equal(result.events.filter(event => event.event === 'observation-repeat-notice').length, 1);
  assert.equal(result.events.some(event => event.event === 'observation-loop-stopped'), false);
});

test('a professional report and artifacts already saved survive a later observation-loop interruption', async t => {
  const report = { outcome: 'failed', summary: 'A concrete product defect was found.', failure_kind: 'implementation', findings: ['The scalar violates its actual criterion.'] };
  const result = await fixture(t, [{ name: 'assignment_report', input: report }, read('check-A'), read('check-A'), read('check-A')]);
  assert.equal(result.done.state, 'blocked'); assert.match(result.done.error, /CONTROLLED_OBSERVATION_LOOP/);
  assert.deepEqual(result.reports, [report]);
  assert.equal(readFileSync(join(result.root, 'src/value.txt'), 'utf8'), 'Existing checked artifact.\n');
});

test('fresh changed evidence is delivered normally and can support an explicit independent failure result', async t => {
  const report = { outcome: 'completed', verdict: 'fail', summary: 'The current evidence establishes a failed requirement.', findings: ['The second fresh read records a nonzero exit.'] };
  const result = await fixture(t, [read('check-A'), read('check-A'), { name: 'assignment_report', input: report }, { text: 'Saved explicit fail verdict.' }],
    (title, count) => [{ title, passed: count === 1, exit_code: count === 1 ? 0 : 1 }]);
  assert.equal(result.done.state, 'completed'); assert.deepEqual(result.reports, [report]);
  assert.equal(result.events.some(event => event.event.startsWith('observation-')), false);
  assert.equal(result.observedResults[1].content.length, 1);
  assert.equal(JSON.parse(result.observedResults[1].content[0].text)[0].passed, false);
});
