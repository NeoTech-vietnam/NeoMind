import { FlowLibrary } from '../../src/storage/flow-library.js';
import { RevisionConflict, withLibraryLock } from '../../src/storage/library-lock.js';

const [, , mode, root, flowId, expected] = process.argv;
if (!mode || !root || !flowId) throw new Error('Usage: library-worker save|hold <root> <flowId> [revision]');
if (mode === 'hold') {
  // Hold the library lock until this process is killed.
  await withLibraryLock(root, async () => { process.stdout.write('locked\n'); await new Promise(() => {}); });
} else {
  const library = new FlowLibrary(root), { draft } = await library.readDraftWithRevision(flowId);
  try { await library.saveDraft(flowId, { ...(draft as object), description: `saved by ${process.pid}` }, expected); process.stdout.write('ok\n'); }
  catch (error) { process.stdout.write(error instanceof RevisionConflict ? 'conflict\n' : `error ${String(error)}\n`); }
}
