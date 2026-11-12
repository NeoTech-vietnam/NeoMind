import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject, templates } from '../src/domain/templates.js';
import { profileTemplates } from '../src/domain/profile-templates.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { createProfileFromTemplate, deleteProfile, draftProfile, publishProfile } from '../src/runtime/profile-authoring.js';
import { draftFlow, publishFlow } from '../src/runtime/flow-authoring.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { skillStatus } from '../src/storage/skill-catalog.js';
import { createSkill, deleteSkill, getSkill, readSkillFile, repinSkill, skillDocument, skillUsage, updateSkill, writeSkillFile, deleteSkillFile } from '../src/storage/skill-library.js';
import { ProfileLibrary } from '../src/storage/profile-library.js';
import { FlowLibrary } from '../src/storage/flow-library.js';
import type { Flow, Profile } from '../src/domain/schema.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-sk-')); await mkdir(path.join(root, 'neomind'));
  await writeFile(path.join(root, 'neomind/project.json'), JSON.stringify(defaultProject)); return root;
}
const ref = (skill: { id: string; path: string; sha256: string }) => ({ id: skill.id, path: skill.path, sha256: skill.sha256 });

test('skills are created in Claude format, edited with a hash guard and keep companion text files', async () => {
  const root = await fixture();
  const created = await createSkill(root, { id: 'checks', name: 'Checks', description: 'Run the checks', body: '# Steps\n\nRun npm test.\n' });
  assert.equal(created.path, 'neomind/skills/checks/SKILL.md'); assert.equal(created.editable, true);
  const text = await readFile(path.join(root, created.path), 'utf8');
  assert.match(text, /^---\nname: Checks\ndescription: Run the checks\n---\n\n# Steps/);
  assert.equal(created.prompt, `Skill Checks (checks):\n${text}`);
  await assert.rejects(createSkill(root, { id: 'checks', name: 'Again' }), /already exists/);
  await assert.rejects(createSkill(root, { id: '../escape', name: 'Bad' }));

  const updated = await updateSkill(root, 'checks', { expectedSha256: created.sha256, body: 'Run npm test and npm run build:ui.\n' });
  assert.equal(updated.skill.description, 'Run the checks'); assert.match(updated.skill.content, /build:ui/);
  await assert.rejects(updateSkill(root, 'checks', { expectedSha256: created.sha256, body: 'stale' }), /sửa ở nơi khác/);
  // Frontmatter keys NeoMind does not edit survive a rename.
  await writeFile(path.join(root, created.path), '---\nname: Checks\ndescription: d\nallowed-tools: Read\n---\nBody\n');
  const raw = await getSkill(root, 'checks'), renamed = await updateSkill(root, 'checks', { expectedSha256: raw.sha256, name: 'Checks 2' });
  assert.match(renamed.skill.content, /allowed-tools: Read/); assert.equal(renamed.skill.name, 'Checks 2');

  const file = await writeSkillFile(root, 'checks', 'docs/ref.md', 'Reference\n', null);
  await assert.rejects(writeSkillFile(root, 'checks', 'docs/ref.md', 'again', null), /đã tồn tại/);
  await writeSkillFile(root, 'checks', 'docs/ref.md', 'Reference 2\n', file.sha256);
  assert.equal((await readSkillFile(root, 'checks', 'docs/ref.md')).content, 'Reference 2\n');
  const withFile = await getSkill(root, 'checks');
  assert.deepEqual(withFile.files, ['docs/ref.md']); assert.match(withFile.prompt, /Companion files \(read only if needed and permitted\): neomind\/skills\/checks\/docs\/ref\.md$/);
  await assert.rejects(writeSkillFile(root, 'checks', '../outside.md', 'x', null), /inside the skill folder/);
  await assert.rejects(writeSkillFile(root, 'checks', 'SKILL.md', 'x', null), /updateSkill/);
  await deleteSkillFile(root, 'checks', 'docs/ref.md');
  assert.deepEqual((await getSkill(root, 'checks')).files, []);
});

test('Claude skills are readable but not editable; symlinked skill folders are refused', async () => {
  const root = await fixture();
  await mkdir(path.join(root, '.claude/skills/guide'), { recursive: true });
  await writeFile(path.join(root, '.claude/skills/guide/SKILL.md'), skillDocument({ name: 'Guide', description: 'g', body: 'Body' }));
  const claude = await getSkill(root, 'guide', 'claude'); assert.equal(claude.editable, false);
  await assert.rejects(updateSkill(root, 'guide', { expectedSha256: claude.sha256, body: 'x' }), { code: 'ENOENT' });
  await assert.rejects(createSkill(root, { id: 'guide', name: 'Shadow' }), /already exists/);
  const outside = await mkdtemp(path.join(tmpdir(), 'nm-out-')); await mkdir(path.join(root, 'neomind/skills'), { recursive: true });
  await writeFile(path.join(outside, 'SKILL.md'), 'outside');
  // A junction needs no privilege on Windows; elsewhere it is a directory symlink.
  await symlink(outside, path.join(root, 'neomind/skills/linked'), 'junction');
  await assert.rejects(getSkill(root, 'linked'), /Symlink/);
  await assert.rejects(writeSkillFile(root, 'linked', 'x.md', 'x', null), /Symlink/);
});

test('usage lists pins, delete refuses a used skill unless forced, and repin updates drafts only', async () => {
  const root = await fixture();
  const one = await createSkill(root, { id: 'one', name: 'One', body: 'v1' }), two = await createSkill(root, { id: 'two', name: 'Two', body: 'other' });
  const profile = await draftProfile(root, { profileId: 'agent', name: 'Agent', from: { profileId: 'implementer' } });
  const profiles = new ProfileLibrary(path.join(root, 'neomind/profiles')), flows = new FlowLibrary(path.join(root, 'neomind/flows'));
  const draft = (await profiles.readDraftWithRevision('agent')).draft as Profile;
  const saved = await profiles.saveDraft('agent', { ...draft, skills: [ref(one)] }, profile.revision);
  await publishProfile(root, 'agent', { author: { kind: 'human' }, expectedRevision: saved });
  const flow = structuredClone(templates.dev) as Flow, plan = flow.definition.nodes.find(node => node.id === 'plan');
  assert.ok(plan?.type === 'agent_task'); plan.skillsOverride = [ref(one)];
  const review = flow.definition.nodes.find(node => node.type === 'review_group'); assert.ok(review?.type === 'review_group'); review.reviewers[0]!.skillsOverride = [ref(one), ref(two)];
  // The fixture project has no role defaults, so a runnable flow pins every binding field.
  const pinned = (value: string) => ({ mode: 'pinned' as const, value });
  for (const binding of Object.values(flow.definition.bindings)) Object.assign(binding, { runner: pinned('codex'), provider: pinned('openai'), model: pinned('gpt-6-luna'), reasoning: pinned('low') });
  const created = await draftFlow(root, { flowId: 'mine', name: 'Mine', draft: flow }); assert.deepEqual(created.diagnostics, []);
  await publishFlow(root, 'mine', { author: { kind: 'human' }, expectedRevision: created.revision });

  const usage = await skillUsage(root, one.path);
  assert.equal(usage.profiles[0]?.profileId, 'agent'); assert.equal(usage.profiles[0]?.latest?.version, 1); assert.equal(usage.profiles[0]?.draft?.stale, false);
  assert.deepEqual(usage.flows[0]?.draft.map(item => item.nodeId.split('/')[0]), ['plan', 'verify']);
  assert.equal(usage.flows[0]?.draft.length, 2); assert.equal(usage.flows[0]?.published.length, 2);
  await assert.rejects(deleteSkill(root, 'one'), (error: Error & { usage?: unknown }) => /đang được dùng/.test(error.message) && !!error.usage);

  const edited = await updateSkill(root, 'one', { expectedSha256: one.sha256, body: 'v2' });
  assert.equal(edited.usage.profiles[0]?.draft?.stale, true);
  assert.deepEqual((await skillStatus(root, [ref(one)])).map(item => item.status), ['changed']);
  const repinned = await repinSkill(root, one.path);
  assert.deepEqual(repinned.profiles.map(item => item.profileId), ['agent']); assert.equal(repinned.flows[0]?.changed, 2);
  const profileDraft = (await profiles.readDraft('agent')) as Profile; assert.equal(profileDraft.skills[0]?.sha256, edited.skill.sha256);
  assert.equal((await profiles.readVersion('agent', 1)).skills[0]?.sha256, one.sha256, 'published profile keeps its pin');
  const flowDraft = (await flows.readDraft('mine')) as Flow, planDraft = flowDraft.definition.nodes.find(node => node.id === 'plan');
  assert.ok(planDraft?.type === 'agent_task'); assert.equal(planDraft.skillsOverride?.[0]?.sha256, edited.skill.sha256);
  const reviewDraft = flowDraft.definition.nodes.find(node => node.type === 'review_group'); assert.ok(reviewDraft?.type === 'review_group');
  assert.equal(reviewDraft.reviewers[0]!.skillsOverride?.[1]?.sha256, two.sha256, 'other skills keep their pins');
  const after = await skillUsage(root, one.path);
  assert.equal(after.profiles[0]?.draft?.stale, false); assert.equal(after.profiles[0]?.latest?.stale, true);

  const forced = await deleteSkill(root, 'one', { force: true }); assert.equal(forced.deleted, true);
  assert.deepEqual((await skillStatus(root, [ref(one)])).map(item => item.status), ['missing']);
});

test('agents from templates pin suggested skills the project has; an agent in use cannot be deleted', async () => {
  const root = await fixture();
  const checklist = await createSkill(root, { id: 'review-checklist', name: 'Checklist', template: 'review-checklist' });
  const created = await createProfileFromTemplate(root, { profileId: 'sec', name: 'Bảo mật', template: 'security-reviewer' });
  assert.deepEqual(created.draft.skills, [ref(checklist)]); assert.equal(created.draft.requestedPermissions.write, false);
  assert.equal(created.draft.instructions, profileTemplates['security-reviewer'].instructions);
  await assert.rejects(createProfileFromTemplate(root, { profileId: 'implementer', name: 'Shadow', template: 'implementer' }), /already exists/);
  const published = await publishProfile(root, 'sec', { author: { kind: 'human' }, expectedRevision: created.revision });
  const flow = structuredClone(templates.dev) as Flow, review = flow.definition.nodes.find(node => node.type === 'review_group');
  assert.ok(review?.type === 'review_group'); review.reviewers[0]!.profileId = 'sec'; review.reviewers[0]!.profileVersion = published.version;
  await draftFlow(root, { flowId: 'secure', name: 'Secure', draft: flow });
  const refused = await deleteProfile(root, 'sec');
  assert.equal(refused.deleted, false); assert.deepEqual(refused.flows.map(item => item.flowId), ['secure']);
  const spare = await createProfileFromTemplate(root, { profileId: 'spare', name: 'Spare', template: 'research' });
  assert.equal(spare.draft.requestedPermissions.checks, false);
  assert.equal((await deleteProfile(root, 'spare')).deleted, true);
});

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
async function runProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } }));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const agents = new FakeRunnerFactory('codex', { respond: async () => JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] }) },
    [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }]);
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([agents]));
  const runs = async () => manager;
  return { repo, git, manager, agents, tools: sessionToolHandlers(runs, createEditorApi(repo, runs)) };
}

