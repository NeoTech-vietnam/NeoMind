import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject, newFlowFromTemplate, templates } from '../src/domain/templates.js';
import { flowSchema } from '../src/domain/schema.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { memoryForRun, stepMemory, stepMemoryPolicy } from '../src/runtime/memory.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { replayRun } from '../src/core/recovery.js';
import { SingleOwnerJournal } from '../src/storage/journal.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';
import { maxAutoProposalsPerRun, proposeFromRun } from '../src/runtime/memory-proposals.js';
import { LessonProposals } from '../src/memory/proposals.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } }));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const prompts: Record<'plan' | 'write' | 'review', string[]> = { plan: [], write: [], review: [] };
  let planVersion = 0;
  const agents = new FakeRunnerFactory('codex', { respond: async (session, request) => {
    const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties?.planId) { prompts.plan.push(request.prompt); return JSON.stringify({ planId: 'p', version: ++planVersion, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] }); }
    if (schema?.properties?.evidence) {
      prompts.review.push(request.prompt);
      const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: (await readFile(path.join(session.workspace, 'proof.txt'), 'utf8')).trim() };
      return JSON.stringify({ verdict: 'pass', findingIds: [], summary: 'Proof matches', evidence: { findings: [],
        criteria: ['approved plan', 'checks', 'regressions', 'proof'].map(criterion => ({ criterion, status: 'pass', references: [reference] })) } });
    }
    prompts.write.push(request.prompt); await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
  } }, codexModels);
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([agents]));
  const runs = async () => manager, api = createEditorApi(repo, runs);
  return { repo, manager, prompts, api, tools: sessionToolHandlers(runs, api) };
}

/** Seed one record of each type through the user's own note path, which creates the default memory folder. */
async function seed(manager: RunManager) {
  const context = (await manager.addMemoryNote({ type: 'context', body: 'CONTEXT-NOTE proof files live at the repository root' })).record;
  const decision = (await manager.addMemoryNote({ type: 'decision', body: 'DECISION-NOTE keep proof changes small' })).record;
  const lesson = (await manager.addMemoryNote({ type: 'lesson', body: 'LESSON-NOTE check proof.txt before review' })).record;
  return { context, decision, lesson };
}

test('a project without configured memory reads empty and the first write creates neomind/memory in the repo', async () => {
  const f = await project();
  try {
    const before = f.manager.readMemory();
    assert.equal(before.root, null); assert.deepEqual(before.records, []);
    assert.equal(before.location.configured, false); assert.equal(before.location.exists, false); assert.equal(before.location.inRepository, true);
    assert.equal(before.location.relativePath, 'neomind/memory');
    assert.equal(memoryForRun(f.repo, path.join(f.manager.stateRoot, 'coordination.sqlite'), 'anything'), undefined, 'no folder yet means no memory, not an error');
    const { record } = await f.manager.addMemoryNote({ type: 'context', scope: 'project', tags: ['proof'], body: 'Proof files live at the root' });
    assert.ok(existsSync(path.join(f.repo, 'neomind', 'memory', 'context', `${record.header.id}.md`)));
    const after = f.manager.readMemory();
    assert.equal(after.location.exists, true); assert.equal(after.records.length, 1);
    assert.match(record.header.id, /^proof-files-live-at-the-root-[a-f0-9]{8}$/);
  } finally { await f.manager.close(); }
});

