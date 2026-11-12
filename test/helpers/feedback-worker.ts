import { appendFeedback, feedbackEvent } from '../../src/memory/feedback.js';
import { MemoryStore } from '../../src/memory/store.js';
const [, , root, db, prefix, count] = process.argv;
if (!root || !db || !prefix || !count) throw new Error('Expected root, database, prefix, count');
const store = new MemoryStore(root, db);
try {
  // One append per rating, so the writers contend for the lock as often as possible.
  for (let i = 0; i < Number(count); i++) appendFeedback(store, [feedbackEvent({ eventId: `${prefix}-${i}`, record: 'context/shared', runId: `run-${prefix}`, rating: 'helpful', createdAt: '2026-11-12T10:00:00.000Z' })]);
  process.stdout.write(JSON.stringify({ success: true }));
} finally { store.close(); }
