import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { initialize, atomicWrite, safePath, hash, createRecord, updateRecord, getRecord, readConfig } from '../dist/storage.js';
import { canonicalJson, ensureRoutingPolicy, roleModelPolicy, routingConfigurationHashes } from '../dist/routing.js';
import { controlledToolNames } from '../dist/controlled-tools.js';
import { evidenceRecordFingerprint } from '../dist/evidence-inputs.js';
import { controlledFingerprints, prepareControlledCheckEvidence, materializeControlledEvidence } from '../dist/controlled-acceptance.js';
import { runCommand } from '../dist/command-runner.js';
import { pendingEvidenceDocumentation } from '../dist/controlled-report-phase.js';
import { assertEvidenceDocumentationAuthority } from '../dist/controlled-report-authority.js';
import { captureControlledCheckerScope } from '../dist/controlled-checker-scope.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Signed structural actor fixtures plus real positive/negative Node processes.
// They test authority boundaries, not live provider inference or client acceptance.
async function fixture(t, verdict = 'pass') {
  const parentPath = resolve(tmpdir()), root = mkdtempSync(join(parentPath, 'neomind-report-authority-'));
  t.after(() => { assert.equal(dirname(resolve(root)), parentPath); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'REPORT-AUTHORITY' });
  const policy = { ...ensureRoutingPolicy(root), vscode_effort_policy: 'allow-unavailable' };
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify(policy));
  const requirement = createRecord(root, { type: 'requirement', title: 'Preserve product and report independent results.', owner: 'manager' });
  const workflow = createRecord(root, { type: 'knowledge', title: 'Workflow: factual report', owner: 'manager', status: 'in-progress',
    data: { kind: 'manager-workflow', phase: 'implementation' } });
  for (const [path, content] of Object.entries({ 'src/value.txt': '1\n', 'docs/report.md': '# Handoff\nIndependent verification is pending.\n',
    'checks/bad.txt': '2\n', 'prior.md': '# Existing source\n',
    'checks/check.cjs': "const fs=require('node:fs');process.exit(fs.readFileSync(process.argv[2],'utf8').trim()==='1'?0:1);\n" }))
    atomicWrite(safePath(root, path), content);
  const plan = { title: 'Factual report', objective: 'Report actual independently checked output.', rationale: 'Keep source and evidence distinct.',
    allowed_paths: ['src', 'docs'], verification_paths: ['checks'], outputs: ['src/value.txt', 'docs/report.md'],
    documentation_paths: ['docs/report.md'], evidence_report_paths: ['docs/report.md'], preservation_paths: ['prior.md'],
    acceptance_criteria: ['Final report at docs/report.md contains actual results.'],
    checks: [{ title: 'Product is one', command: [process.execPath, 'checks/check.cjs', 'src/value.txt'],
      baseline_paths: ['src/value.txt', 'checks/check.cjs', 'docs/report.md'], expected_exit_code: 0,
      negative_controls: [{ title: 'Reject wrong value', command: [process.execPath, 'checks/check.cjs', 'checks/bad.txt'],
        baseline_paths: ['checks/bad.txt', 'checks/check.cjs', 'docs/report.md'], expected_exit_code: 1 }] }] };
  const epoch_id = randomUUID(), task = createRecord(root, { type: 'task', title: 'Actual bounded output', owner: 'developer', status: 'submitted',
    links: [{ type: 'satisfies', target: requirement.meta.id }], data: { workflow_id: workflow.meta.id, epoch_id,
      process_contract: 'software-tools/v2', ...Object.fromEntries(['acceptance_criteria', 'allowed_paths', 'verification_paths', 'outputs', 'documentation_paths']
        .map(key => [key, plan[key]])) } });
  const contract = { schema_version: 2, process: 'software-tools', workflow_id: workflow.meta.id, epoch_id, task_id: task.meta.id,
    plan, plan_hash: hash(JSON.stringify(plan)), requirement_ids: [requirement.meta.id],
    requirement_fingerprints: { [requirement.meta.id]: evidenceRecordFingerprint(requirement) },
    preserved_hashes: controlledFingerprints(root, ['prior.md']), reviewer_required: true, precheck_review: false, risk_reasons: ['Factual report.'] };
  const contractBytes = JSON.stringify(contract, null, 2) + '\n', contractHash = hash(contractBytes);
  atomicWrite(safePath(root, `.neomind/controlled/workflows/${hash(workflow.meta.id)}.${epoch_id}.contract.json`), contractBytes);
  updateRecord(root, task.meta.id, { data: { controlled_contract_hash: contractHash } });
  updateRecord(root, workflow.meta.id, { data: { controlled_epoch_id: epoch_id, controlled_contract_hash: contractHash } });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem);
  atomicWrite(safePath(root, `.neomind/native/keys/${keyId}.pem`), pem);
  atomicWrite(safePath(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const actor = (role, stage) => {
    const id = randomUUID(), request_id = randomUUID(), modelPolicy = roleModelPolicy(root, role), binding = {
      workflow_id: workflow.meta.id, task_id: task.meta.id, role, stage, implementation_paths: plan.allowed_paths,
      verification_paths: plan.verification_paths, execution_steps: [], procedure_bound: false, cornell_bound: false };
    const operations = controlledToolNames(binding), receipt = { schema_version: 1, issuer: 'neomind-vscode-lm', id,
      project_id: readConfig(root).project_id, receipt_path: `.neomind/native/receipts/${id}.json`, key_id: keyId,
      role, state: 'completed', owner_pid: process.pid, execution_mode: 'vscode-extension-host', identity_provenance: 'local-vscode-extension-host',
      host_instance: 'a'.repeat(64), protocol_sha256: hash('neomind-vscode-lm-v1'), runtime_integrity: '', native_sandbox: null,
      native_thread_id: `vscode-host:conversation:${randomUUID()}`, native_turn_id: `vscode-host:turn:${randomUUID()}`, client_version: '1.109.0',
      effort_support: 'unavailable', reasoning_effort: modelPolicy.reasoning_effort, confirmed_reasoning_effort: null,
      requested_model: modelPolicy.models[0], confirmed_model: modelPolicy.models[0], model_provider: 'copilot', inference_completed: true,
      native_tool_scope: operations, gateway_policy_sha256: hash(canonicalJson(operations)), routing_sha256: hash(canonicalJson(policy)),
      configuration_hashes: routingConfigurationHashes(root), workflow_id: workflow.meta.id, task_id: task.meta.id, request_id, reroutes: [],
      controlled_execution: { schema_version: 1, epoch_id, stage, routing_policy: policy, tool_contract: { version: 3,
        local_execution: false, qualified_procedure: false, evidence_documentation: false, research: false } } };
    atomicWrite(safePath(root, receipt.receipt_path), JSON.stringify({ ...receipt,
      signature: sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64') }));
    return { id: randomUUID(), request_id, invocation_id: id, role, stage, state: 'completed' };
  };
  const producer = actor('developer', 'implementation'), verifier = actor('verifier', 'verification');
  const run = { schema_version: 1, process_contract: 'software-tools/v2', workflow_id: workflow.meta.id, epoch_id, contract_hash: contractHash,
    status: 'queued', phase: 'implementation', revision: 10, attempts: [producer, verifier], checks: [], events: [], repairs: 0 };
  const report = (attempt, boundPaths) => {
    attempt.bound_hashes = controlledFingerprints(root, boundPaths);
    attempt.report = { outcome: 'completed', summary: 'Actual bounded work result.', ...(attempt.stage === 'verification' ? { verdict,
      ...(verdict === 'fail' ? { findings: ['The factual report is still pending.', 'An additional semantic finding must remain visible.'] } : {}) } : {}) };
    const record = createRecord(root, { type: 'knowledge', title: `${attempt.role}: result`, owner: attempt.role,
      data: { kind: 'controlled-work-record', workflow_id: run.workflow_id, task_id: task.meta.id, epoch_id,
        attempt_id: attempt.id, invocation_id: attempt.invocation_id, stage: attempt.stage, outcome: 'completed',
        report_payload_hash: hash(canonicalJson(attempt.report)), artifact_hashes: attempt.bound_hashes }, body: '# Result\nActual bounded work result.\n' });
    attempt.report_id = record.meta.id; attempt.report_fingerprint = evidenceRecordFingerprint(record);
  };
  report(producer, plan.outputs);
  for (const selected of [{ ...plan.checks[0], negative: false }, ...plan.checks[0].negative_controls.map(check => ({ ...check, negative: true }))]) {
    const baseline = controlledFingerprints(root, selected.baseline_paths);
    const evidenceInput = prepareControlledCheckEvidence(root, run, contract, selected, baseline, verifier.invocation_id);
    const result = await runCommand({ command: selected.command, cwd: root, timeout_ms: 5000 });
    assert.equal(result.exit_code, selected.expected_exit_code);
    const id = randomUUID(), logPath = `.neomind/controlled/checks/${id}.log`;
    const checkerScope = captureControlledCheckerScope(plan.verification_paths, paths => controlledFingerprints(root, paths));
    const log = JSON.stringify({ command: selected.command, planned_command: selected.command, purpose: 'self-check', baseline, result, checker_scope: checkerScope });
    atomicWrite(safePath(root, logPath), log);
    const check = { id, attempt_id: verifier.id, invocation_id: verifier.invocation_id, title: selected.title,
      command: selected.command, planned_command: selected.command, purpose: 'self-check', baseline, log_path: logPath, log_sha256: hash(log),
      exit_code: result.exit_code, expected_exit_code: selected.expected_exit_code, negative: selected.negative, passed: true,
      cancelled: false, at: new Date().toISOString(), evidence_input: evidenceInput, checker_scope: checkerScope };
    check.evidence_id = materializeControlledEvidence(root, run, contract, check); run.checks.push(check);
  }
  report(verifier, ['checks/check.cjs', 'checks/bad.txt']);
  const source = pendingEvidenceDocumentation(run, contract);
  assert.ok(source);
  const statePath = safePath(root, `.neomind/controlled/workflows/${hash(workflow.meta.id)}.json`), save = () => atomicWrite(statePath, JSON.stringify(run)); save();
  const snapshot = () => JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const path = join(entry.parentPath, entry.name); return [path, hash(readFileSync(path))]; }).sort(([a], [b]) => a.localeCompare(b)));
  return { root, run, contract, source, producer, verifier, save, snapshot };
}

test('one authority evaluation reads each engineering record once and the next evaluation sees edits', async t => {
  const state = await fixture(t), originalRead = fs.readFileSync, counts = new Map();
  const records = safePath(state.root, '.neomind/records').replaceAll('\\', '/').toLowerCase() + '/';
  let guard;
  try {
    fs.readFileSync = function(path, ...args) {
      if (typeof path === 'string') {
        const normalized = path.replaceAll('\\', '/').toLowerCase();
        if (normalized.startsWith(records) && normalized.endsWith('.md')) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
      return Reflect.apply(originalRead, this, [path, ...args]);
    };
    syncBuiltinESMExports();
    guard = assertEvidenceDocumentationAuthority(state.root, state.run, state.contract, state.source);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  assert.equal(guard['src/value.txt'], hash('1\n')); assert.ok(counts.size >= 7);
  assert.equal(Math.max(...counts.values()), 1, 'One per-evaluation record view must replace repeated full repository record loads.');
  const record = getRecord(state.root, state.producer.report_id);
  updateRecord(state.root, record.meta.id, {}, record.body + '\nA later user edit must not inherit a cached verdict.\n');
  assert.throws(() => assertEvidenceDocumentationAuthority(state.root, state.run, state.contract, state.source), /saved typed report/);
});

test('authenticated real check checkpoint authorizes only report changes and returns intact non-report guards', async t => {
  const state = await fixture(t), { root, run, contract, source, snapshot } = state, before = snapshot();
  const guard = assertEvidenceDocumentationAuthority(root, run, contract, source);
  assert.equal(guard['src/value.txt'], hash('1\n')); assert.equal(guard['prior.md'], hash('# Existing source\n'));
  assert.ok(guard['checks/check.cjs']); assert.equal('docs/report.md' in guard, false);
  assert.equal(snapshot(), before, 'Authority checks never rewrite old evidence, records or baselines.');
  run.attempts.push({ id: randomUUID(), request_id: randomUUID(), role: 'developer', stage: 'implementation', purpose: 'evidence-documentation',
    state: 'running', documentation_source: source }); run.status = 'running'; state.save();
  atomicWrite(safePath(root, 'docs/report.md'), '# Final report\nThe product check exited zero; wrong value exited one.\n');
  assert.deepEqual(assertEvidenceDocumentationAuthority(root, run, contract, source), guard,
    'A legitimate report commit does not invalidate its earlier immutable evidence snapshot.');
});

test('completed signed fail remains unchanged while sealed successful executions authorize only the planned report handoff', async t => {
  const state = await fixture(t, 'fail'), { root, run, contract, source, snapshot } = state;
  const original = structuredClone(state.verifier.report), record = getRecord(root, state.verifier.report_id), before = snapshot();
  const guard = assertEvidenceDocumentationAuthority(root, run, contract, source);
  assert.equal(guard['src/value.txt'], hash('1\n')); assert.equal('docs/report.md' in guard, false);
  assert.deepEqual(state.verifier.report, original); assert.equal(state.verifier.report.verdict, 'fail');
  assert.deepEqual(getRecord(root, state.verifier.report_id), record); assert.equal(snapshot(), before);
  run.status = 'blocked'; state.save(); const blockedBefore = snapshot();
  assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, source), /assignment differs/);
  assert.deepEqual(assertEvidenceDocumentationAuthority(root, run, contract, source, { allow_blocked: true }), guard,
    'Explicit backend resume can reauthenticate a blocked checkpoint without writing files or refunding a repair.');
  assert.equal(snapshot(), blockedBefore); assert.deepEqual(state.verifier.report, original);
  const helper = safePath(root, 'checks/new-helper.cjs'); atomicWrite(helper, '// An outside checker edit\n');
  assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, source, { allow_blocked: true }), /checker scope changed outside/,
    'Passing old exits cannot authorize a handoff after the approved checker scope changes.');
});

