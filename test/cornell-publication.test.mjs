import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, getRecord } from '../dist/storage.js';
import { beginWorkflow, readAutomationPolicy } from '../dist/manager.js';
import { reviewRecord } from '../dist/engineering.js';
import { createCornellNote } from '../dist/notes.js';
import { configureCornellDestination, prepareCornellExport, applyCornellExport } from '../dist/cornell-workflow.js';
import { prepareCornellPublication, publishCornellExport } from '../dist/cornell-publication.js';
import { cornellFixture } from './cornell-fixture.mjs';

function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000, ...options });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-publish-source-'));
  const notesRoot = mkdtempSync(join(tmpdir(), 'neomind-publish-notes-'));
  const remote = mkdtempSync(join(tmpdir(), 'neomind publish remote '));
  t.after(() => { for (const directory of [root, notesRoot, remote]) rmSync(directory, { recursive: true, force: true }); });
  initialize(root, { project_id: 'PUBNOTE' });
  const workflow = beginWorkflow(root, { requirement: 'Document a checked export with separate practice and answers.', execution_mode: 'copilot-native' });
  const requirement = getRecord(root, workflow.meta.data.requirement_id);
  const note = createCornellNote(root, cornellFixture(workflow.meta.id, requirement.meta.id));
  reviewRecord(root, note.meta.id, 'reviewer', 'pass', [], 'independent-publication-review');
  const policy = readAutomationPolicy(root);
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ ...policy, network_policy: 'remote-enabled' }));
  git(remote, ['init', '--bare', '--quiet']);
  git(notesRoot, ['init', '-b', 'main', '--quiet']);
  git(notesRoot, ['config', 'user.name', 'Fixture Author']); git(notesRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(notesRoot, 'README.md'), '# Existing notes repository\n');
  git(notesRoot, ['add', 'README.md']); git(notesRoot, ['commit', '-m', 'Initial notes', '--quiet']);
  git(notesRoot, ['remote', 'add', 'origin', remote]); git(notesRoot, ['push', '--quiet', 'origin', 'main']);
  configureCornellDestination(root, { notes_root: notesRoot });
  const exported = prepareCornellExport(root, { note_id: note.meta.id, expected_revision: note.meta.revision });
  assert.equal(exported.status, 'ready'); applyCornellExport(root, { plan_hash: exported.plan_hash });
  writeFileSync(join(notesRoot, 'staged.txt'), 'Unrelated staged note must stay local.\n'); git(notesRoot, ['add', 'staged.txt']);
  writeFileSync(join(notesRoot, 'README.md'), '# My unfinished notes edit\n');
  writeFileSync(join(notesRoot, 'untracked.txt'), 'Unrelated untracked note must stay local.\n');
  return { root, notesRoot, remote, note, exported };
}
function snapshot(work) {
  const status = git(work.notesRoot, ['status', '--porcelain=v1']);
  return { status, index: readFileSync(join(work.notesRoot, '.git/index')).toString('base64'),
    head: git(work.notesRoot, ['rev-parse', 'HEAD']), branch: git(work.notesRoot, ['branch', '--show-current']),
    readme: readFileSync(join(work.notesRoot, 'README.md'), 'utf8') };
}

test('exact publication preview and real local-bare push exclude unrelated staged, unstaged and untracked notes', t => {
  const work = setup(t), before = snapshot(work);
  const input = { plan_hash: work.exported.plan_hash, remote: 'origin', base_branch: 'main' };
  const prepared = prepareCornellPublication(work.root, input);
  assert.deepEqual(prepareCornellPublication(work.root, input), prepared);
  assert.deepEqual(snapshot(work), before, 'Preview preserves the actual Git index, branch and worktree');
  assert.match(prepared.branch, /^codex\/neomind-notes\/[a-f0-9]{24}$/);
  const result = publishCornellExport(work.root, { publication_hash: prepared.publication_hash });
  assert.equal(result.status, 'branch-published'); assert.equal(result.commit, prepared.commit);
  assert.deepEqual(publishCornellExport(work.root, { publication_hash: prepared.publication_hash }), result);
  assert.equal(git(work.remote, ['rev-parse', `refs/heads/${result.branch}`]), prepared.commit);
  const changed = git(work.remote, ['diff', '--name-only', 'main', `refs/heads/${result.branch}`]).split(/\r?\n/).sort();
  assert.deepEqual(changed, prepared.files.map(file => file.path).sort());
  assert.ok(changed.every(path => path.startsWith('00_note/NeoMind/')));
  assert.deepEqual(snapshot(work), before, 'Push also preserves the actual user index, local branch and worktree');
  const provenance = work.exported.files.find(file => file.path.endsWith('/provenance.json'));
  assert.ok(provenance); assert.doesNotMatch(Buffer.from(provenance.content_base64, 'base64').toString('utf8'), /notes_root|[A-Za-z]:\\/);
});

