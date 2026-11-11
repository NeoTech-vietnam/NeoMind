import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject } from '../src/domain/templates.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';

const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const models = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];

test('a finished run is deleted with its worktree, refs and journal; an unfinished one is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r'), state = path.join(root, 's');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } }));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const agents = new FakeRunnerFactory('codex', { respond: async () => JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Write proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] }) }, models);
  const manager = await RunManager.open(repo, state, new RunnerRegistry([agents]));
  const api = createEditorApi(repo, async () => manager);
  try {
    const { runId } = await manager.create('dev', 'Add proof');
    await manager.settle(runId);
    assert.equal((await manager.get(runId)).runtimeState?.phase, 'waiting_approval');
    const refused = await api({ method: 'POST', path: `/api/runs/${runId}/delete`, body: {} });
    assert.ok(refused.status >= 400); assert.match(JSON.stringify(refused.body), /hủy run trước khi xóa/);

    await manager.action(runId, 'cancel', 'ui');
    const workspace = (await manager.get(runId)).runtimeContext!.workspace;
    const deleted = await api({ method: 'POST', path: `/api/runs/${runId}/delete`, body: {} });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual((await manager.list()).map(item => item.runId), []);
    await assert.rejects(access(path.join(state, 'runs', runId)));
    await assert.rejects(access(workspace));
    assert.equal(git('for-each-ref', `refs/neomind/${runId}/`).trim(), '');
    assert.ok(!git('worktree', 'list').includes(runId));

    const bulk = await api({ method: 'POST', path: '/api/runs/delete', body: {} });
    assert.deepEqual(bulk.body, { results: [] });
  } finally { await manager.close(); }
});
