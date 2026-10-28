import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as api from 'workforce';
import { initializeLegacy } from './helpers/legacy-project.mjs';
import { dispatchKnowledgeCommand } from '../dist/knowledge-cli.js';
import {
  discoverProjectKnowledge, searchProjectKnowledge, recordKnowledgeResearch,
  knowledgeResearchProblems,
} from '../dist/knowledge-reuse.js';
import { prepareProjectKnowledge, publishProjectKnowledge } from '../dist/project-knowledge.js';
import { cornellFixture } from './cornell-fixture.mjs';

const repository = 'example/shared';
const classification = { platforms: [process.platform], frameworks: ['Node.js'] };
const query = 'documented integer named export';
const source = 'export const value = 1;\n';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const processMethods = ['spawnSync', 'spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-knowledge-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeLegacy(root, {
    project_id: 'PRIVATE-KNOWLEDGE-CLI', profile: 'basic',
    platforms: ['codex', 'claude', 'copilot'], copilot_integration: 'local',
  });
  api.ensureRoutingPolicy(root);
  const installation = api.installProject(root);
  assert.deepEqual(installation.conflicts, []);
  const policyPath = join(root, '.neomind/automation.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  writeFileSync(policyPath, JSON.stringify({ ...policy, upstream: repository }));
  const workflow = api.beginWorkflow(root, {
    requirement: 'Export and document integer one.', execution_mode: 'copilot-native',
  });
  const requirement = api.getRecord(root, workflow.meta.data.requirement_id);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), source);
  // Explicitly empty durable cache; no remote discovery is implied by local search.
  mkdirSync(join(root, '.neomind/knowledge-cache'));
  return { root, workflow, requirement, installation };
}

function researchInput() {
  return {
    ...classification, workspace_paths: ['src/value.mjs'], queries: [query], selected_sources: [],
    no_match_reason: 'The verified local cache contains no reusable sources for this inspected numeric module; upstream not searched in this local-only fixture.',
    summary: 'Inspected the named export and searched local reusable knowledge before choosing a dependency-free implementation; upstream not searched and runtime compatibility remains unverified.',
  };
}

function candidate(work) {
  const note = api.createCornellNote(work.root,
    cornellFixture(work.workflow.meta.id, work.requirement.meta.id));
  return api.createRecord(work.root, {
    type: 'knowledge', title: 'Focused assertions for deterministic exports', owner: 'curator',
    body: 'PRIVATE_CANDIDATE_BODY must not become public Cornell narrative.',
    data: {
      kind: 'generalized-candidate', workflow_id: work.workflow.meta.id,
      invocation_id: 'curator-candidate', public_safe: true,
      generalization: 'A focused executable assertion establishes a deterministic module contract on an inspected source baseline.',
      applicability: ['Small deterministic module interfaces.'],
      provenance: ['https://nodejs.org/api/assert.html'],
      assumptions: ['The observable contract is a stable exported value.'],
      limitations: ['Does not assess production reliability.'],
      ...classification, pack_id: 'focused-exports', pack_version: '1.0.0',
      cornell_note_ids: [note.meta.id],
      cornell_note_fingerprints: { [note.meta.id]: api.recordFingerprint(note) },
      public_cornell: {
        cues: 'When can a focused executable assertion establish a deterministic module contract?',
        notes: 'Import the public value and compare it against a measurable requirement using an executable assertion. Capture the source baseline and preserve the verification output so independent review can distinguish a tested implementation from an unverified claim.',
        summary: 'A focused import assertion provides repeatable evidence for a bounded deterministic interface.',
        application: 'Use this approach for small module contracts while separately checking broader system behavior and runtime compatibility.',
      },
    },
  });
}

// Match existing integration tests, but stub every process entrypoint so a missing
// dispatcher seam cannot accidentally fall through to an installed gh executable.
async function offline(action, spawnSync = () => assert.fail('Unexpected external process')) {
  const originals = Object.fromEntries(processMethods.map((name) => [name, childProcess[name]]));
  const attempts = [];
  for (const name of processMethods) childProcess[name] = (...args) => {
    attempts.push({ name, args });
    if (name === 'spawnSync') return spawnSync(...args);
    assert.fail(`Unexpected external process: ${name}`);
  };
  syncBuiltinESMExports();
  try { return await action(attempts); }
  finally {
    Object.assign(childProcess, originals);
    syncBuiltinESMExports();
  }
}