test('memory_propose waits for approval, duplicates are merged, and an approved proposal is found by memory_search', async () => {
  const f = await project();
  try {
    const proposed = await f.tools.memory_propose!({ type: 'decision', body: 'Use pnpm for new packages', sources: ['session:abc'], reason: 'The user said so in this session', tags: ['tooling'] }) as { created: boolean; proposalId: string };
    assert.equal(proposed.created, true);
    assert.deepEqual((await f.tools.memory_search!({ query: 'pnpm' }) as { records: unknown[] }).records, [], 'a proposal is not memory');
    const again = await f.tools.memory_propose!({ type: 'decision', body: '  use pnpm   for new packages ', sources: ['session:def'], reason: 'again' }) as { created: boolean; pending?: { proposalId: string } };
    assert.equal(again.created, false); assert.equal(again.pending?.proposalId, proposed.proposalId);
    const pending = await f.tools.memory_pending!({}) as { proposals: { proposalId: string; runId: string | null; proposalHash: string; type: string; body: string }[] };
    assert.equal(pending.proposals.length, 1); assert.equal(pending.proposals[0]!.type, 'decision');
    await assert.rejects(f.tools.memory_approve!({ proposalId: proposed.proposalId, proposalHash: pending.proposals[0]!.proposalHash }), /confirmed: true/);
    await f.tools.memory_approve!({ proposalId: proposed.proposalId, proposalHash: pending.proposals[0]!.proposalHash, confirmed: true });
    const found = await f.tools.memory_search!({ query: 'pnpm', type: 'decision' }) as { records: { id: string; type: string; revision: string }[] };
    assert.equal(found.records.length, 1);
    const got = await f.tools.memory_get!({ type: 'decision', id: found.records[0]!.id }) as { record: { body: string; header: { sources: string[] } } };
    assert.equal(got.record.body, 'Use pnpm for new packages');
    assert.ok(got.record.header.sources.includes('session:abc') && got.record.header.sources.some(source => source.startsWith('approval:')));
    const duplicate = await f.tools.memory_propose!({ type: 'decision', body: 'Use pnpm for new packages', sources: ['session:x'], reason: 'r' }) as { created: boolean; duplicateOf?: string };
    assert.equal(duplicate.created, false); assert.equal(duplicate.duplicateOf, `decision/${found.records[0]!.id}`);
    // Edit then approve, and reject, through the editor API.
    const second = await f.manager.proposeMemory({ type: 'lesson', body: 'Draft lesson', sources: ['cli'], reason: 'test' }, 'ai_session');
    assert.ok(second.created);
    const edited = await f.api({ method: 'POST', path: '/api/memory/proposals/approve', body: { runId: null, proposalId: second.proposalId, proposalHash: second.proposalHash, body: 'Edited lesson' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((edited.body as { record: { body: string } }).record.body, 'Edited lesson');
    const third = await f.manager.proposeMemory({ type: 'context', body: 'Rejected fact', sources: ['cli'], reason: 'test' });
    assert.ok(third.created);
    await f.tools.memory_reject!({ proposalId: third.proposalId, proposalHash: third.proposalHash, confirmed: true });
    assert.deepEqual((await f.manager.memoryProposals()).proposals, []);
  } finally { await f.manager.close(); }
});

test('the Memory page edits with revisions, expires, supersedes and deletes; lessons keep their approval receipt', async () => {
  const f = await project();
  try {
    const { lesson, decision } = await seed(f.manager);
    assert.ok(lesson.header.sources.some(source => source.startsWith('proposal:')) && lesson.header.sources.some(source => source.startsWith('approval:')));
    const edited = await f.api({ method: 'POST', path: '/api/memory', body: { record: { id: lesson.header.id, type: 'lesson', scope: 'project', sources: lesson.header.sources, tags: ['proof'], body: 'LESSON-NOTE edited' }, expectedRevision: lesson.revision } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const stale = await f.api({ method: 'POST', path: '/api/memory', body: { record: { id: lesson.header.id, type: 'lesson', scope: 'project', sources: lesson.header.sources, tags: [], body: 'stale' }, expectedRevision: lesson.revision } });
    assert.equal(stale.status, 400); assert.match((stale.body as { error: string }).error, /revision conflict/);
    const newLesson = await f.api({ method: 'POST', path: '/api/memory', body: { record: { id: 'direct-lesson', type: 'lesson', scope: 'project', sources: ['x'], tags: [], body: 'x' }, expectedRevision: null } });
    assert.equal(newLesson.status, 400, 'a new lesson still needs a proposal');
    const replacement = await f.api({ method: 'POST', path: '/api/memory/note', body: { type: 'decision', body: 'DECISION-NOTE keep proof changes tiny', supersedes: [decision.header.id] } });
    assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
    const replacementRecord = (replacement.body as { record: { header: { id: string }; revision: string } }).record;
    const blocked = await f.api({ method: 'POST', path: '/api/memory/delete', body: { type: 'decision', id: decision.header.id, expectedRevision: decision.revision } });
    assert.equal(blocked.status, 400); assert.match((blocked.body as { error: string }).error, /đang thay thế/);
    const page = f.manager.readMemory();
    assert.deepEqual(page.inactive?.map(item => item.reason), ['superseded']);
    const expired = await f.api({ method: 'POST', path: '/api/memory/expire', body: { type: 'decision', id: replacementRecord.header.id, expectedRevision: replacementRecord.revision } });
    assert.equal(expired.status, 200, JSON.stringify(expired.body));
    const expiredRecord = (expired.body as { record: { revision: string; header: { expiresAt?: string } } }).record;
    assert.ok(expiredRecord.header.expiresAt);
    const removed = await f.api({ method: 'POST', path: '/api/memory/delete', body: { type: 'decision', id: replacementRecord.header.id, expectedRevision: expiredRecord.revision } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(f.manager.readMemory().records.some(record => record.header.id === replacementRecord.header.id), false);
  } finally { await f.manager.close(); }
});

test('step memory: new flows give reviewers decisions and lessons only, older flows still share the whole block', async () => {
  const f = await project();
  try {
    await seed(f.manager);
    // Built-in Dev (no memoryDefaults): every step receives the shared block, exactly as before.
    const legacy = await f.tools.start!({ flowId: 'dev', task: 'Add proof note' }) as { runId: string };
    await f.manager.settle(legacy.runId); await f.manager.action(legacy.runId, 'approve', 'cli');
    const legacyRun = await f.manager.settle(legacy.runId);
    assert.equal(legacyRun.runtimeState?.phase, 'completed', legacyRun.runtimeState?.reason);
    for (const prompt of [f.prompts.plan[0]!, f.prompts.write[0]!, f.prompts.review[0]!]) for (const marker of ['CONTEXT-NOTE', 'DECISION-NOTE', 'LESSON-NOTE']) assert.ok(prompt.includes(marker), marker);
    assert.ok(legacyRun.nodeData.every(item => item.sources.filter(source => source.kind === 'memory').length === 3));
    // A flow created from the template opts into role defaults.
    const created = await f.api({ method: 'POST', path: '/api/flows', body: { id: 'role-dev', name: 'Role dev', template: 'dev' } });
    assert.equal(created.status, 201);
    assert.equal((created.body as { draft: { definition: { memoryDefaults?: string } } }).draft.definition.memoryDefaults, 'role');
    assert.equal((await f.api({ method: 'POST', path: '/api/flows/role-dev/publish', body: {} })).status, 200);
    const counts = { plan: f.prompts.plan.length, write: f.prompts.write.length, review: f.prompts.review.length };
    const roleRun = await f.tools.start!({ flowId: 'role-dev', task: 'Add proof note' }) as { runId: string };
    await f.manager.settle(roleRun.runId); await f.manager.action(roleRun.runId, 'approve', 'cli');
    const run = await f.manager.settle(roleRun.runId);
    assert.equal(run.runtimeState?.phase, 'completed', run.runtimeState?.reason);
    const plan = f.prompts.plan[counts.plan]!, write = f.prompts.write[counts.write]!, review = f.prompts.review[counts.review]!;
    for (const marker of ['CONTEXT-NOTE', 'DECISION-NOTE', 'LESSON-NOTE']) { assert.ok(plan.includes(marker), marker); assert.ok(write.includes(marker), marker); }
    assert.ok(!review.includes('CONTEXT-NOTE')); assert.ok(review.includes('DECISION-NOTE') && review.includes('LESSON-NOTE'));
    const reviewInput = run.nodeData.find(item => item.nodeId === 'verify')!;
    assert.deepEqual(reviewInput.sources.filter(source => source.kind === 'memory').map(source => source.id.split('/')[0]).sort(), ['decision', 'lesson'], 'node_input names exactly the records the reviewer received');
    const use = run.memoryUse.find(item => item.nodeId === 'verify')!;
    assert.match(use.filter, /review/); assert.equal(use.records.length, 2);
    // Replaying the journal gives the same report.
    const events = await new SingleOwnerJournal(path.join(f.manager.stateRoot, 'runs', run.runId, 'events.jsonl'), run.runId).read();
    assert.deepEqual(replayRun(events).nodeData.map(item => item.sources), run.nodeData.map(item => item.sources));
  } finally { await f.manager.close(); }
});

test('a step setting overrides the role default and the write role keeps records in the plan scope', () => {
  const flow = flowSchema.parse(structuredClone(newFlowFromTemplate('dev')));
  const implement = flow.definition.nodes.find(node => node.id === 'implement');
  assert.ok(implement?.type === 'agent_task');
  implement.memory = { types: ['context'], maxRecords: 1 };
  const records = [
    { id: 'a', type: 'context' as const, scope: 'docs', revision: 'r', sources: [], selectionReason: 'x', tags: [], text: '[a]' },
    { id: 'b', type: 'context' as const, scope: 'src/ui', revision: 'r', sources: [], selectionReason: 'x', tags: [], text: '[b]' },
    { id: 'c', type: 'lesson' as const, scope: 'project', revision: 'r', sources: [], selectionReason: 'x', tags: ['t'], text: '[c]' },
  ];
  const memory = { root: '/m', text: '[a]\n\n[b]\n\n[c]', records };
  assert.deepEqual(stepMemory(memory, stepMemoryPolicy(flow, 'implement'), { planScope: ['src'] })?.records.map(item => item.id), ['b']);
  assert.deepEqual(stepMemory(memory, stepMemoryPolicy(flow, 'verify/required-reviewer'))?.records.map(item => item.id), ['c']);
  assert.equal(stepMemory(memory, stepMemoryPolicy(templates.dev, 'verify/required-reviewer')), undefined, 'built-in templates keep the shared block');
  const legacyRecords = records.map(({ text: _text, tags: _tags, ...rest }) => rest);
  assert.equal(stepMemory({ ...memory, records: legacyRecords }, stepMemoryPolicy(flow, 'implement')), undefined, 'runs pinned before per-step memory keep the shared block');
  implement.memory = { off: true };
  assert.equal(stepMemory(memory, stepMemoryPolicy(flow, 'implement'))?.text, '');
});

test('a finished run proposes violated rules and block reasons once each, within the per-run cap', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nm-auto-'));
  const finding = (id: string, criterion: string) => ({ id, criterion, explanation: `${id} explained`, references: [{ kind: 'source', path: 'a', line: 1, quote: 'a' }] });
  const reviewerOutput = (sequence: number, findings: unknown[]) => ({ sequence, type: 'reviewer_output', payload: { evidence: { criteria: [], findings } } });
  const events = [reviewerOutput(5, [finding('f1', 'Rule R1: Keep it small'), finding('f2', 'Rule R1: Keep it small'), finding('f3', 'checks')]),
    { sequence: 6, type: 'runtime_state', payload: { phase: 'blocked', reason: 'Check failed: npm test' } },
    { sequence: 7, type: 'runtime_state', payload: { phase: 'blocked', reason: 'Check failed: npm test' } },
    { sequence: 8, type: 'runtime_state', payload: { phase: 'paused', reason: 'x' } }] as unknown as Parameters<typeof proposeFromRun>[0]['events'];
  const report = { planRevisions: Array.from({ length: 10 }, (_, index) => ({ planningNodeId: 'plan', planId: 'p', version: index + 2, feedback: `feedback ${index}` })) } as unknown as Parameters<typeof proposeFromRun>[0]['report'];
  const input = { directory, runId: 'run-1', task: 'Do it', report, events, rules: [{ id: 'R1', text: 'Keep it small' }] };
  const first = proposeFromRun(input);
  assert.equal(first.length, 5);
  const created = first.map(id => new LessonProposals(directory).read(id));
  assert.equal(created.filter(item => item.origin === 'plan_revision').length, 3, 'at most three plan feedback proposals');
  assert.equal(created.filter(item => item.origin === 'review_rule').length, 1, 'one proposal per violated rule');
  assert.equal(created.filter(item => item.origin === 'run_stopped').length, 1, 'the same block reason once');
  assert.deepEqual(proposeFromRun(input), [], 'running again proposes nothing new');
  const rules = Array.from({ length: 10 }, (_, index) => ({ id: `R${index}`, text: `Rule text ${index}` }));
  const many = [reviewerOutput(5, rules.map(rule => finding(`f-${rule.id}`, `Rule ${rule.id}: ${rule.text}`)))] as unknown as typeof events;
  assert.equal(proposeFromRun({ ...input, directory: await mkdtemp(path.join(tmpdir(), 'nm-cap-')), events: many, rules }).length, maxAutoProposalsPerRun);
});

test('the CLI lists, proposes, approves and notes memory through the same core', async () => {
  const f = await project();
  await f.manager.close();
  // The CLI keeps state in its default location; point it at the fixture's temporary folder.
  const state = path.join(path.dirname(f.repo), 'x'), env = { ...process.env, XDG_STATE_HOME: state, LOCALAPPDATA: state };
  const cli = path.resolve('dist/src/cli/main.js'), run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, 'memory', ...args], { encoding: 'utf8', env })) as Record<string, unknown>;
  const input = path.join(f.repo, '..', 'proposal.json');
  await writeFile(input, JSON.stringify({ type: 'context', body: 'CLI fact', sources: ['cli'], reason: 'test' }));
  const proposed = run('propose', f.repo, input) as { proposalId: string };
  assert.equal((run('pending', f.repo).proposals as unknown[]).length, 1);
  run('approve', f.repo, proposed.proposalId);
  run('note', f.repo, 'decision', 'CLI decision', '--tags', 'cli');
  const listed = run('list', f.repo) as { records: { type: string; summary: string }[] };
  assert.deepEqual(listed.records.map(item => item.summary).sort(), ['CLI decision', 'CLI fact']);
});

test('plan feedback and "remember this" become proposals; ratings are journaled and change the next ranking', async () => {
  const f = await project();
  try {
    await seed(f.manager);
    const database = path.join(f.manager.stateRoot, 'coordination.sqlite');
    const order = () => memoryForRun(f.repo, database, 'unrelated words')!.records.map(record => `${record.header.type}/${record.header.id}`);
    const before = order();
    assert.equal(before.length, 3);
    const { runId } = await f.tools.start!({ flowId: 'dev', task: 'Add proof note' }) as { runId: string };
    let run = await f.manager.settle(runId);
    await f.manager.revisePlan(runId, 'Luôn giữ thay đổi nhỏ trong một file', run.proposedPlanHash!);
    run = await f.manager.settle(runId);
    await f.manager.action(runId, 'approve', 'cli'); run = await f.manager.settle(runId);
    assert.equal(run.runtimeState?.phase, 'completed', run.runtimeState?.reason);
    const remembered = await f.api({ method: 'POST', path: `/api/runs/${runId}/remember`, body: { text: 'Proof chỉ cần một dòng', type: 'lesson' } });
    assert.equal(remembered.status, 200, JSON.stringify(remembered.body));
    const pending = (await f.manager.memoryProposals()).proposals.filter(item => item.runId === runId);
    assert.deepEqual(pending.map(item => item.proposal.origin).sort(), ['plan_revision', 'user_note']);
    const planProposal = pending.find(item => item.proposal.origin === 'plan_revision')!;
    assert.equal(planProposal.proposal.record.type, 'decision'); assert.match(planProposal.proposal.record.body, /Luôn giữ thay đổi nhỏ/);
    assert.ok(planProposal.proposal.record.sources.includes(`run:${runId}`));
    // Ratings: the last record is rated helpful twice and the first wrong, which reverses their order next time.
    const [first, , last] = before;
    await f.api({ method: 'POST', path: `/api/runs/${runId}/memory-feedback`, body: { record: last, nodeId: 'verify', rating: 'helpful' } });
    const rated = await f.api({ method: 'POST', path: `/api/runs/${runId}/memory-feedback`, body: { record: first, nodeId: 'verify', rating: 'wrong' } });
    assert.equal(rated.status, 200, JSON.stringify(rated.body));
    const after = order();
    assert.equal(after[0], last); assert.equal(after.at(-1), first);
    const report = await f.manager.get(runId);
    assert.deepEqual(report.memoryFeedback.map(item => item.rating), ['helpful', 'wrong']);
    assert.equal(report.runtimeState?.phase, 'completed', 'rating does not change the run');
    assert.ok(report.memoryUse.find(item => item.nodeId === 'verify')?.records.some(item => item.rating === 'wrong'));
    const stats = f.manager.readMemory().stats;
    assert.equal(stats[first!]?.wrong, 1); assert.equal(stats[last!]?.uses, 1);
    const unknown = await f.api({ method: 'POST', path: `/api/runs/${runId}/memory-feedback`, body: { record: 'context/not-used', rating: 'helpful' } });
    assert.equal(unknown.status, 400);
  } finally { await f.manager.close(); }
});
