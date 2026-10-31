import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, atomicWrite, safePath, hash, getRecord, updateRecord, createRecord } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation, routingProblems } from '../dist/routing.js';
import { OpenCodeSession } from '../dist/opencode-session.js';
import { ownedContext } from '../dist/controlled-context.js';
import { createControlledMcpServer, controlledInstructions, controlledPlanSchema, workforcePlanSchema } from '../dist/controlled-tools.js';
import { enableWorkForceHost } from '../dist/workforce-host.js';
import { startControlledHost, startControlledWorkflow, controlledStatus, answerControlledWorkflow,
  validateControlledPlan, workforceRecoveryDecision, controlControlledWorkflow } from '../dist/controlled-workflow.js';
import { workforcePrescribedChecksComplete, currentWorkForceCompilerFailure } from '../dist/controlled-workflow.js';
import { verifyControlledTask } from '../dist/controlled-acceptance.js';
import { shutdownNative, waitNative, reconcileWorkForceInvocations } from '../dist/native.js';
import { openCodeVersion, openCodeIntegrity, openCodeProtocolHash } from '../dist/execution-attestation.js';
import { requestProjection } from '../dist/workforce-requests.js';
import { researchFixture } from './cornell-research-fixture.mjs';
import { localOpenAIProvider } from './helpers/local-openai-provider.mjs';
import { probeWorkForceConnection } from '../dist/workforce-connection.js';

