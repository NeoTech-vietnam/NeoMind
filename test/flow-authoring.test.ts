import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject, templates } from '../src/domain/templates.js';
import { compileFlow } from '../src/domain/compiler.js';
import { flowBlocks, draftFlow, getFlow, validateFlow, publishFlow, pinFlowBindings, assess, diffFlows } from '../src/runtime/flow-authoring.js';
import { FlowLibrary } from '../src/storage/flow-library.js';
import { defaultRoles, snapshotProjectFlow } from '../src/runtime/project.js';

async function project(ai?: { flowPublish: 'allow' | 'draft-only' | 'deny' }, maxActiveTimeSeconds?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-author-'));
  await mkdir(path.join(root, 'neomind'));
  await writeFile(path.join(root, 'neomind', 'project.json'), JSON.stringify({ ...defaultProject, roleDefaults: defaultRoles,
    policy: { ...defaultProject.policy, ...(maxActiveTimeSeconds ? { maxActiveTimeSeconds } : {}) }, ...(ai ? { ai } : {}) }));
  return root;
}

test('AI drafts require revisions and publish provenance without breaking old versions', async () => {
  const root = await project(), created = await draftFlow(root, { flowId: 'mine', name: 'Mine', from: { template: 'dev' } });
  assert.deepEqual(created.diagnostics, []);
  const store = new FlowLibrary(path.join(root, 'neomind', 'flows'));
  const old = await store.publish('mine', defaultProject.policy, created.revision);
  assert.equal(old.author, undefined);
  const published = await publishFlow(root, 'mine', { expectedRevision: created.revision, author: { kind: 'ai', sessionId: 's1', reason: 'Need independent review' } });
  assert.equal(published.version, 2); assert.equal(published.author?.sessionId, 's1');
  assert.equal((await getFlow(root, 'mine')).versions[0]?.author.kind, 'human');
  assert.equal((await store.readVersion('mine', 2)).author?.kind, 'ai');
  // The stored author is metadata and must not be passed into the strict flow schema at run snapshot time.
  const blocks = await flowBlocks(root); assert.ok(blocks.nodeTypes.includes('review_group'));
  await assert.rejects(draftFlow(root, { flowId: 'mine', draft: templates.dev }), /expectedRevision/);
  const config = await snapshotProjectFlow(root, 'mine', 2);
  assert.equal(config.configuration.flow.flowId, 'mine');
});

test('AI authoring enforces reviewer, approval and time policy without changing human flows', async () => {
  const root = await project(undefined, 1200), created = await draftFlow(root, { flowId: 'mine', from: { template: 'dev' } });
  assert.ok(created.diagnostics.some(item => item.code === 'ai_limit_exceeded'));
  const draft = structuredClone(templates.dev); draft.flowId = 'mine'; draft.definition.limits.activeTimeSeconds = 1200;
  const reviewer = draft.definition.nodes.find(node => node.type === 'review_group');
  assert.ok(reviewer?.type === 'review_group'); reviewer.reviewers[0]!.required = false;
  const saved = await draftFlow(root, { flowId: 'mine', draft, expectedRevision: created.revision });
  assert.ok(saved.diagnostics.some(item => item.code === 'missing_required_reviewer'));
  const validation = await validateFlow(root, 'mine'); assert.equal(validation.valid, false);
  await assert.rejects(publishFlow(root, 'mine', { author: { kind: 'ai' }, expectedRevision: saved.revision }), /missing_required_reviewer/);
  assert.ok(compileFlow(templates.dev, { ...defaultProject.policy, maxActiveTimeSeconds: 1200 }).ok);
});

test('draft-only permits drafts but rejects AI publish; deny rejects drafting', async () => {
  const root = await project({ flowPublish: 'draft-only' }), created = await draftFlow(root, { flowId: 'mine', from: { template: 'dev' } });
  await assert.rejects(publishFlow(root, 'mine', { expectedRevision: created.revision, author: { kind: 'ai' } }), /disabled/);
  await publishFlow(root, 'mine', { expectedRevision: created.revision, author: { kind: 'human' } });
  const denied = await project({ flowPublish: 'deny' });
  await assert.rejects(draftFlow(denied, { flowId: 'mine', from: { template: 'dev' } }), /disabled/);
});