test('missing or changed source checker seals cannot authorize a new report handoff', async t => {
  const state = await fixture(t);
  const original = structuredClone(state.run.checks[0].checker_scope);
  delete state.run.checks[0].checker_scope; state.save();
  assert.throws(() => assertEvidenceDocumentationAuthority(state.root, state.run, state.contract, state.source), /execution-time seal/);
  state.run.checks[0].checker_scope = { ...original, sha256: 'f'.repeat(64) }; state.save();
  assert.throws(() => assertEvidenceDocumentationAuthority(state.root, state.run, state.contract, state.source), /checker scope changed outside/);
});

test('user product/checker/preserved edits after the checkpoint cannot be adopted by the report-only actor', async t => {
  const state = await fixture(t);
  for (const path of ['src/value.txt', 'checks/check.cjs', 'checks/bad.txt', 'prior.md']) {
    const full = safePath(state.root, path), original = readFileSync(full); atomicWrite(full, 'Unexpected edit\n');
    assert.throws(() => assertEvidenceDocumentationAuthority(state.root, state.run, state.contract, state.source), /changed outside|source check input changed/);
    atomicWrite(full, original);
  }
});

test('source stage identity and typed report payload/fingerprint are authenticated before every handoff', async t => {
  const state = await fixture(t), { root, run, contract, source, producer, verifier, save } = state;
  for (const mutate of [() => { producer.request_id = randomUUID(); }, () => { verifier.request_id = randomUUID(); },
    () => { producer.bound_hashes = {}; }, () => { producer.report.summary = 'A forged summary'; },
    () => { verifier.report_fingerprint = 'f'.repeat(64); }]) {
    const original = structuredClone(run); mutate(); save();
    assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, source), /source stage|original producer|signed result/);
    Object.assign(run, original); save();
    // The fixture references must follow the restored authoritative attempt objects.
    Object.assign(producer, original.attempts[0]); Object.assign(verifier, original.attempts[1]);
    run.attempts = [producer, verifier]; save();
  }
  const record = getRecord(root, producer.report_id); updateRecord(root, record.meta.id, {}, record.body + '\nChanged body.\n');
  assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, source), /saved typed report/);
});

test('altered actual check logs and typed execution evidence cannot authorize report writing', async t => {
  const state = await fixture(t), { root, run, contract, source } = state, check = run.checks[0];
  const logPath = safePath(root, check.log_path), original = readFileSync(logPath);
  atomicWrite(logPath, JSON.stringify({ result: { exit_code: 0 }, command: ['invented'] }));
  assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, source), /source check log changed/);
  atomicWrite(logPath, original);
  const evidence = getRecord(root, check.evidence_id); updateRecord(root, evidence.meta.id, { data: { execution_invocation_id: randomUUID() } });
  assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, source), /typed check evidence differs/);
});

test('forged source paths and another epoch cannot widen report scope or reuse stale ownership', async t => {
  const state = await fixture(t), { root, run, contract, source } = state;
  assert.throws(() => assertEvidenceDocumentationAuthority(root, run, contract, { ...source, paths: ['src/value.txt'] }), /authoritative producer\/check checkpoint/);
  assert.throws(() => assertEvidenceDocumentationAuthority(root, { ...run, epoch_id: randomUUID() }, contract, source), /authoritative producer\/check checkpoint/);
});
