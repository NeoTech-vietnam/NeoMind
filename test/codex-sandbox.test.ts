import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRunner, CodexRunnerFactory } from '../src/runners/codex-runner.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { CodexCheckExecutor } from '../src/adapters/codex-check.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { runtimeContextSchema } from '../src/core/runtime-state.js';
import { fakeBinding, fakeScope } from './helpers/fake-runner.js';

for (const mode of ['enabled', 'disabled'] as const) {
  test(`Codex ${mode} mode is verified for readers, writers and resumed sessions`, async () => {
    const workspace = path.resolve('.'), calls: { method: string; params: Record<string, unknown> }[] = [];
    let sandboxOverride: string | undefined;
    const transport = { request: async (method: string, raw: unknown) => {
      const params = raw as Record<string, unknown>; calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? 'thread' }, cwd: workspace,
        model: fakeBinding.model, modelProvider: fakeBinding.provider, approvalPolicy: 'never',
        sandbox: { type: sandboxOverride ?? (params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite') } };
      return { turn: { id: 'turn' } };
    } };
    const runner = new CodexRunner({ scope: { ...fakeScope(), transport }, events: new CodexTurnEvents(), fault: () => undefined }, mode);
    for (const write of [false, true]) {
      const access = write ? { kind: 'write' as const, writableRoots: [workspace] } : { kind: 'read' as const };
      const session = await runner.openSession({ workspace, binding: fakeBinding, access });
      assert.equal(calls.at(-1)?.params.sandbox, mode === 'disabled' ? 'danger-full-access' : write ? 'workspace-write' : 'read-only');
      await runner.startTurn(session, { prompt: 'Fixture', effort: 'low' });
      if (write) assert.deepEqual(calls.at(-1)?.params.sandboxPolicy, mode === 'disabled' ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
      await runner.openSession({ workspace, binding: fakeBinding, access, resumeSessionId: session.sessionId });
      assert.equal(calls.at(-1)?.method, 'thread/resume');
      sandboxOverride = mode === 'disabled' ? write ? 'workspaceWrite' : 'readOnly' : 'dangerFullAccess';
      await assert.rejects(runner.openSession({ workspace, binding: fakeBinding, access }));
      sandboxOverride = undefined;
    }
    await runner.close();
  });

  test(`checks use Codex ${mode} mode and still require confirmed stop`, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'nm-sandbox-'));
    const coordinator = new WorkspaceCoordinator(path.join(workspace, 'coordination.sqlite'));
    const lease = coordinator.acquire(workspace, 'run', 'host');
    let sent: Record<string, unknown> = {}, stopped = 0;
    const transport = { request: async (_method: string, params: unknown) => { sent = params as Record<string, unknown>; return { exitCode: 0, stdout: 'ok', stderr: '' }; } };
    const scope = { ...fakeScope(async () => { stopped++; return true; }), transport };
    try {
      const executor = new CodexCheckExecutor(transport, mode);
      await executor.run({ id: 'test', command: ['node', '--version'], cwd: workspace, timeoutMs: 10000 }, workspace, lease, coordinator, scope);
      assert.deepEqual(sent.sandboxPolicy, mode === 'disabled' ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
      assert.equal(stopped, 1);
      const unknownStop = { ...fakeScope(async () => false), transport };
      await assert.rejects(executor.run({ id: 'unknown', command: ['node', '--version'], cwd: workspace, timeoutMs: 10000 }, workspace, lease, coordinator, unknownStop), /stop is unconfirmed/);
    } finally { coordinator.close(); }
  });
}

test('the capability factory reports disabled sandbox truthfully and passes the pinned mode to the probe', async () => {
  const modes: unknown[] = [];
  const factory = new CodexRunnerFactory(undefined, undefined, async mode => { modes.push(mode); return { sandboxVerified: mode !== 'disabled', stopVerified: true }; });
  assert.deepEqual(await factory.verifyCapabilities('disabled'), { sandboxVerified: false, stopVerified: true });
  assert.deepEqual(await factory.verifyCapabilities('enabled'), { sandboxVerified: true, stopVerified: true });
  assert.deepEqual(modes, ['disabled', 'enabled']);
});

test('legacy runtime contexts remain readable without inventing a disabled sandbox mode', () => {
  const context = { projectRoot: '/project', workspace: '/worktree', task: 'Fixture', sourceHead: 'a'.repeat(40), initialBaselineHash: 'baseline',
    lease: { workspace: '/worktree', runId: 'run', hostId: 'host', fence: 1 } };
  assert.equal(runtimeContextSchema.parse(context).codexSandbox, undefined);
  assert.equal(runtimeContextSchema.parse({ ...context, codexSandbox: 'disabled' }).codexSandbox, 'disabled');
  assert.throws(() => runtimeContextSchema.parse({ ...context, codexSandbox: 'anything' }));
});