// Deterministic engine boundary only: no model/API inference. All request IPC,
// signed native receipts, bound MCP operations, file writes, subprocess checks
// and acceptance are real. Live OpenCode proof is a separate opt-in test.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixturePlans = new Map();
const fixtureResearch = new Map();
const fixtureOwners = new Map();
const fixtureClocks = new Map();
const observations = [];
const errors = [];
let requestQuestion = false;
let failFirstProduct = false;
let failStorageOnce = false;
let failProviderOnce = false;
let canonicalReviewProviderFailure = false;
let failDesignStalls = false;
let forgeDependencyProse = false;
let qualityBeforeStall = false;
let failAfterSavedStage;
let pendingTestHandoff = false;
let legacyProtocolHandoff = false;
let repeatLegacyProtocolHandoff = false;
const legacyReportEvidence = new Map();
const fixtureProductWrites = new Map();
let mutateScopeAfterRead = false;
const counts = new Map();
function plan(name) {
  return { title: `Deliver ${name}`, objective: `Deliver a checked JSON result for ${name}.`, rationale: 'Use the existing independent project checker directly.',
    acceptance_criteria: ['The JSON result contains the independently expected value 42.'], allowed_paths: [`products/${name}.json`],
    request_kind: 'software', verification_paths: [], outputs: [`products/${name}.json`], documentation_paths: [], execution_steps: [],
    verification_levels: [{ level: 'unit', applicable: true, method: 'execution', rationale: 'The existing project checker exercises this isolated output.', checks: [`Check ${name}`] },
      { level: 'integration', applicable: false, method: 'inspection', rationale: 'No interface integration changes.', checks: [] },
      { level: 'system', applicable: false, method: 'inspection', rationale: 'No deployed system change.', checks: [] },
      { level: 'acceptance', applicable: true, method: 'inspection', rationale: 'Independent roles assess all requested criteria and current artifacts.', checks: [] }],
    checks: [{ title: `Check ${name}`, command: [process.execPath, `checks/${name}.mjs`, `products/${name}.json`], baseline_paths: [] }], risk: 'low' };
}
function parsed(value) { return JSON.parse(value.content[0].text); }
async function deterministicEngine(t) {
  const prior = { open: OpenCodeSession.prototype.open, run: OpenCodeSession.prototype.run, close: OpenCodeSession.prototype.close };
  const supervisedFaultSessions = new WeakSet();
  const canonicalReviewSessions = new WeakSet();
  OpenCodeSession.prototype.open = async function () {
    const context = ownedContext(this.root, this.receipt.request_id);
    assert.ok(context, 'backend owns every invocation');
    if (canonicalReviewProviderFailure && context.binding.stage === 'review') {
      canonicalReviewSessions.add(this); return prior.open.call(this);
    }
    if (failAfterSavedStage === context.binding.stage && !counts.get(`${this.receipt.workflow_id}:${context.binding.stage}`)) {
      // The failing stage uses the real pinned engine and shutdown guardian,
      // without inference. Its report tool is deterministic but its native
      // signature and ended-process proof are real, not synthetic metadata.
      supervisedFaultSessions.add(this); return prior.open.call(this);
    }
    context.bindInvocation(this.receipt.id);
    this.update({ confirmed_model: this.receipt.requested_model, model_provider: 'workforce-router', client_version: openCodeVersion,
      host_instance: 'a'.repeat(64), native_thread_id: `ses_${randomBytes(8).toString('hex')}`, native_turn_id: `msg_${randomBytes(8).toString('hex')}`,
      protocol_sha256: openCodeProtocolHash, runtime_integrity: openCodeIntegrity, effort_support: 'unavailable',
      confirmed_reasoning_effort: null, native_sandbox: null,
      opencode: { version: openCodeVersion, binary_sha256: 'b'.repeat(64), gateway_instance: 'a'.repeat(64) } });
  };
  OpenCodeSession.prototype.close = async function () { if (supervisedFaultSessions.has(this) || canonicalReviewSessions.has(this)) await prior.close.call(this); };
  OpenCodeSession.prototype.run = async function () {
    try {
      const context = ownedContext(this.root, this.receipt.request_id), binding = { ...context.binding, invocation_id: this.receipt.id };
      const name = /Case: ([a-z-]+)/.exec(this.receipt.input_text)?.[1];
      assert.ok(name, 'original user request survives the intake');
      const key = `${this.receipt.workflow_id}:${binding.stage}`, count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
      observations.push({ name, stage: binding.stage, role: binding.role, model: this.receipt.requested_model, request: this.receipt.request_id, invocation: this.receipt.id,
        process_contract: binding.process_contract, review_purpose: binding.review_purpose, prompt: this.receipt.input_text });
      if (canonicalReviewSessions.has(this)) return prior.run.call(this);
      if (failStorageOnce && binding.stage === 'planning' && count === 1) {
        await this.complete('blocked', 'OPENCODE_STORAGE_UNAVAILABLE: fixture observed an unavailable engine journal.'); return;
      }
      if (failProviderOnce && binding.stage === 'planning' && count === 1) {
        await this.complete('blocked', 'OPENCODE_PROVIDER_UNAVAILABLE: fixture observed unavailable endpoint.'); return;
      }
      if (failDesignStalls && binding.stage === 'design' && count <= 2) {
        await this.complete('blocked', 'OPENCODE_PROVIDER_STALLED: fixture observed no meaningful model arguments, and owned abort/idle completed.'); return;
      }
      if (qualityBeforeStall && binding.stage === 'requirements' && count === 1) {
        await this.complete('blocked', 'MCP_DELIVERY_PROTOCOL: fixture observed a failed bound handoff requiring one fresh session.'); return;
      }
      assert.equal(binding.process_contract, 'workforce/v1');
      assert.deepEqual(routingProblems(this.root, binding.role, this.receipt.id, { workflow_id: binding.workflow_id, task_id: binding.task_id, require_completed: false }), []);
      const server = createControlledMcpServer(this.root, binding, context.callbacks), client = new Client({ name: 'workforce-controller-fixture', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
      try {
        const listed = await client.listTools();
        for (const tool of listed.tools) assert.ok(!['assignment_claim', 'assignment_progress', 'record_update', 'manager_run'].includes(tool.name));
        const call = async (tool, args) => {
          const value = await client.callTool({ name: tool, arguments: args });
          assert.ok(!value.isError, `${binding.stage}/${tool}: ${JSON.stringify(parsed(value))}`); return parsed(value);
        };
        const report = extras => call('assignment_report', { summary: `${binding.role} produced its substantive ${binding.stage} result.`, findings: [], ...extras });
        if (binding.stage === 'planning') {
          if (count <= requestQuestion) {
            await call('project_read', { path: 'requirements.md' });
            await call('request_input', { question: 'Which label should the JSON result use?', missing: 'The business label is unspecified.',
              why_cannot_infer: 'requirements.md lists two supported business labels without selecting one.', criterion: 'The requested label must match the user choice.',
              category: 'business-choice', searched_paths: ['requirements.md'] });
          } else {
            assert.equal(binding.planning_result, 'backend');
            assert.ok(!listed.tools.some(tool => tool.name === 'assignment_report'), 'PM has exactly one substantive result operation');
            const saved = await call('workflow_plan', fixturePlans.get(name));
            assert.equal(saved.planning_result.saved, true);
          }
        } else if (binding.stage === 'implementation') {
          const selectedPlan = fixturePlans.get(name), output = selectedPlan.outputs[0]; await call('project_read', { path: output });
          if (pendingTestHandoff) {
            assert.ok(!listed.tools.some(tool => ['task_run', 'check_run'].includes(tool.name)));
            const description = listed.tools.find(tool => tool.name === 'assignment_report').description;
            assert.match(description, /WF\.Tester/); assert.match(description, /Existing temperature tests/);
            if (!legacyProtocolHandoff || count === 1) {
              fixtureProductWrites.set(name, (fixtureProductWrites.get(name) ?? 0) + 1);
              await call('task_file_write', { path: output, content: 'export function celsiusToFahrenheit(celsius) { return celsius * 9 / 5 + 32; }\n' });
            }
            if (legacyProtocolHandoff && (count === 1 || repeatLegacyProtocolHandoff)) {
              // Historical engine boundary fixture: preserve the old backend
              // report shape without submitting it through the new public
              // content schema or rewriting a previously saved record.
              await context.callbacks.saveReport({ outcome: 'blocked', summary: 'The product is corrected; the old producer treated pending independent execution as its own blocker.',
                artifacts: [output], findings: ['Frozen npm test has no producer execution tool; independent testing has not run.'] });
              const saved = controlledStatus(this.root, this.receipt.workflow_id).attempts.at(-1);
              const history = legacyReportEvidence.get(name) ?? []; history.push({ id: saved.report_id, record: JSON.stringify(getRecord(this.root, saved.report_id)) }); legacyReportEvidence.set(name, history);
            } else await report({ summary: 'The corrected product is ready for independent review and the scheduled Tester npm test.',
              artifacts: [output], product_findings: [], limitations: ['Producer has no check_run; independent npm test execution is still scheduled for WF.Tester.'] });
          } else {
          if (selectedPlan.cornell_output_dir) {
            await call('project_read', { path: 'sources/counting.md' });
            await call('cornell_research_compile', fixtureResearch.get(name)); await report({ artifacts: selectedPlan.outputs });
          } else if (selectedPlan.execution_steps.length) {
            await call('project_read', { path: selectedPlan.execution_steps[0].command[1] });
            const execution = await call('task_run', { title: selectedPlan.execution_steps[0].title });
            assert.equal(execution.passed, true); await report({ artifacts: [output] });
          } else {
          if (mutateScopeAfterRead) {
            updateRecord(this.root, binding.task_id, { data: { allowed_paths: ['revoked-location'] } });
            await call('project_read', { path: output }); // frozen public read authorization remains available
            const denied = await client.callTool({ name: 'task_file_write', arguments: { path: output, content: '{"value":42}\n' } });
            assert.equal(denied.isError, true); assert.equal(parsed(denied).code, 'INPUT_CHANGED');
            await this.complete('blocked', 'Fixture task authorization changed intentionally.'); return;
          }
          if (!(failAfterSavedStage === 'implementation' && count > 1)) {
          fixtureProductWrites.set(name, (fixtureProductWrites.get(name) ?? 0) + 1);
          await call('task_file_write', { path: output, content: selectedPlan.request_kind === 'document'
            ? '# Temperature conversion\n\nFahrenheit = Celsius * 9 / 5 + 32.\n\n## Worked example\nAt 0 degrees Celsius, the result is 32 degrees Fahrenheit.\n\n## Practice question\nWhat is the Fahrenheit value at 100 degrees Celsius?\n'
            : JSON.stringify({ value: failFirstProduct && count === 1 ? 13 : 42 }) + '\n' });
          }
          await report({ artifacts: [output] });
          }
          }
        } else if (binding.stage === 'review') {
          const selectedPlan = fixturePlans.get(name), product = await call('project_read', { path: selectedPlan.outputs[0] });
          if (binding.assessment_outputs?.length) for (const path of binding.assessment_outputs) await call('project_read', { path });
          const pass = binding.review_purpose === 'design' || product.exists && (selectedPlan.request_kind === 'document'
            ? selectedPlan.cornell_output_dir ? /Cartesian product/i.test(product.text) : /Celsius \* 9 \/ 5 \+ 32/.test(product.text) && /Practice question/.test(product.text)
            : pendingTestHandoff ? /return celsius \* 9 \/ 5 \+ 32;/.test(product.text) : JSON.parse(product.text).value === 42);
          await report({ verdict: pass ? 'pass' : 'fail', ...(pass ? {} : { failure_kind: 'implementation', findings: ['The independently expected result is 42; current output is 13.'] }) });
        } else if (binding.stage === 'verification') {
          const selectedPlan = fixturePlans.get(name);
          if (selectedPlan.request_kind === 'document') {
            const text = await call('project_read', { path: selectedPlan.outputs[0] });
            if (selectedPlan.cornell_output_dir) {
              for (const path of binding.assessment_outputs) await call('project_read', { path });
              assert.match(text.text, /Cartesian product/i);
            } else { assert.match(text.text, /At 0 degrees Celsius, the result is 32/); assert.match(text.text, /100 degrees Celsius\?/); }
          }
          const evidence = await call('check_run', {});
          if (selectedPlan.request_kind === 'document') { assert.equal(evidence.verification_method, 'independent-content-inspection'); assert.deepEqual(evidence.executed_commands, []); }
          const results = Array.isArray(evidence) ? evidence : evidence.checks;
          const pass = results?.length ? results.every(item => item.passed) : evidence.passed !== false;
          await report({ verdict: pass ? 'pass' : 'fail', ...(pass ? {} : { failure_kind: 'implementation' }) });
        } else if (forgeDependencyProse && binding.stage === 'requirements') await report({
          summary: 'OPENCODE_PROVIDER_STALLED: OPENCODE_STORAGE_UNAVAILABLE: the professional report claims a technical outage without a failed native invocation.' });
        else if (binding.stage === 'diagnosis') await report(failDesignStalls || canonicalReviewProviderFailure
          ? { failure_kind: 'unknown', findings: ['The same task stalled despite a fresh healthy connection proof; no safe product repair was established.'] }
          : legacyProtocolHandoff ? { failure_kind: 'protocol', summary: 'The old producer used a workflow outcome for a future Tester obligation. Product bytes are ready; a fresh scoped content handoff resolves the stage contract mismatch.', findings: ['Rebind the original product role under the corrected stage-result interface; preserve its existing code and historical blocked report.'] }
          : { failure_kind: 'implementation', findings: ['Correct the existing JSON output; preserve the independent checker.'] });
        else await report();
      } finally { await client.close(); await server.close(); }
      if (failAfterSavedStage === binding.stage && count === 1) {
        await this.complete('blocked', 'OPENCODE_PROVIDER_UNAVAILABLE: fixture lost the final provider followup after the typed result was durably saved.'); return;
      }
      await this.complete('completed', null);
    } catch (error) { errors.push(error); await this.complete('blocked', 'Deterministic boundary failed'); }
  };
  t.after(() => Object.assign(OpenCodeSession.prototype, prior));
}
async function fixture(t, names, options = {}) {
  const parent = resolve('artifacts/test-temp'); mkdirSync(parent, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(parent), 'wf-controller-')));
  initialize(root, { project_id: 'WF-TEST', name: 'WorkForce deterministic controller', execution_engine: 'opencode', repair_attempts: 1, max_workers: options.maxWorkers ?? 3 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [{ id: 'top-models', url: 'http://127.0.0.1:1/v1' }, { id: 'worker-models', url: 'http://127.0.0.1:1/v1' }] }]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, strong_model: 'top-models', worker_models: ['worker-models'],
    strong_provider: 'fixture', worker_provider: 'fixture', language_models_file: 'catalog.json', vscode_effort_policy: 'allow-unavailable' }));
  for (const name of names) {
    fixturePlans.set(name, plan(name));
    atomicWrite(safePath(root, `checks/${name}.mjs`), "import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(JSON.parse(readFileSync(process.argv[2],'utf8')).value,42);console.log('actual existing checker passed');\n");
  }
  atomicWrite(safePath(root, 'requirements.md'), 'Supported labels: Alpha or Beta; user chooses one.\n');
  observations.length = 0; errors.length = 0; counts.clear(); fixtureProductWrites.clear(); legacyReportEvidence.clear(); requestQuestion = options.questions ?? (options.question ? 1 : 0); failFirstProduct = !!options.repair; failStorageOnce = !!options.storage; failProviderOnce = !!options.provider; failDesignStalls = !!options.stalls; forgeDependencyProse = !!options.forgeDependencyProse; qualityBeforeStall = !!options.qualityBeforeStall; failAfterSavedStage = options.failAfterSavedStage; pendingTestHandoff = !!options.pendingTestHandoff; legacyProtocolHandoff = !!options.legacyProtocolHandoff; repeatLegacyProtocolHandoff = !!options.repeatLegacyProtocolHandoff; mutateScopeAfterRead = !!options.mutateScope;
  await deterministicEngine(t);
  canonicalReviewProviderFailure = !!options.canonicalReviewProviderFailure;
  const api = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] } };
  const clock = { value: Date.now() }; fixtureClocks.set(root, clock);
  const bridge = await enableWorkForceHost(api, root), owner = await startControlledHost(root, options.clock ? { condition_clock: () => clock.value, condition_poll_ms: 10 } : {});
  fixtureOwners.set(root, owner);
  t.after(async () => { await fixtureOwners.get(root).close(); await shutdownNative(root); await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function temperatureCase(root, name) {
  atomicWrite(safePath(root, 'src/temperature.mjs'), 'export function celsiusToFahrenheit(celsius) { return celsius * 9 / 5 - 32; }\n');
  const packageBytes = JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test/temperature.test.mjs' } }) + '\n';
  const testBytes = "import test from 'node:test';import assert from 'node:assert/strict';import{celsiusToFahrenheit}from'../src/temperature.mjs';for(const[c,f]of[[0,32],[100,212],[-40,-40],[37.5,99.5]])test(String(c),()=>assert.equal(celsiusToFahrenheit(c),f));\n";
  atomicWrite(safePath(root, 'package.json'), packageBytes); atomicWrite(safePath(root, 'test/temperature.test.mjs'), testBytes);
  const candidate = fixturePlans.get(name);
  Object.assign(candidate, { title: 'Correct temperature conversion', objective: 'Fix the conversion and run the existing project tests.',
    allowed_paths: ['src/temperature.mjs'], outputs: ['src/temperature.mjs'], preservation_paths: ['package.json', 'test/temperature.test.mjs'],
    acceptance_criteria: ['Preserve the public API and correct Celsius conversion.', 'Run the unchanged project tests with four passing cases.'],
    checks: [{ title: 'Existing temperature tests', command: ['npm', 'test'], baseline_paths: ['package.json', 'test/temperature.test.mjs', 'src/temperature.mjs'] }] });
  for (const level of candidate.verification_levels) if (level.method === 'execution') level.checks = ['Existing temperature tests'];
  return { packageBytes, testBytes };
}
async function wait(root, id, expected = 'completed', timeout = 60000, failureContext = () => ({})) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = controlledStatus(root, id);
    if (state.status === expected) return state;
    if (['blocked', 'uncertain', 'cancelled'].includes(state.status) || Date.now() > deadline)
      assert.fail(JSON.stringify({ status: state.status, phase: state.phase, blocker: state.blocker, errors: errors.map(error => error.message),
        dependency_wait: state.dependency_wait ?? null, incident_code: state.incident_condition?.code ?? null,
        recent_events: state.events.slice(-8).map(({ kind, stage, at }) => ({ kind, stage, at })), ...failureContext() }));
    await delay(50);
  }
}

