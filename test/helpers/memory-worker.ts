import { MemoryStore } from '../../src/memory/store.js';
const [, , root, db, revision, content] = process.argv;
if (!root || !db || !revision || !content) throw new Error('Expected root, database, revision, content');
const store = new MemoryStore(root, db);
try {
  store.write({ id: 'project-facts', type: 'context', scope: 'project', sources: ['README.md'], tags: ['architecture'], body: content },
    revision, { projectWrite: true, confirmedByUser: false });
  process.stdout.write(JSON.stringify({ success: true }));
} catch (error) { process.stdout.write(JSON.stringify({ success: false, message: error instanceof Error ? error.message : String(error) })); }
finally { store.close(); }
