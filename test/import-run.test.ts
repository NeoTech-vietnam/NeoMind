import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import type { WorkerFactory } from '../src/runtime/worker.js';

/** A checkout with the user's uncommitted work; the writer either adds its own file or rewrites the user's edited line. */
async function fixture(mode: 'separate' | 'overlap') {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-import-run-')), project = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(project); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(project, 'app.js'), 'const mode = "base";\nmodule.exports = { mode };\n');
  const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } };
  await mkdir(path.join(project, '.neomind')); await writeFile(path.join(project, '.neomind/project.json'), JSON.stringify(config));
  git('add', '.'); git('commit', '-qm', 'baseline');
  await writeFile(path.join(project, 'app.js'), 'const mode = "user";\nmodule.exports = { mode };\n');
  await writeFile(path.join(project, 'notes.md'), 'user notes\n');
  const snapshot = await materializeRun(templates.dev, config, { 'implementer@1': builtinProfile('implementer'), 'verifier@1': builtinProfile('verifier') }, project);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const threads = new Map<string, { cwd: string; sandbox: string }>(), prompts: string[] = [];
  const factory: WorkerFactory = async () => {
    const events = new CodexTurnEvents(); let active = true;
    const transport = { request: async (method: string, input: unknown): Promise<unknown> => {
      const params = input as Record<string, unknown>;
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
      if (method === 'thread/start' || method === 'thread/resume') {
        const id = method === 'thread/start' ? randomUUID() : String(params.threadId);
        threads.set(id, { cwd: String(params.cwd), sandbox: String(params.sandbox) });
        return { thread: { id }, cwd: String(params.cwd), model: String(params.model), modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
      }
      if (method !== 'turn/start') throw new Error(`Unexpected method ${method}`);
      const threadId = String(params.threadId), turnId = randomUUID(), thread = threads.get(threadId)!;
      const schema = params.outputSchema as { properties?: Record<string, unknown> } | undefined;
      prompts.push(JSON.stringify(params.input));
      let output: unknown;
      if (schema?.properties?.planId) output = { planId: 'import-plan', version: 1, goal: 'Extend the app', scope: ['.'], approach: 'Edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [], workPackets: [] };
      else if (schema?.properties?.evidence) {
        const ref = mode === 'separate' ? { kind: 'source', path: 'feature.js', line: 1, quote: 'exports.feature = true;' } : { kind: 'source', path: 'app.js', line: 1, quote: 'const mode = "user and run";' };
        output = { verdict: 'pass', findingIds: [], summary: 'Done', evidence: { criteria: ['approved plan', 'checks', 'regressions', 'done'].map(criterion => ({ criterion, status: 'pass', references: [ref] })), findings: [] } };
      } else if (thread.sandbox !== 'read-only') {
        if (mode === 'separate') await writeFile(path.join(thread.cwd, 'feature.js'), 'exports.feature = true;\n');
        else await writeFile(path.join(thread.cwd, 'app.js'), 'const mode = "user and run";\nmodule.exports = { mode };\n');
        output = 'Implemented';
      } else output = 'read only';
      events.accept('item/completed', { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text: typeof output === 'string' ? output : JSON.stringify(output) } });
      events.accept('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      return { turn: { id: turnId } };
    } };
    return { events, fault: () => undefined, scope: { transport, identity: { unit: `neomind-run-${randomUUID()}.scope`, controlGroup: `/user.slice/user-0.slice/fixture.scope` }, isActive: async () => active, stop: async () => { active = false; return true; } } };
  };
  const confirmed = (await captureBaseline(project)).baselineHash;
  const run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: 'Extend the app', snapshot, coordinator, workerFactory: factory, importDirty: confirmed,
    capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  const approve = async () => { run.launch(); await run.settled(); await run.approve('fixture-user', 'cli'); await run.settled(); return run.report(); };
  return { run, coordinator, project, confirmed, approve, prompts };
}
const show = (workspace: string, spec: string) => execFileSync('git', ['-C', workspace, 'show', spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('imported uncommitted changes are run input but stay out of the commit', async () => {
  const f = await fixture('separate');
  try {
    assert.deepEqual(f.run.context.imported?.paths, ['app.js', 'notes.md']);
    const report = await f.approve();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    // The commit is read from the project: the run's worktree was removed once the commit was kept under a NeoMind ref.
    const commit = report.commits[0]!.commit!;
    assert.equal(show(f.project, `${commit}:feature.js`), 'exports.feature = true;\n');
    assert.equal(show(f.project, `${commit}:app.js`), 'const mode = "base";\nmodule.exports = { mode };\n', 'the user edit is not committed');
    assert.throws(() => show(f.project, `${commit}:notes.md`), 'untracked user files are not committed');
    assert.deepEqual(report.workspaceCleanup && { cleaned: report.workspaceCleanup.cleaned, discarded: report.workspaceCleanup.discarded }, { cleaned: true, discarded: [] },
      'the imported user edits left out of the commit are still in the checkout, so removing the worktree loses nothing');
    assert.equal((await captureBaseline(f.project)).baselineHash, f.confirmed, 'the user checkout was never touched');
    assert.ok(f.prompts.some(prompt => prompt.includes('uncommitted changes in: [\\"app.js\\",\\"notes.md\\"]')), 'agents are told which changes are the user\'s');
    assert.ok(report.commits[0]!.workspaceTree && report.commits[0]!.workspaceTree !== report.commits[0]!.expectedTree);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a run change that cannot be separated from the user change waits for the user, who may commit both', async () => {
  const f = await fixture('overlap');
  try {
    let report = await f.approve();
    assert.equal(report.runtimeState.phase, 'blocked');
    assert.match(report.runtimeState.reason, /^Chồng lên thay đổi có sẵn/);
    assert.equal(report.commits.length, 0);
    await f.run.includeImportedInCommit(); await f.run.settled();
    report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(show(f.project, `${report.commits[0]!.commit}:app.js`), 'const mode = "user and run";\nmodule.exports = { mode };\n');
    assert.equal(show(f.project, `${report.commits[0]!.commit}:notes.md`), 'user notes\n', 'the chosen scope includes every imported change');
    assert.deepEqual(report.includeImportedCommitNodeIds, ['commit']);
  } finally { await f.run.close(); f.coordinator.close(); }
});
