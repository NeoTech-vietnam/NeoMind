import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startWorkerScope } from '../../src/adapters/worker-scope.js';
import { fakeRunnerSession } from './fake-runner.js';
import { CodexReadOnlyDispatch } from '../../src/core/codex-readonly-dispatch.js';
import { CodexWriteDispatch } from '../../src/core/codex-write-dispatch.js';
import { RunService } from '../../src/core/run-service.js';
import { templates, defaultProject } from '../../src/domain/templates.js';
import { WorkspaceCoordinator } from '../../src/storage/coordination.js';
import { OwnedJournal } from '../../src/storage/owned-journal.js';
import { captureBaseline } from '../../src/workspace/baseline.js';
const root = process.argv[2]; if (!root) throw new Error('Missing root');
const primary = path.join(root, 'repo'), workspace = path.join(root, 'work'); mkdirSync(primary);
const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
git('init', '-q'); writeFileSync(path.join(primary, 'a'), 'initial'); git('add', 'a');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial'); git('worktree', 'add', '--detach', workspace, 'HEAD');
const coordinator = new WorkspaceCoordinator(path.join(root, 'db')), owner = coordinator.acquireRun('run', 'worker-host');
const lease = coordinator.acquire(workspace, 'run', 'worker-host'), journal = new OwnedJournal(path.join(root, 'events'), coordinator, owner);
const service = await RunService.create(journal, templates.dev, defaultProject.policy); await service.completeControl('start');
const planner = await fakeRunnerSession('thread', { startTurn: async () => 'plan-turn' });
const reader = new CodexReadOnlyDispatch(journal, planner.runner, planner.session);
await service.dispatchReadOnly(reader, 'plan', 'thread', 'plan', 'low', 'plan-attempt', 'plan-request');
const plan = { planId: 'p', version: 1, goal: 'fixture', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
await service.recordReadOnlyPlan(reader, 'plan-attempt', { threadId: 'thread', turnId: 'plan-turn', status: 'completed', messages: [JSON.stringify(plan)] });
await service.approveProposedPlan('approval', 'plan', 'fixture', 'cli');
const approval = (await service.report()).approvals[0]!.approval;
const admission = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy,
  expectedBaselineHash: (await captureBaseline(workspace)).baselineHash, sandboxVerified: true, stopVerified: true };
const live = await startWorkerScope(() => {}, () => {});
// The writer turn is fake; its scope is a real worker scope with a live command, which recovery must stop.
const real = realpathSync(workspace), scope = { identity: live.identity, isActive: () => live.isActive(), stop: () => live.stop() };
const implementer = await fakeRunnerSession('thread', { startTurn: async () => 'write-turn', workspace: real, access: { kind: 'write', writableRoots: [real] }, scope });
const writer = new CodexWriteDispatch(journal, implementer.runner, implementer.session);
await service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', admission, scope);
const command = process.platform === 'win32'
  ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', 'Set-Content ready ready; Start-Sleep -Seconds 3; Set-Content marker leaked']
  : ['/bin/sh', '-c', 'printf ready > ready; sleep 3; printf leaked > marker'];
void live.transport.request('command/exec', { command, cwd: workspace,
  sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }, timeoutMs: 10000 }, 15000).catch(() => {});
for (let n = 0; n < 50 && !existsSync(path.join(workspace, 'ready')); n++) await new Promise(resolve => setTimeout(resolve, 100));
if (!existsSync(path.join(workspace, 'ready'))) throw new Error('Worker did not start');
process.stdout.write('ready\n');
await new Promise(() => {});
