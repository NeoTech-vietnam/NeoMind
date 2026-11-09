import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, hash, requestFolderForWorkflow, getRecord } from '../dist/storage.js';
import { resolveProcedure, createProcedureInputPacket } from '../dist/procedures.js';
import { captureNativeTools } from '../dist/native-learning.js';
import { randomUUID } from 'node:crypto';
import { openNativeRequest, planNativeRequest, nextNativeAssignment, recordNativeResult,
  runNativeChecks, finishNativeRequest, refreshNativeRequestLearning } from '../dist/native-request.js';
import { findRequestExperiences } from '../dist/request-experience.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-learning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root);
  mkdirSync(join(root, 'scripts'));
  const definition = { title: 'Generate practice note', description: 'Generate a research practice note', task_family: 'practice-note',
    script: 'scripts/generate.cjs', verification_script: 'scripts/verify.cjs', dependencies: ['scripts/template.md'],
    parameters: { destination: { type: 'string', path: true }, topic: { type: 'string' } },
    outputs: [{ path: '{destination}/note.md', min_bytes: 5 }],
    environment: { platforms: [process.platform], clients: ['copilot'], node_major_min: 24 },
    effects: { write_roots: ['{destination}'], network: false, publication: false } };
  const files = { 'scripts/generate.cjs': 'console.log("generator");', 'scripts/verify.cjs': 'console.log("independent checker");',
    'scripts/template.md': '# Cornell practice note', 'scripts/note.procedure.json': JSON.stringify(definition) };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  const inspected = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, hash(Buffer.from(text))]));
  return { root, definition, inspected, outputs: Object.keys(files) };
}

test('accepted script manifests are captured idempotently as candidates without fabricated reviews or runs', t => {
  const app = fixture(t);
  const result = captureNativeTools(app.root, app);
  assert.deepEqual(result.issues, []); assert.equal(result.candidates.length, 1);
  const reference = result.candidates[0], saved = resolveProcedure(app.root, reference.id, reference.version);
  assert.equal(saved.status, 'candidate'); assert.deepEqual(saved.reviews, []); assert.deepEqual(saved.runs, []);
  assert.deepEqual(saved.outputs, app.definition.outputs, 'future products are distinct from the delivered tooling files');
  assert.deepEqual(captureNativeTools(app.root, app), result);
  const original = readFileSync(join(app.root, 'scripts/note.procedure.json'));
  assert.equal(hash(original), app.inspected['scripts/note.procedure.json']);
});

test('uninspected, modified or invalid optional tooling does not create an executable candidate', t => {
  const app = fixture(t);
  delete app.inspected['scripts/verify.cjs'];
  assert.equal(captureNativeTools(app.root, app).candidates.length, 0);
  assert.equal(captureNativeTools(app.root, app).issues.length, 1);
  app.inspected['scripts/verify.cjs'] = hash('console.log("independent checker");');
  writeFileSync(join(app.root, 'scripts/generate.cjs'), 'CHANGED');
  assert.equal(captureNativeTools(app.root, app).candidates.length, 0);
  writeFileSync(join(app.root, 'scripts/note.procedure.json'), '{bad json');
  assert.equal(captureNativeTools(app.root, app).candidates.length, 0);
  assert.deepEqual(captureNativeTools(app.root, { outputs: ['ordinary-product.json'], inspected: {} }), { candidates: [], issues: [] });
});

test('a script supporting older Node versions inherits the procedure runtime minimum without a model repair', t => {
  const app = fixture(t);
  app.definition.environment.node_major_min = 18;
  const text = JSON.stringify(app.definition);
  writeFileSync(join(app.root, 'scripts/note.procedure.json'), text);
  app.inspected['scripts/note.procedure.json'] = hash(text);
  const learned = captureNativeTools(app.root, app);
  assert.equal(learned.candidates.length, 1);
  assert.equal(resolveProcedure(app.root, learned.candidates[0].id).environment.node_major_min, 24);
  assert.equal(readFileSync(join(app.root, 'scripts/note.procedure.json'), 'utf8'), text);
});