test('diff reports graph and binding changes; assessment respects auto approval policy', async () => {
  const before = structuredClone(templates.dev), after = structuredClone(before);
  after.definition.nodes = after.definition.nodes.filter(node => node.id !== 'repair');
  after.definition.nodes.push({ id: 'end2', label: 'Other', type: 'finish' });
  after.definition.bindings.implementer!.model = { mode: 'pinned', value: 'gpt-6-luna' };
  const diff = diffFlows(before, after);
  assert.equal(diff.nodes.added[0]?.id, 'end2'); assert.equal(diff.nodes.removed[0]?.id, 'repair'); assert.equal(diff.bindings[0]?.id, 'implementer');
  const root = await project();
  assert.equal((await assess(root, 'nghiên cứu các phương án')).flowId, 'research');
  assert.equal((await assess(root, 'sửa chữ trong một file')).flowId, 'dev');
  await writeFile(path.join(root, 'neomind', 'project.json'), JSON.stringify({ ...defaultProject, policy: { ...defaultProject.policy, allowAutoApproval: true, allowHumanReview: true } }));
  assert.equal((await assess(root, 'sửa chữ trong một file')).flowId, 'fast');
  assert.equal((await assess(root, 'xây dựng tính năng lớn')).flowId, 'dev');
});


test('CLI and API expose authoring, diff and assessment through the shared core', async () => {
  const root = await project(), script = path.resolve('dist/src/cli/main.js');
  const { execFileSync } = await import('node:child_process');
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })) as Record<string, unknown>;
  const input = path.join(root, 'draft.json');
  await writeFile(input, JSON.stringify({ flowId: 'cli-flow', name: 'CLI flow', from: { template: 'dev' } }));
  const result = cli('flow', 'author-draft', root, input);
  assert.equal(typeof result.revision, 'string');
  assert.ok((cli('flow', 'blocks', root).nodeTypes as string[]).includes('agent_task'));
  assert.equal(cli('flow', 'author-validate', root, 'cli-flow').valid, true);
  assert.ok(((cli('flow', 'diff', root, 'cli-flow').nodes as { added: unknown[] }).added).length > 0);
  cli('flow', 'author-publish', root, 'cli-flow', result.revision as string, 'CLI author');
  const read = cli('flow', 'get', root, 'cli-flow');
  assert.equal((read.versions as { author: { kind: string } }[])[0]!.author.kind, 'ai');
  const taskFile = path.join(root, 'task.txt'); await writeFile(taskFile, 'nghiên cứu kiến trúc');
  assert.equal(cli('assess', root, '--task-file', taskFile).flowId, 'research');
  assert.equal(cli('assess', root, 'xây dựng tính năng').flowId, 'dev');
});


test('authoring API preserves human publish compatibility and rejects stale AI writes', async () => {
  const root = await project();
  const { createEditorApi } = await import('../src/ui-server/server.js');
  const editor = createEditorApi(root, async () => { throw new Error('A run manager is not needed'); });
  const create = await editor({ method: 'POST', path: '/api/flow-draft', body: { flowId: 'api-flow', from: { template: 'dev' } } });
  assert.equal(create.status, 200);
  const revision = (create.body as { revision: string }).revision;
  assert.equal((await editor({ method: 'POST', path: '/api/flows/api-flow/publish', body: { expectedRevision: revision, author: { kind: 'ai', reason: 'Requested' } } })).status, 200);
  const listing = await editor({ method: 'GET', path: '/api/flows/api-flow/versions' });
  assert.equal((listing.body as { versionInfo: { author: { kind: string } }[] }).versionInfo[0]?.author.kind, 'ai');
  const stale = await editor({ method: 'POST', path: '/api/flow-draft', body: { flowId: 'api-flow', draft: templates.dev, expectedRevision: 'f'.repeat(64) } });
  assert.equal(stale.status, 409);
  const diff = await editor({ method: 'GET', path: '/api/flows/api-flow/diff' });
  assert.equal(diff.status, 200);
  const human = await editor({ method: 'POST', path: '/api/flows/api-flow/publish' });
  assert.equal(human.status, 200); assert.equal((human.body as { version: { author: { kind: string } } }).version.author.kind, 'human');
});

test('flow blocks include existing profile permissions and project bindings', async () => {
  const root = await project();
  await draftFlow(root, { flowId: 'saved', from: { template: 'dev' } });
  const { ProfileLibrary } = await import('../src/storage/profile-library.js');
  const store = new ProfileLibrary(path.join(root, 'neomind', 'profiles'));
  await store.create('custom', 'Custom');
  const { builtinProfile } = await import('../src/runtime/project.js');
  await store.saveDraft('custom', { ...builtinProfile('implementer')!, profileId: 'custom', name: 'Custom' });
  const blocks = await flowBlocks(root);
  assert.ok(blocks.flowBindings.some(item => item?.flowId === 'saved'));
  assert.ok(blocks.profiles.some(item => item.profileId === 'custom' && 'requestedPermissions' in item && item.requestedPermissions.write));
});