// This preload runs only inside the real CLI subprocess. It records and rejects
// remote/process attempts before they can execute, including any live gh call.
const offlinePreload = `data:text/javascript,${encodeURIComponent(`
  import childProcess from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  import { writeFileSync } from 'node:fs';
  const deny = () => {
    writeFileSync(process.env.NEOMIND_CLI_REMOTE_ATTEMPT, 'Unexpected remote/process call');
    throw new Error('External processes and network are forbidden in knowledge CLI tests.');
  };
  for (const name of ${JSON.stringify(processMethods)}) childProcess[name] = deny;
  globalThis.fetch = deny;
  syncBuiltinESMExports();
`)}`;

function invoke(work, ...args) {
  const marker = join(work.root, 'unexpected-remote-call.txt');
  const result = childProcess.spawnSync(process.execPath, [
    '--import', offlinePreload, cli, ...args, '--project', work.root, '--json',
  ], {
    cwd: work.root, encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, NODE_OPTIONS: '', NEOMIND_CLI_REMOTE_ATTEMPT: marker },
  });
  assert.ifError(result.error);
  assert.equal(existsSync(marker), false, 'CLI must not attempt a remote call or nested process');
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function failure(result, pattern) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, pattern);
}

function assertResearch(work, record) {
  assert.equal(record.meta.type, 'knowledge');
  assert.equal(record.meta.owner, work.workflow.meta.owner);
  assert.equal(record.meta.data.kind, 'knowledge-research');
  assert.equal(record.meta.data.workflow_id, work.workflow.meta.id);
  assert.equal(record.meta.data.complete, true);
  assert.deepEqual(record.meta.data.workspace_hashes, { 'src/value.mjs': api.hash(source) });
  assert.deepEqual(record.meta.data.provenance_refs, []);
  assert.deepEqual(record.meta.data.source_fingerprints, {});
  assert.deepEqual(record.meta.data.selected_sources, []);
  assert.deepEqual(record.meta.data.queries, [query]);
  assert.equal(record.meta.data.no_match_reason, researchInput().no_match_reason);
  assert.ok(record.meta.links.some((link) =>
    link.type === 'documents' && link.target === work.workflow.meta.id));
  assert.deepEqual(api.getRecord(work.root, record.meta.id), record);
  assert.deepEqual(api.knowledgeResearchProblems(work.root, work.workflow.meta.id,
    { check_workspace: true }), []);
}

test('package root exports the knowledge reuse and project publication APIs', () => {
  for (const [name, implementation] of Object.entries({
    discoverProjectKnowledge, searchProjectKnowledge, recordKnowledgeResearch,
    knowledgeResearchProblems, prepareProjectKnowledge, publishProjectKnowledge,
  })) assert.equal(api[name], implementation, `Package root export: ${name}`);
});

test('CLI dispatcher discovers an empty upstream and searches only the empty local cache', async (t) => {
  const work = project(t);
  // Only this simulated remote fixture opts in; ordinary local research stays local-only.
  const policyPath = join(work.root, '.neomind/automation.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  writeFileSync(policyPath, JSON.stringify({ ...policy, network_policy: 'remote-enabled' }));
  await offline(async (attempts) => {
    const input = { ...classification, query };
    assert.deepEqual(await dispatchKnowledgeCommand(work.root, 'knowledge', 'discover', [], input),
      { handled: true, result: [] });
    assert.equal(attempts.length, 1);
    assert.deepEqual(await dispatchKnowledgeCommand(work.root, 'knowledge', 'search', [], input),
      { handled: true, result: [] });
    assert.deepEqual(await dispatchKnowledgeCommand(work.root, 'knowledge', 'search',
      [JSON.stringify(input)]), { handled: true, result: [] });
    assert.equal(attempts.length, 1, 'Local search must not invoke gh');
    assert.deepEqual(readdirSync(join(work.root, '.neomind/knowledge-cache')), []);
    assert.ok(existsSync(join(work.root, '.neomind/cache/knowledge.sqlite')));
    assert.deepEqual(await dispatchKnowledgeCommand(work.root, 'unrelated', 'search', []),
      { handled: false });
  }, (command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['api', '--method', 'GET',
      `repos/${repository}/branches?per_page=100&page=1`]);
    assert.equal(options.shell, false);
    return { status: 0, stdout: '[]', stderr: '' };
  });
});

