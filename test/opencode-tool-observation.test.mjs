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

test('successful reads and timestamps cannot reset a repeated failure but distinct committed writes can', () => {
  const guard = new OpenCodeToolFailureGuard(sid, ['project_read', 'task_file_write']);
  assert.equal(guard.observe(part('call1', 'error')).repeated_failures, 1);
  guard.observe(part('read2', 'completed', { path: 'other.txt' }));
  guard.observe(part('write1', 'completed', { path: 'result.txt', content: 'updated' }, 'wf_task_file_write'));
  assert.equal(guard.observe(part('call2', 'error')).repeated_failures, 1);
  guard.observe(part('write2', 'completed', { path: 'result.txt', content: 'updated' }, 'wf_task_file_write'));
  assert.equal(guard.observe(part('call3', 'error')).halt, true, 'identical successful payload/output is not new engineering progress');
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
