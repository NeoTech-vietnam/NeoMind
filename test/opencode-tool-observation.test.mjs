import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeToolFailureGuard } from '../dist/opencode-tool-observation.js';
const sid = 'ses_offline';
const read = { path: 'source.txt', start_line: 2, start_char: 10 };
let sequence = 0;
const part = (call, status, input = read, tool = 'wf_project_read', error = 'Choose one nondefault cursor.') => ({
  id: `${call}-${status}-${++sequence}`, type: 'message.part.updated', properties: { sessionID: sid,
    part: { type: 'tool', callID: call, tool, state: { status, input, ...(status === 'error' ? { error } : { output: 'done' }) } } },
});
const next = (call, type, properties = {}) => ({ id: `${call}-${type}`, type: `session.next.tool.${type}`,
  properties: { sessionID: sid, callID: call, ...properties } });

test('actual pinned legacy tool parts stop two unchanged failures and ignore event redelivery', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read']);
  assert.equal(guard.observe(part('call1', 'error')).repeated_failures, 1);
  assert.equal(guard.observe(part('call1', 'error')), undefined, 'same call cannot be charged twice');
  const second = guard.observe(part('call2', 'error'));
  assert.equal(second.repeated_failures, 2); assert.equal(second.halt, true);
  assert.doesNotMatch(JSON.stringify(second), /source.txt|Choose one/);
});

test('pinned next tool events retain actual input and deduplicate their legacy terminal mirror', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read']);
  guard.observe(next('call1', 'called', { tool: 'wf_project_read', input: read }));
  assert.equal(guard.observe(next('call1', 'failed', { error: { name: 'UnknownError', data: { message: 'bad range' } } })).repeated_failures, 1);
  assert.equal(guard.observe(part('call1', 'error', read, 'wf_project_read', 'bad range')), undefined);
  guard.observe(next('call2', 'called', { tool: 'wf_project_read', input: read }));
  assert.equal(guard.observe(next('call2', 'failed', { error: { name: 'UnknownError', data: { message: 'bad range' } } })).halt, true);
});

test('successful reads, timestamps and committed writes cannot erase the same protocol error within its owned session', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read', 'task_file_write']);
  assert.equal(guard.observe(part('call1', 'error')).repeated_failures, 1);
  guard.observe(part('read2', 'completed', { path: 'other.txt' }));
  const write = part('write1', 'completed', { path: 'result.txt', content: 'updated' }, 'wf_task_file_write');
  write.properties.part.state.output = JSON.stringify({ path: 'result.txt', saved: true, replayed: false, sha256: 'a'.repeat(64), previous_sha256: 'b'.repeat(64) });
  guard.observe(write);
  assert.equal(guard.observe(part('call2', 'error')).halt, true);
});

test('three identical successful read responses ignore metadata and duplicate events, but a real new artifact resets only the read counter', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read', 'task_file_write']);
  const read = (id, time, content = 'unchanged') => {
    const event = part(id, 'completed', { path: 'result.txt' });
    event.properties.part.state.output = JSON.stringify({ path: 'result.txt', text: content, observed_at: time }); return event;
  };
  assert.equal(guard.observe(read('read1', 'one')).repeated_observations, 1);
  assert.equal(guard.observe(read('read1', 'two')), undefined);
  assert.equal(guard.observe(read('read2', 'two')).repeated_observations, 2);
  const write = part('write1', 'completed', { path: 'result.txt', content: 'actual new product' }, 'wf_task_file_write');
  write.properties.part.state.output = JSON.stringify({ path: 'result.txt', saved: true, replayed: false, sha256: 'a'.repeat(64), previous_sha256: 'b'.repeat(64) });
  guard.observe(write);
  assert.equal(guard.observe(read('read3', 'three')).repeated_observations, 1);
  const replay = structuredClone(write); replay.id = 'new-event'; replay.properties.part.callID = 'write-replay';
  replay.properties.part.state.output = JSON.stringify({ path: 'result.txt', saved: true, replayed: true, sha256: 'a'.repeat(64), previous_sha256: 'b'.repeat(64) });
  guard.observe(replay);
  assert.equal(guard.observe(read('read4', 'four')).repeated_observations, 2);
  const stopped = guard.observe(read('read5', 'five')); assert.equal(stopped.halt, true); assert.equal(stopped.halt_reason, 'repeated-observation');
});

test('fresh check locators and nonce fields cannot refund identical protocol failures', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read', 'check_run']);
  assert.equal(guard.observe(part('error1', 'error')).repeated_failures, 1);
  const check = part('check1', 'completed', { title: 'Check' }, 'wf_check_run');
  check.properties.part.state.output = JSON.stringify({ checks: [{ passed: false, evidence: 'new-locator', nonce: 'changed' }] });
  guard.observe(check);
  assert.equal(guard.observe(part('error2', 'error')).halt, true);
});

test('invalid pseudo-tool schema errors before MCP dispatch are bounded and foreign sessions cannot trip the guard', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read']);
  const input = { tool: 'wf_project_read', error: 'Expected string path; received null' };
  const foreign = part('foreign', 'error', input, 'invalid'); foreign.properties.sessionID = 'different';
  assert.equal(guard.observe(foreign), undefined);
  assert.equal(guard.observe(part('invalid1', 'error', input, 'invalid')).repeated_failures, 1);
  assert.equal(guard.observe(part('invalid2', 'error', input, 'invalid')).halt, true);
});

test('a completed protocol error envelope is bounded without treating a failed product check as a protocol error', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read', 'check_run']);
  for (const id of ['product1', 'product2']) {
    const event = part(id, 'completed', {}, 'wf_check_run'); event.properties.part.state.output = JSON.stringify({ passed: false, findings: ['The product value is wrong.'] });
    assert.equal(guard.observe(event).status, 'completed');
  }
  for (const [index, id] of ['protocol1', 'protocol2'].entries()) {
    const event = part(id, 'completed'); event.properties.part.state.output = JSON.stringify({ error: 'Bad cursor', code: 'INVALID_PAYLOAD', validation: { owner: 'agent-content' } });
    const observed = guard.observe(event); assert.equal(observed.status, 'error'); assert.equal(observed.repeated_failures, index + 1);
    if (index) assert.equal(observed.halt, true);
  }
});