test('native tool-building assignments carry the actual backend stdin envelope with string output paths', t => {
  const app = fixture(t);
  const opened = openNativeRequest(app.root, { requirement: 'Deliver reusable note tooling' });
  planNativeRequest(app.root, opened.request_ref, { summary: 'Reusable note tooling', requirements: ['Use the real runtime interface'],
    design: 'Generator and independent checker', outputs: app.outputs,
    checks: [{ title: 'Existing checker', level: 'acceptance', command: [process.execPath, '--check', 'scripts/verify.cjs'] }] });
  const job = nextNativeAssignment(app.root, opened.request_ref);
  const match = /Procedure subprocess stdin contract: (.*)\n/.exec(job.prompt);
  assert.ok(match, 'The model receives the real protocol description without having to rediscover it');
  const example = JSON.parse(match[1]);
  assert.deepEqual(example, createProcedureInputPacket(example));
  assert.ok(example.outputs.every(path => typeof path === 'string'));
  assert.match(job.prompt, /scripts may ignore those identifiers/);
});

for (const invalidManifest of [false, true]) test(`real acceptance captures optional tooling without blocking delivery (invalid=${invalidManifest})`, { timeout: 60000 }, async t => {
  const app = fixture(t);
  if (invalidManifest) writeFileSync(join(app.root, 'scripts/note.procedure.json'), '{bad json');
  writeFileSync(join(app.root, 'product.md'), '# Delivered practice note\n');
  const opened = openNativeRequest(app.root, { requirement: 'Generate a research practice note and reusable tooling' });
  planNativeRequest(app.root, opened.request_ref, { summary: 'Generate a research practice note', task_family: 'practice-note',
    requirements: ['Deliver the requested note and inspect reusable tooling'], design: 'Existing Node script interface',
    outputs: [...app.outputs, 'product.md'], checks: [{ title: 'Actual note assertion', level: 'acceptance',
      command: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('product.md','utf8'),'# Delivered practice note\\n')"] }] });
  // Host-outcome seam, not desktop model evidence. All check commands below
  // execute real processes; optional learning cannot invent model/process runs.
  for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const job = nextNativeAssignment(app.root, opened.request_ref);
    assert.equal(job.agentName, role);
    recordNativeResult(app.root, { request_ref: opened.request_ref, assignment_ref: job.assignment_ref,
      invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: role, status: 'returned' },
      raw_result: { content: [{ value: JSON.stringify({ summary: 'Inspected the assigned product', verdict: 'pass', findings: [] }) }] } });
  }
  await runNativeChecks(app.root, opened.request_ref);
  const completed = finishNativeRequest(app.root, opened.request_ref);
  assert.equal(completed.accepted, true);
  assert.equal(completed.learning.candidates.length, invalidManifest ? 0 : 1);
  assert.equal(completed.learning.issues.length, invalidManifest ? 1 : 0);
  const experience = findRequestExperiences(app.root, { request: 'Generate a research practice note', task_family: 'practice-note' });
  assert.equal(experience.candidates.length, 1);
  assert.deepEqual(experience.candidates[0].procedures, completed.learning.candidates);
  assert.equal(finishNativeRequest(app.root, opened.request_ref).final_report_id, completed.final_report_id);
  if (!invalidManifest) {
    const candidate = resolveProcedure(app.root, completed.learning.candidates[0].id);
    assert.equal(candidate.status, 'candidate'); assert.deepEqual(candidate.runs, []); assert.deepEqual(candidate.reviews, []);
    const delivery = getRecord(app.root, completed.final_report_id);
    const deliveryBytes = readFileSync(join(app.root, delivery.path));
    // Simulate an earlier runtime's optional metadata failure, not a product or
    // model outcome. Upgrading may retry learning without replaying either.
    const path = join(app.root, '.workforce', requestFolderForWorkflow(app.root, opened.request_ref).directory, 'native/execution.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const prior = { candidates: [], issues: ['Older optional metadata reader was unavailable'] };
    saved.learning = prior; writeFileSync(path, JSON.stringify(saved));
    const refreshed = refreshNativeRequestLearning(app.root, opened.request_ref);
    assert.equal(refreshed.accepted, true);
    assert.deepEqual(refreshed.learning.candidates, completed.learning.candidates);
    const current = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(current.learning_history.at(-1).result, prior);
    assert.deepEqual(current.checks.map(check => check.execution_id), saved.checks.map(check => check.execution_id));
    assert.deepEqual(current.assignments, saved.assignments);
    assert.deepEqual(readFileSync(join(app.root, delivery.path)), deliveryBytes);
  }
});
