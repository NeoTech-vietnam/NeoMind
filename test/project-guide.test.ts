import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDefaultMemoryRoot } from '../src/memory/project-root.js';
import { readProject } from '../src/runtime/project.js';
import { initProject } from '../src/runtime/project-init.js';
import { SESSION_TOOLS, sessionToolHandlers } from '../src/runtime/session-tools.js';
import { FlowLibrary } from '../src/storage/flow-library.js';
import { ProfileLibrary } from '../src/storage/profile-library.js';
import { projectDir } from '../src/storage/project-dir.js';
import { GUIDE_REFERENCE, installProjectGuide, PROJECT_GUIDE_PATH, PROJECT_GUIDE_PATHS, SHARED_GUIDE_PATH } from '../src/storage/project-guide.js';
import { FLOW_AUTHORING_SKILL } from '../src/storage/project-guide-skill.js';
import { skillCatalog } from '../src/storage/skill-catalog.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { fileSymlink } from './helpers/symlink.js';

const cli = path.resolve('dist/src/cli/main.js');
// The exact lines NeoMind's own AGENTS.md uses.
const SECTION = '## References\n\n- Authoring NeoMind flows: read .claude/skills/neomind-flow-authoring/SKILL.md first.\n';
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-guide-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}
const guide = (root: string) => path.join(root, ...PROJECT_GUIDE_PATH.split('/'));
const shared = (root: string) => path.join(root, ...SHARED_GUIDE_PATH.split('/'));
const statuses = (result: { guides: { status: string }[] }) => result.guides.map(item => item.status);
const flows = (root: string) => new FlowLibrary(path.join(projectDir(root), 'flows'));