test('WorkForce accepts existing project checker commands while legacy wrapper/negative contract is preserved', () => {
  const candidate = plan('schema');
  assert.equal(workforcePlanSchema.safeParse(candidate).success, true);
  assert.equal(controlledPlanSchema.safeParse(candidate).success, false);
  assert.match(controlledInstructions({ workflow_id: 'unused', role: 'manager', stage: 'planning', process_contract: 'workforce/v1', implementation_paths: [], verification_paths: [] }), /existing project/);
});

test('content-only product handoff with pending npm test proceeds to independent review, actual Tester execution and acceptance', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['scheduled-tests'], { pendingTestHandoff: true });
  const { packageBytes, testBytes } = temperatureCase(root, 'scheduled-tests');
  const started = await startControlledWorkflow(root, { requirement: 'Case: scheduled-tests\nFix the temperature conversion bug and keep the existing API. Run the project tests.' });
  const run = await wait(root, started.workflow_id);
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['planning', 'requirements', 'design', 'implementation', 'review', 'verification']);
  const producer = run.attempts.find(attempt => attempt.stage === 'implementation');
  assert.equal(producer.report.outcome, 'completed'); assert.match(producer.report.limitations[0], /scheduled for WF\.Tester/);
  assert.equal(run.repairs, 0); assert.equal(run.checks.length, 1); assert.equal(run.checks[0].passed, true);
  assert.deepEqual(run.checks[0].command, ['npm', 'test']);
  const log = JSON.parse(readFileSync(safePath(root, run.checks[0].log_path), 'utf8'));
  assert.match(log.result.stdout, /tests 4/); assert.match(log.result.stdout, /pass 4/);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBytes);
  assert.equal(readFileSync(join(root, 'test/temperature.test.mjs'), 'utf8'), testBytes);
  const contract = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`), 'utf8'));
  assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted').ok, true);
  assert.deepEqual(errors, []);
});

for (const repeat of [false, true]) test(`an honest protocol diagnosis rebinds the original failed product role ${repeat ? 'once and refuses the same failure loop' : 'without rewriting history before actual test acceptance'}`, { timeout: 90000 }, async t => {
  const name = repeat ? 'protocol-repeat' : 'protocol-handoff';
  const root = await fixture(t, [name], { pendingTestHandoff: true, legacyProtocolHandoff: true, repeatLegacyProtocolHandoff: repeat });
  const preserved = temperatureCase(root, name);
  const started = await startControlledWorkflow(root, { requirement: `Case: ${name}\nFix the temperature conversion bug and keep the existing API. Run the project tests.` });
  const run = await wait(root, started.workflow_id, repeat ? 'blocked' : 'completed');
  assert.equal(run.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.equal(run.attempts.filter(attempt => attempt.stage === 'requirements').length, 1);
  assert.equal(run.attempts.filter(attempt => attempt.stage === 'design').length, 1);
  assert.equal(run.attempts.filter(attempt => attempt.stage === 'implementation').length, 2);
  assert.equal(run.attempts.filter(attempt => attempt.stage === 'diagnosis').length, 1);
  assert.equal(fixtureProductWrites.get(name), 1);
  for (const prior of legacyReportEvidence.get(name)) assert.equal(JSON.stringify(getRecord(root, prior.id)), prior.record);
  const source = run.attempts.find(attempt => attempt.stage === 'implementation'), diagnosis = run.attempts.find(attempt => attempt.stage === 'diagnosis');
  assert.equal(source.report.outcome, 'blocked'); assert.equal(diagnosis.report.failure_kind, 'protocol');
  assert.equal(run.protocol_reconciliations.length, 1);
  assert.equal(run.protocol_reconciliations[0].attempt_id, source.id);
  assert.equal(run.protocol_reconciliations[0].diagnosis_attempt_id, diagnosis.id);
  assert.deepEqual(run.workforce_recovery.strategies.map(item => item.strategy), ['diagnose', 'reconcile_session']);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), preserved.packageBytes);
  assert.equal(readFileSync(join(root, 'test/temperature.test.mjs'), 'utf8'), preserved.testBytes);
  if (repeat) {
    assert.equal(run.checks.length, 0); assert.equal(run.final_report_id, undefined);
    assert.equal(run.blocker.code, 'WORKFORCE_OPERATIONAL_INCIDENT');
  } else {
    assert.equal(run.checks.length, 1); assert.equal(run.checks[0].passed, true);
    const contract = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`), 'utf8'));
    assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted').ok, true);
  }
  assert.deepEqual(errors, []);
});

test('PM exposes one substantive result operation and preserves old signed planning scopes without the backend flag', () => {
  const base = { workflow_id: 'wf', role: 'manager', stage: 'planning', process_contract: 'workforce/v1', implementation_paths: [], verification_paths: [] };
  const old = controlledInstructions(base), current = controlledInstructions({ ...base, planning_result: 'backend' });
  assert.match(old, /then one assignment_report/);
  assert.match(current, /single substantive result/);
  assert.doesNotMatch(current, /then one assignment_report/);
});

test('stale signed worker capacity is reconciled from actual owner exit before a new request dispatches', { timeout: 120000 }, async t => {
  const root = await fixture(t, ['capacity'], { maxWorkers: 1 });
  const previous = createRecord(root, { type: 'knowledge', title: 'A previous process owner', data: { kind: 'manager-workflow' } });
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Owned capacity checkpoint', data: { workflow_id: previous.meta.id } });
  const child = fork(fileURLToPath(new URL('./helpers/workforce-native-owner.mjs', import.meta.url)), [root, previous.meta.id, task.meta.id],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); });
  const [opened] = await once(child, 'message', { signal: AbortSignal.timeout(80000) });
  assert.equal(opened.failed, undefined); assert.equal(opened.state, 'running');
  const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
  // Do not call native reconciliation here: the controller capacity path must
  // recover this actual stale signed receipt before it can dispatch SWSD.
  const started = await startControlledWorkflow(root, { requirement: 'Case: capacity\nCreate the requested result using the existing project checker.' });
  const run = await wait(root, started.workflow_id);
  assert.equal(run.status, 'completed');
  const interrupted = readInvocation(root, opened.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.match(interrupted.opencode.interruption_proof_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(errors, []);
});

test('WorkForce still qualifies new independent checkers with negative controls and forbids hidden legacy specialists', t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-plan-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-PLAN', name: 'Plan qualification', execution_engine: 'opencode' });
  const candidate = plan('custom'); candidate.verification_paths = ['independent'];
  candidate.checks[0].command = ['node', 'independent/check.mjs', candidate.outputs[0]];
  candidate.checks[0].baseline_paths = [candidate.outputs[0], 'independent/check.mjs'];
  assert.throws(() => validateControlledPlan(root, candidate, 'workforce/v1'), /custom checkers need/);
  candidate.checks[0].negative_controls = [{ title: 'Reject wrong data', command: ['node', 'independent/check.mjs', '--negative-control', 'wrong-data'],
    baseline_paths: ['independent/check.mjs'], expected_exit_code: 1 }];
  assert.equal(validateControlledPlan(root, candidate, 'workforce/v1').checks.length, 1);
  assert.equal(workforcePlanSchema.safeParse({ ...candidate, specialists: [{ role: 'explorer', objective: 'Hidden work' }] }).success, false);
});

