import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCheckExecutor } from '../src/adapters/codex-check.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';

test('check uses bounded sandbox and rejects cwd outside the leased workspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-check-')), workspace = path.join(dir, 'workspace'); await mkdir(workspace);
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), lease = coordinator.acquire(workspace, 'run', 'host');
  let calls = 0, sent: unknown;
  const transport = { request: async (_method: string, params: unknown) => { calls++; sent = params; return { exitCode: 0, stdout: 'ok', stderr: '' }; } };
  const scope = { identity: { unit: 'neomind-run-abcd.scope', controlGroup: '/user.slice/neomind-run-abcd.scope' }, transport, isActive: async () => true, stop: async () => true };
  const executor = new CodexCheckExecutor(transport);
  const spec = { id: 'test', command: ['make', 'test'], cwd: workspace, timeoutMs: 10000 };
  await assert.rejects(executor.run({ ...spec, cwd: dir }, workspace, lease, coordinator, scope), /inside workspace/);
  assert.equal(calls, 0);
  const result = await executor.run(spec, workspace, lease, coordinator, scope);
  assert.equal(result.exitCode, 0); assert.match(result.outputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual((sent as { sandboxPolicy: { writableRoots: string[] } }).sandboxPolicy.writableRoots, [workspace]);
  coordinator.release(lease, true); coordinator.close();
});
