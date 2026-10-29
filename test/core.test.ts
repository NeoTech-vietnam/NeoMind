import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { allocateRepairRound, type BudgetState } from '../src/core/budget.js';
import { admitAttempt, beginRecovery, finishRecovery, mayReleaseWorkspace, observeStop, requestStop, type Lifecycle } from '../src/core/lifecycle.js';
import { JournalCorruption, SingleOwnerJournal, type NewRunEvent } from '../src/storage/journal.js';

test('journal repairs torn final bytes while retaining durable events and sequence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-journal-'));
  const file = path.join(dir, 'events.jsonl');
  const journal = new SingleOwnerJournal(file, 'run1');
  const first: NewRunEvent = { schemaVersion: 1, eventId: 'event1', runId: 'run1', requestId: 'request1',
    type: 'dispatch_intent', timestamp: '2026-10-28T00:00:00Z', payload: { attemptId: 'a1' } };
  assert.equal((await journal.append(first, 0)).sequence, 1);
  await appendFile(file, '{"eventId":"incomplete');
  assert.equal((await journal.read()).length, 1);
  const second = { ...first, eventId: 'event2', type: 'dispatch_receipt' };
  assert.equal((await journal.append(second, 1)).sequence, 2);
  assert.deepEqual((await journal.read()).map(e => e.eventId), ['event1', 'event2']);
  assert.ok(!(await readFile(file, 'utf8')).includes('incomplete'));
  await assert.rejects(journal.append({ ...second, eventId: 'event3' }, 1), /sequence conflict/);
  await assert.rejects(journal.append(second, 2), /Duplicate event ID/);
});

test('journal blocks recovery for complete corrupt lines and mismatched run identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-corrupt-'));
  const file = path.join(dir, 'events.jsonl');
  const journal = new SingleOwnerJournal(file, 'run1');
  await appendFile(file, 'not-json\n');
  await assert.rejects(journal.read(), JournalCorruption);
  await assert.rejects(journal.append({ schemaVersion: 1, eventId: 'e', runId: 'another', requestId: 'r',
    type: 'test', timestamp: '2026-10-28T00:00:00Z', payload: null }, 0), /Run ID/);
});

test('journal refuses malformed UTF-8 in a complete line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-utf8-'));
  const file = path.join(dir, 'events.jsonl');
  await appendFile(file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
  await assert.rejects(new SingleOwnerJournal(file, 'run1').read(), /Invalid UTF-8/);
});

test('repair allocations are idempotent per epoch and cannot overspend run or scope budgets', () => {
  const initial: BudgetState = { runRoundsUsed: 0, scopesUsed: {}, allocations: {} };
  const first = allocateRepairRound(initial, 'round1', ['scopeB', 'scopeA'], 2, { scopeA: 2, scopeB: 1 });
  assert.equal(initial.runRoundsUsed, 0);
  assert.equal(first.runRoundsUsed, 1);
  assert.deepEqual(first.scopesUsed, { scopeA: 1, scopeB: 1 });
  assert.deepEqual(allocateRepairRound(first, 'round1', ['scopeA', 'scopeB'], 2, { scopeA: 2, scopeB: 1 }), first);
  assert.throws(() => allocateRepairRound(first, 'round1', ['scopeA'], 2, { scopeA: 2 }), /reused/);
  assert.throws(() => allocateRepairRound(first, 'round2', ['scopeB'], 2, { scopeB: 1 }), /exhausted/);
  const second = allocateRepairRound(first, 'round2', ['scopeA'], 2, { scopeA: 2 });
  assert.throws(() => allocateRepairRound(second, 'round3', ['scopeA'], 2, { scopeA: 3 }), /Run repair budget exhausted/);
});

test('pause does not release unknown workers; cancel stays pending until every worker stops', () => {
  let state: Lifecycle = { phase: 'running', stopIntent: null, attempts: {} };
  state = admitAttempt(state, 'a', 2); state = admitAttempt(state, 'b', 2);
  assert.throws(() => admitAttempt(state, 'c', 2), /Concurrency/);
  state = requestStop(state, 'pause');
  assert.throws(() => admitAttempt(state, 'c', 2), /not accepting/);
  state = observeStop(state, 'a', 'confirmed');
  state = observeStop(state, 'b', 'unknown');
  assert.equal(state.phase, 'stop_unconfirmed');
  assert.equal(mayReleaseWorkspace(state), false);
  state = requestStop(state, 'cancel');
  assert.equal(state.phase, 'stopping');
  state = observeStop(state, 'b', 'confirmed');
  assert.equal(state.phase, 'cancelled');
  assert.equal(mayReleaseWorkspace(state), true);
  assert.throws(() => beginRecovery(state), /not resumable/);
});

test('pause/resume requires explicit user confirmation and reconciliation', () => {
  let state: Lifecycle = { phase: 'running', stopIntent: null, attempts: {} };
  state = admitAttempt(state, 'a', 1);
  state = requestStop(state, 'pause');
  state = observeStop(state, 'a', 'confirmed');
  assert.equal(state.phase, 'paused');
  state = beginRecovery(state);
  assert.throws(() => finishRecovery(state, false, true), /not safe/);
  assert.throws(() => finishRecovery(state, true, false), /not safe/);
  state = finishRecovery(state, true, true);
  assert.equal(state.phase, 'running');
  assert.equal(state.stopIntent, null);
});