test('the guide NeoMind ships is the repository\'s .claude/skills/neomind-flow-authoring/SKILL.md and its .agents/skills copy', async () => {
  for (const file of PROJECT_GUIDE_PATHS) {
    const source = (await readFile(path.resolve(file), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(FLOW_AUTHORING_SKILL, source, `run \`node scripts/sync-project-guide.mjs\` after editing the skill (${file})`);
  }
  assert.match(FLOW_AUTHORING_SKILL, /^---\nname: neomind-flow-authoring\n/);
});

test('the first write that creates neomind/ installs the guide once; later writes and reads leave .claude/ alone', async () => {
  const root = await repository();
  try {
    await readProject(root); await skillCatalog(root); await flows(root).list();
    assert.ok(!existsSync(path.join(root, 'neomind')) && !existsSync(path.join(root, '.claude')) && !existsSync(path.join(root, '.agents')) && !existsSync(path.join(root, 'AGENTS.md')), 'reading a project configures nothing');
    await flows(root).create('first', 'First');
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL);
    assert.equal(await readFile(shared(root), 'utf8'), FLOW_AUTHORING_SKILL, 'Codex and OpenCode scan .agents/skills');
    assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), SECTION, 'agent instructions point at the guide');
    const listed = (await skillCatalog(root)).find(skill => skill.id === 'neomind-flow-authoring');
    assert.deepEqual([listed?.path, listed?.shadowed?.map(item => item.path)], [SHARED_GUIDE_PATH, [PROJECT_GUIDE_PATH]], 'listed once, from .agents/skills');
    await rm(path.join(root, '.claude'), { recursive: true }); await rm(path.join(root, '.agents'), { recursive: true }); await rm(path.join(root, 'AGENTS.md'));
    await flows(root).create('second', 'Second');
    await new ProfileLibrary(path.join(projectDir(root), 'profiles')).create('custom', 'Custom');
    assert.ok(!existsSync(path.join(root, '.claude')) && !existsSync(path.join(root, '.agents')) && !existsSync(path.join(root, 'AGENTS.md')), 'a guide the user removed is not reinstalled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a guide the user already has is kept when NeoMind configures the project, the other copy is still created, and the memory path installs both', async () => {
  const root = await repository();
  try {
    await mkdir(path.dirname(guide(root)), { recursive: true }); await writeFile(guide(root), 'my own notes\n');
    await new ProfileLibrary(path.join(projectDir(root), 'profiles')).create('custom', 'Custom');
    assert.equal(await readFile(guide(root), 'utf8'), 'my own notes\n');
    assert.equal(await readFile(shared(root), 'utf8'), FLOW_AUTHORING_SKILL);
    assert.deepEqual(installProjectGuide(root), [{ path: SHARED_GUIDE_PATH, status: 'up-to-date' }, { path: PROJECT_GUIDE_PATH, status: 'modified-kept' }]);
    await writeFile(guide(root), FLOW_AUTHORING_SKILL.replace(/\n/g, '\r\n'));
    assert.deepEqual(statuses({ guides: installProjectGuide(root) }), ['up-to-date', 'up-to-date'], 'a CRLF checkout of the same guide is not a user edit');
  } finally { await rm(root, { recursive: true, force: true }); }
  const memory = await repository();
  try {
    resolveDefaultMemoryRoot(memory, true);
    assert.equal(await readFile(guide(memory), 'utf8'), FLOW_AUTHORING_SKILL);
    assert.equal(await readFile(shared(memory), 'utf8'), FLOW_AUTHORING_SKILL);
  } finally { await rm(memory, { recursive: true, force: true }); }
});

test('init creates neomind/, the default project.json and both copies of the guide, is idempotent, and rewrites an edited copy only with force', async () => {
  const root = await repository();
  try {
    const defaults = await readProject(root);
    const first = await initProject(root);
    assert.deepEqual([first.directory, first.projectJson, ...first.guides], [
      { path: 'neomind', status: 'created' }, { path: 'neomind/project.json', status: 'created' },
      { path: SHARED_GUIDE_PATH, status: 'created' }, { path: PROJECT_GUIDE_PATH, status: 'created' }]);
    assert.deepEqual(first.agents, { path: 'AGENTS.md', status: 'created' }); assert.equal(first.claude, undefined);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'neomind/project.json'), 'utf8')), defaults, 'same defaults a missing project.json reads as');
    assert.deepEqual(await readProject(root), defaults);
    const again = await initProject(root);
    assert.deepEqual([again.directory.status, again.projectJson.status, ...statuses(again), again.agents.status], ['existing', 'existing', 'up-to-date', 'up-to-date', 'present']);
    await writeFile(guide(root), 'edited\n'); await writeFile(shared(root), 'shared edit\n');
    assert.deepEqual(statuses(await initProject(root)), ['modified-kept', 'modified-kept']);
    assert.equal(await readFile(guide(root), 'utf8'), 'edited\n'); assert.equal(await readFile(shared(root), 'utf8'), 'shared edit\n');
    assert.deepEqual(statuses(await initProject(root, { force: true })), ['replaced', 'replaced']);
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL); assert.equal(await readFile(shared(root), 'utf8'), FLOW_AUTHORING_SKILL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('init in a project NeoMind configured before .agents/skills adds that copy without force', async () => {
  const root = await repository();
  try {
    await mkdir(path.join(root, 'neomind')); await mkdir(path.dirname(guide(root)), { recursive: true }); await writeFile(guide(root), FLOW_AUTHORING_SKILL);
    await writeFile(path.join(root, 'AGENTS.md'), `# Rules\n\n${SECTION}`);
    const result = await initProject(root);
    assert.deepEqual([...statuses(result), result.agents.status], ['created', 'up-to-date', 'present']);
    assert.equal(await readFile(shared(root), 'utf8'), FLOW_AUTHORING_SKILL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('init keeps an existing project.json and policy, and works in a legacy .neomind/ project', async () => {
  const root = await repository();
  try {
    await mkdir(path.join(root, '.neomind'));
    const config = JSON.stringify({ ...(await readProject(root)), projectId: 'kept', policy: { ...(await readProject(root)).policy, maxRepairRounds: 1 } });
    await writeFile(path.join(root, '.neomind/project.json'), config);
    const result = await initProject(root);
    assert.deepEqual([result.directory, result.projectJson.status, ...statuses(result)], [{ path: '.neomind', status: 'existing' }, 'existing', 'created', 'created']);
    assert.equal(await readFile(path.join(root, '.neomind/project.json'), 'utf8'), config);
    assert.ok(!existsSync(path.join(root, 'neomind')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the editor API, the project_init session tool and the CLI share the same init', async () => {
  const root = await repository();
  try {
    type Init = { guides: { path: string; status: string }[] };
    const api = createEditorApi(root, async () => { throw new Error('init needs no runs'); });
    const tools = sessionToolHandlers(async () => { throw new Error('init needs no runs'); }, api);
    const response = await api({ method: 'POST', path: '/api/project/init', body: {} });
    assert.equal(response.status, 200); assert.deepEqual((response.body as Init).guides.map(item => item.path), [SHARED_GUIDE_PATH, PROJECT_GUIDE_PATH]);
    assert.deepEqual(statuses(response.body as Init), ['created', 'created']);
    await writeFile(guide(root), 'edited\n');
    assert.deepEqual(statuses(await tools.project_init!({}) as Init), ['up-to-date', 'modified-kept']);
    await assert.rejects(tools.project_init!({ force: true }), /confirmed: true/);
    assert.deepEqual(statuses(await tools.project_init!({ force: true, confirmed: true }) as Init), ['up-to-date', 'replaced']);
    await writeFile(guide(root), 'edited again\n');
    const kept = spawnSync(process.execPath, [cli, 'init', root], { encoding: 'utf8' });
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /neomind: đã có, giữ nguyên/); assert.match(kept.stdout, /AGENTS\.md: đã có tham chiếu skill, giữ nguyên/);
    assert.match(kept.stdout, /\.agents\/skills\/neomind-flow-authoring\/SKILL\.md: đã có, đúng bản hiện tại/);
    assert.match(kept.stdout, /\.claude\/skills\/neomind-flow-authoring\/SKILL\.md: đã bị sửa, giữ nguyên \(ghi đè: --force\)/);
    const forced = spawnSync(process.execPath, [cli, 'init', root, '--force'], { encoding: 'utf8' });
    assert.equal(forced.status, 0, forced.stderr); assert.match(forced.stdout, /\.claude\/skills\/neomind-flow-authoring\/SKILL\.md: đã ghi đè/);
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL);
    assert.equal(spawnSync(process.execPath, [cli, 'init'], { encoding: 'utf8' }).status, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function initWith(files: Record<string, string | Buffer>) {
  const root = await repository();
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return { root, result: await initProject(root), read: (name: string) => readFile(path.join(root, name)) };
}

test('init appends the guide reference to an AGENTS.md, keeping its line endings and encoding', async () => {
  const cases: Array<[string, string | Buffer, string | Buffer]> = [
    ['LF, no References section', '# Project\n\nRules.\n', `# Project\n\nRules.\n\n${SECTION}`],
    ['CRLF without final newline', '# Project\r\n\r\nRules.', `# Project\r\n\r\nRules.\r\n\r\n${SECTION.replace(/\n/g, '\r\n')}`],
    ['existing References section, UTF-8 with BOM', '﻿# Dự án\n\n## References\n\n- Other doc\n\n## Ghi chú\n\n```\n## References\n```\n',
      `﻿# Dự án\n\n## References\n\n- Other doc\n${GUIDE_REFERENCE}\n\n## Ghi chú\n\n\`\`\`\n## References\n\`\`\`\n`],
    ['empty References section at the end, CRLF', '# P\r\n\r\n## References\r\n', `# P\r\n\r\n## References\r\n\r\n${GUIDE_REFERENCE}\r\n`],
    ['UTF-16LE', Buffer.from('﻿# Dự án\r\n', 'utf16le'), Buffer.from(`﻿# Dự án\r\n\r\n${SECTION.replace(/\n/g, '\r\n')}`, 'utf16le')],
  ];
  for (const [name, before, after] of cases) {
    const { root, result, read } = await initWith({ 'AGENTS.md': before });
    try {
      assert.deepEqual(result.agents, { path: 'AGENTS.md', status: 'appended' }, name);
      assert.deepEqual(await read('AGENTS.md'), Buffer.isBuffer(after) ? after : Buffer.from(after, 'utf8'), name);
      const again = await initProject(root), forced = await initProject(root, { force: true });
      assert.deepEqual([again.agents.status, forced.agents.status], ['present', 'present'], name);
      assert.deepEqual(await read('AGENTS.md'), Buffer.isBuffer(after) ? after : Buffer.from(after, 'utf8'), `${name}: init again and --force change nothing`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('init leaves an AGENTS.md that already names the guide byte for byte, and never touches CLAUDE.md next to it', async () => {
  const claude = 'Claude rules\n';
  // A line naming the .agents/skills copy counts too.
  for (const own of ['Rules\r\nBefore writing a flow see `.claude/skills/neomind-flow-authoring/SKILL.md`.', '- Flows: .agents/skills/neomind-flow-authoring/SKILL.md\n']) {
    const { root, result, read } = await initWith({ 'AGENTS.md': own, 'CLAUDE.md': claude });
    try {
      assert.deepEqual(result.agents, { path: 'AGENTS.md', status: 'present' }); assert.equal(result.claude, undefined);
      assert.equal((await read('AGENTS.md')).toString('utf8'), own); assert.equal((await read('CLAUDE.md')).toString('utf8'), claude);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('a repository with only CLAUDE.md gets AGENTS.md for Codex, and the reference in CLAUDE.md unless it imports AGENTS.md', async () => {
  const plain = await initWith({ 'CLAUDE.md': '# Rules\n' });
  try {
    assert.deepEqual([plain.result.agents, plain.result.claude], [{ path: 'AGENTS.md', status: 'created' }, { path: 'CLAUDE.md', status: 'appended' }]);
    assert.equal((await plain.read('AGENTS.md')).toString('utf8'), SECTION);
    assert.equal((await plain.read('CLAUDE.md')).toString('utf8'), `# Rules\n\n${SECTION}`);
    const again = await initProject(plain.root);
    assert.deepEqual([again.agents.status, again.claude], ['present', undefined]);
  } finally { await rm(plain.root, { recursive: true, force: true }); }
  const importing = await initWith({ 'CLAUDE.md': '# Rules\n\n@AGENTS.md\n' });
  try {
    assert.deepEqual(importing.result.claude, { path: 'CLAUDE.md', status: 'present' });
    assert.equal((await importing.read('CLAUDE.md')).toString('utf8'), '# Rules\n\n@AGENTS.md\n');
  } finally { await rm(importing.root, { recursive: true, force: true }); }
});

test('the reference is never written through a symlinked AGENTS.md; the first write only warns', async t => {
  const root = await repository(), outside = await mkdtemp(path.join(tmpdir(), 'neomind-outside-'));
  try {
    await writeFile(path.join(outside, 'AGENTS.md'), 'outside\n');
    // Without the file-symlink privilege on Windows a junction is the link available; lstat reports both as symlinks.
    if (!await fileSymlink(t, path.join(outside, 'AGENTS.md'), path.join(root, 'AGENTS.md'))) await symlink(outside, path.join(root, 'AGENTS.md'), 'junction');
    const warn = t.mock.method(console, 'warn', () => {});
    await flows(root).create('first', 'First');
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /AGENTS\.md qua symlink/);
    assert.equal(await readFile(guide(root), 'utf8'), FLOW_AUTHORING_SKILL, 'the guide itself is still installed');
    await assert.rejects(initProject(root), /AGENTS\.md qua symlink/);
    assert.deepEqual(await readdir(outside), ['AGENTS.md']);
    assert.equal(await readFile(path.join(outside, 'AGENTS.md'), 'utf8'), 'outside\n');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('the tools that author flows, profiles and skills tell the agent to read the guide first', () => {
  const authoring = ['flow_draft', 'flow_validate', 'flow_publish', 'flow_pin_bindings', 'profile_draft', 'profile_publish', 'skill_create', 'skill_update'];
  for (const tool of SESSION_TOOLS) {
    const mentions = tool.description.includes(`read ${PROJECT_GUIDE_PATH} (run project_init if it is missing)`);
    assert.equal(mentions, authoring.includes(tool.name), tool.name);
  }
});
