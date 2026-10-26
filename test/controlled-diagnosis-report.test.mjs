import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer, controlledInstructions } from '../dist/controlled-tools.js';
import { researchFixture } from './cornell-research-fixture.mjs';

async function fixture(t, extra = {}) {
  const a = researchFixture(t), received = [], traces = [];
  mkdirSync(join(a.root, 'reports'), { recursive: true });
  const binding = { workflow_id: a.workflow.meta.id, invocation_id: 'actual-diagnosis-report-test', stage: 'diagnosis', role: 'manager',
    implementation_paths: ['docs'], verification_paths: ['checks'], read_paths: ['reports'], execution_steps: [], procedure_bound: false,
    cornell_bound: false, ...extra };
  const server = createControlledMcpServer(a.root, binding, { assertActive() {},
    saveReport(value, source) { received.push({ value, source }); return { saved: true }; }, trace(event) { traces.push(event); } });
  const client = new Client({ name: 'diagnosis-report-tests', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { ...a, binding, received, traces, client, call: arguments_ => client.callTool({ name: 'assignment_report', arguments: arguments_ }),
    prepared(name, value) { const path = `reports/${name}.json`; writeFileSync(join(a.root, path), JSON.stringify(value)); return { input_path: path }; } };
}

test('real diagnosis advertises and requires a completed professional failure_kind without inventing a cause', async t => {
  const a = await fixture(t), advertised = (await a.client.listTools()).tools.find(tool => tool.name === 'assignment_report');
  const schema = advertised.inputSchema;
  assert.ok(schema.allOf?.some(condition => condition.if?.properties?.outcome?.const === 'completed' &&
    condition.if.required?.includes('outcome') && condition.then?.required?.includes('failure_kind')));
  assert.deepEqual(schema.properties.failure_kind.enum, ['implementation','checker','protocol','environment','unknown']);
  assert.match(advertised.description, /completed manager diagnosis.*failure_kind/);
  assert.match(controlledInstructions(a.binding), /top-level failure_kind/);
  const missing = { outcome: 'completed', summary: 'Diagnosis is complete but the professional cause was not classified.' };
  for (const args of [missing, a.prepared('missing', missing)]) assert.equal((await a.call(args)).isError, true);
  assert.equal(a.received.length, 0);
  const uncertain = { ...missing, failure_kind: 'unknown' };
  assert.equal((await a.call(uncertain)).isError, undefined); assert.equal(a.received[0].value.failure_kind, 'unknown');
});

test('a precise anchored finding is canonicalized before completed diagnosis validation in direct and prepared forms', async t => {
  const a = await fixture(t), report = { outcome: 'completed', summary: 'The completed diagnosis identifies a checker defect.',
    findings: ['failure_kind: checker. The independently inspected checker assumes an output that the frozen contract never promised.'] };
  const original = structuredClone(report);
  assert.equal((await a.call(report)).isError, undefined);
  assert.equal((await a.call(a.prepared('anchored', report))).isError, undefined);
  assert.deepEqual(report, original, 'The model report object and saved source are not rewritten.');
  assert.ok(a.received.every(item => item.value.failure_kind === 'checker'));
  assert.ok(a.received.every(item => !Object.hasOwn(item.value, 'verdict')));
  const payload = a.traces.filter(event => event.event === 'payload-resolved');
  assert.ok(payload.every(event => event.backend_input.semantic.failure_kind === 'checker'), 'Backend trace records the normalized field; host raw model trace remains separate.');
  assert.ok(a.received[1].source?.sha256, 'Prepared source provenance stays bound to its actual unchanged bytes.');
});

test('classification never guesses from summary text, embedded phrases, malformed markers or conflicting enums', async t => {
  const a = await fixture(t);
  const base = { outcome: 'completed', summary: 'Chẩn đoán failure_kind=checker remains prose without a structured marker.' };
  for (const value of [base, { ...base, findings: ['The conclusion is failure_kind: checker. This embedded prose is not an anchored marker.'] },
    { ...base, findings: ['failure_kind: checkers. A prefix must not be treated as a valid enum.'] },
    { ...base, findings: ['failure_kind: checker. First cause.', 'failure_kind: implementation. Different cause.'] },
    { ...base, failure_kind: 'environment', findings: ['failure_kind: checker. Explicit field conflicts.'] }]) {
    assert.equal((await a.call(value)).isError, true);
    assert.equal((await a.call(a.prepared(`bad-${a.traces.length}`, value))).isError, true);
  }
  assert.equal(a.received.length, 0);
});

test('incomplete diagnosis and specialist consultation do not acquire a mandatory manager classification gate', async t => {
  const a = await fixture(t);
  for (const outcome of ['blocked','failed']) assert.equal((await a.call({ outcome, summary: 'Useful partial observations remain retained without a completed diagnosis.',
    findings: ['failure_kind: checker. A provisional possibility.', 'failure_kind: unknown. The incomplete investigation has not decided.'] })).isError, undefined);
  assert.ok(a.received.every(item => !Object.hasOwn(item.value, 'failure_kind')));
  const specialist = await fixture(t, { role: 'architect' }), planning = await fixture(t, { stage: 'planning' });
  for (const actor of [specialist, planning]) {
    const schema = (await actor.client.listTools()).tools.find(tool => tool.name === 'assignment_report').inputSchema;
    assert.equal(schema.allOf?.some(condition => condition.then?.required?.includes('failure_kind')) ?? false, false);
    assert.equal((await actor.call({ outcome: 'completed', summary: 'A bounded professional consultation result, not the actual manager diagnosis.' })).isError, undefined);
    assert.equal(Object.hasOwn(actor.received[0].value, 'failure_kind'), false);
  }
});

test('read-only saved-report classification preserves historical bytes and rejects ambiguity', async () => {
  const { classifyControlledDiagnosisReport: classify } = await import('../dist/controlled-report-normalization.js');
  const report = { outcome: 'completed', summary: 'Chẩn đoán failure_kind=checker', findings: [
    'failure_kind: checker. The concrete independent checker mismatch is documented here.', 'Other professional observations remain untouched.' ] };
  const before = JSON.stringify(report);
  assert.deepEqual(classify(report), { failure_kind: 'checker', source: 'anchored-finding', index: 0 });
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(classify({ ...report, failure_kind: 'checker' }), { failure_kind: 'checker', source: 'explicit-field' });
  assert.equal(classify({ summary: 'failure_kind=checker' }), undefined);
  assert.equal(classify({ findings: ['An embedded failure_kind: checker. is not a declared marker.'] }), undefined);
  assert.throws(() => classify({ ...report, failure_kind: 'implementation' }), /conflict/);
  assert.throws(() => classify({ findings: ['failure_kind: checker. First.', 'failure_kind: unknown. Second.'] }), /conflict/);
});