test('session skill tools follow ai.skillEdit and confirmation; a step override replaces the agent skills in the prompt', async () => {
  const f = await runProject();
  try {
    const agentSkill = await f.tools.skill_create!({ skillId: 'agent-skill', name: 'Agent skill', body: 'AGENT-SKILL-TEXT' }, { sessionId: 's1' }) as { skill: { sha256: string; path: string } };
    const stepSkill = await f.tools.skill_create!({ skillId: 'step-skill', name: 'Step skill', body: 'STEP-SKILL-TEXT' }) as { skill: { sha256: string; path: string; prompt: string } };
    const read = await f.tools.skill_get!({ skillId: 'step-skill' }) as { sha256: string; prompt: string };
    assert.equal(read.sha256, stepSkill.skill.sha256);
    const withFile = await f.tools.skill_update!({ skillId: 'step-skill', expectedSha256: read.sha256, files: [{ path: 'notes.md', content: 'notes', expectedSha256: null }] }) as { skill: { prompt: string; sha256: string } };
    assert.equal(withFile.skill.sha256, read.sha256, 'companion files do not change the SKILL.md pin');

    await assert.rejects(f.tools.skill_delete!({ skillId: 'agent-skill' }), /ask them in this session first/);
    const profiles = new ProfileLibrary(path.join(f.repo, 'neomind/profiles')), { builtinProfile } = await import('../src/runtime/project.js');
    await profiles.create('implementer', 'Implementer');
    await profiles.saveDraft('implementer', { ...builtinProfile('implementer')!, skills: [{ id: 'agent-skill', path: agentSkill.skill.path, sha256: agentSkill.skill.sha256 }] });
    await profiles.publish('implementer');
    const refused = await f.tools.skill_delete!({ skillId: 'agent-skill', confirmed: true }) as { deleted: boolean; usage: { profiles: unknown[] } };
    assert.equal(refused.deleted, false); assert.equal(refused.usage.profiles.length, 1);
    const usage = await f.tools.skill_usage!({ skillId: 'agent-skill' }) as { profiles: { profileId: string }[] };
    assert.equal(usage.profiles[0]?.profileId, 'implementer');

    const flow = structuredClone(templates.dev) as Flow, plan = flow.definition.nodes.find(node => node.id === 'plan');
    assert.ok(plan?.type === 'agent_task'); plan.skillsOverride = [{ id: 'step-skill', path: stepSkill.skill.path, sha256: stepSkill.skill.sha256 }];
    const created = await draftFlow(f.repo, { flowId: 'skilled', name: 'Skilled', draft: flow });
    await publishFlow(f.repo, 'skilled', { author: { kind: 'human' }, expectedRevision: created.revision });
    const started = await f.tools.start!({ flowId: 'skilled', task: 'Add proof' }) as { runId: string; started: boolean };
    assert.equal(started.started, true);
    await f.tools.wait!({ runId: started.runId, timeoutSeconds: 30 });
    const prompts = f.agents.started.flatMap(runner => runner.turns.map(turn => turn.request.prompt));
    const planPrompt = prompts.find(prompt => prompt.includes('STEP-SKILL-TEXT'));
    assert.ok(planPrompt, 'the plan step receives its own skill');
    assert.ok(planPrompt.includes(withFile.skill.prompt), 'the editor preview is the exact prompt text');
    assert.ok(!planPrompt.includes('AGENT-SKILL-TEXT'), 'skillsOverride replaces the agent skills');

    const file = path.join(f.repo, 'neomind/project.json'), config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...config, ai: { skillEdit: 'deny' } }));
    await assert.rejects(f.tools.skill_create!({ skillId: 'blocked', name: 'Blocked' }), /ai\.skillEdit/);
    await assert.rejects(f.tools.skill_update!({ skillId: 'step-skill', expectedSha256: read.sha256, body: 'x' }), /ai\.skillEdit/);
    await assert.rejects(f.tools.skill_delete!({ skillId: 'step-skill', confirmed: true, force: true }), /ai\.skillEdit/);
    // The user can still edit through the editor API, which has no AI author.
    const api = createEditorApi(f.repo, async () => f.manager);
    assert.equal((await api({ method: 'POST', path: '/api/skills', body: { id: 'human', name: 'Human' } })).status, 201);
    const inUse = await api({ method: 'POST', path: '/api/skills/agent-skill/delete', body: {} });
    assert.equal(inUse.status, 409); assert.ok((inUse.body as { usage: unknown }).usage);
    assert.equal((await api({ method: 'POST', path: '/api/skills/agent-skill/delete', body: { force: true } })).status, 200);
    assert.equal((await api({ method: 'GET', path: '/api/skill-library' })).status, 200);
  } finally { await f.manager.close(); }
});