test('technical limits cannot become user-input questions even after a source was read', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-question-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-QUESTION', name: 'Question ownership', execution_engine: 'opencode' });
  atomicWrite(safePath(root, 'requirements.md'), 'User wants a JSON result.\n');
  let questions = 0;
  const binding = { workflow_id: 'backend-request', invocation_id: 'backend-invocation', role: 'manager', stage: 'planning',
    process_contract: 'workforce/v1', implementation_paths: [], verification_paths: [], read_paths: ['.'] };
  const server = createControlledMcpServer(root, binding, { assertActive() {}, saveReport() {}, requestInput() { questions++; } });
  const client = new Client({ name: 'workforce-question-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  await client.callTool({ name: 'project_read', arguments: { path: 'requirements.md' } });
  const result = await client.callTool({ name: 'request_input', arguments: { question: 'Increase the recovery limit?', missing: 'repair_attempts exhausted',
    why_cannot_infer: 'The tool failed.', criterion: 'Deliver JSON', category: 'business-choice', searched_paths: ['requirements.md'] } });
  assert.equal(result.isError, true); assert.equal(parsed(result).code, 'TECHNICAL_INCIDENT'); assert.equal(questions, 0);
  const guide = parsed(await client.callTool({ name: 'project_read', arguments: { path: '.neomind/guides/controlled-workflows.md' } }));
  assert.equal(guide.path, '.workforce/guides/workforce.md'); assert.doesNotMatch(guide.text, /Allowed consultation roles|Each check needs/);
});

test('passing content assessment requires complete current reads, including paginated long lines', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-content-read-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-READ', name: 'Content read evidence', execution_engine: 'opencode' });
  atomicWrite(safePath(root, 'docs/note.md'), '# Note\n' + 'A'.repeat(256) + '\nFinal factual paragraph.\n');
  let saved = 0;
  const binding = { workflow_id: 'request', invocation_id: 'invocation', role: 'verifier', stage: 'verification', process_contract: 'workforce/v1',
    implementation_paths: ['docs/note.md'], verification_paths: [], read_paths: ['.'], assessment_outputs: ['docs/note.md'] };
  const server = createControlledMcpServer(root, binding, { assertActive() {}, saveReport() { saved++; return { saved: true }; } });
  const client = new Client({ name: 'content-read-proof', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  const report = () => client.callTool({ name: 'assignment_report', arguments: { verdict: 'pass', summary: 'Independently assessed the complete current note.' } });
  assert.equal(parsed(await report()).code, 'READ_REQUIRED');
  const first = parsed(await client.callTool({ name: 'project_read', arguments: { path: 'docs/note.md', max_chars: 128 } }));
  assert.equal(first.truncated, true); assert.equal(parsed(await report()).code, 'READ_REQUIRED');
  await client.callTool({ name: 'project_read', arguments: { path: 'docs/note.md', start_char: first.next_start_char } });
  assert.equal((await report()).isError, undefined); assert.equal(saved, 1);
});

test('WorkForce reads normalize equivalent default cursors and optional nulls while rejecting actual ambiguity and required nulls', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-read-position-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { execution_engine: 'opencode' }); atomicWrite(safePath(root, 'source.txt'), 'First line\nSecond line\nThird line\n');
  const binding = { workflow_id: 'request', invocation_id: 'invocation', stage: 'planning', role: 'manager', process_contract: 'workforce/v1',
    implementation_paths: [], verification_paths: [], read_paths: ['.'] };
  const server = createControlledMcpServer(root, binding, { assertActive() {}, saveReport() {} });
  const client = new Client({ name: 'read-origin-replay', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  const call = args => client.callTool({ name: 'project_read', arguments: { path: 'source.txt', ...args } });
  for (const args of [{ max_chars: 64000, start_line: 1, start_char: 0 }, { max_chars: null, start_line: null, start_char: null }, {}]) {
    const value = await call(args); assert.equal(value.isError, undefined); assert.equal(parsed(value).text, 'First line\nSecond line\nThird line\n');
  }
  assert.equal(parsed(await call({ start_line: 2, start_char: 0 })).text, 'Second line\nThird line\n');
  assert.equal(parsed(await call({ start_line: 1, start_char: 11 })).text, 'Second line\nThird line\n');
  assert.equal(parsed(await call({ start_line: 2, start_char: 11 })).code, 'INVALID_PAYLOAD');
  assert.equal((await call({ start_line: 0 })).isError, true);
  assert.equal((await call({ path: null })).isError, true);
});

test('concurrent WorkForce requests complete six explicit roles with independent Reviewer before Tester and real subprocess evidence', { timeout: 120000 }, async t => {
  const root = await fixture(t, ['alpha', 'beta']);
  const [a, b] = await Promise.all(['alpha', 'beta'].map(name => startControlledWorkflow(root, { requirement: `Case: ${name}\nCreate the requested JSON result.`, request_id: `test-${name}`, context: [{ path: 'requirements.md', kind: 'file' }] })));
  const runs = await Promise.all([wait(root, a.workflow_id), wait(root, b.workflow_id)]);
  for (const run of runs) {
    assert.equal(run.process_contract, 'workforce/v1'); assert.equal(run.transport, 'opencode');
    assert.deepEqual(run.attempts.map(item => item.role), ['manager', 'requirements', 'architect', 'developer', 'reviewer', 'verifier']);
    assert.equal(new Set(run.attempts.map(item => item.invocation_id)).size, 6);
    assert.ok(run.checks.length === 1 && run.checks[0].passed && !run.checks[0].negative);
    const producer = run.attempts.find(item => item.role === 'developer');
    assert.equal(readInvocation(root, producer.invocation_id).requested_model, 'top-models', 'unknown family begins strong');
    const contractPath = `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`;
    const contract = JSON.parse(readFileSync(safePath(root, contractPath), 'utf8'));
    assert.equal(contract.schema_version, 3); assert.equal(contract.process, 'workforce');
    assert.ok(contract.preserved_hashes[contract.plan.checks[0].command[1]], 'actual existing checker bytes are frozen readonly');
    assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted').ok, true);
    const delivered = requestProjection(root, run);
    assert.equal(delivered.accepted, true);
    assert.ok(delivered.stages.some(level => level.id === 'integration' && level.state === 'not-applicable'));
    assert.ok(observations.filter(item => item.request === run.attempts[0].request_id)[0].prompt.includes('requirements.md'));
    // Explicit external edit after acceptance: current evidence becomes stale,
    // while the canonical historical accepted record remains unchanged.
    atomicWrite(safePath(root, contract.plan.outputs[0]), '{"value":99}\n');
    const changed = requestProjection(root, run);
    assert.equal(changed.accepted, false); assert.equal(changed.status, 'changed');
    assert.equal(controlledStatus(root, run.workflow_id).status, 'completed');
    assert.equal(getRecord(root, contract.task_id).meta.status, 'accepted');
  }
  assert.deepEqual(errors, []);
});

test('elevated-risk WorkForce changes require a separate design review before the producer and independent product review before tests', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['elevated']); fixturePlans.get('elevated').risk = 'high';
  const started = await startControlledWorkflow(root, { requirement: 'Case: elevated\nCreate the requested JSON result under an explicitly elevated risk assessment.' });
  const run = await wait(root, started.workflow_id);
  assert.deepEqual(run.attempts.map(item => item.role), ['manager', 'requirements', 'architect', 'reviewer', 'developer', 'reviewer', 'verifier']);
  assert.equal(run.attempts[3].purpose, 'design-review');
  assert.equal(run.attempts[5].purpose, undefined); assert.deepEqual(errors, []);
});

test('a note-only request completes independent full-content assessment without manufactured scripts or executable test claims', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['document']);
  const document = fixturePlans.get('document');
  Object.assign(document, { request_kind: 'document', title: 'Explain temperature conversion', outputs: ['docs/temperature.md'],
    allowed_paths: ['docs/temperature.md'], checks: [], acceptance_criteria: ['Explain the correct conversion, show a worked freezing-point example and one practice question.'] });
  document.verification_levels = ['unit', 'integration', 'system', 'acceptance'].map(level => ({ level, applicable: level === 'acceptance',
    method: 'inspection', rationale: level === 'acceptance' ? 'Independent reviewers inspect the complete requested note and example.' : 'No software system or executable change.', checks: [] }));
  const started = await startControlledWorkflow(root, { requirement: 'Case: document\nWrite a short note explaining Celsius/Fahrenheit conversion with a worked example and one practice question. Do not create scripts or change software.' });
  const run = await wait(root, started.workflow_id);
  assert.equal(run.status, 'completed'); assert.equal(run.checks.length, 0); assert.equal(run.local_executions, undefined);
  assert.equal(run.attempts.filter(item => item.role === 'reviewer' || item.role === 'verifier').length, 2);
  for (const attempt of run.attempts.filter(item => ['review', 'verification'].includes(item.stage))) assert.ok(attempt.bound_hashes['docs/temperature.md']);
  assert.match(readFileSync(join(root, 'docs/temperature.md'), 'utf8'), /Practice question/); assert.deepEqual(errors, []);
});

