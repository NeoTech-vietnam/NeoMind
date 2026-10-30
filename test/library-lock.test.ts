import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { FlowLibrary } from '../src/storage/flow-library.js';
import { ProfileLibrary } from '../src/storage/profile-library.js';
import { RevisionConflict, withLibraryLock } from '../src/storage/library-lock.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
const execFileAsync = promisify(execFile);
const worker = path.resolve('dist/test/helpers/library-worker.js');

async function library() {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'neomind-library-lock-')), 'flows'), flows = new FlowLibrary(root);
  await flows.create('dev', 'Dev');
  const revision = await flows.saveDraft('dev', { ...structuredClone(templates.dev), flowId: 'dev' });
  return { root, flows, revision };
}

test('a stale draft revision cannot overwrite newer work, in drafts or publish', async () => {
  const { flows, revision } = await library();
  const newer = await flows.saveDraft('dev', { ...structuredClone(templates.dev), description: 'from the CLI' }, revision);
  await assert.rejects(flows.saveDraft('dev', { ...structuredClone(templates.dev), description: 'stale editor' }, revision), RevisionConflict);
  assert.equal(((await flows.readDraft('dev')) as { description: string }).description, 'from the CLI');
  await assert.rejects(flows.publish('dev', defaultProject.policy, revision), RevisionConflict);
  assert.equal((await flows.publish('dev', defaultProject.policy, newer)).version, 1);
  const profiles = new ProfileLibrary(path.join(path.dirname((await library()).root), 'profiles'));
  await profiles.create('helper', 'Helper');
  const first = await profiles.saveDraft('helper', { ...builtinProfile('implementer')!, profileId: 'helper', name: 'Helper' });
  await profiles.saveDraft('helper', { ...builtinProfile('implementer')!, profileId: 'helper', name: 'Helper', instructions: 'newer' }, first);
  await assert.rejects(profiles.saveDraft('helper', { ...builtinProfile('implementer')!, profileId: 'helper', name: 'Helper' }, first), RevisionConflict);
});

test('concurrent processes saving from the same revision: exactly one wins', { timeout: 60000 }, async () => {
  const { root, revision } = await library();
  const results = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, [worker, 'save', root, 'dev', revision]).then(result => result.stdout.trim())));
  assert.deepEqual(results.sort(), ['conflict', 'conflict', 'conflict', 'ok']);
});

test('a lock held by a process that dies is released by the OS', { timeout: 60000 }, async () => {
  const { root } = await library();
  const holder = spawn(process.execPath, [worker, 'hold', root, 'dev'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Holder did not lock')), 20000);
    holder.stdout.on('data', chunk => { if (String(chunk).includes('locked')) { clearTimeout(timer); resolve(); } });
  });
  holder.kill(); await new Promise(resolve => holder.once('exit', resolve));
  const started = Date.now();
  assert.equal(await withLibraryLock(root, async () => 'acquired'), 'acquired');
  assert.ok(Date.now() - started < 5000, 'no stale lock to wait out');
});

test('in-process mutations are serialized rather than deadlocking on the shared lock', async () => {
  const { root, flows } = await library();
  const order: string[] = [];
  await Promise.all([
    withLibraryLock(root, async () => { order.push('a-start'); await new Promise(resolve => setTimeout(resolve, 50)); order.push('a-end'); }),
    withLibraryLock(root, async () => { order.push('b'); }),
    flows.rename('dev', 'Dev renamed'),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  assert.equal((await flows.metadata('dev')).name, 'Dev renamed');
});