test('session profile_delete needs confirmation and refuses an agent in use', async () => {
  const f = await runProject();
  try {
    const api = createEditorApi(f.repo, async () => f.manager);
    assert.equal((await api({ method: 'POST', path: '/api/profiles/from-template', body: { id: 'ui', name: 'UI', template: 'ui-reviewer' } })).status, 201);
    await assert.rejects(f.tools.profile_delete!({ profileId: 'ui' }), /ask them in this session first/);
    const flow = structuredClone(templates.dev) as Flow, review = flow.definition.nodes.find(node => node.type === 'review_group');
    assert.ok(review?.type === 'review_group'); review.reviewers[0]!.profileId = 'ui';
    await draftFlow(f.repo, { flowId: 'uses-ui', name: 'Uses UI', draft: flow });
    const refused = await f.tools.profile_delete!({ profileId: 'ui', confirmed: true }) as { deleted: boolean; flows: { flowId: string }[] };
    assert.equal(refused.deleted, false); assert.equal(refused.flows[0]?.flowId, 'uses-ui');
    assert.deepEqual(await f.tools.profile_archive!({ profileId: 'ui' }), { archived: true, flows: [{ flowId: 'uses-ui', name: 'Uses UI' }] });
    assert.equal((await new ProfileLibrary(path.join(f.repo, 'neomind/profiles')).metadata('ui')).archived, true);
  } finally { await f.manager.close(); }
});