test('CLI dispatcher records --data research against a real native workflow and inspected baseline', async (t) => {
  const work = project(t);
  assert.equal(work.workflow.meta.data.execution_mode, 'copilot-native');
  assert.equal(work.workflow.meta.data.knowledge_research_required, true);
  assert.match(api.knowledgeResearchProblems(work.root, work.workflow.meta.id).join(' '), /research is required/i);
  await offline(async (attempts) => {
    const response = await dispatchKnowledgeCommand(work.root, 'knowledge', 'research',
      [work.workflow.meta.id], researchInput());
    assert.equal(response.handled, true);
    assertResearch(work, response.result);
    assert.deepEqual(attempts, []);
  });
});

test('CLI dispatcher rejects ambiguous, non-object and extra knowledge input without side effects', async (t) => {
  const work = project(t);
  const before = api.loadRecords(work.root).length;
  await offline(async (attempts) => {
    for (const command of ['discover', 'search']) {
      await assert.rejects(dispatchKnowledgeCommand(work.root, 'knowledge', command,
        [JSON.stringify(classification)], classification), /positional JSON or --data, not both/);
      for (const input of ['[]', 'null', '"text"'])
        await assert.rejects(dispatchKnowledgeCommand(work.root, 'knowledge', command, [input]),
          /must be a JSON object/);
      await assert.rejects(dispatchKnowledgeCommand(work.root, 'knowledge', command, ['{}', '{}']),
        /single argument/);
    }
    await assert.rejects(dispatchKnowledgeCommand(work.root, 'knowledge', 'research', [], researchInput()),
      /knowledge research WORKFLOW/);
    await assert.rejects(dispatchKnowledgeCommand(work.root, 'knowledge', 'research',
      [work.workflow.meta.id, JSON.stringify(researchInput())], researchInput()), /not both/);
    await assert.rejects(dispatchKnowledgeCommand(work.root, 'knowledge', 'publish', ['candidate']),
      /--upstream OWNER\/REPO/);
    assert.deepEqual(attempts, []);
  });
  assert.equal(api.loadRecords(work.root).length, before);
});

test('standalone CLI parses --data for local search and native workflow research', (t) => {
  const work = project(t);
  assert.deepEqual(success(invoke(work, 'knowledge', 'search', '--data',
    JSON.stringify({ ...classification, query }))), []);
  const record = success(invoke(work, 'knowledge', 'research', work.workflow.meta.id,
    '--data', JSON.stringify(researchInput())));
  assertResearch(work, record);
  assert.deepEqual(readdirSync(join(work.root, '.neomind/knowledge-cache')), []);
});

test('standalone CLI forwards --upstream to repository validation before any remote call', (t) => {
  const work = project(t);
  const lesson = candidate(work);
  failure(invoke(work, 'knowledge', 'publish', lesson.meta.id), /--upstream OWNER\/REPO/);
  const invalid = invoke(work, 'knowledge', 'publish', lesson.meta.id, '--upstream', '../invalid');
  failure(invalid, /Upstream must be a safe explicit owner\/repository name/);
  assert.doesNotMatch(invalid.stderr, /Use knowledge publish|is required/);
  assert.equal(existsSync(join(work.root, '.neomind/project-knowledge', `${lesson.meta.id}.json`)), false,
    'Invalid repository must not freeze publication state');
});