test('a Cornell-only document completes from actual compiler output and independent current-text proof without fake positive commands', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['cornell']);
  const candidate = fixturePlans.get('cornell');
  const paths = ['note.md', 'exercises.md', 'answers.md'].map(name => `docs/cartesian/${name}`);
  Object.assign(candidate, { request_kind: 'document', title: 'Cartesian product learning note', allowed_paths: ['docs/cartesian'], outputs: paths,
    documentation_paths: paths, checks: [], cornell_output_dir: 'docs/cartesian',
    acceptance_criteria: ['Explain the finite Cartesian product with a worked example, practice questions and separate answers.'] });
  candidate.verification_levels = ['unit', 'integration', 'system', 'acceptance'].map(level => ({ level, applicable: level === 'acceptance',
    method: 'inspection', rationale: level === 'acceptance' ? 'Independent roles inspect the actual complete compiler-generated note and practice.' : 'No software or executable change.', checks: [] }));
  const { input } = researchFixture(t);
  const { schema_version, requirement_id, expected_requirement_revision, workflow_id, output_dir, ...semantic } = input;
  const { solution_path, starter, ...practice } = semantic.practice;
  semantic.practice = practice; semantic.sources = [{ id: 'S1', title: 'Finite Cartesian product source', uri: 'sources/counting.md', locator: 'Definition and finite example' }];
  fixtureResearch.set('cornell', semantic);
  atomicWrite(safePath(root, 'sources/counting.md'), 'The Cartesian product A×B consists of every ordered pair (a,b) for a in A and b in B. Three distinct letters and two distinct digits produce six ordered pairs.\n');
  const started = await startControlledWorkflow(root, { requirement: 'Case: cornell\nCreate a Cornell note about the finite Cartesian product, with a worked example, practice and separate answers. Do not create software or scripts.' });
  const run = await wait(root, started.workflow_id);
  assert.equal(run.checks.length, 0);
  const contract = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`), 'utf8'));
  assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted').ok, true);
  for (const role of ['reviewer', 'verifier']) {
    const report = run.attempts.findLast(attempt => attempt.role === role);
    assert.equal(report.content_assessment.mode, 'complete-current-text');
    assert.deepEqual(Object.keys(report.content_assessment.artifact_hashes).sort(), [...paths].sort());
  }
  const verifier = run.attempts.findLast(attempt => attempt.role === 'verifier');
  updateRecord(root, verifier.report_id, { data: { content_assessment: { ...verifier.content_assessment, artifact_hashes: {} } } });
  assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted').ok, false, 'Reported prose cannot replace the captured independent read proof.');
});

test('a document label cannot bypass executable verification for software and browser destinations cannot grant network access', t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-tailoring-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-TAILOR', name: 'Tailoring', execution_engine: 'opencode' });
  const candidate = plan('software'); candidate.request_kind = 'document'; candidate.allowed_paths = ['src/module.mjs']; candidate.outputs = ['src/module.mjs']; candidate.checks = [];
  assert.throws(() => validateControlledPlan(root, candidate, 'workforce/v1'), /document label cannot waive/);
  const remote = plan('url'); remote.allowed_urls = ['https://example.com/page']; remote.checks[0].baseline_paths = remote.outputs;
  assert.throws(() => validateControlledPlan(root, remote, 'workforce/v1'), /network permission/);
  for (const url of ['http://user:secret@localhost/', 'http://localhost/*', 'file:///etc/passwd']) {
    remote.allowed_urls = [url]; assert.throws(() => validateControlledPlan(root, remote, 'workforce/v1'));
  }
  remote.allowed_urls = ['http://127.0.0.1:3000/']; assert.equal(validateControlledPlan(root, remote, 'workforce/v1').allowed_urls.length, 1);
});

test('product repair uses the semantic ledger and obtains fresh independent review and tests', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['repair'], { repair: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: repair\nCreate the requested JSON result.' });
  const run = await wait(root, started.workflow_id);
  assert.equal(run.attempts.filter(item => item.role === 'developer').length, 2);
  assert.equal(run.attempts.filter(item => item.role === 'reviewer').length, 2);
  assert.equal(run.repair_budget, undefined, 'legacy counters cannot become a WorkForce acceptance gate');
  assert.equal(run.workforce_recovery.strategies[0].strategy, 'repair_product');
  assert.equal(run.status, 'completed'); assert.deepEqual(errors, []);
});

test('declared producer operations and independent checks use authenticated durable jobs with actual generated output', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['producer']);
  atomicWrite(safePath(root, 'scripts/generate.cjs'), "const fs=require('node:fs');fs.mkdirSync('products',{recursive:true});fs.writeFileSync('products/producer.json',JSON.stringify({value:42})+'\\n');\n");
  const selected = fixturePlans.get('producer'); selected.preservation_paths = ['scripts/generate.cjs'];
  selected.execution_steps = [{ title: 'Generate requested JSON', command: [process.execPath, 'scripts/generate.cjs'], output_paths: selected.outputs }];
  const started = await startControlledWorkflow(root, { requirement: 'Case: producer\nRun the existing local generator to create the requested JSON result and independently test it.' });
  const run = await wait(root, started.workflow_id);
  assert.equal(run.local_executions.length, 1); assert.equal(run.local_executions[0].passed, true); assert.ok(run.local_executions[0].durable_job);
  assert.ok(run.checks[0].durable_job); assert.deepEqual(JSON.parse(readFileSync(join(root, 'products/producer.json'), 'utf8')), { value: 42 });
  const final = getRecord(root, run.final_report_id); assert.ok(final.meta.data.traceability); assert.equal(final.meta.data.source_invocations.length, 6);
  assert.match(final.body, /OpenCode engine provider observations/); assert.deepEqual(errors, []);
});

test('only a confirmed business question pauses for user input and its answer continues the same request', { timeout: 40000 }, async t => {
  const root = await fixture(t, ['question'], { question: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: question\nCreate the requested JSON result with my preferred label.' });
  const asked = await wait(root, started.workflow_id, 'needs_input');
  assert.equal(asked.pending_question.category, 'business-choice'); assert.equal(asked.blocker, undefined);
  await assert.rejects(answerControlledWorkflow(root, asked.workflow_id, 'Use Alpha.', '00000000-0000-4000-8000-000000000000'), /different|another|changed|rejected|refused/i);
  const answered = await answerControlledWorkflow(root, asked.workflow_id, 'Use Alpha.', asked.pending_question.id);
  assert.equal(answered.workflow_id, asked.workflow_id);
  assert.equal(answered.answer_receipt.replayed, false);
  const replayed = await answerControlledWorkflow(root, asked.workflow_id, 'Use Alpha.', asked.pending_question.id);
  assert.equal(replayed.answer_receipt.replayed, true);
  await assert.rejects(answerControlledWorkflow(root, asked.workflow_id, 'Use Beta.', asked.pending_question.id));
  const run = await wait(root, asked.workflow_id);
  assert.equal(run.answers[0].answer, 'Use Alpha.'); assert.equal(run.pending_question, undefined);
  assert.equal(run.attempts.filter(item => item.role === 'manager').length, 2); assert.deepEqual(errors, []);
});

test('quality escalation is reserved before the no-progress guard and cannot reset through attempt wording', () => {
  const state = { workforce_recovery: { strategies: [], strong_implementation: false, no_progress: 2, resolved_checks: [] } };
  assert.deepEqual(workforceRecoveryDecision(state, 'implementation', 'same-checkpoint', [], true), { allowed: true, strategy: 'repair_product', strong: true });
  state.workforce_recovery.strong_implementation = true;
  assert.equal(workforceRecoveryDecision(state, 'implementation', 'same-checkpoint', [], true).allowed, false);
  state.workforce_recovery.no_progress = 0;
  state.workforce_recovery.strategies.push({ checkpoint: 'same-checkpoint', strategy: 'repair_product' });
  assert.equal(workforceRecoveryDecision(state, 'implementation', 'same-checkpoint', [], false).allowed, false);
});

test('a delayed duplicate Q1 answer cannot consume or replace a newer Q2', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['two-questions'], { questions: 2 });
  const started = await startControlledWorkflow(root, { requirement: 'Case: two-questions\nCreate the requested JSON result with the confirmed business choices.' });
  const first = await wait(root, started.workflow_id, 'needs_input'), q1 = first.pending_question.id;
  await answerControlledWorkflow(root, first.workflow_id, 'Alpha.', q1);
  const second = await wait(root, first.workflow_id, 'needs_input'), q2 = second.pending_question.id;
  assert.notEqual(q1, q2);
  const replay = await answerControlledWorkflow(root, first.workflow_id, 'Alpha.', q1);
  assert.equal(replay.answer_receipt.replayed, true); assert.equal(replay.pending_question.id, q2);
  await assert.rejects(answerControlledWorkflow(root, first.workflow_id, 'Beta.', q1));
  assert.equal(controlledStatus(root, first.workflow_id).pending_question.id, q2);
  await answerControlledWorkflow(root, first.workflow_id, 'Beta.', q2);
  const complete = await wait(root, first.workflow_id); assert.equal(complete.answers.length, 2); assert.deepEqual(errors, []);
});

test('a completed Tester report with no or partial check receipts cannot advance a resumed request', () => {
  const candidate = plan('resume'); candidate.checks[0].baseline_paths = candidate.outputs;
  candidate.checks.push({ ...candidate.checks[0], title: 'Second independent check', command: ['node', '--test', 'test/second.mjs'] });
  const run = { attempts: [], checks: [] }, contract = { plan: candidate };
  const receipt = { title: candidate.checks[0].title, command: candidate.checks[0].command, expected_exit_code: 0, negative: false, passed: true, checker_scope_current: true };
  assert.equal(workforcePrescribedChecksComplete(run, contract, []), false);
  assert.equal(workforcePrescribedChecksComplete(run, contract, [receipt]), false);
  const complete = [receipt, { ...receipt, title: candidate.checks[1].title, command: candidate.checks[1].command }];
  assert.equal(workforcePrescribedChecksComplete(run, contract, complete), true);
  assert.equal(workforcePrescribedChecksComplete(run, contract, [receipt, { ...complete[1], passed: false }]), false);
});

test('a compiler failure is resolved only by a current canonical positive receipt, never a changed label or artifact bytes alone', () => {
  const failure = { generation: 'failed-generation', owner: 'runtime', attempt_ids: ['producer'] };
  const run = { compiler_failures: [failure], compiler_resolutions: [{ failed_generation: failure.generation,
    successful_generation: 'passed-generation', attempt_id: 'producer', note_id: 'note', record_fingerprint: 'current-note' }], cornell_results: [] };
  assert.equal(currentWorkForceCompilerFailure(run, 'producer', () => 'current-note'), failure);
  run.cornell_results.push({ note_id: 'note', record_fingerprint: 'current-note', canonical_validation: { generation: 'passed-generation', exit_code: 0 } });
  assert.equal(currentWorkForceCompilerFailure(run, 'producer', () => 'current-note'), undefined);
  assert.equal(currentWorkForceCompilerFailure(run, 'producer', () => 'external-edit'), failure);
  assert.equal(run.compiler_failures[0], failure, 'historical failure is retained unchanged');
});

test('an engine storage incident resumes the same request only after an actual SQLite storage postcondition succeeds', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['storage'], { storage: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: storage\nCreate the requested JSON result.' });
  const stopped = await wait(root, started.workflow_id, 'waiting');
  assert.equal(stopped.blocker.code, 'WORKFORCE_OPERATIONAL_INCIDENT'); assert.equal(stopped.incident_condition.code, 'storage');
  assert.equal(stopped.attempts.length, 1, 'the failed engine is not polled through repeat model sessions');
  await controlControlledWorkflow(root, { workflow_id: stopped.workflow_id, action: 'resume' });
  const finished = await wait(root, stopped.workflow_id);
  assert.equal(finished.workflow_id, stopped.workflow_id);
  assert.ok(finished.runtime_observations.some(item => item.kind === 'storage-sqlite-write-restored'));
  assert.ok(finished.events.some(item => item.kind === 'operational-incident'));
  assert.equal(finished.attempts.filter(item => item.role === 'manager').length, 2); assert.deepEqual(errors, []);
});

test('the owner automatically resumes a storage dependency from its persisted clock checkpoint and actual SQLite probe', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['storage-auto'], { storage: true, clock: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: storage-auto\nCreate the requested result and use the existing project checker.' });
  const waiting = await wait(root, started.workflow_id, 'waiting');
  assert.equal(waiting.dependency_wait.code, 'storage'); assert.equal(waiting.dependency_wait.attempts, 0);
  assert.equal(waiting.pending_question, undefined);
  fixtureClocks.get(root).value = Date.parse(waiting.dependency_wait.next_condition_check_at) + 1;
  const completed = await wait(root, started.workflow_id);
  assert.equal(completed.dependency_wait, undefined);
  assert.equal(completed.attempts.filter(attempt => attempt.stage === 'planning').length, 2);
  assert.ok(completed.runtime_observations.some(observation => observation.kind === 'storage-sqlite-write-restored'));
  assert.ok(completed.events.some(event => event.kind === 'dependency-condition-check'));
});

test('a known missing command installed at the same frozen path wakes verification without a model/config edit or product replay', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['prerequisite'], { clock: true });
  const installation = mkdtempSync(join(resolve('artifacts/test-temp'), 'wf-installed-tool-'));
  t.after(() => rmSync(installation, { recursive: true, force: true }));
  const executable = join(installation, process.platform === 'win32' ? 'node.exe' : 'node');
  fixturePlans.get('prerequisite').checks[0].command[0] = executable;
  const started = await startControlledWorkflow(root, { requirement: 'Case: prerequisite\nCreate the requested result and run the existing checker with its configured executable.' });
  const waiting = await wait(root, started.workflow_id, 'waiting');
  assert.equal(waiting.dependency_wait.code, 'prerequisite'); assert.equal(waiting.incident_condition.prerequisite.kind, 'node');
  assert.equal(waiting.pending_question, undefined);
  const configuration = waiting.incident_condition.configuration;
  copyFileSync(process.execPath, executable);
  fixtureClocks.get(root).value = Date.parse(waiting.dependency_wait.next_condition_check_at) + 1;
  const run = await wait(root, started.workflow_id);
  assert.equal(run.incident_condition.configuration, configuration);
  assert.equal(run.attempts.filter(attempt => attempt.role === 'developer').length, 1, 'A dependency installation does not redo correct product work.');
  assert.equal(run.attempts.filter(attempt => attempt.role === 'verifier').length, 2);
  assert.equal(run.checks.length, 2); assert.equal(run.checks[0].passed, false); assert.equal(run.checks[1].passed, true);
  assert.ok(run.runtime_observations.some(observation => observation.kind === 'known-prerequisite-restored'));
  assert.deepEqual(errors, []);
});

test('unreachable provider checks persist bounded backoff without inference and pause/owner-close stop the watcher', { timeout: 30000 }, async t => {
  const root = await fixture(t, ['provider-wait'], { provider: true, clock: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: provider-wait\nCreate the requested result and use the existing project checker.' });
  const waiting = await wait(root, started.workflow_id, 'waiting');
  const clock = fixtureClocks.get(root); clock.value = Date.parse(waiting.dependency_wait.next_condition_check_at) + 1;
  let current;
  const deadline = Date.now() + 5000;
  do { current = controlledStatus(root, started.workflow_id); if (current.dependency_wait.attempts === 1) break; await delay(20); } while (Date.now() < deadline);
  assert.equal(current.dependency_wait.attempts, 1); assert.equal(current.attempts.length, 1);
  assert.equal(Date.parse(current.dependency_wait.next_condition_check_at) - clock.value, 120000);
  await fixtureOwners.get(root).close();
  const restarted = await startControlledHost(root, { condition_clock: () => clock.value, condition_poll_ms: 10 });
  fixtureOwners.set(root, restarted);
  await delay(50);
  assert.equal(controlledStatus(root, started.workflow_id).dependency_wait.attempts, 1, 'Restart preserves the future backoff checkpoint.');
  clock.value = Date.parse(current.dependency_wait.next_condition_check_at) + 1;
  const nextDeadline = Date.now() + 5000;
  do { current = controlledStatus(root, started.workflow_id); if (current.dependency_wait.attempts === 2) break; await delay(20); } while (Date.now() < nextDeadline);
  assert.equal(current.dependency_wait.attempts, 2);
  assert.equal(Date.parse(current.dependency_wait.next_condition_check_at) - clock.value, 300000);
  await controlControlledWorkflow(root, { workflow_id: started.workflow_id, action: 'pause' });
  clock.value += 600000; await delay(50);
  assert.equal(controlledStatus(root, started.workflow_id).status, 'paused');
  assert.equal(controlledStatus(root, started.workflow_id).dependency_wait.attempts, 2);
  await fixtureOwners.get(root).close();
  const before = controlledStatus(root, started.workflow_id).revision;
  clock.value += 600000; await delay(50);
  assert.equal(controlledStatus(root, started.workflow_id).revision, before);
});

test('canonical OpenCode HTTP 503 with upstream usage 429 signs a bound failure, waits and completes the same review after actual healthy proof', { timeout: 150000 }, async t => {
  const began = Date.now(), remaining = () => Math.max(1, began + 140000 - Date.now());
  let healthy = false, staleRejected = false;
  const routeNonces = new Map();
  const secret = 'PRIVATE_PROVIDER_ERROR_CANARY';
  const provider = await localOpenAIProvider((_index, body) => {
    if (!healthy) return { statusCode: 503, headers: { 'retry-after-ms': '1' },
      body: { error: { type: 'upstream_error', message: `[429] The usage limit has been reached. ${secret}` } } };
    if (body.tools.some(tool => tool.function?.name === 'wf_capability_ping')) {
      const nonce = /nonce ([a-f0-9-]{36})/.exec(JSON.stringify(body.messages)); assert.ok(nonce);
      const ping = value => ({ name: 'wf_capability_ping', arguments: { nonce: value } });
      if (body.messages.at(-1).role === 'tool') {
        const calls = body.messages.flatMap(message => message.tool_calls ?? []);
        if (JSON.parse(calls.at(-1).function.arguments).nonce !== nonce[1]) {
          assert.match(JSON.stringify(body.messages.at(-1)), /stale/i);
          staleRejected = true; return { toolCalls: [ping(nonce[1])] };
        }
        return { text: 'connected' };
      }
      routeNonces.set(body.model, nonce[1]);
      return { toolCalls: [ping(routeNonces.values().next().value)] };
    }
    const called = body.messages.flatMap(message => message.tool_calls ?? []).map(call => call.function.name);
    if (called.includes('wf_assignment_report')) return { text: 'Independent review completed.' };
    if (called.includes('wf_project_read')) return { toolCalls: [{ name: 'wf_assignment_report',
      arguments: { summary: 'Independently read the current JSON and confirmed expected value 42.', findings: [], verdict: 'pass' } }] };
    return { toolCalls: [{ name: 'wf_project_read', arguments: { path: 'products/canonical-provider.json' } }] };
  }, 30);
  t.after(() => provider.close());
  const root = await fixture(t, ['canonical-provider'], { canonicalReviewProviderFailure: true, clock: true });
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  const started = await startControlledWorkflow(root, { requirement: 'Case: canonical-provider\nCreate the requested JSON and use the existing independent checker.' });
  const waiting = await wait(root, started.workflow_id, 'waiting', remaining());
  assert.equal(waiting.phase, 'review'); assert.equal(waiting.dependency_wait.code, 'provider');
  assert.deepEqual(waiting.provider_stalls?.flatMap(checkpoint => checkpoint.attempts.map(attempt => attempt.action)), ['retry-provider'],
    'A canonical transient failure enters the same task-bound recovery ledger as a stalled provider stream.');
  const failed = waiting.attempts.at(-1);
  await waitNative(root, failed.invocation_id, Math.min(60000, remaining()));
  await reconcileWorkForceInvocations(root, started.workflow_id);
  const native = readInvocation(root, failed.invocation_id);
  const originalReceipt = readFileSync(safePath(root, native.receipt_path), 'utf8');
  assert.equal(native.inference_completed, false); assert.equal(native.state, 'interrupted');
  assert.match(native.opencode.interruption_proof_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(native.opencode.provider_failure, { schema_version: 1, code: 'RATE_LIMITED', status_code: 503, retryable: true,
    session_id: native.native_thread_id, user_message_id: native.native_turn_id, assistant_message_id: native.opencode.response_message_id });
  assert.match(native.error, /^RATE_LIMITED:/); assert.equal(originalReceipt.includes(secret), false);
  try {
    const forged = JSON.parse(originalReceipt); forged.opencode.provider_failure.status_code = 400;
    atomicWrite(safePath(root, native.receipt_path), JSON.stringify(forged));
    assert.throws(() => readInvocation(root, native.id), /signature/i, 'Provider metadata is covered by the native signature.');
  } finally { atomicWrite(safePath(root, native.receipt_path), originalReceipt); }
  assert.equal(waiting.attempts.filter(attempt => attempt.stage === 'diagnosis').length, 0);
  assert.equal(waiting.pending_question, undefined);
  const product = readFileSync(join(root, 'products/canonical-provider.json'));
  healthy = true; fixtureClocks.get(root).value = Date.parse(waiting.dependency_wait.next_condition_check_at) + 1;
  const completed = await wait(root, started.workflow_id, 'completed', remaining());
  assert.equal(completed.attempts.filter(attempt => attempt.stage === 'review').length, 2);
  assert.equal(completed.attempts.filter(attempt => attempt.stage === 'implementation').length, 1);
  assert.equal(completed.checks.length, 1); assert.equal(completed.checks[0].passed, true);
  assert.ok(completed.runtime_observations.some(observation => observation.kind === 'provider-capability-restored'));
  const reviewer = readInvocation(root, completed.attempts.filter(attempt => attempt.stage === 'review').at(-1).invocation_id);
  assert.equal(reviewer.inference_completed, true); assert.equal(reviewer.opencode.provider_failure, undefined);
  assert.deepEqual(readFileSync(join(root, 'products/canonical-provider.json')), product);
  assert.equal(readFileSync(safePath(root, native.receipt_path), 'utf8'), originalReceipt, 'Prior failed native evidence is immutable.');
  const proofPath = safePath(root, '.workforce/setup/model-capabilities.json'), proofBytes = readFileSync(proofPath);
  const proof = JSON.parse(proofBytes.toString('utf8'));
  assert.equal(routeNonces.size, 2); assert.equal(new Set(routeNonces.values()).size, 2);
  assert.equal(new Set(proof.models.map(model => model.session_id)).size, 2, 'Each alias has its own actual SDK session.');
  assert.equal(staleRejected, true, 'A nonce from the other proof session cannot authorize this route.');
  assert.equal(controlledStatus(root, started.workflow_id).status, 'completed');
  t.diagnostic(JSON.stringify({ accepted: true, elapsed_ms: Date.now() - began,
    review_invocations: completed.attempts.filter(attempt => attempt.stage === 'review').length,
    implementation_invocations: completed.attempts.filter(attempt => attempt.stage === 'implementation').length,
    independent_checks: completed.checks.length, stale_nonce_refused: staleRejected }));
  assert.deepEqual(provider.failures, []); assert.deepEqual(errors, []);
});

test('a real connection probe with duplicate current nonce calls cannot replace its previous complete proof', { timeout: 90000 }, async t => {
  let duplicate = false;
  const provider = await localOpenAIProvider((_index, body) => {
    if (body.messages.at(-1).role === 'tool') return { text: 'connected' };
    const nonce = /nonce ([a-f0-9-]{36})/.exec(JSON.stringify(body.messages)); assert.ok(nonce);
    const ping = { name: 'wf_capability_ping', arguments: { nonce: nonce[1] } };
    return { toolCalls: duplicate ? [ping, ping] : [ping] };
  }, 10);
  t.after(() => provider.close());
  const root = await fixture(t, ['duplicate-proof']);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  assert.equal((await probeWorkForceConnection(root)).valid, true);
  const path = safePath(root, '.workforce/setup/model-capabilities.json'), before = readFileSync(path);
  duplicate = true;
  await assert.rejects(() => probeWorkForceConnection(root, undefined, { not_before: new Date().toISOString() }), /did not complete its bound tool-call check/);
  assert.deepEqual(readFileSync(path), before, 'Duplicate current nonce calls cannot replace the prior complete proof with partial evidence.');
  assert.deepEqual(provider.failures, []); assert.deepEqual(errors, []);
});

test('repeated canonical OpenCode HTTP 503 cannot spend healthy proof nonces indefinitely on an unchanged review', { timeout: 150000 }, async t => {
  const began = Date.now(), remaining = () => Math.max(1, began + 140000 - Date.now());
  let healthCalls = 0, taskCalls = 0;
  const provider = await localOpenAIProvider((_index, body) => {
    if (body.tools.some(tool => tool.function?.name === 'wf_capability_ping')) {
      healthCalls++;
      if (body.messages.at(-1).role === 'tool') return { text: 'connected' };
      const nonce = /nonce ([a-f0-9-]{36})/.exec(JSON.stringify(body.messages)); assert.ok(nonce);
      return { toolCalls: [{ name: 'wf_capability_ping', arguments: { nonce: nonce[1] } }] };
    }
    taskCalls++;
    return { statusCode: 503, headers: { 'retry-after-ms': '1' },
      body: { error: { type: 'upstream_error', message: '[429] The usage limit has been reached.' } } };
  }, 20);
  t.after(() => provider.close());
  const root = await fixture(t, ['canonical-recurring'], { canonicalReviewProviderFailure: true, clock: true });
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  const started = await startControlledWorkflow(root, { requirement: 'Case: canonical-recurring\nCreate the requested JSON and use the existing independent checker.' });
  const waiting = await wait(root, started.workflow_id, 'waiting', remaining());
  const product = readFileSync(join(root, 'products/canonical-recurring.json'));
  fixtureClocks.get(root).value = Date.parse(waiting.dependency_wait.next_condition_check_at) + 1;
  const stopped = await wait(root, started.workflow_id, 'blocked', remaining());
  assert.equal(healthCalls, 4, 'Exactly one actual capability proof across both configured routes.');
  assert.ok(taskCalls >= 2 && taskCalls <= 12, 'Pinned OpenCode retries are bounded within two failed review sessions.');
  assert.deepEqual(stopped.provider_stalls.flatMap(checkpoint => checkpoint.attempts.map(attempt => attempt.action)), ['retry-provider', 'diagnose']);
  assert.equal(stopped.attempts.filter(attempt => attempt.stage === 'review').length, 2);
  assert.equal(stopped.attempts.filter(attempt => attempt.stage === 'diagnosis').length, 1);
  assert.equal(stopped.attempts.filter(attempt => attempt.stage === 'implementation').length, 1);
  assert.equal(stopped.pending_question, undefined); assert.equal(stopped.dependency_wait, undefined);
  assert.deepEqual(readFileSync(join(root, 'products/canonical-recurring.json')), product);
  const attempts = stopped.attempts.length, requests = provider.requests.length;
  fixtureClocks.get(root).value += 3600000; await delay(100);
  assert.equal(controlledStatus(root, started.workflow_id).attempts.length, attempts);
  assert.equal(provider.requests.length, requests);
  assert.deepEqual(provider.failures, []); assert.deepEqual(errors, []);
});

test('canonical OpenCode invalid-schema HTTP 400 remains a retained technical incident without healthy-provider polling', { timeout: 90000 }, async t => {
  const provider = await localOpenAIProvider(() => ({ statusCode: 400,
    body: { error: { type: 'invalid_request_error', message: 'Invalid tool JSON schema PRIVATE_INVALID_SCHEMA' } } }), 4);
  t.after(() => provider.close());
  const root = await fixture(t, ['canonical-schema'], { canonicalReviewProviderFailure: true, clock: true });
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  const started = await startControlledWorkflow(root, { requirement: 'Case: canonical-schema\nCreate the requested JSON and use the existing independent checker.' });
  const stopped = await wait(root, started.workflow_id, 'blocked');
  const native = readInvocation(root, stopped.attempts.at(-1).invocation_id);
  assert.equal(stopped.phase, 'review'); assert.equal(stopped.dependency_wait, undefined); assert.equal(stopped.pending_question, undefined);
  assert.equal(native.opencode.provider_failure.code, 'PROVIDER_REQUEST_REJECTED');
  assert.equal(native.opencode.provider_failure.status_code, 400); assert.equal(native.opencode.provider_failure.retryable, false);
  assert.match(native.error, /^PROVIDER_REQUEST_REJECTED:/); assert.equal(JSON.stringify(native).includes('PRIVATE_INVALID_SCHEMA'), false);
  const attempts = stopped.attempts.length, requests = provider.requests.length;
  fixtureClocks.get(root).value += 3600000; await delay(100);
  assert.equal(controlledStatus(root, started.workflow_id).attempts.length, attempts); assert.equal(provider.requests.length, requests);
  assert.deepEqual(provider.failures, []); assert.deepEqual(errors, []);
});

test('concurrent dependency waits share one actual local nonce proof and pausing one consumer preserves the other', { timeout: 120000 }, async t => {
  const provider = await localOpenAIProvider((_index, body) => {
    const last = body.messages.at(-1);
    if (last.role === 'tool') return { text: 'connected' };
    const nonce = /nonce ([a-f0-9-]{36})/.exec(JSON.stringify(body.messages));
    assert.ok(nonce, 'the runtime supplies the actual private proof nonce');
    return { toolCalls: [{ name: 'wf_capability_ping', arguments: { nonce: nonce[1] } }] };
  }, 8);
  t.after(() => provider.close());
  const root = await fixture(t, ['provider-alpha', 'provider-beta'], { provider: true, clock: true });
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  const [a, b] = await Promise.all(['provider-alpha', 'provider-beta'].map(name => startControlledWorkflow(root, { requirement: `Case: ${name}\nCreate the requested result with the existing checker.` })));
  const [wa, wb] = await Promise.all([wait(root, a.workflow_id, 'waiting'), wait(root, b.workflow_id, 'waiting')]);
  fixtureClocks.get(root).value = Math.max(Date.parse(wa.dependency_wait.next_condition_check_at), Date.parse(wb.dependency_wait.next_condition_check_at)) + 1;
  const deadline = Date.now() + 60000;
  while (!provider.requests.length && Date.now() < deadline) await delay(25);
  assert.ok(provider.requests.length > 0, 'the pinned engine actually started the shared loopback proof');
  await controlControlledWorkflow(root, { workflow_id: a.workflow_id, action: 'pause' });
  const completed = await wait(root, b.workflow_id);
  assert.equal(completed.status, 'completed'); assert.equal(controlledStatus(root, a.workflow_id).status, 'paused');
  assert.equal(provider.requests.length, 4, 'one call+tool-result completion per distinct route, shared across waiting requests');
  assert.deepEqual(provider.failures, []); assert.deepEqual(errors, []);
});

test('fresh healthy model nonces do not rearm the same stalled task indefinitely after one strong diagnosis', { timeout: 150000 }, async t => {
  const provider = await localOpenAIProvider((_index, body) => {
    if (body.messages.at(-1).role === 'tool') return { text: 'connected' };
    const nonce = /nonce ([a-f0-9-]{36})/.exec(JSON.stringify(body.messages)); assert.ok(nonce);
    return { toolCalls: [{ name: 'wf_capability_ping', arguments: { nonce: nonce[1] } }] };
  }, 8);
  t.after(() => provider.close());
  const root = await fixture(t, ['stall-loop'], { stalls: true, clock: true, qualityBeforeStall: true });
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  const started = await startControlledWorkflow(root, { requirement: 'Case: stall-loop\nCreate the requested result and use the existing independent checker.' });
  const waiting = await wait(root, started.workflow_id, 'waiting');
  assert.equal(waiting.workforce_recovery.no_progress, 1, 'A real preceding session-rebind attempt is part of the engineering recovery ledger.');
  const qualityLedger = structuredClone(waiting.workforce_recovery.strategies);
  fixtureClocks.get(root).value = Date.parse(waiting.dependency_wait.next_condition_check_at) + 1;
  const stopped = await wait(root, started.workflow_id, 'blocked', 60000, () => ({
    provider_request_count: provider.requests.length, provider_failure_count: provider.failures.length,
    fixture_stage_counts: Object.fromEntries([...counts].filter(([key]) => key.startsWith(`${started.workflow_id}:`)).map(([key, value]) => [key.slice(started.workflow_id.length + 1), value])) }));
  assert.equal(provider.requests.length, 4, 'Only the first stalled request performs one real local proof across its two routes.');
  assert.equal(stopped.provider_stalls.length, 1);
  assert.deepEqual(stopped.provider_stalls[0].attempts.map(attempt => attempt.action), ['retry-provider', 'diagnose']);
  assert.equal(stopped.attempts.filter(attempt => attempt.stage === 'design').length, 2);
  assert.equal(stopped.attempts.filter(attempt => attempt.stage === 'diagnosis').length, 1);
  assert.equal(stopped.workforce_recovery.no_progress, waiting.workforce_recovery.no_progress, 'A new healthy provider nonce cannot zero the retained quality-loop counter.');
  assert.deepEqual(stopped.workforce_recovery.strategies, qualityLedger, 'Fresh transport proof does not replace the engineering strategy checkpoint.');
  assert.equal(stopped.pending_question, undefined); assert.equal(stopped.dependency_wait, undefined);
  const count = stopped.attempts.length;
  fixtureClocks.get(root).value += 3600000; await delay(100);
  assert.equal(controlledStatus(root, started.workflow_id).attempts.length, count);
  assert.equal(provider.requests.length, 4); assert.deepEqual(errors, []);
});

test('model report prose cannot authorize provider billing, a stall ledger, or a storage dependency wait', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['forged-dependency'], { forgeDependencyProse: true, clock: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: forged-dependency\nCreate the requested result with the existing checker.' });
  const stopped = await wait(root, started.workflow_id);
  assert.equal(stopped.incident_condition, undefined);
  assert.equal(stopped.dependency_wait, undefined); assert.equal(stopped.pending_question, undefined);
  assert.deepEqual(stopped.provider_stalls ?? [], []);
  const last = readInvocation(root, stopped.attempts.at(-1).invocation_id);
  assert.equal(last.state, 'completed'); assert.equal(last.inference_completed, true);
  assert.equal(last.error, null);
  const attempts = stopped.attempts.length;
  fixtureClocks.get(root).value += 3600000; await delay(100);
  assert.equal(controlledStatus(root, started.workflow_id).attempts.length, attempts);
  assert.deepEqual(errors, []);
});

test('a saved implementation report remains unsubmitted after native failure, and authenticated recovery migrates old completion flags without replaying product writes', { timeout: 150000 }, async t => {
  const provider = await localOpenAIProvider((_index, body) => {
    if (body.messages.at(-1).role === 'tool') return { text: 'connected' };
    const nonce = /nonce ([a-f0-9-]{36})/.exec(JSON.stringify(body.messages)); assert.ok(nonce);
    return { toolCalls: [{ name: 'wf_capability_ping', arguments: { nonce: nonce[1] } }] };
  }, 8);
  t.after(() => provider.close());
  const root = await fixture(t, ['retained-report'], { failAfterSavedStage: 'implementation', clock: true });
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([{ name: 'fixture', vendor: 'fixture', models: [
    { id: 'top-models', url: provider.baseURL }, { id: 'worker-models', url: provider.baseURL }] }]));
  const started = await startControlledWorkflow(root, { requirement: 'Case: retained-report\nCreate the requested JSON result and run the existing project checker.' });
  const stopped = await wait(root, started.workflow_id, 'waiting');
  const retained = stopped.attempts.at(-1);
  assert.equal(stopped.phase, 'implementation'); assert.equal(retained.state, 'interrupted');
  assert.equal(retained.report.outcome, 'completed'); assert.equal(stopped.checks.length, 0);
  assert.equal(stopped.attempts.some(attempt => ['review', 'verification'].includes(attempt.stage)), false);
  const contract = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(stopped.workflow_id)}.${stopped.epoch_id}.contract.json`), 'utf8'));
  assert.notEqual(getRecord(root, contract.task_id).meta.status, 'submitted');
  const reportBefore = JSON.stringify(getRecord(root, retained.report_id)), productBefore = readFileSync(join(root, 'products/retained-report.json'));
  const terminal = await waitNative(root, retained.invocation_id, 10000);
  assert.equal(terminal.inference_completed, false); assert.match(terminal.error, /^OPENCODE_PROVIDER_UNAVAILABLE:/);
  assert.ok(terminal.opencode.supervision, 'The failing fixture owns a real engine/process guardian.');
  // Reproduce the older persisted controller bug without touching the signed
  // receipt, report, contract, product or provider-proof history.
  const legacy = controlledStatus(root, started.workflow_id); legacy.attempts.at(-1).state = 'completed';
  atomicWrite(safePath(root, `.neomind/controlled/workflows/${hash(started.workflow_id)}.json`), JSON.stringify(legacy, null, 2) + '\n');
  fixtureClocks.get(root).value = Date.parse(legacy.dependency_wait.next_condition_check_at) + 1;
  const completed = await wait(root, started.workflow_id, 'completed', 110000);
  assert.equal(completed.attempts.find(attempt => attempt.id === retained.id).state, 'interrupted');
  assert.ok(completed.events.some(event => event.kind === 'incomplete-result-reconciled'));
  assert.equal(completed.attempts.filter(attempt => attempt.stage === 'implementation').length, 2);
  assert.equal(fixtureProductWrites.get('retained-report'), 1, 'The fresh role reads and reports the retained product instead of rewriting it.');
  assert.equal(JSON.stringify(getRecord(root, retained.report_id)), reportBefore);
  assert.deepEqual(readFileSync(join(root, 'products/retained-report.json')), productBefore);
  assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted').ok, true);
  assert.equal(provider.requests.length, 4); assert.deepEqual(provider.failures, []); assert.deepEqual(errors, []);
});

