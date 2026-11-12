import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { skillCatalog, skillStatus } from '../src/storage/skill-catalog.js';
import { defaultProject, templates } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { draftProfile, getProfile, getProfileVersion, migrateProfile, profileUsage, publishProfile } from '../src/runtime/profile-authoring.js';
import { draftFlow, publishFlow } from '../src/runtime/flow-authoring.js';
import { fileSymlink } from './helpers/symlink.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-skill-')); await mkdir(path.join(root, 'neomind'));
  await writeFile(path.join(root, 'neomind/project.json'), JSON.stringify(defaultProject)); return root;
}

test('catalog reads both sources, YAML metadata and detects changed/missing skills', async () => {
  const root = await fixture();
  for (const folder of ['.claude/skills/one', 'neomind/skills/two']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, '.claude/skills/one/SKILL.md'), '---\nname: "Skill One"\ndescription: >\n  First line\n  second line\n---\nInstructions\n');
  await writeFile(path.join(root, 'neomind/skills/two/SKILL.md'), '---\nname: Skill Two\ndescription: Second\n---\nInstructions\n');
  const skills = await skillCatalog(root); assert.deepEqual(skills.map(item => item.source), ['claude', 'neomind']);
  assert.equal(skills[0]?.name, 'Skill One'); assert.equal(skills[0]?.description, 'First line second line');
  assert.deepEqual((await skillStatus(root, skills)).map(item => item.status), ['ok', 'ok']);
  await writeFile(path.join(root, skills[0]!.path), 'changed'); await rm(path.join(root, skills[1]!.path));
  assert.deepEqual((await skillStatus(root, skills)).map(item => item.status), ['changed', 'missing']);
});

test('profile authoring retains old version hashes and respects AI policy', async () => {
  const root = await fixture(), created = await draftProfile(root, { profileId: 'custom', from: { profileId: 'implementer' } });
  assert.deepEqual(created.diagnostics, []);
  const first = await publishProfile(root, 'custom', { author: { kind: 'ai', sessionId: 's1', reason: 'test' }, expectedRevision: created.revision });
  assert.equal(first.author?.kind, 'ai'); assert.equal((await getProfileVersion(root, 'custom', 1)).version, 1);
  assert.equal((await getProfile(root, 'custom')).versions[0]?.author.kind, 'ai');
  await writeFile(path.join(root, 'neomind/project.json'), JSON.stringify({ ...defaultProject, ai: { profilePublish: 'draft-only' } }));
  await assert.rejects(publishProfile(root, 'custom', { author: { kind: 'ai' }, expectedRevision: created.revision }), /disabled/);
  await writeFile(path.join(root, 'neomind/project.json'), JSON.stringify({ ...defaultProject, ai: { profilePublish: 'deny' } }));
  await assert.rejects(draftProfile(root, { profileId: 'another', from: { profileId: 'implementer' } }), /disabled/);
  assert.equal(builtinProfile('implementer')?.version, 1);
});

test('migration changes selected drafts only and rejects stale revisions', async () => {
  const root = await fixture(), p = await draftProfile(root, { profileId: 'custom', from: { profileId: 'implementer' } });
  await publishProfile(root, 'custom', { author: { kind: 'human' }, expectedRevision: p.revision });
  await publishProfile(root, 'custom', { author: { kind: 'human' }, expectedRevision: p.revision });
  const draft = structuredClone(templates.dev); const node = draft.definition.nodes.find(item => item.id === 'implement'); assert.ok(node?.type === 'agent_task'); node.profileId = 'custom'; node.profileVersion = 1;
  // The project has no role defaults, so a runnable flow pins every binding field.
  const pinned = (value: string) => ({ mode: 'pinned' as const, value });
  for (const binding of Object.values(draft.definition.bindings)) Object.assign(binding, { runner: pinned('codex'), provider: pinned('openai'), model: pinned('gpt-6-luna'), reasoning: pinned('low') });
  const created = await draftFlow(root, { flowId: 'mine', draft });
  assert.deepEqual(created.diagnostics, []);
  await publishFlow(root, 'mine', { author: { kind: 'human' }, expectedRevision: created.revision });
  const before = await profileUsage(root, 'custom'); assert.equal(before[0]?.draft[0]?.version, 1); assert.equal(before[0]?.published[0]?.version, 1);
  const stale = await migrateProfile(root, 'custom', 2, [{ flowId: 'mine', expectedRevision: 'f'.repeat(64) }]); assert.ok(stale.results[0]?.error);
  const result = await migrateProfile(root, 'custom', 2, [{ flowId: 'mine', expectedRevision: created.revision }]); assert.equal(result.results[0]?.changed, 1);
  const after = await profileUsage(root, 'custom'); assert.equal(after[0]?.draft[0]?.version, 2); assert.equal(after[0]?.published[0]?.version, 1);
});

test('catalog refuses a skill symlink outside the project', async t => {
  const root = await fixture(), outside = await mkdtemp(path.join(tmpdir(), 'nm-out-'));
  await mkdir(path.join(root, '.claude/skills/escape'), { recursive: true }); await writeFile(path.join(outside, 'secret.md'), 'secret');
  if (await fileSymlink(t, path.join(outside, 'secret.md'), path.join(root, '.claude/skills/escape/SKILL.md'))) await assert.rejects(skillCatalog(root), /escapes project root/);
});

test('API and CLI expose catalog, authored versions and migration through shared core', async () => {
  const root = await fixture(), { createEditorApi } = await import('../src/ui-server/server.js');
  const api = createEditorApi(root, async () => { throw new Error('No runner needed'); });
  const draft = await api({ method: 'POST', path: '/api/profile-draft', body: { profileId: 'custom', from: { profileId: 'implementer' } } });
  assert.equal(draft.status, 200); const revision = (draft.body as { revision: string }).revision;
  const published = await api({ method: 'POST', path: '/api/profiles/custom/publish', body: { expectedRevision: revision, author: { kind: 'ai', reason: 'test' } } });
  assert.equal(published.status, 200);
  assert.equal((await api({ method: 'GET', path: '/api/profiles/custom/versions/1' })).status, 200);
  assert.equal((await api({ method: 'GET', path: '/api/profiles/custom/skills-status' })).status, 200);
  assert.equal((await api({ method: 'GET', path: '/api/profiles/custom/usage' })).status, 200);
  assert.equal((await api({ method: 'GET', path: '/api/skills' })).status, 200);
  const { execFileSync } = await import('node:child_process'), script = path.resolve('dist/src/cli/main.js');
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })) as Record<string, unknown>;
  assert.ok(Array.isArray(cli('skills', root).skills));
  assert.equal((cli('profile', 'version', root, 'custom', '1').version as { author: { kind: string } }).author.kind, 'ai');
  assert.ok(Array.isArray(cli('profile', 'usage', root, 'custom').flows));
});
