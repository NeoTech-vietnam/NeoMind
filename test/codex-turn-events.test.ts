import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';

test('correlates early completion messages and terminal events to the exact turn', () => {
  const events = new CodexTurnEvents();
  events.accept('item/completed', { threadId: 't', turnId: 'one', item: { type: 'agentMessage', id: 'm1', text: 'plan' } });
  events.accept('turn/completed', { threadId: 't', turn: { id: 'one', status: 'completed' } });
  assert.deepEqual(events.result('t', 'one'), { threadId: 't', turnId: 'one', status: 'completed', messages: ['plan'] });
  assert.equal(events.result('t', 'two'), undefined);
  events.forget('t', 'one'); assert.equal(events.result('t', 'one'), undefined);
});
test('reports failed turns and rejects duplicate terminal messages', () => {
  const events = new CodexTurnEvents();
  events.accept('turn/completed', { threadId: 't', turn: { id: 'one', status: 'failed' } });
  assert.equal(events.result('t', 'one')?.status, 'failed');
  assert.throws(() => events.accept('turn/completed', { threadId: 't', turn: { id: 'one', status: 'completed' } }), /Duplicate/);
});

test('an interrupted turn can still have an active command', () => {
  const events = new CodexTurnEvents();
  events.accept('item/started', { threadId: 't', turnId: 'one', item: { type: 'commandExecution', id: 'cmd' } });
  events.accept('turn/completed', { threadId: 't', turn: { id: 'one', status: 'interrupted' } });
  assert.equal(events.pendingCommands('t', 'one'), 1);
  events.accept('item/completed', { threadId: 't', turnId: 'one', item: { type: 'commandExecution', id: 'cmd' } });
  assert.equal(events.pendingCommands('t', 'one'), 0);
});