test('flow diff ignores JSON object key order but reports connection changes', () => {
  const before = structuredClone(templates.dev), after = structuredClone(before);
  const original = after.definition.bindings.implementer!;
  after.definition.bindings.implementer = { fallback: original.fallback, reasoning: original.reasoning, model: original.model, provider: original.provider, runner: original.runner };
  const first = after.definition.edges[0]!;
  after.definition.edges[0] = { outcome: first.outcome, to: first.to, from: first.from };
  assert.equal(diffFlows(before, after).bindings.length, 0);
  assert.equal(diffFlows(before, after).edges.added.length, 0);
  after.definition.edges.splice(0, 1);
  assert.equal(diffFlows(before, after).edges.removed.length, 1);
});


test('assessment flags an unpublished project flow that shadows a built-in', async () => {
  const root = await project();
  await draftFlow(root, { flowId: 'dev', from: { template: 'dev' } });
  const result = await assess(root, 'triển khai tính năng mới');
  assert.equal(result.flowId, 'dev'); assert.equal(result.available, false);
  assert.ok(result.reasons.some(reason => reason.includes('chưa sẵn sàng')));
  assert.ok(!result.alternatives.includes('fast'));
});


test('authoring can inspect, validate and copy a built-in flow', async () => {
  const root = await project(), builtin = await getFlow(root, 'dev');
  assert.equal((builtin.draft as { flowId: string }).flowId, 'dev'); assert.equal(builtin.revision, null);
  assert.equal((await validateFlow(root, 'dev')).valid, true);
  const created = await draftFlow(root, { flowId: 'dev-copy', from: { flowId: 'dev' } });
  assert.deepEqual(created.diagnostics, []);
  assert.equal(((await getFlow(root, 'dev-copy')).draft as { flowId: string }).flowId, 'dev-copy');
});


test('AI draft rename does not mutate metadata when its revision is stale', async () => {
  const root = await project(), created = await draftFlow(root, { flowId: 'mine', name: 'Original', from: { template: 'dev' } });
  await assert.rejects(draftFlow(root, { flowId: 'mine', name: 'Wrong', expectedRevision: 'f'.repeat(64) }), /bị sửa/);
  assert.equal((await getFlow(root, 'mine')).metadata.name, 'Original');
  await draftFlow(root, { flowId: 'mine', name: 'New name', expectedRevision: created.revision });
  assert.equal((await getFlow(root, 'mine')).metadata.name, 'New name');
});


test('assessment prefers a matching published project flow over template defaults', async () => {
  const root = await project(), draft = structuredClone(templates.dev);
  draft.name = 'Parser chuyên dụng'; draft.description = 'Phân tích parser calculator';
  const saved = await draftFlow(root, { flowId: 'parser-flow', name: draft.name, draft });
  await publishFlow(root, 'parser-flow', { author: { kind: 'human' }, expectedRevision: saved.revision });
  const result = await assess(root, 'Phân tích parser calculator');
  assert.equal(result.flowId, 'parser-flow'); assert.equal(result.available, true);
});


test('AI time ceiling never exceeds Dev even if project ceiling is higher', () => {
  const draft = structuredClone(templates.dev); draft.definition.limits.activeTimeSeconds = 1801;
  const policy = { ...defaultProject.policy, maxActiveTimeSeconds: 3600 };
  const ai = compileFlow(draft, policy, { aiAuthored: true });
  assert.equal(ai.ok, false); if (!ai.ok) assert.ok(ai.diagnostics.some(item => item.code === 'ai_limit_exceeded'));
  assert.equal(compileFlow(draft, policy).ok, true);
});


test('concurrent AI draft renames keep the winning name and draft together', async () => {
  const root = await project(), created = await draftFlow(root, { flowId: 'mine', name: 'Original', from: { template: 'dev' } });
  const outcomes = await Promise.allSettled(['First', 'Second'].map(name => draftFlow(root, { flowId: 'mine', name, expectedRevision: created.revision })));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const result = await getFlow(root, 'mine');
  assert.ok(['First', 'Second'].includes(result.metadata.name));
  assert.equal((result.draft as { name: string }).name, result.metadata.name);
});


