// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hash, atomicWrite, safePath, createRecord, getRecord, updateRecord } from '../dist/storage.js';
import { createControlledMcpServer } from '../dist/controlled-tools.js';
import { controlledReviewContext } from '../dist/controlled-review-context.js';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';

// Structural authority fixtures; these do not claim provider inference.
function fixture(t, count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-review-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'REVIEW', name: 'Bound review context' });
  const requirement = createRecord(root, { type: 'requirement', title: 'Preserve sources and report actual checks.', owner: 'manager' });
  const parent = createRecord(root, { type: 'knowledge', title: 'Workflow: preservation', owner: 'manager', status: 'in-progress',
    data: { kind: 'manager-workflow', phase: 'review' } });
  const epoch_id = randomUUID(), preserved = Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const path = `prior/file-${String(index).padStart(3, '0')}.md`, content = `Preserved original ${index}\n`;
    atomicWrite(safePath(root, path), content); return [path, hash(content)];
  }));
  atomicWrite(safePath(root, 'docs/report.md'), '# Implementation handoff\nIndependent checks will follow.\n');
  const plan = { title: 'Bound report', objective: 'Report observed execution.', rationale: 'Keep independent evidence visible.',
    acceptance_criteria: ['Final docs/report.md contains actual independently observed results.'],
    allowed_paths: ['docs'], verification_paths: ['checks'], outputs: ['docs/report.md'],
    documentation_paths: ['docs/report.md'], checks: [] };
  const task = createRecord(root, { type: 'task', title: 'Execution', owner: 'developer', status: 'in-progress',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { workflow_id: parent.meta.id, epoch_id, process_contract: 'software-tools/v2',
      ...Object.fromEntries(['acceptance_criteria', 'allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'].map(key => [key, plan[key]])) } });
  const contract = { schema_version: 2, process: 'software-tools', workflow_id: parent.meta.id, epoch_id, plan,
    plan_hash: hash(JSON.stringify(plan)), task_id: task.meta.id, requirement_ids: [requirement.meta.id],
    requirement_fingerprints: { [requirement.meta.id]: evidenceRecordFingerprint(requirement) }, preserved_hashes: preserved,
    reviewer_required: true, risk_reasons: ['State-sensitive requirement.'], precheck_review: false };
  const run = { schema_version: 1, workflow_id: parent.meta.id, epoch_id, process_contract: 'software-tools/v2',
    status: 'running', phase: 'review', revision: 7, checks: [], attempts: [],
    events: [{ kind: 'plan-saved', at: '2026-10-25T21:38:29.376Z', summary: 'Original bound baseline.' }] };
  const statePath = safePath(root, `.neomind/controlled/workflows/${hash(parent.meta.id)}.json`);
  const contractPath = safePath(root, `.neomind/controlled/workflows/${hash(parent.meta.id)}.${epoch_id}.contract.json`);
  const saveRun = () => atomicWrite(statePath, JSON.stringify(run));
  const seal = () => {
    const bytes = JSON.stringify(contract, null, 2) + '\n'; run.contract_hash = hash(bytes);
    atomicWrite(contractPath, bytes); saveRun();
    updateRecord(root, parent.meta.id, { data: { controlled_epoch_id: epoch_id, controlled_contract_hash: run.contract_hash } });
    updateRecord(root, task.meta.id, { data: { controlled_contract_hash: run.contract_hash } });
  };
  seal();
  const snapshot = () => JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const path = join(entry.parentPath, entry.name); return [path, hash(readFileSync(path))]; }).sort(([a], [b]) => a.localeCompare(b)));
  return { root, run, contract, parent, task, requirement, statePath, contractPath, saveRun, seal, snapshot };
}

