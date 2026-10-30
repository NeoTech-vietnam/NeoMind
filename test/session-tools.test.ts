import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject } from '../src/domain/templates.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { SESSION_TOOLS, sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];

/** A project whose agents are fake Codex runners: plans name proof.txt, writers create it. */
async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r'); // short: Windows Git refuses long worktree paths
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n');
  await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } }));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const agents = new FakeRunnerFactory('codex', {
    respond: async (session, request) => {
      if ((request.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.planId)
        return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] });
      if (session.access.kind === 'write') await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n');
      return 'done';
    },
  }, codexModels);
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([agents]));
  const runs = async () => manager, started: string[] = [];
  const tools = sessionToolHandlers(runs, createEditorApi(repo, runs), { onStart: runId => { started.push(runId); } });
  return { repo, manager, tools, started };
}

test('session tools cover the CLI commands; panel-only tools are marked', () => {
  const names = SESSION_TOOLS.map(tool => tool.name);
  for (const name of ['flows', 'preview', 'start', 'status', 'wait', 'approve', 'request_changes', 'pause', 'resume', 'cancel', 'extend_time', 'apply', 'retry_commit', 'include_imported', 'clean', 'session'])
    assert.ok(names.includes(name), name);
  assert.deepEqual(SESSION_TOOLS.filter(tool => tool.panelOnly).map(tool => tool.name), ['api']);
  for (const name of ['approve', 'apply', 'include_imported']) assert.ok((SESSION_TOOLS.find(tool => tool.name === name)!.inputSchema.required as string[]).includes('confirmed'));
});

test('a session previews and starts Fast, waits for it, reads what the agents did, and applies only once the user confirmed', async () => {
  const f = await project();
  try {
    assert.ok(((await f.tools.flows!({})) as { builtIn: string[] }).builtIn.includes('fast'));
    const preview = await f.tools.preview!({ flowId: 'fast' }) as { blockers: string[]; exceptions: string[]; steps: Record<string, { model: string }> };
    assert.deepEqual(preview.blockers, []); assert.equal(preview.exceptions.length, 2); assert.equal(preview.steps.implement?.model, 'gpt-6-luna');
    const started = await f.tools.start!({ flowId: 'fast', task: 'Add proof' }, { caller: 'agent', sessionId: 's1' }) as { started: boolean; runId: string };
    assert.ok(started.started); assert.deepEqual(f.started, [started.runId]);
    let run = await f.tools.wait!({ runId: started.runId, timeoutSeconds: 60 }) as { phase: string; changedFiles?: string[]; applied?: boolean; changed: boolean };
    while (run.phase === 'running') run = await f.tools.wait!({ runId: started.runId, timeoutSeconds: 60 }) as typeof run;
    assert.equal(run.phase, 'completed'); assert.deepEqual([run.changedFiles, run.applied], [['proof.txt'], false]);
    const turns = (await f.tools.session!({ runId: started.runId }) as { turns: { attemptId: string; step: string; files: string[] }[] }).turns;
    assert.deepEqual(turns.map(turn => turn.step), ['plan', 'implement']); assert.deepEqual(turns[1]!.files, []);
    const events = (await f.tools.session!({ runId: started.runId, attemptId: turns[1]!.attemptId }) as { events: { kind: string }[] }).events;
    assert.deepEqual(events.map(event => event.kind).filter(kind => kind !== 'turn'), ['meta', 'prompt', 'end']);
    await assert.rejects(f.tools.apply!({ runId: started.runId }), /user's decision: ask them in this session first/);
    const applied = await f.tools.apply!({ runId: started.runId, confirmed: true }) as { applied: boolean; worktreeCleaned?: boolean };
    assert.deepEqual([applied.applied, applied.worktreeCleaned], [true, true]);
    assert.equal(await readFile(path.join(f.repo, 'proof.txt'), 'utf8'), 'ok\n');
    const listed = await f.tools.status!({}) as { runs: { runId: string; phase: string }[] };
    assert.deepEqual(listed.runs.map(item => [item.runId, item.phase]), [[started.runId, 'completed']]);
    // The panel reaches the same project through the editor API.
    const api = await f.tools.api!({ method: 'get', path: `/api/runs/${started.runId}` }) as { status: number; body: { runId: string } };
    assert.deepEqual([api.status, api.body.runId], [200, started.runId]);
    assert.equal((await f.tools.api!({ method: 'GET', path: '/api/nothing' }) as { status: number }).status, 404);
  } finally { await f.manager.close(); }
});

test('a session approves a Dev plan only with the user\'s confirmation, and the journal says it came from a session', async () => {
  const f = await project();
  try {
    const { runId } = await f.tools.start!({ flowId: 'dev', task: 'Add proof' }) as { runId: string };
    let run = await f.tools.wait!({ runId, timeoutSeconds: 60 }) as { phase: string; planHash?: string; waitsFor?: string };
    while (run.phase === 'running') run = await f.tools.wait!({ runId, timeoutSeconds: 60 }) as typeof run;
    assert.equal(run.phase, 'waiting_approval'); assert.ok(run.planHash && run.waitsFor);
    await assert.rejects(f.tools.approve!({ runId, planHash: run.planHash }), /ask them in this session first/);
    await f.tools.approve!({ runId, planHash: run.planHash, confirmed: true });
    const approval = (await f.manager.get(runId)).approvals[0]!.approval;
    assert.deepEqual([approval.source, approval.actor], ['session', 'local-user (Nimbalyst session)']);
    await (await f.manager.settle(runId));
  } finally { await f.manager.close(); }
});