test('changed source, advanced base or a preexisting different publication branch cannot be pushed', t => {
  for (const change of ['source', 'base', 'branch']) {
    const work = setup(t), prepared = prepareCornellPublication(work.root, { plan_hash: work.exported.plan_hash, remote: 'origin', base_branch: 'main' });
    if (change === 'source') writeFileSync(join(work.root, work.note.meta.data.artifact_path), '# My edited source note\n');
    if (change === 'base') {
      const tree = git(work.remote, ['rev-parse', 'main^{tree}']);
      const commit = git(work.remote, ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', prepared.base_commit, '-m', 'Advance fixture base']);
      git(work.remote, ['update-ref', 'refs/heads/main', commit]);
    }
    if (change === 'branch') git(work.notesRoot, ['push', '--quiet', 'origin', `HEAD:refs/heads/${prepared.branch}`]);
    assert.throws(() => publishCornellExport(work.root, { publication_hash: prepared.publication_hash }), /changed|advanced|diverged/);
    if (change === 'branch') assert.equal(git(work.remote, ['rev-parse', `refs/heads/${prepared.branch}`]), prepared.base_commit);
    else assert.equal(git(work.remote, ['for-each-ref', '--format=%(refname)', `refs/heads/${prepared.branch}`]), '');
  }
});

test('an exact published branch recovers its missing receipt after the source advances without another push', t => {
  const work = setup(t);
  const prepared = prepareCornellPublication(work.root, { plan_hash: work.exported.plan_hash, remote: 'origin', base_branch: 'main' });
  const published = publishCornellExport(work.root, { publication_hash: prepared.publication_hash });
  unlinkSync(join(work.root, '.neomind/cornell-publications/receipts', `${prepared.publication_hash}.json`));
  writeFileSync(join(work.root, work.note.meta.data.artifact_path), '# A later authored source revision must remain unchanged.\n');
  const before = snapshot(work);
  const refsBefore = git(work.remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const countBefore = git(work.remote, ['rev-list', '--all', '--count']);
  const recovered = publishCornellExport(work.root, { publication_hash: prepared.publication_hash });
  assert.equal(recovered.status, 'branch-published');
  assert.equal(recovered.commit, published.commit);
  assert.equal(recovered.publication_hash, prepared.publication_hash);
  assert.equal(git(work.remote, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore);
  assert.equal(git(work.remote, ['rev-list', '--all', '--count']), countBefore);
  assert.deepEqual(snapshot(work), before);
  assert.equal(readFileSync(join(work.root, work.note.meta.data.artifact_path), 'utf8'), '# A later authored source revision must remain unchanged.\n');
  assert.deepEqual(publishCornellExport(work.root, { publication_hash: prepared.publication_hash }), recovered);
});

test('remote publication requires explicit opt-in, a selected safe remote/base and unchanged remote identity', t => {
  const work = setup(t), policy = readAutomationPolicy(work.root);
  writeFileSync(join(work.root, '.neomind/automation.json'), JSON.stringify({ ...policy, network_policy: 'local-only' }));
  assert.throws(() => prepareCornellPublication(work.root, { plan_hash: work.exported.plan_hash, remote: 'origin', base_branch: 'main' }), /Local-only/);
  writeFileSync(join(work.root, '.neomind/automation.json'), JSON.stringify(policy));
  assert.throws(() => prepareCornellPublication(work.root, { plan_hash: work.exported.plan_hash, remote: '--upload-pack=bad', base_branch: 'main' }));
  assert.throws(() => prepareCornellPublication(work.root, { plan_hash: work.exported.plan_hash, remote: 'origin', base_branch: '-bad' }));
  const prepared = prepareCornellPublication(work.root, { plan_hash: work.exported.plan_hash, remote: 'origin', base_branch: 'main' });
  git(work.notesRoot, ['remote', 'set-url', 'origin', 'https://sensitive-token@example.invalid/private.git']);
  assert.throws(() => publishCornellExport(work.root, { publication_hash: prepared.publication_hash }), error => !String(error).includes('sensitive-token') && /credentials|parameters/.test(String(error)));
});