test('one workflow-context evaluation reads each record once and a later evaluation sees record changes', t => {
  const { root, run, contract } = fixture(t);
  const report = createRecord(root, { type: 'knowledge', title: 'Pending backend final report', owner: 'manager', data: {
    kind: 'controlled-final-report', workflow_id: run.workflow_id, epoch_id: run.epoch_id, contract_hash: run.contract_hash } });
  run.finalizing_report_id = report.meta.id;
  atomicWrite(safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.json`), JSON.stringify(run));
  const prefix = safePath(root, '.neomind/records').replaceAll('\\', '/').toLowerCase() + '/', reads = new Map(), original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string') {
      const path = file.replaceAll('\\', '/').toLowerCase();
      if (path.startsWith(prefix) && path.endsWith('.md')) reads.set(path, (reads.get(path) ?? 0) + 1);
    }
    return Reflect.apply(original, this, [file, ...args]);
  }; syncBuiltinESMExports();
  let value;
  try { value = controlledReviewContext(root, run, contract); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  assert.equal(value.available, true); assert.equal(value.finalization.backend_final_report, 'pending-acceptance');
  assert.ok(reads.size >= 4); assert.equal(Math.max(...reads.values()), 1, 'Task, contract and final-report lookup share one fresh record view per evaluation.');
  const requirement = getRecord(root, contract.requirement_ids[0]);
  updateRecord(root, requirement.meta.id, {}, requirement.body + '\nAn external requirement edit must not inherit a cached preservation observation.\n');
  assert.throws(() => controlledReviewContext(root, run, contract), /requirement baseline changed/);
});

test('Reviewer receives actual original preservation hashes and explicit report lifecycle without changing records', t => {
  const { root, run, contract, snapshot } = fixture(t), before = snapshot();
  const evidence = controlledReviewContext(root, run, contract);
  assert.equal(evidence.available, true); assert.equal(evidence.source, 'backend-immutable-contract-and-current-files');
  assert.equal(evidence.preservation.baseline_source, 'original-immutable-plan');
  assert.equal(evidence.preservation.baseline_captured_at, '2026-10-25T21:38:29.376Z');
  assert.equal(evidence.preservation.file_count, 2); assert.equal(evidence.preservation.all_unchanged, true);
  assert.ok(evidence.preservation.files.every(file => file.unchanged && file.expected_sha256 === file.current_sha256));
  assert.match(evidence.preservation.coverage, /not a whole-repository historical snapshot/);
  assert.equal(evidence.finalization.backend_final_report, 'not-created');
  assert.equal(evidence.finalization.final_report_pending, true);
  assert.deepEqual(evidence.finalization.producer_documents, [{ path: 'docs/report.md', owner: 'developer',
    declared_output: true, final_criteria_still_apply: true }]);
  assert.match(evidence.finalization.duties, /handoff prose cannot replace promised post-verification findings/i);
  assert.equal(snapshot(), before, 'An observation cannot rebaseline, rewrite reports or pass an acceptance gate.');
});

test('changed original files are visible even beyond the display bound and never silently rebased', t => {
  const { root, run, contract, snapshot } = fixture(t, 70), path = 'prior/file-069.md';
  const expected = contract.preserved_hashes[path]; atomicWrite(safePath(root, path), 'unexpected change\n');
  const before = snapshot(), evidence = controlledReviewContext(root, run, contract, 'final-product', 4);
  assert.equal(evidence.preservation.all_unchanged, false); assert.equal(evidence.preservation.changed_count, 1);
  assert.equal(evidence.preservation.displayed_count, 4); assert.equal(evidence.preservation.omitted_count, 66);
  assert.equal(evidence.preservation.files[0].path, path); assert.equal(evidence.preservation.files[0].expected_sha256, expected);
  assert.equal(evidence.preservation.files[0].unchanged, false); assert.equal(snapshot(), before);
  assert.equal(contract.preserved_hashes[path], expected);
});

test('private preserved configuration stays hidden while approved canonical skill hashes remain visible', t => {
  const { root, run, contract, seal } = fixture(t);
  const privatePath = '.codex/auth.json', skill = '.agents/skills/course/assets/template.md';
  atomicWrite(safePath(root, privatePath), '{"secret":"DO_NOT_DISCLOSE_CONTENT"}');
  atomicWrite(safePath(root, skill), '# Canonical template\n');
  contract.preserved_hashes[privatePath] = hash(readFileSync(safePath(root, privatePath)));
  contract.preserved_hashes[skill] = hash(readFileSync(safePath(root, skill))); contract.plan.input_paths = [skill];
  contract.plan_hash = hash(JSON.stringify(contract.plan)); seal();
  const evidence = controlledReviewContext(root, run, contract), serialized = JSON.stringify(evidence);
  assert.equal(evidence.preservation.file_count, 4); assert.equal(evidence.preservation.private_path_count, 1);
  assert.ok(evidence.preservation.files.some(file => file.path === skill));
  assert.doesNotMatch(serialized, /DO_NOT_DISCLOSE_CONTENT|\.codex\/auth\.json/);
});

test('foreign, stale or tampered contracts cannot create an apparent trusted baseline', t => {
  const { root, run, contract, contractPath, task } = fixture(t);
  assert.equal(controlledReviewContext(root, run).reason, 'NO_FROZEN_CONTRACT');
  assert.equal(controlledReviewContext(root, { ...run, workflow_id: 'OTHER-KNW-0001' }, contract).reason, 'CONTRACT_BINDING_MISMATCH');
  const forged = structuredClone(contract); forged.preserved_hashes['prior/file-000.md'] = 'f'.repeat(64);
  assert.equal(controlledReviewContext(root, run, forged).reason, 'CONTRACT_BINDING_MISMATCH');
  assert.throws(() => controlledReviewContext(root, run, contract, 'final-product', 129), /one and 128/);
  atomicWrite(contractPath, JSON.stringify(forged));
  assert.throws(() => controlledReviewContext(root, run, contract), /immutable contract do not match/);
  assert.equal(getRecord(root, task.meta.id).meta.status, 'in-progress');
});

test('latest independent verifier freshness and final record state come from authoritative journal', t => {
  const { root, run, contract, saveRun } = fixture(t);
  run.attempts = [{ id: 'producer', stage: 'implementation', state: 'completed', report: { outcome: 'completed' } },
    { id: 'verifier', stage: 'verification', state: 'completed', report: { outcome: 'completed' } }];
  run.checks = [{ id: 'positive', attempt_id: 'verifier', title: 'Positive product check', negative: false, passed: true },
    { id: 'negative', attempt_id: 'verifier', title: 'Reject wrong product', negative: true, passed: true }]; saveRun();
  let evidence = controlledReviewContext(root, run, contract);
  assert.equal(evidence.checks.fresh_after_latest_producer, true); assert.equal(evidence.checks.positive_count, 1);
  assert.equal(evidence.checks.negative_count, 1); assert.equal(evidence.checks.journal_results_all_passed, true);
  run.attempts.push({ id: 'repair', stage: 'implementation', state: 'running' }); saveRun();
  assert.equal(controlledReviewContext(root, run, contract).checks.fresh_after_latest_producer, false);
  const final = createRecord(root, { type: 'knowledge', title: 'Backend closure', owner: 'manager',
    data: { kind: 'controlled-final-report', workflow_id: run.workflow_id, epoch_id: run.epoch_id, contract_hash: run.contract_hash } });
  run.finalizing_report_id = final.meta.id; saveRun();
  assert.equal(controlledReviewContext(root, run, contract).finalization.backend_final_report, 'pending-acceptance');
  run.final_report_id = final.meta.id; run.phase = 'completed'; run.status = 'completed'; saveRun();
  evidence = controlledReviewContext(root, run, contract);
  assert.equal(evidence.finalization.backend_final_report, 'completed'); assert.equal(evidence.finalization.final_report_pending, false);
  updateRecord(root, final.meta.id, { data: { epoch_id: randomUUID() } });
  assert.equal(controlledReviewContext(root, run, contract).finalization.backend_final_report, 'invalid');
});

test('final reviewer can request backend workflow evidence through the actual bound MCP schema', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-review-context-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'REVIEW', name: 'Bound review evidence' });
  const expected = { kind: 'workflow', preservation: { all_unchanged: true }, finalization: { final_report_pending: true } };
  let actualKind;
  const server = createControlledMcpServer(root, { workflow_id: 'REVIEW-KNW-0001', task_id: 'REVIEW-TASK-0001',
    invocation_id: 'actual-independent-reviewer', stage: 'review', role: 'reviewer',
    implementation_paths: ['src'], verification_paths: ['checks'] }, {
    assertActive() {}, saveReport: () => ({ saved: true }),
    readEvidence: (_title, kind) => { actualKind = kind; return expected; },
  });
  const client = new Client({ name: 'review-workflow-context', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'check_evidence', arguments: { kind: 'workflow' } });
  assert.notEqual(result.isError, true, 'A real Reviewer must receive this trusted evidence without guessing private paths.');
  assert.equal(actualKind, 'workflow');
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  assert.equal((await client.callTool({ name: 'check_evidence', arguments: { kind: 'workflow', workflow_id: 'foreign' } })).isError, true);
});
