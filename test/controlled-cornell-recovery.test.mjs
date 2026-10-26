import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { researchFixture } from './cornell-research-fixture.mjs';
import { atomicWrite, createRecord, getRecord, updateRecord, safePath, hash, readConfig } from '../dist/storage.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { controlledCornellResult } from '../dist/controlled-cornell-sources.js';
import { persistControlledCornellNote } from '../dist/controlled-cornell-write.js';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';
import { canonicalJson, ensureRoutingPolicy, roleModelPolicy, routingConfigurationHashes } from '../dist/routing.js';
import { controlledToolNames } from '../dist/controlled-tools.js';

// Real owned draft/revision persistence and signed structural actor proofs; no live model or client claim.
function fixture(t) {
  const a = researchFixture(t), epoch = randomUUID();
  const policy = { ...ensureRoutingPolicy(a.root), vscode_effort_policy: 'allow-unavailable' };
  atomicWrite(safePath(a.root, '.neomind/routing.json'), JSON.stringify(policy));
  const paths = ['note.md', 'exercises.md', 'answers.md'].map(name => `${a.input.output_dir}/${name}`);
  const plan = { title: 'Managed research repair', objective: 'Retain canonical Cornell sections and practice.', rationale: 'Repair only an authenticated owned overwrite.',
    acceptance_criteria: ['The canonical Cornell trio and independent results remain required.'], allowed_paths: [a.input.output_dir],
    verification_paths: ['checks'], outputs: paths, documentation_paths: paths, cornell_output_dir: a.input.output_dir,
    checks: [{ title: 'Validate Cornell format', command: ['node', 'checks/validate.cjs'], baseline_paths: paths, negative_controls: [] }] };
  const task = createRecord(a.root, { type: 'task', title: plan.title, owner: 'developer', status: 'in-progress',
    links: [{ type: 'satisfies', target: a.requirement.meta.id }], data: { workflow_id: a.workflow.meta.id, epoch_id: epoch,
      process_contract: 'software-tools/v2', ...Object.fromEntries(['acceptance_criteria','allowed_paths','verification_paths','outputs','documentation_paths'].map(key => [key, plan[key]])) } });
  const input = { ...a.input, task_id: task.meta.id, worked_example: { ...a.input.worked_example } };
  delete input.worked_example.observed; delete input.worked_example.evidence_ids;
  const compiled = compileCornellResearch(a.root, input), note = createCornellNote(a.root, compiled.note), saved = controlledCornellResult(compiled, note);
  const context = { workflow_id: a.workflow.meta.id, epoch_id: epoch, task_id: task.meta.id,
    requirement_ids: [a.requirement.meta.id], evidence: [], saved_results: [saved], file_allowed: () => false };
  const contract = { schema_version: 2, process: 'software-tools', workflow_id: a.workflow.meta.id, epoch_id: epoch, task_id: task.meta.id,
    plan, plan_hash: hash(JSON.stringify(plan)), requirement_ids: [a.requirement.meta.id],
    requirement_fingerprints: { [a.requirement.meta.id]: evidenceRecordFingerprint(a.requirement) }, preserved_hashes: {},
    reviewer_required: true, precheck_review: false, risk_reasons: ['Generated artifact repair remains independently reviewed.'] };
  const contractBytes = JSON.stringify(contract, null, 2) + '\n', contractHash = hash(contractBytes);
  atomicWrite(safePath(a.root, `.neomind/controlled/workflows/${hash(a.workflow.meta.id)}.${epoch}.contract.json`), contractBytes);
  updateRecord(a.root, task.meta.id, { data: { controlled_contract_hash: contractHash } });
  updateRecord(a.root, a.workflow.meta.id, { data: { controlled_epoch_id: epoch, controlled_contract_hash: contractHash } });
  const invocation = randomUUID(), request = randomUUID(), attemptId = randomUUID(), model = roleModelPolicy(a.root, 'developer');
  const binding = { workflow_id: a.workflow.meta.id, task_id: task.meta.id, invocation_id: invocation, role: 'developer', stage: 'implementation',
    implementation_paths: plan.allowed_paths, verification_paths: plan.verification_paths, execution_steps: [], procedure_bound: false, cornell_bound: true };
  const operations = controlledToolNames(binding), { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem);
  atomicWrite(safePath(a.root, `.neomind/native/keys/${keyId}.pem`), pem);
  atomicWrite(safePath(a.root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const receipt = { schema_version: 1, issuer: 'neomind-vscode-lm', id: invocation, project_id: readConfig(a.root).project_id,
    receipt_path: `.neomind/native/receipts/${invocation}.json`, key_id: keyId, role: 'developer', state: 'completed', owner_pid: process.pid,
    execution_mode: 'vscode-extension-host', identity_provenance: 'local-vscode-extension-host', host_instance: 'a'.repeat(64),
    protocol_sha256: hash('neomind-vscode-lm-v1'), runtime_integrity: '', native_sandbox: null,
    native_thread_id: `vscode-host:conversation:${randomUUID()}`, native_turn_id: `vscode-host:turn:${randomUUID()}`, client_version: '1.109.0',
    effort_support: 'unavailable', reasoning_effort: model.reasoning_effort, confirmed_reasoning_effort: null,
    requested_model: model.models[0], confirmed_model: model.models[0], model_provider: 'copilot', inference_completed: true,
    native_tool_scope: operations, gateway_policy_sha256: hash(canonicalJson(operations)), routing_sha256: hash(canonicalJson(policy)),
    configuration_hashes: routingConfigurationHashes(a.root), workflow_id: a.workflow.meta.id, task_id: task.meta.id, request_id: request, reroutes: [],
    controlled_execution: { schema_version: 1, epoch_id: epoch, stage: 'implementation', routing_policy: policy,
      tool_contract: { version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: false, research: true } } };
  atomicWrite(safePath(a.root, receipt.receipt_path), JSON.stringify({ ...receipt, signature: sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64') }));
  const path = compiled.note.path, canonical = readFileSync(safePath(a.root, path)), overwritten = Buffer.from('# A producer removed required research sections.\n');
  const bindingHash = hash(JSON.stringify(binding)), badHash = hash(overwritten), operation = hash(JSON.stringify({ binding_hash: bindingHash, path,
    previous_hash: saved.artifact_hashes[path], sha256: badHash }));
  const base = `.neomind/controlled-tools/${hash(invocation)}`, folder = `${base}/writes/${operation}`;
  const intent = { schema_version: 1, operation, binding_hash: bindingHash, path, previous_hash: hash(canonical), sha256: badHash };
  atomicWrite(safePath(a.root, `${folder}/intent.json`), JSON.stringify(intent, null, 2) + '\n');
  atomicWrite(safePath(a.root, `${folder}/completion.json`), JSON.stringify({ ...intent, kind: 'completed-controlled-file-write' }, null, 2) + '\n');
  atomicWrite(safePath(a.root, `${folder}/previous.utf8`), canonical); atomicWrite(safePath(a.root, `${folder}/next.utf8`), overwritten);
  atomicWrite(safePath(a.root, `${base}/state.json`), JSON.stringify({ schema_version: 1, binding_hash: bindingHash, reads: {}, writes: [{ operation, path,
    previous_hash: hash(canonical), sha256: badHash, completed: true }] }));
  atomicWrite(safePath(a.root, path), overwritten);
  const attempt = { id: attemptId, request_id: request, invocation_id: invocation, role: 'developer', stage: 'implementation', state: 'completed',
    report: { outcome: 'completed', summary: 'The producer reported its owned research output.' },
    bound_hashes: { ...saved.artifact_hashes, [path]: badHash } };
  const report = createRecord(a.root, { type: 'knowledge', title: 'Developer result', owner: 'developer', data: { kind: 'controlled-work-record',
    workflow_id: a.workflow.meta.id, task_id: task.meta.id, epoch_id: epoch, attempt_id: attemptId, invocation_id: invocation, stage: 'implementation',
    outcome: 'completed', report_payload_hash: hash(canonicalJson(attempt.report)), artifact_hashes: attempt.bound_hashes }, body: '# Result\nProducer output remains subject to actual independent acceptance.\n' });
  attempt.report_id = report.meta.id; attempt.report_fingerprint = evidenceRecordFingerprint(report);
  const run = { schema_version: 1, workflow_id: a.workflow.meta.id, epoch_id: epoch, status: 'running', phase: 'implementation',
    process_contract: 'software-tools/v2', transport: 'vscode-lm', contract_hash: contractHash, attempts: [attempt], checks: [], events: [],
    cornell_results: [saved], repairs: 1, revision: 1 };
  const save = () => atomicWrite(safePath(a.root, `.neomind/controlled/workflows/${hash(a.workflow.meta.id)}.json`), JSON.stringify(run)); save();
  return { ...a, input, task, compiled, note, saved, context, path, canonical, overwritten, badHash, folder, base, run, save, receipt, report };
}

test('an owned signed compiler overwrite is regenerated as a new revision with canonical and overwritten history', t => {
  const a = fixture(t), before = getRecord(a.root, a.note.meta.id);
  assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, false);
  assert.throws(() => persistControlledCornellNote(a.root, a.compiled, a.context));
  const repaired = persistControlledCornellNote(a.root, a.compiled, a.context, { recover_owned_overwrite: true });
  assert.equal(repaired.meta.revision, before.meta.revision + 1);
  assert.equal(validateCornellNote(a.root, repaired.meta.id).ok, true);
  const entry = repaired.meta.data.revision_history.at(-1);
  assert.deepEqual(readFileSync(safePath(a.root, entry.artifacts[a.path].history_path)), a.canonical);
  assert.deepEqual(readFileSync(safePath(a.root, entry.owned_artifact_recovery.artifacts[a.path].history_path)), a.overwritten);
  assert.deepEqual(readFileSync(safePath(a.root, a.path)), a.canonical);
  assert.equal(a.run.repairs, 1); assert.equal(a.run.status, 'running', 'Repair does not accept or close a workflow.');
  assert.equal(persistControlledCornellNote(a.root, a.compiled, a.context, { recover_owned_overwrite: true }).meta.revision, repaired.meta.revision);
});

test('owned overwrite eligibility rejects external edits, altered histories, foreign identity and unsigned actors', async t => {
  const { controlledCornellOwnedOverwriteRecovery: eligible } = await import('../dist/controlled-cornell-recovery.js');
  for (const mutation of ['external-edit','completion','canonical-bytes','report','signature','foreign-task','foreign-epoch','missing-saved']) {
    const a = fixture(t);
    assert.equal(eligible(a.root, a.context.workflow_id, a.context.task_id, a.saved).kind, 'owned-cornell-overwrite');
    if (mutation === 'external-edit') writeFileSync(safePath(a.root, a.path), '# Independent user edit must survive.\n');
    if (mutation === 'completion') writeFileSync(safePath(a.root, `${a.folder}/completion.json`), '{}');
    if (mutation === 'canonical-bytes') writeFileSync(safePath(a.root, `${a.folder}/previous.utf8`), '# Different bytes.\n');
    if (mutation === 'report') updateRecord(a.root, a.report.meta.id, {}, a.report.body + '\nChanged outside the saved report.\n');
    if (mutation === 'signature') { const p = safePath(a.root, a.receipt.receipt_path), v = JSON.parse(readFileSync(p)); v.signature = 'invalid'; writeFileSync(p, JSON.stringify(v)); }
    if (mutation === 'foreign-task') a.run.attempts[0].request_id = randomUUID();
    if (mutation === 'foreign-epoch') a.run.attempts[0].invocation_id = randomUUID();
    if (mutation === 'missing-saved') a.run.cornell_results = [];
    a.save(); const bytes = readFileSync(safePath(a.root, a.path)), record = getRecord(a.root, a.note.meta.id);
    assert.throws(() => eligible(a.root, a.context.workflow_id, a.context.task_id, a.saved), mutation);
    assert.throws(() => persistControlledCornellNote(a.root, a.compiled, a.context, { recover_owned_overwrite: true }), mutation);
    assert.deepEqual(readFileSync(safePath(a.root, a.path)), bytes); assert.deepEqual(getRecord(a.root, a.note.meta.id), record);
  }
});

test('interrupted owned overwrite repair resumes only its exact prepared rendering and retains both histories', t => {
  for (const mode of ['partial-render','lost-result']) {
    const a = fixture(t), originalWrite = fs.writeFileSync; let injected = false;
    const revised = compileCornellResearch(a.root, { ...a.input, practice: { ...a.input.practice,
      questions: a.input.practice.questions.map(question => ({ ...question, prompt: `${question.prompt} Explain the equal-length rows.` })) } });
    fs.writeFileSync = function(file, ...args) {
      const path = typeof file === 'string' ? file.replaceAll('\\','/') : '';
      if (!injected && (mode === 'partial-render' ? path.startsWith(safePath(a.root, a.compiled.note.practice.answer_path).replaceAll('\\','/') + '.')
        : /\/controlled\/cornell-writes\/[^/]+\/result\.json\./.test(path))) {
        injected = true; throw Object.assign(new Error('Injected interrupted owned artifact repair.'), { code: 'EIO' });
      }
      return Reflect.apply(originalWrite, this, [file, ...args]);
    }; syncBuiltinESMExports();
    try { assert.throws(() => persistControlledCornellNote(a.root, revised, a.context, { recover_owned_overwrite: true })); }
    finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const repaired = persistControlledCornellNote(a.root, revised, a.context, { recover_owned_overwrite: true });
    assert.equal(validateCornellNote(a.root, repaired.meta.id).ok, true); assert.equal(repaired.meta.revision, a.note.meta.revision + 1);
    assert.equal(repaired.meta.data.revision_history.length, 1);
    assert.deepEqual(readFileSync(safePath(a.root, repaired.meta.data.revision_history[0].owned_artifact_recovery.artifacts[a.path].history_path)), a.overwritten);
  }
});

test('a changed file after owned recovery eligibility is rechecked under the actual revision lock', async t => {
  const a = fixture(t), { controlledCornellOwnedOverwriteRecovery: eligible } = await import('../dist/controlled-cornell-recovery.js');
  assert.ok(eligible(a.root, a.context.workflow_id, a.context.task_id, a.saved));
  const originalWrite = fs.writeFileSync; let injected = false;
  fs.writeFileSync = function(file, ...args) {
    const result = Reflect.apply(originalWrite, this, [file, ...args]);
    if (!injected && typeof file === 'string' && /\/controlled\/cornell-writes\/[^/]+\/rendered\.json\./.test(file.replaceAll('\\','/'))) {
      injected = true; originalWrite(safePath(a.root, a.path), '# Concurrent user edit during compiler rendering.\n');
    }
    return result;
  }; syncBuiltinESMExports();
  try { assert.throws(() => persistControlledCornellNote(a.root, a.compiled, a.context, { recover_owned_overwrite: true })); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.match(readFileSync(safePath(a.root, a.path), 'utf8'), /Concurrent user edit/);
  assert.equal(getRecord(a.root, a.note.meta.id).meta.revision, a.note.meta.revision);
});

test('backend canonical restoration preserves semantic provenance and creates one managed revision without a model payload', async t => {
  const { restoreControlledCornellOwnedArtifacts: restore } = await import('../dist/controlled-cornell-restore.js');
  const a = fixture(t), original = getRecord(a.root, a.note.meta.id), first = restore(a.root, a.context.workflow_id, a.context.task_id, a.saved);
  assert.equal(first.replayed, false); assert.equal(first.note.meta.revision, original.meta.revision + 1);
  assert.equal(first.result.input_hash, a.saved.input_hash); assert.equal(first.result.compiled_note_hash, a.saved.compiled_note_hash);
  assert.deepEqual(first.result.artifact_hashes, a.saved.artifact_hashes);
  assert.equal(first.note.body, original.body); assert.deepEqual(first.note.meta.data.research, original.meta.data.research);
  assert.deepEqual(first.note.meta.data.sources, original.meta.data.sources); assert.deepEqual(first.note.meta.data.demonstration, original.meta.data.demonstration);
  assert.equal(validateCornellNote(a.root, first.note.meta.id).ok, true);
  const history = first.note.meta.data.revision_history.at(-1);
  assert.deepEqual(readFileSync(safePath(a.root, history.artifacts[a.path].history_path)), a.canonical);
  assert.deepEqual(readFileSync(safePath(a.root, history.owned_artifact_recovery.artifacts[a.path].history_path)), a.overwritten);
  const again = restore(a.root, a.context.workflow_id, a.context.task_id, a.saved);
  assert.equal(again.replayed, true); assert.equal(again.note.meta.revision, first.note.meta.revision); assert.deepEqual(again.result, first.result);
  assert.equal(a.run.status, 'running'); assert.equal(a.run.repairs, 1); assert.equal(a.run.cornell_results.length, 1);
});

test('canonical restoration reconciles exact partially restored files and a committed revision with lost result', async t => {
  const { restoreControlledCornellOwnedArtifacts: restore } = await import('../dist/controlled-cornell-restore.js');
  for (const mode of ['partial-file', 'lost-result']) {
    const a = fixture(t), originalWrite = fs.writeFileSync, originalRename = fs.renameSync; let injected = false;
    fs.writeFileSync = function(file, ...args) {
      if (mode === 'lost-result' && !injected && typeof file === 'string' && /\/controlled\/cornell-restorations\/[^/]+\/result\.json\./.test(file.replaceAll('\\','/'))) {
        injected = true; throw Object.assign(new Error('Injected lost restoration result.'), { code: 'EIO' });
      }
      return Reflect.apply(originalWrite, this, [file, ...args]);
    };
    fs.renameSync = function(source, target) {
      const result = Reflect.apply(originalRename, this, [source, target]);
      if (mode === 'partial-file' && !injected && target === safePath(a.root, a.path)) {
        injected = true; throw Object.assign(new Error('Injected response loss after exact canonical file replacement.'), { code: 'EIO' });
      }
      return result;
    }; syncBuiltinESMExports();
    try { assert.throws(() => restore(a.root, a.context.workflow_id, a.context.task_id, a.saved), error => error.code === 'STATE_UNCERTAIN'); }
    finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const recovered = restore(a.root, a.context.workflow_id, a.context.task_id, a.saved);
    assert.equal(recovered.note.meta.revision, a.note.meta.revision + 1); assert.equal(recovered.note.meta.data.revision_history.length, 1);
    assert.equal(validateCornellNote(a.root, recovered.note.meta.id).ok, true);
    assert.equal(restore(a.root, a.context.workflow_id, a.context.task_id, a.saved).note.meta.revision, recovered.note.meta.revision);
  }
});

test('canonical restoration refuses concurrent edits at CAS commit and reauthenticates source history on replay', async t => {
  const { restoreControlledCornellOwnedArtifacts: restore } = await import('../dist/controlled-cornell-restore.js');
  const a = fixture(t), originalWrite = fs.writeFileSync; let injected = false;
  fs.writeFileSync = function(file, ...args) {
    const result = Reflect.apply(originalWrite, this, [file, ...args]);
    if (!injected && typeof file === 'string' && file.startsWith(safePath(a.root, a.path) + '.')) {
      injected = true; originalWrite(safePath(a.root, a.path), '# Concurrent user edit while a canonical restoration is prepared.\n');
    }
    return result;
  }; syncBuiltinESMExports();
  try { assert.throws(() => restore(a.root, a.context.workflow_id, a.context.task_id, a.saved), error => error.code === 'STATE_UNCERTAIN'); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.match(readFileSync(safePath(a.root, a.path), 'utf8'), /Concurrent user edit/);
  assert.equal(getRecord(a.root, a.note.meta.id).meta.revision, a.note.meta.revision);
  assert.throws(() => restore(a.root, a.context.workflow_id, a.context.task_id, a.saved));
  const b = fixture(t), restored = restore(b.root, b.context.workflow_id, b.context.task_id, b.saved), snapshot = readFileSync(safePath(b.root, b.path));
  writeFileSync(safePath(b.root, `${b.folder}/completion.json`), '{}');
  assert.throws(() => restore(b.root, b.context.workflow_id, b.context.task_id, b.saved));
  assert.deepEqual(readFileSync(safePath(b.root, b.path)), snapshot); assert.equal(getRecord(b.root, b.note.meta.id).meta.revision, restored.note.meta.revision);
});

test('canonical restoration cannot replace a newer committed semantic compiler generation or bypass its owner guard', async t => {
  const { restoreControlledCornellOwnedArtifacts: restore } = await import('../dist/controlled-cornell-restore.js');
  const a = fixture(t), revised = compileCornellResearch(a.root, { ...a.input, discussion: `${a.input.discussion}\n\n[expected] A newer independently reviewable research conclusion remains authoritative [S1].` });
  const newer = persistControlledCornellNote(a.root, revised, a.context, { recover_owned_overwrite: true });
  a.run.cornell_results.push(controlledCornellResult(revised, newer)); a.save();
  const current = readFileSync(safePath(a.root, a.path));
  assert.throws(() => restore(a.root, a.context.workflow_id, a.context.task_id, a.saved));
  assert.deepEqual(readFileSync(safePath(a.root, a.path)), current); assert.equal(getRecord(a.root, a.note.meta.id).meta.revision, newer.meta.revision);
  const b = fixture(t); let guarded = 0;
  assert.throws(() => restore(b.root, b.context.workflow_id, b.context.task_id, b.saved, { assertActive() { guarded++; throw new Error('Stopped owner.'); } }));
  assert.equal(guarded, 1); assert.deepEqual(readFileSync(safePath(b.root, b.path)), b.overwritten);
});