test('a committed business question is immediately answerable after its final native followup fails', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['retained-question'], { question: true, failAfterSavedStage: 'planning' });
  const started = await startControlledWorkflow(root, { requirement: 'Case: retained-question\nCreate the requested result with the user-selected business label.' });
  const asked = await wait(root, started.workflow_id, 'needs_input');
  const failed = asked.attempts.at(-1);
  assert.equal(failed.state, 'interrupted'); assert.equal(asked.dependency_wait, undefined);
  const native = await waitNative(root, failed.invocation_id, 10000);
  assert.equal(native.inference_completed, false); assert.match(native.error, /^OPENCODE_PROVIDER_UNAVAILABLE:/);
  assert.ok(native.opencode.supervision);
  const answer = await answerControlledWorkflow(root, asked.workflow_id, 'Use Alpha.', asked.pending_question.id);
  assert.equal(answer.answer_receipt.accepted, true);
  const completed = await wait(root, started.workflow_id);
  assert.equal(completed.workflow_id, asked.workflow_id); assert.equal(completed.pending_question, undefined);
  assert.equal(completed.answers[0].question_id, asked.pending_question.id);
  assert.equal(completed.attempts.find(attempt => attempt.id === failed.id).state, 'interrupted');
  assert.equal(completed.attempts.filter(attempt => attempt.stage === 'planning').length, 2);
  assert.deepEqual(errors, []);
});

test('changing frozen task scope after a readonly read refuses the next actual product mutation', { timeout: 90000 }, async t => {
  const root = await fixture(t, ['scope-change'], { mutateScope: true });
  const started = await startControlledWorkflow(root, { requirement: 'Case: scope-change\nCreate the requested JSON result.' });
  const run = await wait(root, started.workflow_id, 'uncertain');
  assert.equal(run.blocker.code, 'INPUT_CHANGED');
  assert.throws(() => readFileSync(join(root, 'products/scope-change.json')), /ENOENT/);
  assert.deepEqual(errors, []);
});
