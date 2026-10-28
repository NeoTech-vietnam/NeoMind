// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord, getRecord, updateRecord, hash } from '../dist/storage.js';
import { reviewRecord, recordFingerprint } from '../dist/engineering.js';
import { createCornellNote } from '../dist/notes.js';
import { ensureAutomationPolicy } from '../dist/manager.js';
import { prepareProjectKnowledge, publishProjectKnowledge } from '../dist/project-knowledge.js';
import { cornellFixture } from './cornell-fixture.mjs';

const repository = 'example/shared';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-project-knowledge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'PRIVATE-PROJECT' });
  const policy = ensureAutomationPolicy(root);
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ ...policy, upstream: repository }));
  const workflow = createRecord(root, {
    type: 'knowledge', title: 'Private workflow', owner: 'manager', body: 'PRIVATE_WORKFLOW_BODY',
    data: { kind: 'manager-workflow' },
  });
  const requirement = createRecord(root, {
    type: 'requirement', title: 'Private export requirement', owner: 'owner',
    body: 'PRIVATE_REQUIREMENT_BODY: export the documented acceptance value.',
  });
  const note = createCornellNote(root, cornellFixture(workflow.meta.id, requirement.meta.id));
  return { root, workflow, requirement, note };
}
function candidate(work, packId = 'durable-configuration') {
  const record = createRecord(work.root, {
    type: 'knowledge', title: 'Validate durable configuration before replacement', owner: 'curator',
    body: 'PRIVATE_CANDIDATE_BODY: never publish this record body.',
    data: {
      invocation_id: `curation-${packId}`, workflow_id: work.workflow.meta.id,
      generalization: 'PRIVATE_GENERALIZATION: use only the sanitized Cornell narrative for publication.',
      public_safe: true,
      public_cornell: {
        cues: 'How can configuration updates preserve a valid representation when validation fails?',
        notes: 'Validate the complete replacement representation before writing it to durable storage. Keep the previous valid bytes available until the replacement passes validation, and use atomic replacement to avoid exposing partial writes to readers.',
        summary: 'Validate first and replace atomically so failed updates preserve a usable configuration.',
        application: 'Apply this pattern to applications that maintain local configuration and need crash-safe updates.',
      },
      cornell_note_ids: [work.note.meta.id],
      cornell_note_fingerprints: { [work.note.meta.id]: recordFingerprint(work.note) },
      pack_id: packId, pack_version: '1.0.0',
      platforms: ['Windows', 'Linux'], frameworks: ['Node.js'],
      applicability: ['Applications with durable local configuration.'],
      provenance: ['https://nodejs.org/api/fs.html'],
      // These non-public fields must never escape through the existing pack renderer.
      domains: ['PRIVATE_DOMAIN'], assumptions: ['PRIVATE_ASSUMPTION'],
    },
  });
  const review = approve(work, record.meta.id);
  return { ...work, id: record.meta.id, reviewId: review.meta.id };
}
function approve(work, id) {
  const review = reviewRecord(work.root, id, 'reviewer', 'pass', [], `review-${id}`, true);
  return updateRecord(work.root, review.meta.id, { data: { public_safe: true } });
}
function statePath(work) {
  return join(work.root, '.neomind/project-knowledge', `${work.id}.json`);
}
function state(work) { return JSON.parse(readFileSync(statePath(work), 'utf8')); }
function notFound() { return Object.assign(new Error('HTTP 404: reference absent'), { status: 404 }); }