test('pinning run choices publishes the flow default, and a template choice becomes a new project flow', async () => {
  const opus = { runner: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5', reasoning: 'high' };
  const root = await project(), created = await draftFlow(root, { flowId: 'mine', name: 'Mine', from: { template: 'dev' } });
  await publishFlow(root, 'mine', { author: { kind: 'human' }, expectedRevision: created.revision });
  const pinned = await pinFlowBindings(root, 'mine', { values: { implement: opus }, author: { kind: 'human' } });
  assert.equal(pinned.version, 2); assert.equal(pinned.changed, true);
  assert.deepEqual(pinned.pinned[0]?.steps, ['plan', 'implement']);
  // The next run of the flow starts from the pinned choice without overrides.
  const snapshot = await snapshotProjectFlow(root, 'mine');
  assert.deepEqual(snapshot.configuration.bindings.implement?.values, opus);
  assert.deepEqual(snapshot.configuration.bindings.plan?.values, opus);
  assert.equal(snapshot.configuration.bindings['verify/required-reviewer']?.values.runner, defaultRoles.verifier!.runner);
  assert.equal((await getFlow(root, 'mine')).versions.at(-1)?.author.kind, 'human');
  // Pinning the same values again publishes nothing.
  assert.equal((await pinFlowBindings(root, 'mine', { values: { plan: opus }, author: { kind: 'human' } })).changed, false);

  // Unpublished draft edits are never published along with the pin.
  const { draft, revision } = await getFlow(root, 'mine') as { draft: typeof templates.dev; revision: string };
  await draftFlow(root, { flowId: 'mine', expectedRevision: revision, draft: { ...draft, description: 'edited' } });
  await assert.rejects(pinFlowBindings(root, 'mine', { values: { implement: { model: 'claude-sonnet-5-5' } }, author: { kind: 'human' } }), /chưa publish/);
  await assert.rejects(pinFlowBindings(root, 'mine', { values: { implement: opus }, author: { kind: 'human' }, expectedRevision: 'f'.repeat(64) }), /sửa ở nơi khác/);

  await assert.rejects(pinFlowBindings(root, 'dev', { values: { implement: opus }, author: { kind: 'human' } }), /new flow/);
  const copy = await pinFlowBindings(root, 'dev', { values: { implement: opus }, author: { kind: 'human' }, saveAs: { name: 'Dev của tôi' } });
  assert.equal(copy.flowId, 'dev-cua-toi'); assert.equal(copy.created, true); assert.equal(copy.version, 1);
  assert.deepEqual((await snapshotProjectFlow(root, 'dev-cua-toi')).configuration.bindings.implement?.values, opus);
  assert.equal((await pinFlowBindings(root, 'dev', { values: { implement: opus }, author: { kind: 'human' }, saveAs: { name: 'Dev của tôi' } })).flowId, 'dev-cua-toi-2');
  // A project flow can be copied the same way, from its latest published version.
  assert.equal((await pinFlowBindings(root, 'mine', { values: { implement: opus }, author: { kind: 'human' }, saveAs: { name: 'Dev' } })).flowId, 'dev-2');
  assert.equal(templates.dev.definition.bindings.implementer!.model.mode, 'inherit');
});

test('AI pinning follows the flow publish policy and needs the observed revision', async () => {
  const opus = { runner: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5', reasoning: 'high' };
  for (const flowPublish of ['draft-only', 'deny'] as const) {
    const root = await project({ flowPublish });
    await assert.rejects(pinFlowBindings(root, 'dev', { values: { implement: opus }, author: { kind: 'ai' }, saveAs: { name: 'Copy' } }), /disabled by project policy/);
    assert.equal('builtin' in (await getFlow(root, 'dev')).metadata, true);
  }
  const root = await project({ flowPublish: 'allow' }), created = await draftFlow(root, { flowId: 'mine', name: 'Mine', from: { template: 'dev' } });
  await publishFlow(root, 'mine', { author: { kind: 'human' }, expectedRevision: created.revision });
  await assert.rejects(pinFlowBindings(root, 'mine', { values: { implement: opus }, author: { kind: 'ai' } }), /expectedRevision/);
  const result = await pinFlowBindings(root, 'mine', { values: { implement: opus }, author: { kind: 'ai', sessionId: 's1', reason: 'User asked' }, expectedRevision: created.revision });
  assert.equal(result.version, 2); assert.equal((await getFlow(root, 'mine')).versions.at(-1)?.author.kind, 'ai');
});
