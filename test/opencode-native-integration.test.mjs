import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialize, createRecord, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation, routingProblems } from '../dist/routing.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { startNative, waitNative, shutdownNative } from '../dist/native.js';
import { isControlledExecutionReceipt } from '../dist/execution-attestation.js';

// Explicit live acceptance only. The ordinary regression suite never spends
// provider quota or requires the developer's private catalog.
test('real pinned OpenCode executes a signed native assignment through scoped tools and saves its result', {
  skip: process.env.WORKFORCE_LIVE_OPENCODE !== '1', timeout: 180000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-live-'));
  const resultsPath = resolve('artifacts/workforce-engine-proof/native-integration-results.json');
  const traces = [];
  let activeInvocation, report, reportCalls = 0, release;
  const diagnostic = { engine: 'opencode', version: '1.19.4', real_model: true, passed: false };
  t.after(async () => { release?.(); await shutdownNative(root); rmSync(root, { recursive: true, force: true }); });
  try {
    initialize(root, { project_id: 'WF-NATIVE', name: 'Bound engine acceptance', execution_engine: 'opencode' });
    const catalogPath = process.env.WORKFORCE_MODEL_CATALOG ?? 'C:/Users/daveb/AppData/Roaming/Code/User/chatLanguageModels.json';
    assert.ok(existsSync(catalogPath), 'private configured catalog exists');
    const policy = { ...ensureRoutingPolicy(root), strong_model: 'top-models', worker_models: ['worker-models'],
      strong_provider: 'customendpoint', worker_provider: 'customendpoint', language_models_file: catalogPath,
      role_models: { developer: { model: 'top-models', provider: 'customendpoint', effort: 'high' } },
      vscode_effort_policy: 'allow-unavailable' };
    writeFileSync(safePath(root, '.neomind/routing.json'), JSON.stringify(policy));
    const workflow = createRecord(root, { type: 'knowledge', title: 'Bound engine live acceptance', data: { kind: 'manager-workflow' } });
    const task = createRecord(root, { type: 'task', title: 'Create one bound JSON result', owner: 'developer',
      data: { workflow_id: workflow.meta.id, required_tools: [] } });
    const requestId = randomUUID(), epoch = randomUUID();
    const binding = { workflow_id: workflow.meta.id, task_id: task.meta.id, role: 'developer', stage: 'implementation',
      implementation_paths: ['proof-output'], verification_paths: ['proof-checks'], read_paths: ['proof-output'],
      execution_steps: [], procedure_bound: false, cornell_bound: false };
    release = registerControlledContext(root, requestId, { binding, epoch_id: epoch,
      bindInvocation(id) { activeInvocation = id; },
      callbacks: {
        assertActive() {
          assert.ok(activeInvocation);
          const receipt = readInvocation(root, activeInvocation);
          assert.equal(receipt.state, 'running');
          assert.equal(receipt.workflow_id, workflow.meta.id);
          assert.equal(receipt.task_id, task.meta.id);
          assert.deepEqual(routingProblems(root, 'developer', activeInvocation, {
            workflow_id: workflow.meta.id, task_id: task.meta.id, require_completed: false,
          }), []);
        },
        saveReport(value) {
          reportCalls++; report = value;
          const record = createRecord(root, { type: 'knowledge', title: 'Actual bound worker result', owner: 'developer',
            body: value.summary, data: { kind: 'controlled-assignment-result', workflow_id: workflow.meta.id,
              task_id: task.meta.id, invocation_id: activeInvocation, report: value } });
          return { saved: true, report_id: record.meta.id };
        },
        trace(value) { traces.push({ event: value.event, status: value.status, tool: value.tool, error_name: value.error_name }); },
      } });
    const started = Date.now();
    const invocation = await startNative(root, { role: 'developer', workflow_id: workflow.meta.id, task_id: task.meta.id,
      request_id: requestId, prompt: 'Create proof-output/result.json using wf_task_file_write. The exact full file content must be {"verified":true,"value":42}\n. Then call wf_assignment_report with outcome completed, summary describing the saved JSON file, artifacts ["proof-output/result.json"], and findings []. Return a short factual message. This is the entire bounded request; do not inspect unrelated paths, invoke unavailable tools, or claim independent testing.' });
    diagnostic.invocation_id = invocation.id;
    let current = invocation;
    while (['starting', 'running', 'waiting-native-permission'].includes(current.state) && Date.now() - started < 150000)
      current = await waitNative(root, invocation.id, 1000);
    Object.assign(diagnostic, { elapsed_ms: Date.now() - started, state: current.state, issuer: current.issuer,
      identity_provenance: current.identity_provenance, model_id: current.confirmed_model, provider_id: current.model_provider,
      error_name: current.error ? 'native_execution_incomplete' : null, report_calls: reportCalls,
      scoped_file_created: existsSync(join(root, 'proof-output/result.json')), trace_events: traces });
    assert.equal(current.state, 'completed', 'actual native inference completed');
    assert.equal(current.issuer, 'workforce-opencode');
    assert.equal(current.identity_provenance, 'local-opencode');
    assert.equal(current.confirmed_model, 'top-models');
    assert.equal(isControlledExecutionReceipt(current), true);
    assert.deepEqual(routingProblems(root, 'developer', current.id, { workflow_id: workflow.meta.id, task_id: task.meta.id }), []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'proof-output/result.json'), 'utf8')), { verified: true, value: 42 });
    assert.equal(reportCalls, 1);
    assert.equal(report.outcome, 'completed');
    assert.deepEqual(report.artifacts, ['proof-output/result.json']);
    diagnostic.passed = true;
  } finally {
    mkdirSync(resolve('artifacts/workforce-engine-proof'), { recursive: true });
    writeFileSync(resultsPath, JSON.stringify(diagnostic, null, 2));
    t.diagnostic(JSON.stringify({ passed: diagnostic.passed, state: diagnostic.state,
      model: diagnostic.model_id, report_calls: diagnostic.report_calls, elapsed_ms: diagnostic.elapsed_ms }));
  }
});
