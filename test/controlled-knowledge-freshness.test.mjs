import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';
import { controlledKnowledgeFreshness } from '../dist/controlled-cornell-selection.js';

// Routing-only fixtures. Signed actor/evidence/artifact acceptance is exercised
// by the actual Bridge/MCP dual-directory test in controlled-acceptance.test.mjs.
function fixture() {
  const workflow = 'KNOWLEDGE-KNW-0001', primaryId = 'KNOWLEDGE-KNW-0002', knowledgeId = 'KNOWLEDGE-KNW-0003';
  const planned = { title: 'Independent current product check', command: ['node', 'checks/product.cjs'], expected_exit_code: 0,
    negative_controls: [{ title: 'Reject a deliberately wrong product', command: ['node', 'checks/product.cjs', '--negative'], expected_exit_code: 1 }] };
  const contract = { workflow_id: workflow, plan: { cornell_output_dir: 'docs/primary', checks: [planned] }, knowledge_directory: 'docs/final' };
  const note = (id, directory, evidence) => ({ path: `records/${id}.md`, body: '# Research record\n', meta: {
    schema_version: 1, id, type: 'knowledge', title: 'Actual-current-evidence routing fixture', owner: 'manager', status: 'draft',
    revision: 1, created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z', links: [],
    data: { workflow_id: workflow, format: 'cornell-v1', artifact_path: `${directory}/note.md`, research: { input_hash: 'a'.repeat(64) },
      artifact_hashes: Object.fromEntries(['note.md', 'exercises.md', 'answers.md'].map(path => [`${directory}/${path}`, 'b'.repeat(64)])),
      demonstration: { evidence_ids: evidence } } } });
  const primary = note(primaryId, 'docs/primary', []), knowledge = note(knowledgeId, 'docs/final', ['KNOWLEDGE-EVD-0001']);
  const records = new Map([[primaryId, primary], [knowledgeId, knowledge]]);
  const generation = note => ({ note_id: note.meta.id, input_hash: note.meta.data.research.input_hash,
    compiled_note_hash: 'c'.repeat(64), record_fingerprint: evidenceRecordFingerprint(note), artifact_hashes: structuredClone(note.meta.data.artifact_hashes) });
  const producer = id => ({ id, stage: 'implementation', role: 'developer', state: 'completed', report: { outcome: 'completed' } });
  const verifier = id => ({ id, stage: 'verification', role: 'verifier', state: 'completed', report: { outcome: 'completed', verdict: 'pass' } });
  const checks = (attempt, suffix) => [
    { id: `positive-${suffix}`, title: planned.title, attempt_id: attempt, evidence_id: `KNOWLEDGE-EVD-${suffix}`,
      planned_command: planned.command, command: planned.command, negative: false, expected_exit_code: 0, exit_code: 0, passed: true, cancelled: false },
    { id: `negative-${suffix}`, title: planned.negative_controls[0].title, attempt_id: attempt, evidence_id: `NEGATIVE-EVD-${suffix}`,
      planned_command: planned.negative_controls[0].command, command: planned.negative_controls[0].command,
      negative: true, expected_exit_code: 1, exit_code: 1, passed: true, cancelled: false },
  ];
  const run = { workflow_id: workflow, cornell_note_ids: [primaryId, knowledgeId],
    cornell_results: [generation(primary), generation(knowledge)], attempts: [producer('producer-1'), verifier('verifier-1')],
    checks: checks('verifier-1', '0001') };
  return { contract, run, primary, knowledge, records, generation, producer, verifier, checks,
    inspect: () => controlledKnowledgeFreshness(run, contract, id => records.get(id)) };
}

test('primary expected-only bundle never substitutes for separately requested current knowledge', () => {
  const a = fixture(); a.run.cornell_note_ids = [a.primary.meta.id];
  assert.deepEqual(a.inspect(), { required: true, ready: false, reason: 'missing-bundle' });
  delete a.contract.knowledge_directory;
  assert.deepEqual(a.inspect(), { required: false, ready: true, reason: 'not-requested' });
});

test('current knowledge routes ready only with its unchanged generation and completed current independent evidence', () => {
  const a = fixture(), before = structuredClone({ run: a.run, knowledge: a.knowledge });
  assert.deepEqual(a.inspect(), { required: true, ready: true, reason: 'ready' });
  assert.deepEqual({ run: a.run, knowledge: a.knowledge }, before, 'Routing must not rewrite notes, evidence, proof or lifecycle.');
});