/** A small Git database: trees inherit all prior paths and commits have one parent. */
function fakeGitHub() {
  const calls = [];
  const branches = new Map([['main', 'base']]);
  const trees = new Map([['base-tree', new Map([['README.md', '# Shared upstream\n']])]]);
  const commits = new Map([['base', { sha: 'base', tree: { sha: 'base-tree' }, parents: [] }]]);
  const options = { loseRef: false, before: null };
  let sequence = 0;
  function request(method, endpoint, body) {
    calls.push({ method, endpoint, body });
    options.before?.(method, endpoint, body);
    assert.ok(!endpoint.includes('/pulls'), 'No PR pipeline calls');
    if (method === 'GET' && endpoint === `repos/${repository}`) return { default_branch: 'main' };
    const marker = '/git/ref/heads/';
    if (method === 'GET' && endpoint.includes(marker)) {
      const branch = decodeURIComponent(endpoint.split(marker)[1]);
      if (!branches.has(branch)) throw notFound();
      return { object: { sha: branches.get(branch) } };
    }
    if (method === 'GET' && endpoint.includes('/git/commits/')) {
      const sha = endpoint.split('/git/commits/')[1];
      assert.ok(commits.has(sha), `Known commit ${sha}`);
      return commits.get(sha);
    }
    if (method === 'GET' && endpoint.includes('/contents/')) {
      const url = new URL(`https://api.github.com/${endpoint}`);
      const path = url.pathname.split('/contents/')[1];
      const commit = commits.get(url.searchParams.get('ref'));
      assert.ok(commit, 'Catalog is read at frozen commit, not moving branch');
      const content = trees.get(commit.tree.sha).get(path);
      if (content === undefined) throw notFound();
      return { encoding: 'base64', content: Buffer.from(content).toString('base64') };
    }
    if (method === 'POST' && endpoint.endsWith('/git/trees')) {
      assert.ok(trees.has(body.base_tree));
      const files = new Map(trees.get(body.base_tree));
      for (const file of body.tree) {
        assert.equal(file.type, 'blob');
        assert.equal(file.mode, '100644');
        files.set(file.path, file.content);
      }
      const sha = `tree-${++sequence}`;
      trees.set(sha, files);
      return { sha };
    }
    if (method === 'POST' && endpoint.endsWith('/git/commits')) {
      assert.ok(trees.has(body.tree));
      assert.equal(body.parents.length, 1);
      assert.ok(commits.has(body.parents[0]));
      const sha = `commit-${++sequence}`;
      commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents });
      return { sha };
    }
    if (method === 'POST' && endpoint.endsWith('/git/refs')) {
      const branch = body.ref.replace('refs/heads/', '');
      if (branches.has(branch)) throw Object.assign(new Error('Reference exists'), { status: 422 });
      assert.ok(commits.has(body.sha));
      branches.set(branch, body.sha);
      if (options.loseRef) { options.loseRef = false; throw new Error('Lost successful ref response'); }
      return {};
    }
    if (method === 'PATCH' && endpoint.includes('/git/refs/heads/')) {
      assert.equal(body.force, false);
      const branch = decodeURIComponent(endpoint.split('/git/refs/heads/')[1]);
      const commit = commits.get(body.sha);
      if (commit.parents[0] !== branches.get(branch))
        throw Object.assign(new Error('Non-fast-forward conflict'), { status: 422 });
      branches.set(branch, body.sha);
      if (options.loseRef) { options.loseRef = false; throw new Error('Lost successful ref response'); }
      return {};
    }
    throw new Error(`Unexpected fake API call: ${method} ${endpoint}`);
  }
  return { calls, branches, trees, commits, options, request };
}
function publish(work, github) { return publishProjectKnowledge(work.root, work.id, repository, github.request); }
function mutations(github) { return github.calls.filter((call) => call.method !== 'GET'); }
function refMutations(github) {
  return mutations(github).filter((call) => call.endpoint.includes('/git/refs'));
}

