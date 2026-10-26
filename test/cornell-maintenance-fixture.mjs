import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { researchFixture } from './cornell-research-fixture.mjs';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote } from '../dist/notes.js';
import { createRecord, updateRecord, hash, safePath, atomicWrite } from '../dist/storage.js';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';
import { normalizeControlledCornellSources, controlledCornellResult, bindControlledCornellPractice } from '../dist/controlled-cornell-sources.js';
export function cornellMaintenanceFixture(t, options = {}) {
  const a = researchFixture(t), epoch = randomUUID(), directory = 'docs/research/product',
    sourcePath = options.unbound ? `${directory}/research.json` : 'prepared/research.json';
  const assetRoot = fileURLToPath(new URL('./fixtures/cornell-format-assets/', import.meta.url));
  const template = '.agents/skills/layout/assets/layout.md', validator = '.agents/skills/layout/scripts/check.py';
  for (const [path, name] of [[template, 'cornell-note-template.md'], [validator, 'validate_notes.py']]) {
    mkdirSync(join(a.root, path, '..'), { recursive: true }); copyFileSync(join(assetRoot, name), safePath(a.root, path));
  }
  const profile = { schema_version: 1, id: 'leetcode-cornell-v1',
    template: { path: template, sha256: hash(readFileSync(safePath(a.root, template))) },
    validator: { path: validator, sha256: hash(readFileSync(safePath(a.root, validator))) } };
  const { requirement_id, expected_requirement_revision, workflow_id, output_dir, ...semantic } = structuredClone(a.input);
  semantic.topic = 'Leetcode - 4244 - Retained renderer recovery';
  delete semantic.practice.solution_path; delete semantic.practice.starter;
  semantic.sources = semantic.sources.map(({ record_id, retrieved_at, ...item }) => item);
  const flow = '```mermaid\nflowchart TD\n A[Input] --> B[Count]\n classDef sample fill:#123,stroke:#fff\n class A,B sample\n```';
  semantic.explanations = [{ heading: 'Strategy A: Inspect input', body: '[inferred] Count the finite input independently before producing the bounded result [S1].' },
    { heading: 'Strategy A Flow', body: flow }, { heading: 'Strategy A Worked Example Flow', body: flow }];
  const sourceBytes = JSON.stringify(semantic); mkdirSync(join(a.root, sourcePath, '..'), { recursive: true }); writeFileSync(safePath(a.root, sourcePath), sourceBytes);
  const outputs = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`), checker = 'verify/check.cjs';
  const plan = { title: 'A retained primary Cornell delivery', objective: 'Explain the requested finite example.', rationale: 'Use a reviewed pinned canonical format.',
    acceptance_criteria: ['The note passes the exact approved canonical format and independent checks.'],
    allowed_paths: [directory], verification_paths: ['verify'], outputs, documentation_paths: outputs,
    cornell_output_dir: directory, ...(!options.unbound ? { cornell_input_path: sourcePath } : {}),
    input_paths: [template, validator], preservation_paths: options.unbound ? [] : [sourcePath],
    checks: [{ title: 'Check managed note', command: [process.execPath, checker, outputs[0]], baseline_paths: [...outputs, checker],
      negative_controls: [{ title: 'Reject a wrong note', command: [process.execPath, checker, 'verify/bad.md'], baseline_paths: [checker, 'verify/bad.md'], expected_exit_code: 1 }] }], risk: 'high' };
  const task = createRecord(a.root, { type: 'task', title: plan.title, owner: 'developer', status: 'in-progress',
    links: [{ type: 'satisfies', target: a.requirement.meta.id }], data: { workflow_id: a.workflow.meta.id, epoch_id: epoch, process_contract: 'software-tools/v2',
      acceptance_criteria: plan.acceptance_criteria, allowed_paths: plan.allowed_paths, verification_paths: plan.verification_paths,
      outputs, documentation_paths: outputs } });
  const context = { workflow_id: a.workflow.meta.id, epoch_id: epoch, task_id: task.meta.id, requirement_ids: [a.requirement.meta.id],
    saved_results: [], evidence: [], file_allowed: () => true };
  const sources = normalizeControlledCornellSources(a.root, semantic.sources, context);
  const compiled = compileCornellResearch(a.root, { ...semantic, practice: bindControlledCornellPractice(semantic.practice, directory, false),
    sources: sources.sources, requirement_id: a.requirement.meta.id, expected_requirement_revision: a.requirement.meta.revision,
    workflow_id: a.workflow.meta.id, task_id: task.meta.id, owner: 'developer', output_dir: directory },
    { approved_source_files: sources.approved_source_files, format_profile: profile });
  const legacy = structuredClone(compiled); legacy.note.main_notes = legacy.note.main_notes.replace(/^## Strategy A:/m, '### Strategy A:');
  delete legacy.note.research.format_renderer_revision; legacy.input_hash = hash('fixture legacy compiler input'); legacy.note.research.input_hash = legacy.input_hash;
  legacy.recipe_input.parameters.note = legacy.note;
  const note = createCornellNote(a.root, legacy.note), source = { path: sourcePath, sha256: hash(sourceBytes), size_bytes: Buffer.byteLength(sourceBytes) };
  const result = { ...controlledCornellResult(legacy, note), payload_source: source };
  const contract = { schema_version: 2, process: 'software-tools', workflow_id: a.workflow.meta.id, epoch_id: epoch,
    plan, plan_hash: hash(JSON.stringify(plan)), task_id: task.meta.id, requirement_ids: [a.requirement.meta.id],
    requirement_fingerprints: { [a.requirement.meta.id]: evidenceRecordFingerprint(a.requirement) },
    preserved_hashes: { [sourcePath]: source.sha256, [template]: profile.template.sha256, [validator]: profile.validator.sha256 },
    reviewer_required: true, risk_reasons: ['Mandatory fixture review'], precheck_review: false };
  const contractBytes = `${JSON.stringify(contract, null, 2)}\n`, contractHash = hash(contractBytes);
  atomicWrite(safePath(a.root, `.neomind/controlled/workflows/${hash(a.workflow.meta.id)}.${epoch}.contract.json`), contractBytes);
  updateRecord(a.root, task.meta.id, { data: { controlled_contract_hash: contractHash } });
  updateRecord(a.root, a.workflow.meta.id, { data: { controlled_epoch_id: epoch, controlled_contract_hash: contractHash } });
  const run = { schema_version: 1, workflow_id: a.workflow.meta.id, epoch_id: epoch, status: 'blocked', phase: 'implementation',
    process_contract: 'software-tools/v2', transport: 'vscode-lm', owner_pid: process.pid, owner_instance: 'offline-maintenance-fixture',
    updated_at: new Date().toISOString(), requirement: a.workflow.meta.data.original_requirement, title: plan.title, revision: 17,
    request_id: randomUUID(), contract_hash: contractHash, attempts: [], checks: [], events: [], repairs: 3,
    repair_budget: { schema_version: 1, product: 3, protocol: 0, environment: 0 }, active_invocations: [],
    blocker: { kind: 'unknown', message: 'Diagnostic reconciliation stopped. Original exhausted result remains unchanged.' },
    cornell_note_ids: [note.meta.id], cornell_results: [result] };
  const statePath = safePath(a.root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.json`);
  atomicWrite(statePath, `${JSON.stringify(run, null, 2)}\n`);
  return { ...a, run, note, source, statePath, contractBytes, contract, input: { workflow_id: run.workflow_id, expected_revision: run.revision, note_id: note.meta.id } };
}
