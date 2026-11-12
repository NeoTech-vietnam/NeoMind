import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDefaultMemoryRoot } from '../src/memory/project-root.js';
import { readProject } from '../src/runtime/project.js';
import { initProject } from '../src/runtime/project-init.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { FlowLibrary } from '../src/storage/flow-library.js';
import { ProfileLibrary } from '../src/storage/profile-library.js';
import { projectDir } from '../src/storage/project-dir.js';
import { installProjectGuide, PROJECT_GUIDE_PATH } from '../src/storage/project-guide.js';
import { FLOW_AUTHORING_SKILL } from '../src/storage/project-guide-skill.js';
import { skillCatalog } from '../src/storage/skill-catalog.js';
import { createEditorApi } from '../src/ui-server/server.js';

const cli = path.resolve('dist/src/cli/main.js');
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-guide-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}
const guide = (root: string) => path.join(root, ...PROJECT_GUIDE_PATH.split('/'));
const flows = (root: string) => new FlowLibrary(path.join(projectDir(root), 'flows'));

test('the guide NeoMind ships is the repository\'s .claude/skills/neomind-flow-authoring/SKILL.md', async () => {
  const source = (await readFile(path.resolve(PROJECT_GUIDE_PATH), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(FLOW_AUTHORING_SKILL, source, 'run `node scripts/sync-project-guide.mjs` after editing the skill');
  assert.match(FLOW_AUTHORING_SKILL, /^---\nname: neomind-flow-authoring\n/);
});

test('the first write that creates neomind/ installs the guide once; later writes and reads leave .claude/ alone', async () => {
  const root = await repository();
  try {
    await readProject(root); await skillCatalog(root); await flows(root).list();
    assert.ok(!existsSync(path.join(root, 'neomind')) && !existsSync(path.join(root, '.claude')), 'reading a project configures nothing');
    await flows(root).create('first', 'First');
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL);
    assert.ok((await skillCatalog(root)).some(skill => skill.id === 'neomind-flow-authoring'), 'agents find it as a Claude skill');
    await rm(path.join(root, '.claude'), { recursive: true });
    await flows(root).create('second', 'Second');
    await new ProfileLibrary(path.join(projectDir(root), 'profiles')).create('custom', 'Custom');
    assert.ok(!existsSync(path.join(root, '.claude')), 'a guide the user removed is not reinstalled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a guide the user already has is kept when NeoMind configures the project, and the memory path installs it too', async () => {
  const root = await repository();
  try {
    await mkdir(path.dirname(guide(root)), { recursive: true }); await writeFile(guide(root), 'my own notes\n');
    await new ProfileLibrary(path.join(projectDir(root), 'profiles')).create('custom', 'Custom');
    assert.equal(await readFile(guide(root), 'utf8'), 'my own notes\n');
    assert.deepEqual(installProjectGuide(root), { path: PROJECT_GUIDE_PATH, status: 'modified-kept' });
    await writeFile(guide(root), FLOW_AUTHORING_SKILL.replace(/\n/g, '\r\n'));
    assert.equal(installProjectGuide(root).status, 'up-to-date', 'a CRLF checkout of the same guide is not a user edit');
  } finally { await rm(root, { recursive: true, force: true }); }
  const memory = await repository();
  try {
    resolveDefaultMemoryRoot(memory, true);
    assert.equal(await readFile(guide(memory), 'utf8'), FLOW_AUTHORING_SKILL);
  } finally { await rm(memory, { recursive: true, force: true }); }
});

test('init creates neomind/, the default project.json and the guide, is idempotent, and rewrites an edited guide only with force', async () => {
  const root = await repository();
  try {
    const defaults = await readProject(root);
    const first = await initProject(root);
    assert.deepEqual([first.directory, first.projectJson, first.guide], [
      { path: 'neomind', status: 'created' }, { path: 'neomind/project.json', status: 'created' }, { path: PROJECT_GUIDE_PATH, status: 'created' }]);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'neomind/project.json'), 'utf8')), defaults, 'same defaults a missing project.json reads as');
    assert.deepEqual(await readProject(root), defaults);
    const again = await initProject(root);
    assert.deepEqual([again.directory.status, again.projectJson.status, again.guide.status], ['existing', 'existing', 'up-to-date']);
    await writeFile(guide(root), 'edited\n');
    assert.equal((await initProject(root)).guide.status, 'modified-kept');
    assert.equal(await readFile(guide(root), 'utf8'), 'edited\n');
    assert.equal((await initProject(root, { force: true })).guide.status, 'replaced');
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('init keeps an existing project.json and policy, and works in a legacy .neomind/ project', async () => {
  const root = await repository();
  try {
    await mkdir(path.join(root, '.neomind'));
    const config = JSON.stringify({ ...(await readProject(root)), projectId: 'kept', policy: { ...(await readProject(root)).policy, maxRepairRounds: 1 } });
    await writeFile(path.join(root, '.neomind/project.json'), config);
    const result = await initProject(root);
    assert.deepEqual([result.directory, result.projectJson.status, result.guide.status], [{ path: '.neomind', status: 'existing' }, 'existing', 'created']);
    assert.equal(await readFile(path.join(root, '.neomind/project.json'), 'utf8'), config);
    assert.ok(!existsSync(path.join(root, 'neomind')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the editor API, the project_init session tool and the CLI share the same init', async () => {
  const root = await repository();
  try {
    const api = createEditorApi(root, async () => { throw new Error('init needs no runs'); });
    const tools = sessionToolHandlers(async () => { throw new Error('init needs no runs'); }, api);
    const response = await api({ method: 'POST', path: '/api/project/init', body: {} });
    assert.equal(response.status, 200); assert.equal((response.body as { guide: { status: string } }).guide.status, 'created');
    await writeFile(guide(root), 'edited\n');
    assert.equal((await tools.project_init!({}) as { guide: { status: string } }).guide.status, 'modified-kept');
    await assert.rejects(tools.project_init!({ force: true }), /confirmed: true/);
    assert.equal((await tools.project_init!({ force: true, confirmed: true }) as { guide: { status: string } }).guide.status, 'replaced');
    await writeFile(guide(root), 'edited again\n');
    const kept = spawnSync(process.execPath, [cli, 'init', root], { encoding: 'utf8' });
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /neomind: đã có, giữ nguyên/); assert.match(kept.stdout, /SKILL\.md: đã bị sửa, giữ nguyên \(ghi đè: --force\)/);
    const forced = spawnSync(process.execPath, [cli, 'init', root, '--force'], { encoding: 'utf8' });
    assert.equal(forced.status, 0, forced.stderr); assert.match(forced.stdout, /SKILL\.md: đã ghi đè/);
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL);
    assert.equal(spawnSync(process.execPath, [cli, 'init'], { encoding: 'utf8' }).status, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