test('preparation renders only sanitized Cornell narrative, public metadata and opaque project identity', (t) => {
  const work = candidate(project(t));
  const prepared = prepareProjectKnowledge(work.root, work.id);
  assert.equal(prepared.project_hash, hash('PRIVATE-PROJECT'));
  assert.equal(prepared.branch, `neomind/knowledge/${hash('PRIVATE-PROJECT').slice(0, 16)}`);
  assert.equal(prepared.path, `knowledge/projects/${hash('PRIVATE-PROJECT')}/notes/durable-configuration/1.0.0.md`);
  assert.match(prepared.content_hash, /^[a-f0-9]{64}$/);
  const markdown = prepared.files.find((file) => file.path === prepared.path).content;
  const companion = JSON.parse(prepared.files.find((file) => file.path.endsWith('/1.0.0.json')).content);
  assert.equal(companion.sha256, hash(markdown));
  assert.equal(companion.artifact_path, prepared.path);
  assert.deepEqual(companion.platforms, ['Windows', 'Linux']);
  assert.deepEqual(companion.frameworks, ['Node.js']);
  const serialized = JSON.stringify(prepared.files);
  for (const secret of ['PRIVATE_', work.id, work.note.meta.id, work.reviewId,
    work.workflow.meta.id, work.root, 'docs/knowledge/value.md']) assert.ok(!serialized.includes(secret), secret);
  assert.match(markdown, /## Cue Column/);
  assert.match(markdown, /## Application/);
});

test('local-only publication fails before transport, requires explicit remote opt-in, and preserves publication receipts', (t) => {
  const work = candidate(project(t));
  const path = join(work.root, '.neomind/automation.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  const prepared = prepareProjectKnowledge(work.root, work.id);
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Local-only publication must never invoke transport.'); };
  writeFileSync(path, JSON.stringify({ ...policy, network_policy: 'local-only', automatic_pr: true }));
  assert.throws(() => publishProjectKnowledge(work.root, work.id, repository, forbidden), /local-only.*remote-enabled/i);
  assert.equal(calls, 0);
  assert.deepEqual(prepareProjectKnowledge(work.root, work.id), prepared, 'Local preparation retains safety and source validation');
  writeFileSync(path, JSON.stringify({ ...policy, network_policy: 'remote-enabled' }));
  const github = fakeGitHub();
  assert.equal(publish(work, github).status, 'branch-published');
  const receipt = readFileSync(statePath(work), 'utf8');
  writeFileSync(path, JSON.stringify({ ...policy, network_policy: 'local-only' }));
  assert.throws(() => publishProjectKnowledge(work.root, work.id, repository, forbidden), /local-only.*remote-enabled/i);
  assert.equal(calls, 0);
  assert.equal(readFileSync(statePath(work), 'utf8'), receipt, 'Deferral must not erase a proven publication');
  updateRecord(work.root, work.reviewId, { data: { public_safe: false } });
  assert.throws(() => prepareProjectKnowledge(work.root, work.id), /public_safe/);
  updateRecord(work.root, work.reviewId, { data: { public_safe: true } });
  updateRecord(work.root, work.note.meta.id, {}, 'Changed source after remote publication');
  writeFileSync(path, JSON.stringify({ ...policy, network_policy: 'remote-enabled' }));
  const freshRemote = fakeGitHub();
  assert.throws(() => publish(work, freshRemote), /Cornell|fingerprints/);
  assert.deepEqual(freshRemote.calls, [], 'Opt-in never bypasses pinned source validation');
});

test('preparation rejects private project identity embedded in an otherwise portable pack_id', (t) => {
  const work = candidate(project(t), 'shared-private-project-lesson');
  assert.throws(() => prepareProjectKnowledge(work.root, work.id), /private project identity/);
});

test('publisher rejects nondiscoverable credentials paths and leading-zero versions before any remote request', (t) => {
  for (const data of [{ pack_id: 'credentials' }, { pack_version: '01.0.0' }]) {
    const work = candidate(project(t));
    updateRecord(work.root, work.id, { data });
    approve(work, work.id);
    const github = fakeGitHub();
    assert.throws(() => publish(work, github), /Unsafe project knowledge artifact path/, JSON.stringify(data));
    assert.deepEqual(github.calls, [], 'Invalid artifact paths must fail before even remote reads');
  }
});

test('current independent review and explicit candidate/reviewer public safety gate every remote mutation', (t) => {
  for (const failure of ['candidate-safety', 'review-safety', 'stale', 'same-owner', 'same-invocation', 'fail']) {
    const work = candidate(project(t));
    if (failure === 'candidate-safety') {
      updateRecord(work.root, work.id, { data: { public_safe: false } });
      approve(work, work.id);
    } else if (failure === 'review-safety') {
      updateRecord(work.root, work.reviewId, { data: { public_safe: false } });
    } else if (failure === 'stale') {
      updateRecord(work.root, work.id, { title: 'Unreviewed replacement title' });
    } else if (failure === 'same-owner') {
      updateRecord(work.root, work.reviewId, { owner: 'curator' });
    } else if (failure === 'same-invocation') {
      updateRecord(work.root, work.reviewId, { data: { invocation_id: 'curation-durable-configuration' } });
    } else updateRecord(work.root, work.reviewId, { data: { decision: 'fail' } });
    const github = fakeGitHub();
    assert.throws(() => publish(work, github), /public_safe|independent generalization review/, failure);
    assert.equal(mutations(github).length, 0, failure);
  }
});

test('public Cornell fields must be meaningful and classification arrays explicitly supplied', (t) => {
  const invalid = [
    { public_cornell: { cues: 'Too short' } },
    { public_cornell: { cues: 'x'.repeat(50), notes: 'x'.repeat(150), summary: 'x'.repeat(50), application: 'x'.repeat(50) } },
    { platforms: 'Windows' }, { frameworks: null }, { cornell_note_ids: [] },
    { cornell_note_fingerprints: {} },
  ];
  for (const data of invalid) {
    const work = candidate(project(t));
    updateRecord(work.root, work.id, { data });
    approve(work, work.id);
    const github = fakeGitHub();
    assert.throws(() => publish(work, github), /Cornell|platforms|frameworks|fingerprints/);
    assert.equal(mutations(github).length, 0);
  }
});

test('source notes require current fingerprints, same workflow and validated original artifacts', (t) => {
  for (const failure of ['fingerprint', 'workflow', 'artifact']) {
    const work = candidate(project(t));
    if (failure === 'artifact') writeFileSync(join(work.root, 'docs/knowledge/value.md'), 'Changed original note');
    else {
      const changed = failure === 'workflow'
        ? updateRecord(work.root, work.note.meta.id, { data: { workflow_id: work.requirement.meta.id } })
        : updateRecord(work.root, work.note.meta.id, {}, 'Changed private note record');
      if (failure === 'workflow') {
        updateRecord(work.root, work.id, { data: { cornell_note_fingerprints: { [changed.meta.id]: recordFingerprint(changed) } } });
        approve(work, work.id);
      }
    }
    const github = fakeGitHub();
    assert.throws(() => publish(work, github), /Cornell|fingerprints/);
    assert.equal(mutations(github).length, 0);
  }
});

test('stable project branch accumulates two candidates and a discoverable merged catalog', (t) => {
  const work = project(t);
  const first = candidate(work);
  const second = candidate(work, 'atomic-updates');
  const github = fakeGitHub();
  const published = publish(first, github);
  github.options.before = (method, endpoint, body) => {
    if (method !== 'PATCH') return;
    const frozen = state(second);
    assert.equal(frozen.repository, repository);
    assert.equal(frozen.branch, published.branch);
    assert.equal(frozen.base_commit, published.commit);
    assert.equal(frozen.status, 'commit-created');
    assert.equal(frozen.commit, body.sha);
    assert.equal(frozen.files_hash, hash(JSON.stringify(frozen.files)));
    assert.match(frozen.content_hash, /^[a-f0-9]{64}$/);
    assert.match(frozen.validation_hash, /^[a-f0-9]{64}$/);
    assert.ok(frozen.tree && frozen.base_tree);
  };
  const next = publish(second, github);
  assert.equal(published.branch, next.branch);
  assert.notEqual(published.commit, next.commit);
  assert.equal(next.status, 'branch-published');
  assert.equal(next.repository, repository);
  assert.equal(next.url, `https://github.com/${repository}/blob/${next.commit}/${next.path}`);
  assert.deepEqual(github.commits.get(next.commit).parents, [published.commit]);
  const files = github.trees.get(github.commits.get(next.commit).tree.sha);
  assert.ok(files.has(published.path));
  assert.ok(files.has(next.path));
  assert.ok(files.has('README.md'));
  const catalog = JSON.parse(files.get(`knowledge/projects/${hash('PRIVATE-PROJECT')}/manifest.json`));
  assert.equal(catalog.notes.length, 2);
  for (const entry of catalog.notes) {
    assert.equal(entry.sha256, hash(files.get(entry.artifact_path)));
    assert.deepEqual(JSON.parse(files.get(entry.artifact_path.replace(/\.md$/, '.json'))), entry);
  }
  assert.equal(refMutations(github).filter((call) => call.method === 'POST').length, 1);
  assert.equal(refMutations(github).filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(state(second).base_commit, published.commit);
  assert.ok(!JSON.stringify(github.calls).includes('PRIVATE_'));
  assert.equal(github.branches.get('main'), 'base', 'Default branch never updated');
});

test('lost successful create and update ref responses recover persisted commits without duplicate mutations', (t) => {
  const work = project(t);
  const github = fakeGitHub();
  for (const packId of ['first-publication', 'second-publication']) {
    const current = candidate(work, packId);
    github.options.loseRef = true;
    assert.throws(() => publish(current, github), /Lost successful ref response/);
    const frozen = state(current);
    assert.equal(frozen.status, 'commit-created');
    assert.ok(frozen.base_commit && frozen.base_tree && frozen.tree && frozen.commit);
    assert.equal(github.branches.get(frozen.branch), frozen.commit);
    const count = mutations(github).length;
    const recovered = publish(current, github);
    assert.equal(recovered.commit, frozen.commit);
    assert.equal(state(current).status, 'branch-published');
    assert.equal(mutations(github).length, count);
    const total = github.calls.length;
    assert.deepEqual(publish(current, github), recovered);
    assert.equal(github.calls.length, total, 'Completed return uses current local validation without remote mutation');
  }
});

test('project lock prevents a different candidate from reentering branch updates', (t) => {
  const work = project(t);
  const first = candidate(work);
  const second = candidate(work, 'other-candidate');
  const github = fakeGitHub();
  let tried = false;
  github.options.before = () => {
    if (tried) return;
    tried = true;
    assert.throws(() => publish(second, github), /already running in this invocation/);
  };
  publish(first, github);
  assert.equal(tried, true);
  assert.equal(refMutations(github).length, 1);
});

test('divergent branch is rejected before ref mutation, without force or rebase', (t) => {
  const work = candidate(project(t));
  const github = fakeGitHub();
  const branch = prepareProjectKnowledge(work.root, work.id).branch;
  github.options.before = (method, endpoint) => {
    if (method === 'POST' && endpoint.endsWith('/git/commits')) github.branches.set(branch, 'other-head');
  };
  assert.throws(() => publish(work, github), /diverged/);
  assert.equal(refMutations(github).length, 0);
  assert.equal(github.branches.get(branch), 'other-head');
});

test('remote fast-forward conflict is surfaced and never retried with force', (t) => {
  const work = project(t);
  const github = fakeGitHub();
  const first = publish(candidate(work), github);
  const second = candidate(work, 'concurrent-update');
  github.options.before = (method) => {
    if (method === 'PATCH') github.branches.set(first.branch, 'concurrent-head');
  };
  assert.throws(() => publish(second, github), /Non-fast-forward conflict/);
  const patches = github.calls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.force, false);
  assert.equal(github.branches.get(first.branch), 'concurrent-head');
});

test('candidate or approval changes during catalog GET stop before uploading tree content', (t) => {
  for (const failure of ['candidate', 'review']) {
    const work = candidate(project(t));
    const github = fakeGitHub();
    let changed = false;
    github.options.before = (method, endpoint) => {
      if (changed || method !== 'GET' || !endpoint.includes('/contents/')) return;
      changed = true;
      if (failure === 'candidate') {
        updateRecord(work.root, work.id, { title: 'Freshly reviewed replacement public title' });
        approve(work, work.id);
      } else {
        updateRecord(work.root, work.reviewId, {}, 'Changed approval rationale while preserving the public narrative.');
      }
    };
    assert.throws(() => publish(work, github), /changed/, failure);
    assert.equal(changed, true, failure);
    assert.deepEqual(mutations(github), [], 'No public content may be uploaded after the frozen approval changes');
    const count = github.calls.length;
    assert.throws(() => publish(work, github), /changed/, failure);
    assert.equal(github.calls.length, count, 'Changed frozen intent must also fail locally on retry');
  }
});

test('revoking approval during tree creation stops before commit creation', (t) => {
  const work = candidate(project(t));
  const github = fakeGitHub();
  let revoked = false;
  github.options.before = (method, endpoint) => {
    if (method !== 'POST' || !endpoint.endsWith('/git/trees')) return;
    revoked = true;
    updateRecord(work.root, work.reviewId, { data: { public_safe: false } });
  };
  assert.throws(() => publish(work, github), /public_safe/);
  assert.equal(revoked, true);
  assert.deepEqual(mutations(github).map((call) => call.endpoint), [`repos/${repository}/git/trees`]);
  assert.equal(state(work).status, 'tree-created');
  const count = github.calls.length;
  assert.throws(() => publish(work, github), /public_safe/);
  assert.equal(github.calls.length, count, 'Revoked approval cannot resume the tree into a commit');
});

test('changed candidate or review during remote preparation cannot mutate a ref or resume frozen intent', (t) => {
  for (const failure of ['candidate', 'review', 'source']) {
    const work = candidate(project(t));
    const github = fakeGitHub();
    let changed = false;
    github.options.before = (method, endpoint) => {
      if (changed || method !== 'POST' || !endpoint.endsWith('/git/commits')) return;
      changed = true;
      if (failure === 'candidate') {
        updateRecord(work.root, work.id, { title: 'Different freshly reviewed public title' });
        approve(work, work.id);
      } else if (failure === 'review') {
        updateRecord(work.root, work.reviewId, {}, 'Changed approval rationale with unchanged public content.');
      } else updateRecord(work.root, work.note.meta.id, {}, 'Changed private source record');
    };
    assert.throws(() => publish(work, github), /changed|fingerprints/);
    assert.equal(refMutations(github).length, 0);
    assert.throws(() => publish(work, github), /changed|fingerprints/);
    assert.equal(refMutations(github).length, 0);
  }
});

test('completed receipt is not returned for changed current candidate, review, sources or upstream', (t) => {
  for (const failure of ['candidate', 'review', 'source', 'repository']) {
    const work = candidate(project(t));
    const github = fakeGitHub();
    publish(work, github);
    if (failure === 'candidate') {
      updateRecord(work.root, work.id, { title: 'Replacement reviewed public title' });
      approve(work, work.id);
    } else if (failure === 'review') {
      updateRecord(work.root, work.reviewId, { data: { public_safe: false } });
    } else if (failure === 'source') {
      writeFileSync(join(work.root, 'docs/practice/value-answer.md'), 'Changed answer');
    } else {
      const path = join(work.root, '.neomind/automation.json');
      const policy = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...policy, upstream: 'other/shared' }));
    }
    const count = github.calls.length;
    assert.throws(() => failure === 'repository'
      ? publishProjectKnowledge(work.root, work.id, 'other/shared', github.request)
      : publish(work, github), /changed|public_safe|validation failed/);
    assert.equal(github.calls.length, count);
  }
});

