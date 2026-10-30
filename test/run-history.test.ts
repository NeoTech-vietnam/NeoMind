import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRun } from '../src/runtime/local-run.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { projectRuntimeRoot, snapshotProjectFlow } from '../src/runtime/project.js';
import { FlowLibrary } from '../src/storage/flow-library.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { templates, defaultProject } from '../src/domain/templates.js';

test('run history stays readable after its flow definition is deleted, and templates never mutate project flows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-history-')), project = path.join(root, 'repo'), stateBase = path.join(root, 'state');
  await mkdir(project);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(path.join(project, 'README.md'), 'x\n'); git('add', '.');
  git('-c', 'user.name=F', '-c', 'user.email=f@x.test', 'commit', '-qm', 'base');
  const library = new FlowLibrary(path.join(project, '.neomind', 'flows'));
  await library.create('mine', 'Mine');
  const draft = { ...structuredClone(templates.dev), flowId: 'mine', name: 'Mine', description: 'project copy' };
  await library.saveDraft('mine', draft); await library.publish('mine', defaultProject.policy);
  // Built-in templates are copied into the project; changing the template object afterwards does not touch the copy.
  templates.dev.description = 'mutated template';
  try { assert.equal((await library.readVersion('mine', 1)).description, 'project copy'); }
  finally { templates.dev.description = 'Dev code flow with user approval and independent verification.'; }

  const stateRoot = await projectRuntimeRoot(project, stateBase), coordinator = new WorkspaceCoordinator(path.join(stateRoot, 'coordination.sqlite'));
  const run = await LocalRun.create({ projectRoot: project, stateRoot, task: 'History', snapshot: await snapshotProjectFlow(project, 'mine'), coordinator,
    workerFactory: async () => { throw new Error('not dispatched'); }, capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  const runId = run.runId; await run.close(); coordinator.close();
  await library.deletePermanently('mine', 'Mine');

  const manager = await RunManager.open(project, stateBase);
  try {
    const history = await manager.get(runId);
    assert.equal((history.snapshot as { configuration: { flow: { flowId: string; description: string } } }).configuration.flow.flowId, 'mine');
    assert.equal((history.snapshot as { configuration: { flow: { description: string } } }).configuration.flow.description, 'project copy');
    assert.deepEqual((await manager.list()).map(item => item.runId), [runId]);
  } finally { await manager.close(); }
});
