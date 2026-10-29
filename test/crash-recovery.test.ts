import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { OwnedJournal } from '../src/storage/owned-journal.js';
import { RunService } from '../src/core/run-service.js';
import { CodexWriteDispatch } from '../src/core/codex-write-dispatch.js';
import { CodexWorkspaceWriteAdapter } from '../src/adapters/codex-workspace-write.js';
import { defaultProject } from '../src/domain/templates.js';

test('after scheduler crash, owner is reclaimed and active writer scope is stopped without replay', { timeout: 30000 }, async t => {
  if (process.platform !== 'linux' || spawnSync('systemd-run', ['--user', '--scope', '--quiet', '/bin/true']).status !== 0 || spawnSync('codex', ['--version']).status !== 0) {
    t.skip('User systemd or Codex unavailable'); return;
  }
  const root = await mkdtemp(path.join(homedir(), '.neomind-crash-test-'));
  const worker = spawn(process.execPath, [path.resolve('dist/test/helpers/crash-worker.js'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker readiness timed out: ${stderr}`)), 15000);
      worker.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited before ready: ${code} ${stderr}`)); });
    });
    worker.kill('SIGKILL'); await new Promise<void>(resolve => worker.once('exit', () => resolve()));
    const coordinator = new WorkspaceCoordinator(path.join(root, 'db'));
    const previous = coordinator.getRunOwner('run')!; coordinator.reclaimDeadRun(previous);
    const owner = coordinator.acquireRun('run', 'recovery-host'), held = coordinator.getWriter(path.join(root, 'work'))!;
    const journal = new OwnedJournal(path.join(root, 'events'), coordinator, owner), service = await RunService.recover(journal);
    const plan = (await service.report()).plans[0]!.plan, approval = (await service.report()).approvals[0]!.approval;
    const adapter = new CodexWorkspaceWriteAdapter({ request: async () => ({}) }), dispatcher = new CodexWriteDispatch(journal, adapter);
    await service.reconcileWriteStop(dispatcher, 'write-attempt', { workspace: held.workspace, lease: held, coordinator, plan, approval,
      livePolicy: defaultProject.policy, expectedBaselineHash: 'unused', sandboxVerified: true, stopVerified: true });
    assert.deepEqual((await service.report()).unresolvedAttemptIds, []);
    await new Promise(resolve => setTimeout(resolve, 3500));
    await assert.rejects(access(path.join(root, 'work', 'marker')), /ENOENT/);
    await journal.close(); coordinator.release(held, true); coordinator.releaseRun(owner, true); coordinator.close();
    await rm(root, { recursive: true, force: true });
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    // Preserve the temporary fixture for diagnosis if a test fails; it contains no user data.
  }
});
