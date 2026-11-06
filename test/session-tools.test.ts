import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), policy: { ...defaultProject.policy, allowAutoApproval: true, allowHumanReview: true }, roleDefaults: { implementer: codexRole, verifier: codexRole } }));
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
  return { repo, manager, tools, started, agents };
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


test('session authors a flow through shared API and cannot bypass project policy', async () => {
  const f = await project();
  try {
    for (const name of ['flow_blocks', 'flow_get', 'flow_draft', 'flow_validate', 'flow_publish', 'assess']) {
      assert.ok(SESSION_TOOLS.some(tool => tool.name === name), name); assert.ok(f.tools[name], name);
    }
    const created = await f.tools.flow_draft!({ flowId: 'session-flow', name: 'Session flow', from: { template: 'dev' } }) as { revision: string; diagnostics: unknown[] };
    assert.deepEqual(created.diagnostics, []);
    const validation = await f.tools.flow_validate!({ flowId: 'session-flow' }) as { valid: boolean; diff: { nodes: { added: unknown[] } } };
    assert.equal(validation.valid, true); assert.ok(validation.diff.nodes.added.length > 0);
    await f.tools.flow_publish!({ flowId: 'session-flow', expectedRevision: created.revision, reason: 'Review required' }, { sessionId: 'test-session' });
    const data = await f.tools.flow_get!({ flowId: 'session-flow' }) as { draft: import('../src/domain/schema.js').Flow; versions: { author: { kind: string; sessionId?: string } }[]; revision: string };
    assert.deepEqual(data.versions[0]?.author, { kind: 'ai', sessionId: 'test-session', reason: 'Review required' });
    const review = data.draft.definition.nodes.find(node => node.type === 'review_group'); assert.ok(review?.type === 'review_group'); review.reviewers[0]!.required = false;
    const modified = await f.tools.flow_draft!({ flowId: 'session-flow', draft: data.draft, expectedRevision: data.revision }) as { revision: string };
    await assert.rejects(f.tools.flow_publish!({ flowId: 'session-flow', expectedRevision: modified.revision, reason: 'Try bypass' }), /missing_required_reviewer/);
    const policyFile = path.join(f.repo, 'neomind', 'project.json');
    const configuration = JSON.parse(await readFile(policyFile, 'utf8')) as Record<string, unknown>;
    await writeFile(policyFile, JSON.stringify({ ...configuration, ai: { flowPublish: 'draft-only' } }));
    await assert.rejects(f.tools.flow_publish!({ flowId: 'session-flow', expectedRevision: modified.revision, reason: 'Forbidden' }), /disabled/);
    await writeFile(policyFile, JSON.stringify({ ...configuration, ai: { flowPublish: 'deny' } }));
    await assert.rejects(f.tools.flow_draft!({ flowId: 'another', from: { template: 'dev' } }), /disabled/);
    assert.equal((await f.tools.assess!({ task: 'nghiên cứu giải pháp' }) as { flowId: string }).flowId, 'research');
  } finally { await f.manager.close(); }
});

test('fake runner receives pinned SKILL.md with its name and companion paths', async () => {
  const f = await project();
  try {
    const skillPath = '.claude/skills/review/SKILL.md', folder = path.join(f.repo, '.claude/skills/review');
    await mkdir(folder, { recursive: true });
    const content = '---\nname: Review Guide\ndescription: Test skill\n---\nUse evidence.\n';
    await writeFile(path.join(f.repo, skillPath), content); await writeFile(path.join(folder, 'reference.md'), 'Reference data');
    const { ProfileLibrary } = await import('../src/storage/profile-library.js'), { builtinProfile } = await import('../src/runtime/project.js');
    const profiles = new ProfileLibrary(path.join(f.repo, 'neomind/profiles')); await profiles.create('implementer', 'Implementer');
    await profiles.saveDraft('implementer', { ...builtinProfile('implementer')!, skills: [{ id: 'review', path: skillPath, sha256: createHash('sha256').update(content).digest('hex') }] });
    await profiles.publish('implementer');
    const started = await f.tools.start!({ flowId: 'dev', task: 'Add proof' }) as { runId: string };
    await f.manager.settle(started.runId);
    const prompts = f.agents.started.flatMap(runner => runner.turns.map(turn => turn.request.prompt));
    assert.ok(prompts.some(prompt => prompt.includes('Skill Review Guide (review):') && prompt.includes('Use evidence.') && prompt.includes('.claude/skills/review/reference.md')));
    assert.ok(prompts.every(prompt => !prompt.includes('Reference data')));
  } finally { await f.manager.close(); }
});

test('session profile authoring uses the shared policy and records AI provenance', async () => {
  const f = await project();
  try {
    for (const name of ['skills', 'profile_get', 'profile_draft', 'profile_publish']) { assert.ok(SESSION_TOOLS.some(tool => tool.name === name)); assert.ok(f.tools[name]); }
    const draft = await f.tools.profile_draft!({ profileId: 'custom', from: { profileId: 'implementer' } }) as { revision: string };
    await f.tools.profile_publish!({ profileId: 'custom', expectedRevision: draft.revision, reason: 'Review profile' }, { sessionId: 's1' });
    const profile = await f.tools.profile_get!({ profileId: 'custom' }) as { versions: { author: { kind: string; sessionId: string } }[] };
    assert.equal(profile.versions[0]?.author.kind, 'ai'); assert.equal(profile.versions[0]?.author.sessionId, 's1');
    const file = path.join(f.repo, 'neomind/project.json'), projectConfig = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...projectConfig, ai: { profilePublish: 'draft-only' } }));
    await assert.rejects(f.tools.profile_publish!({ profileId: 'custom', expectedRevision: draft.revision, reason: 'blocked' }), /disabled/);
    await writeFile(file, JSON.stringify({ ...projectConfig, ai: { profilePublish: 'deny' } }));
    await assert.rejects(f.tools.profile_draft!({ profileId: 'other', from: { profileId: 'implementer' } }), /disabled/);
  } finally { await f.manager.close(); }
});