test('standalone CLI --public-safe review persists the actual invocation and binds the current candidate', (t) => {
  const work = project(t);
  const lesson = candidate(work);
  const reviewArgs = ['review', lesson.meta.id, '--owner', 'reviewer', '--decision', 'pass',
    '--generalization-review'];
  const unspecified = success(invoke(work, ...reviewArgs, '--invocation', 'review-unspecified'));
  assert.notEqual(unspecified.meta.data.public_safe, true);
  assert.throws(() => api.prepareProjectKnowledge(work.root, lesson.meta.id), /public_safe/);

  const before = api.loadRecords(work.root).length;
  failure(invoke(work, ...reviewArgs, '--invocation', 'curator-candidate', '--public-safe'),
    /different owner and invocation/);
  assert.equal(api.loadRecords(work.root).length, before, 'Self-review must not create a review');

  const approved = success(invoke(work, ...reviewArgs, '--invocation', 'review-public', '--public-safe'));
  assert.equal(approved.meta.data.public_safe, true);
  assert.equal(approved.meta.data.generalization_review, true);
  assert.equal(approved.meta.data.invocation_id, 'review-public');
  assert.equal(approved.meta.data.workflow_id, work.workflow.meta.id);
  assert.equal(approved.meta.data.target_fingerprint, api.recordFingerprint(lesson));
  assert.deepEqual(approved.meta.links, [{ type: 'reviews', target: lesson.meta.id }]);
  assert.deepEqual(api.getRecord(work.root, approved.meta.id), approved);
  const prepared = api.prepareProjectKnowledge(work.root, lesson.meta.id);
  assert.equal(prepared.entry.title, lesson.meta.title);
  assert.doesNotMatch(JSON.stringify(prepared.files), /PRIVATE_CANDIDATE_BODY/);

  const changed = api.updateRecord(work.root, lesson.meta.id, {
    title: 'Repeatable assertions for deterministic exports',
  });
  assert.throws(() => api.prepareProjectKnowledge(work.root, lesson.meta.id), /current independent generalization review/);
  const refreshed = success(invoke(work, ...reviewArgs, '--invocation', 'review-current', '--public-safe'));
  assert.equal(refreshed.meta.data.invocation_id, 'review-current');
  assert.equal(refreshed.meta.data.target_fingerprint, api.recordFingerprint(changed));
  assert.equal(api.prepareProjectKnowledge(work.root, lesson.meta.id).entry.title, changed.meta.title);
});

test('installer copies the knowledge reuse skill without adding agents to the nine-profile Copilot and Codex sets', (t) => {
  const work = project(t);
  const skillPath = 'skills/neomind-knowledge-reuse/SKILL.md';
  const resource = readFileSync(new URL('../resources/skills/neomind-knowledge-reuse/SKILL.md',
    import.meta.url), 'utf8');
  for (const prefix of ['.agents', '.claude', '.github']) {
    const path = `${prefix}/${skillPath}`;
    assert.ok(work.installation.installed.includes(path), `Installed ${path}`);
    const installed = readFileSync(join(work.root, path), 'utf8');
    assert.match(installed, /^---\r?\nname: neomind-knowledge-reuse\r?\n/);
    for (const contract of ['knowledge discover --data JSON', 'knowledge search --data JSON',
      'knowledge research WORKFLOW_ID --data JSON', 'knowledge publish CANDIDATE --upstream OWNER/REPO',
      '--generalization-review --public-safe', 'cornell_note_fingerprints', 'source_fingerprints'])
      assert.ok(installed.includes(contract), `${path}: ${contract}`);
    assert.match(installed, /zero remote discovery, publication or archive requests/);
    assert.match(installed, /upstream not searched/);
    assert.match(installed, /401.*never a no-match/);
    assert.match(installed, /note\.workflow_id/);
    assert.match(installed, /same workflow only/);
    assert.match(installed, /saved note ID\/path is confirmed/);
    assert.match(installed, /user opt-in to `network_policy: remote-enabled`/);
    assert.doesNotMatch(installed, /Authentication, network, inaccessible upstream.*are blockers/);
    if (prefix !== '.github') assert.equal(installed, resource);
  }
  assert.deepEqual(readdirSync(join(work.root, '.github/agents')).sort(), [
    'neomind-architect.agent.md', 'neomind-coordinator.agent.md', 'neomind-debugger.agent.md',
    'neomind-explorer.agent.md', 'neomind-implementer.agent.md', 'neomind-planner.agent.md',
    'neomind-researcher.agent.md', 'neomind-reviewer.agent.md', 'neomind-verifier.agent.md',
  ]);
  assert.equal(readdirSync(join(work.root, '.claude/agents')).length, 12);
  assert.deepEqual(readdirSync(join(work.root, '.codex/agents')).sort(), [
    'neomind-architect.toml', 'neomind-coordinator.toml', 'neomind-debugger.toml',
    'neomind-explorer.toml', 'neomind-implementer.toml', 'neomind-planner.toml',
    'neomind-researcher.toml', 'neomind-reviewer.toml', 'neomind-verifier.toml',
  ]);
});