test('current knowledge selects the latest same-attempt evidence and a later failure cannot reveal an earlier pass', () => {
  const a = fixture(), positive = a.run.checks[0];
  a.run.checks.unshift({ ...positive, id: 'old-failed', passed: false, exit_code: 1, evidence_id: 'OLD-FAILED-EVIDENCE' });
  assert.equal(a.inspect().ready, true);
  const history = structuredClone(a.run.checks);
  a.run.checks.push({ ...positive, id: 'new-failed', passed: false, exit_code: 1 });
  assert.equal(a.inspect().reason, 'incomplete-verification');
  assert.deepEqual(a.run.checks.slice(0, -1), history);
  a.run.checks.at(-1).passed = true;
  a.run.checks.at(-1).negative = true;
  assert.equal(a.inspect().reason, 'incomplete-verification', 'Malformed latest receipt cannot expose its old positive counterpart.');
});

test('a rejected review followed by product repair requires new synthesis after the new verifier', () => {
  const a = fixture();
  a.run.attempts.push({ id: 'failed-review', stage: 'review', role: 'reviewer', state: 'completed', report: { outcome: 'completed', verdict: 'fail' } });
  a.run.attempts.push(a.producer('producer-2'));
  assert.equal(a.inspect().reason, 'stale-verification');
  a.run.attempts.push({ ...a.verifier('verifier-2'), state: 'running' });
  assert.equal(a.inspect().reason, 'incomplete-verification');
  a.run.attempts.at(-1).state = 'completed';
  a.run.checks.push(...a.checks('verifier-2', '0002'));
  assert.deepEqual(a.inspect(), { required: true, ready: false, reason: 'missing-current-evidence' });
  assert.deepEqual(a.knowledge.meta.data.demonstration.evidence_ids, ['KNOWLEDGE-EVD-0001']);
  a.knowledge.meta.data.demonstration.evidence_ids = ['KNOWLEDGE-EVD-0002'];
  assert.equal(a.inspect().reason, 'changed-generation', 'Changing note metadata alone cannot forge fresh synthesis.');
  a.run.cornell_results.push(a.generation(a.knowledge));
  assert.deepEqual(a.inspect(), { required: true, ready: true, reason: 'ready' });
});

test('missing generation, changed current fingerprints and incomplete or unrelated checks stay unready', () => {
  const a = fixture(), original = structuredClone(a.run);
  a.run.cornell_results = a.run.cornell_results.filter(result => result.note_id !== a.knowledge.meta.id);
  assert.equal(a.inspect().reason, 'missing-generation');
  Object.assign(a.run, structuredClone(original));
  a.run.cornell_results.at(-1).record_fingerprint = 'd'.repeat(64);
  assert.equal(a.inspect().reason, 'changed-generation');
  Object.assign(a.run, structuredClone(original));
  delete a.run.checks[0].evidence_id;
  assert.equal(a.inspect().reason, 'incomplete-verification');
  Object.assign(a.run, structuredClone(original));
  a.run.checks[0].command = ['node', 'checks/unrelated.cjs']; delete a.run.checks[0].planned_command;
  assert.equal(a.inspect().reason, 'incomplete-verification');
  Object.assign(a.run, structuredClone(original));
  a.run.checks[1].passed = false;
  assert.equal(a.inspect().reason, 'incomplete-verification');
  Object.assign(a.run, structuredClone(original));
  a.run.checks.splice(1);
  assert.equal(a.inspect().reason, 'incomplete-verification');
});

test('latest verifier selection does not borrow an earlier success while a replacement has no results', () => {
  const a = fixture(); a.run.attempts.push(a.verifier('replacement-verifier'));
  assert.equal(a.inspect().reason, 'incomplete-verification');
  a.run.attempts = [a.producer('producer-without-verifier')];
  assert.equal(a.inspect().reason, 'missing-verification');
});

test('unrelated tracked identities and duplicate destinations remain hard ownership errors', () => {
  const a = fixture();
  const foreign = structuredClone(a.knowledge); foreign.meta.id = 'FOREIGN-KNW-0001'; foreign.meta.data.workflow_id = 'FOREIGN-WORKFLOW';
  a.records.set(foreign.meta.id, foreign); a.run.cornell_note_ids.push(foreign.meta.id);
  assert.throws(() => a.inspect(), /same-workflow/);
  a.run.cornell_note_ids.pop(); a.contract.knowledge_directory = a.contract.plan.cornell_output_dir;
  assert.throws(() => a.inspect(), /distinct destinations/);
});