test('only typed 404 or HTTP404 denotes missing refs; authentication errors stop preparation', (t) => {
  for (const error of [Object.assign(new Error('Unauthorized'), { status: 401 }),
    new Error('Forbidden: ref not found'), new Error('404 quota messages are not HTTP status')]) {
    const work = candidate(project(t));
    const github = fakeGitHub();
    const request = (method, endpoint, body) => {
      if (endpoint.includes('/git/ref/heads/')) throw error;
      return github.request(method, endpoint, body);
    };
    assert.throws(() => publishProjectKnowledge(work.root, work.id, repository, request), (actual) => actual === error);
    assert.equal(mutations(github).length, 0);
  }
  const work = candidate(project(t));
  const github = fakeGitHub();
  const request = (method, endpoint, body) => {
    try { return github.request(method, endpoint, body); }
    catch (error) {
      if (error.status === 404) throw new Error('HTTP404: missing remote object');
      throw error;
    }
  };
  assert.equal(publishProjectKnowledge(work.root, work.id, repository, request).status, 'branch-published');
});

test('safe repository validation, configured upstream and accidental private metadata prevent publication', (t) => {
  const work = candidate(project(t));
  const github = fakeGitHub();
  for (const unsafe of ['../shared', 'owner/..', '-owner/shared', 'owner/shared?token=x', 'owner/repo/extra'])
    assert.throws(() => publishProjectKnowledge(work.root, work.id, unsafe, github.request), /safe explicit/);
  assert.throws(() => publishProjectKnowledge(work.root, work.id, 'other/shared', github.request), /configured/);
  updateRecord(work.root, work.id, { data: { provenance: [`Private origin ${work.note.meta.id}`] } });
  approve(work, work.id);
  assert.throws(() => publish(work, github), /private project identity/);
  assert.equal(mutations(github).length, 0);
});

test('published pack version cannot be silently replaced by another reviewed candidate', (t) => {
  const work = project(t);
  const first = candidate(work);
  const github = fakeGitHub();
  publish(first, github);
  const second = candidate(work);
  updateRecord(work.root, second.id, { title: 'A different public interpretation of atomic replacement' });
  approve(work, second.id);
  const before = mutations(github).length;
  assert.throws(() => publish(second, github), /different content/);
  assert.equal(mutations(github).length, before);
});

test('a source record baseline changes even if the candidate public bytes stay identical', (t) => {
  const work = candidate(project(t));
  const before = prepareProjectKnowledge(work.root, work.id);
  const note = updateRecord(work.root, work.note.meta.id, {}, 'Updated private explanation with preserved artifacts.');
  updateRecord(work.root, work.id, { data: { cornell_note_fingerprints: { [note.meta.id]: recordFingerprint(note) } } });
  approve(work, work.id);
  const after = prepareProjectKnowledge(work.root, work.id);
  assert.equal(before.content_hash, after.content_hash);
  assert.notEqual(before.validation_hash, after.validation_hash);
  assert.equal(getRecord(work.root, work.id).meta.data.public_safe, true);
});
