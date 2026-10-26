import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialize, atomicWrite, createRecord, getRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { executionModes } from '../dist/execution-mode.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus, reconcileInterruptedControlledChecks } from '../dist/controlled-workflow.js';
import { readCheckReconciliations, unresolvedControlledChecks, assertFreshVerifierAfterReconciliation, reconciliationPath } from '../dist/controlled-check-reconciliation.js';
import { setRoleModel } from '../dist/model-control.js';
import { readAgentMap } from '../dist/agent-map.js';
import { verify } from '../dist/engineering.js';
import { ownedContext } from '../dist/controlled-context.js';
import { beginWorkflow } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment } from '../dist/assignment-runtime.js';
import { planNativeSoftware, readNativeSoftwareContract } from '../dist/native-software.js';
import { controlledContractForTask, verifyControlledTask } from '../dist/controlled-acceptance.js';
import { researchFixture } from './cornell-research-fixture.mjs';

// These tests exercise the actual signed local Bridge, MCP, filesystem and child runner.
// The language model and editor API are deterministic fixtures, not actual Copilot/Codex inference.
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (name, input) => ({ name, input });
const prohibited = new Set(['workflow_id', 'task_id', 'invocation_id', 'reported_assignment', 'claim_token', 'access_token', 'operation_id', 'expected_hash']);
function assertSemanticSchemas(tools) {
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const name of Object.keys(value.properties ?? {})) assert.ok(!prohibited.has(name), `model must not construct ${name}`);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  for (const tool of tools) {
    assert.ok(!['assignment_open', 'assignment_claim', 'assignment_progress', 'record_create', 'record_update', 'manager_run', 'native_dispatch', 'run_in_terminal'].includes(tool.name));
    visit(tool.inputSchema);
  }
}
function lastToolResult(messages) {
  const result = messages.at(-1)?.content?.[0];
  if (!(result instanceof Result)) return;
  let decoded = JSON.parse(result.content[0].value);
  return decoded;
}
function semanticToolValue(messages) {
  const result = lastToolResult(messages), content = result?.content?.[0];
  return content?.type === 'text' ? JSON.parse(content.text) : result;
}
function planFor(name, options = {}) {
  if (options.preparedCornell) {
    const directory = `${name}/notes`, checker = `${name}/verify/check.cjs`, wrong = `${name}/verify/bad.md`;
    const outputs = ['note.md', 'exercises.md', 'answers.md'].map(path => `${directory}/${path}`);
    return { title: 'Compile the backend-bound prepared Cornell source', objective: 'Deliver a source-bound research note with independent positive and negative checks.',
      rationale: 'Native compilation consumes one prepared JSON source through the existing backend formatter, not a guessed executable.',
      acceptance_criteria: ['The primary Cornell bundle explains six ordered pairs.', 'Its actual independent checker rejects a deliberately incorrect note.'],
      allowed_paths: [directory], verification_paths: [`${name}/verify`], outputs: [...outputs, checker, wrong], documentation_paths: outputs,
      cornell_output_dir: directory, preservation_paths: [`${name}/reference.md`, '.agents/skills/native-cornell/assets/template.md'],
      cornell_input_path: `prepared/${name}.json`, execution_steps: [],
      checks: [{ title: 'Inspect source-bound Cornell', command: [process.execPath, checker, outputs[0]],
        negative_controls: [{ title: 'Reject an incorrect research note', command: [process.execPath, checker, wrong], expected_exit_code: 1 }] }], risk: 'high' };
  }
  const output = `${name}/src/value.txt`, checker = `${name}/verify/check.cjs`, bad = `${name}/verify/bad.txt`;
  const baseline = [output, checker];
  const plan = { title: `Produce ${name} scalar`, objective: 'Persist a scalar equal to one with independent positive and negative verification.',
    rationale: 'A bounded test artifact demonstrates actual workflow transitions and execution evidence.',
    acceptance_criteria: ['The delivered scalar is one.', 'The independent checker rejects a scalar equal to two.'],
    allowed_paths: [output], verification_paths: [`${name}/verify`], outputs: [output], documentation_paths: [],
    checks: [{ title: options.observationLoop ? 'Validate scalar policy observation' : 'Validate scalar', command: [process.execPath, checker, output], baseline_paths: baseline,
      negative_controls: [{ title: 'Reject incorrect scalar', command: [process.execPath, checker, bad], baseline_paths: [checker, bad], expected_exit_code: 1 }] }],
    risk: options.highRisk ? 'high' : 'low' };
  if (options.evidenceReport) {
    const path = `${name}/docs/final-report.md`, reportChecker = `${name}/verify/report.cjs`, badReport = `${name}/verify/bad-report.md`;
    plan.allowed_paths.push(path); plan.outputs.push(path); plan.documentation_paths.push(path);
    plan.evidence_report_paths = [path];
    plan.acceptance_criteria.push(`Final report ${path} contains actual product-check commands and exits before independent final verification.`);
    plan.checks.push({ title: 'Validate final execution report', after_evidence_reports: true,
      command: [process.execPath, reportChecker, path], baseline_paths: [path, reportChecker],
      negative_controls: [{ title: 'Reject a report with invented evidence', command: [process.execPath, reportChecker, badReport],
        baseline_paths: [reportChecker, badReport], expected_exit_code: 1 }] });
  }
  if (options.registrationEvidence) {
    const script = `${name}/src/generate.cjs`;
    plan.allowed_paths.push(script); plan.outputs.push(script);
    plan.procedure_candidate = { title: 'Reusable scalar producer', description: 'Generate a future scalar and check it independently.',
      script, verification_script: checker, parameters: { output: { type: 'string', path: true, required: true } },
      outputs: [{ path: '{output}', min_bytes: 1 }], environment: { platforms: [process.platform], clients: ['codex', 'copilot', 'cli'] },
      effects: { write_roots: ['generated'], network: false, publication: false } };
  }
  if (options.readOnlyBaseline) {
    const dependency = 'scripts/verify-leetcode-exercise.mjs';
    const hiddenInput = '.agents/skills/helpers/assets/oracle.json';
    plan.preservation_paths = [options.privateBaselineDirectory ? 'scripts' : dependency];
    plan.input_paths = [hiddenInput];
    plan.checks[0].baseline_paths.push(options.privateBaselineDirectory ? 'scripts' : dependency, hiddenInput);
    plan.checks[0].negative_controls[0].baseline_paths.push(options.privateBaselineDirectory ? 'scripts' : dependency, hiddenInput);
  }
  if (options.conflictingReadInput) {
    const publicSkillInput = '.github/skills/helpers/assets/oracle.json';
    plan.allowed_paths.push(publicSkillInput); plan.input_paths.push(publicSkillInput);
  }
  return plan;
}
function scriptFor(name, stage, attempt, options, held) {
  const plan = planFor(name, options), output = plan.outputs[0], checker = plan.checks[0].command[1], bad = plan.checks[0].negative_controls[0].command[2];
  const report = (extra = {}) => call('assignment_report', { outcome: 'completed', summary: `${stage} completed with actual scoped artifacts.`,
    findings: [`Independent ${stage} result recorded.`], ...extra });
  if (options.preparedCornell) {
    if (stage === 'planning') return [call('workflow_plan', plan), report()];
    if (stage === 'implementation') return [call('cornell_research_compile', {}), call('cornell_research_compile', {}), report()];
    if (stage === 'verification') return [call('project_read', { path: output }), call('project_read', { path: checker }),
      call('task_file_write', { path: checker, content: "const fs=require('node:fs'),assert=require('node:assert/strict');assert.match(fs.readFileSync(process.argv[2],'utf8'),/six ordered pairs/);console.log('source-bound Cornell independently checked');\n" }),
      call('project_read', { path: bad }), call('task_file_write', { path: bad, content: '# Wrong research\nThere are 999 ordered pairs.\n' }),
      call('check_run', {}), report({ verdict: 'pass', artifacts: [checker, bad] })];
    if (stage === 'review') return [call('project_read', { path: output }), call('check_evidence', { kind: 'workflow' }),
      call('check_evidence', {}), report({ verdict: 'pass' })];
    throw new Error(`Unexpected source-bound Cornell fixture stage ${stage}`);
  }
  if (stage === 'planning') return [call('project_list', { path: '.' }), call('workflow_plan', plan), report()];
  if (stage === 'implementation') {
    if (options.evidenceReport && attempt > 1) return [call('check_evidence', {}), async ({ messages }) => {
      const checks = semanticToolValue(messages); held.documentationEvidence = checks;
      assert.equal(checks.length, 2); assert.ok(checks.every(check => check.passed));
      return new Call('fixture-read-final-report', 'project_read', { path: plan.evidence_report_paths[0] });
    }, call('task_file_write', { path: plan.evidence_report_paths[0],
      content: `# Actual product checkpoint\n\nCommand: ${JSON.stringify(plan.checks[0].command)}\nPositive exit: 0\nNegative exit: 1\nFinal independent verification and review follow this report.\n` }),
    report({ artifacts: plan.evidence_report_paths })];
    const value = options.precheckProductFailure || options.productFailure && attempt === 1 ? '2\n' : '1\n';
    return [call('project_read', { path: output }), call('task_file_write', { path: output, content: value }),
      ...(options.evidenceReport ? [call('project_read', { path: plan.evidence_report_paths[0] }),
        call('task_file_write', { path: plan.evidence_report_paths[0], content: '# Implementation handoff\n\nActual independent product-check results are pending.\n' })] : []),
      ...(options.registrationEvidence ? [call('task_file_write', { path: plan.procedure_candidate.script,
        content: "let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{const packet=JSON.parse(input);require('node:fs').writeFileSync(packet.outputs[0],'1\\n');});\n" })] : []),
      ...(options.holdImplementation && attempt === 1 ? [async ({ token }) => {
        held.entered = true;
        while (!token.isCancellationRequested && !held.release) await delay(10);
        return held.release ? new Call('fixture-held-resume', 'project_read', { path: output })
          : new Text('Canceled deterministic model fixture.');
      }] : []), report({ artifacts: [output] })];
  }
  if (stage === 'verification') {
    const wrongChecker = options.checkerFailure && attempt === 1;
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(`${name}/verify/child.json`)},JSON.stringify({pid:process.pid,created_at:new Date(performance.timeOrigin).toISOString()}));setInterval(()=>{},1000);`;
    const content = options.slowChecker && attempt === (options.orphanHistory ? 2 : 1)
      ? `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(`${name}/verify/running.json`)},JSON.stringify({pid:process.pid,created_at:new Date(performance.timeOrigin).toISOString(),child:child.pid}));console.log('owned long checker started');setInterval(()=>{},1000);\n`
      : options.readOnlyBaseline ? "const run=require('node:child_process').spawnSync(process.execPath,['scripts/verify-leetcode-exercise.mjs',process.argv[2]],{encoding:'utf8'});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exit(run.status??2);\n"
      : options.unsafeChecker ? "require('node:fs').writeFileSync(require('node:path').join(__dirname,'../../escape.txt'),'outside assigned scope');\n"
      : options.exitZeroChecker ? 'process.exit(0);\n'
      : `const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(Number(fs.readFileSync(process.argv[2],'utf8')),${wrongChecker ? 2 : 1}); console.log('scalar validated');\n`;
    const defect = wrongChecker || options.productFailure && attempt === 1;
    return [call('project_read', { path: output }), call('project_read', { path: checker }), call('task_file_write', { path: checker, content }),
      ...(options.evidenceReport ? [call('project_read', { path: plan.checks[1].command[1] }),
        call('task_file_write', { path: plan.checks[1].command[1], content: "const assert=require('node:assert/strict');const text=require('node:fs').readFileSync(process.argv[2],'utf8');assert.match(text,/# Actual product checkpoint/);assert.match(text,/Positive exit: 0/);assert.match(text,/Negative exit: 1/);assert.match(text,/Command: /);console.log('actual report checkpoint checked');\n" }),
        call('project_read', { path: plan.checks[1].negative_controls[0].command[2] }),
        call('task_file_write', { path: plan.checks[1].negative_controls[0].command[2], content: '# Invented success\nNo actual command or exit evidence is recorded.\n' })] : []),
      call('project_read', { path: bad }), call('task_file_write', { path: bad, content: '2\n' }), call('check_run', {}),
      ...(options.reviewScope && attempt > 1 ? [async ({ token, messages }) => {
        held.postCheckEvidence = semanticToolValue(messages); held.postChecksEntered = true;
        while (!token.isCancellationRequested && !held.postChecksRelease) await delay(10);
        return new Text('Actual diagnostic check checkpoint; no product acceptance is claimed.');
      }] : []),
      report({ outcome: defect ? 'failed' : 'completed', verdict: defect ? 'fail' : 'pass', artifacts: [output, checker, bad],
        negative_controls: ['The prescribed incorrect scalar fixture must exit one.'],
        ...(defect ? { failure_kind: wrongChecker ? 'checker' : 'implementation' } : {}) })];
  }
  if (stage === 'review') {
    if (options.observationLoop && (attempt === 1 || options.repeatObservationLoop)) return [
      call('project_read', { path: output }), call('project_read', { path: checker }),
      report({ outcome: 'blocked', summary: 'Review evidence inspection is incomplete; the final independent verdict is pending.',
        findings: ['A partial professional result is retained before the repeated evidence reads.'] }),
      call('check_evidence', { title: plan.checks[0].title }), call('check_evidence', { title: 'Reject incorrect scalar' }),
      call('check_evidence', { title: plan.checks[0].title }), call('check_evidence', { title: 'Reject incorrect scalar' }),
      call('check_evidence', { title: plan.checks[0].title }),
    ];
    const scopeReview = options.reviewScope || options.unsafeChecker;
    const result = report({ verdict: options.unsafeChecker || options.orphanHistory && attempt === 1 ? 'fail' : 'pass', artifacts: [output, checker, bad],
      ...(options.orphanHistory && attempt === 1 ? { failure_kind: 'checker', findings: ['A separate current verification attempt is required before final acceptance.'] } : {}),
      ...(options.unsafeChecker ? { failure_kind: 'checker', findings: ['Checker writes escape.txt outside its assigned/disposable execution scope; do not execute it.'] }
        : options.reviewScope ? { findings: ['The product scalar is two; the sound independent checker will safely diagnose that product defect by rejecting it.'],
          limitations: ['Pre-execution checker readiness is separate from product acceptance; no execution evidence exists yet.'] } : {}) });
    return [call('project_read', { path: output }), call('project_read', { path: checker }),
      ...(options.registrationEvidence ? [call('check_evidence', { kind: 'registration' }), async ({ messages }) => {
        held.registrationEvidence = semanticToolValue(messages); return new Call('fixture-registration-read', 'project_read', { path: output });
      }] : []),
      ...(scopeReview || options.holdFinalReview ? [call('check_evidence', {})] : []),
      ...(options.reviewScope || options.holdFinalReview ? [async ({ token, messages }) => {
        held.reviewEvidence = semanticToolValue(messages); held.reviewEntered = true;
        while (!token.isCancellationRequested && !held.reviewRelease) await delay(10);
        return held.reviewRelease ? new Call('fixture-review-result', result.name, result.input) : new Text('Canceled held review fixture.');
      }] : [result]),
      ...(options.finalizationExternalEdit ? [async () => {
        atomicWrite(safePath(held.root, output), 'External user content after review\n');
        return new Text('Review response ended; a concurrent outside edit must remain preserved.');
      }] : [])];
  }
  if (stage === 'diagnosis') return [call('project_read', { path: checker }), report({ failure_kind: 'checker' })];
  throw new Error(`Unexpected fixture stage ${stage}`);
}

async function setup(t, scenarios, existingRoot) {
  // The owner canonicalizes native roots; direct private callback lookup must use
  // that same identity when Windows TEMP is exposed through an 8.3 alias.
  const parent = realpathSync.native(tmpdir()), root = existingRoot ? realpathSync.native(existingRoot) : realpathSync.native(mkdtempSync(join(parent, 'neomind-controlled-flow-')));
  if (!existingRoot) initialize(root, { project_id: 'CONTROLLED', name: 'Controlled Bridge fixture', platforms: ['codex', 'copilot'], max_workers: 3, repair_attempts: 1 });
  if (Object.values(scenarios).some(options => options.readOnlyBaseline)) {
    atomicWrite(safePath(root, 'scripts/verify-leetcode-exercise.mjs'), "import {readFileSync} from 'node:fs';const expected=JSON.parse(readFileSync('.agents/skills/helpers/assets/oracle.json','utf8')).expected;const value=Number(readFileSync(process.argv[2],'utf8'));console.log('readonly delegate observed scalar: '+value);process.exit(value===expected?0:1);\n");
    atomicWrite(safePath(root, '.agents/skills/helpers/assets/oracle.json'), '{"expected":1}\n');
  }
  if (Object.values(scenarios).some(options => options.privateBaselineDirectory))
    atomicWrite(safePath(root, 'scripts/.env'), 'PRIVATE_BASELINE_CANARY=must-not-be-captured\n');
  if (Object.values(scenarios).some(options => options.conflictingReadInput))
    atomicWrite(safePath(root, '.github/skills/helpers/assets/oracle.json'), '{"expected":1}\n');
  for (const [name, options] of Object.entries(scenarios)) if (options.preparedCornell) {
    atomicWrite(safePath(root, `prepared/${name}.json`), `${JSON.stringify(options.preparedResearch, null, 2)}\n`);
    atomicWrite(safePath(root, `${name}/reference.md`), '# Finite ordered pairs\nThree letters and two digits produce six ordered pairs.\n');
    atomicWrite(safePath(root, '.agents/skills/native-cornell/assets/template.md'), '# Existing read-only research template\n');
  }
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: [...policy.worker_models, 'next-worker'].map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const conversations = new WeakMap(), counts = new Map(), observed = [], errors = [], held = { entered: false, root };
  const api = {
    version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (messages, options, token) => {
      assertSemanticSchemas(options.tools);
      let conversation = conversations.get(messages);
      if (!conversation) {
        const text = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const name = /Scenario: ([a-z0-9-]+)/.exec(text)?.[1], stage = /Your stage: (planning|implementation|verification|review|diagnosis)/.exec(text)?.[1];
        assert.ok(name && stage, 'controller must provide meaningful stage/request context');
        const key = `${name}:${stage}`, attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
        conversation = { name, stage, attempt, actions: scriptFor(name, stage, attempt, scenarios[name] ?? {}, held), round: 0 };
        conversations.set(messages, conversation);
        observed.push({ name, stage, attempt, tools: options.tools.map(tool => tool.name),
          ...(scenarios[name]?.preparedCornell && stage === 'implementation'
            ? { compilerSchema: options.tools.find(tool => tool.name === 'cornell_research_compile').inputSchema } : {}),
          promptLayers: messages.filter(message => typeof message.content === 'string').map(message => message.content) });
      }
      const prior = lastToolResult(messages);
      if (prior?.isError) {
        errors.push({ name: conversation.name, stage: conversation.stage, round: conversation.round, result: prior });
        throw new Error('Deterministic fixture encountered a failed semantic MCP call.');
      }
      const action = conversation.actions[conversation.round++];
      let part = action ? typeof action === 'function' ? await action({ token, messages })
        : new Call(`fixture-call-${conversation.round}`, action.name, action.input) : new Text('Typed result persisted; deterministic fixture session complete.');
      return { stream: (async function* () { yield part; })() };
    } }] },
  };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, observed, errors, held, closeOwner: () => owner.close(), closeBridge: () => bridge.close(), restart: async () => {
    await owner.close(); await shutdownNative(root); await bridge.close();
    bridge = await enableVSCodeHost(api, root); owner = await startControlledHost(root);
  } };
}

// A separate real owner creates signed producer/interrupted-Verifier receipts.
// A targeted I/O failure leaves an actual unknown command intent; no signature or
// receipt ownership is fabricated, and the creating owner then genuinely exits.
if (process.env.NEOMIND_TEST_ORPHAN_OWNER === '1') {
  const env = await setup({ after() {} }, { orphaned: { slowChecker: true, highRisk: true, orphanHistory: true } });
  const initial = await startControlledWorkflow(env.root, { requirement: 'Scenario: orphaned\nCreate and independently verify the requested scalar.', request_id: 'fixture-orphaned' }), marker = safePath(env.root, 'orphaned/verify/running.json'), childMarker = safePath(env.root, 'orphaned/verify/child.json');
  await until(env.root, initial.workflow_id, () => existsSync(marker) && existsSync(childMarker), 'fixture checker tree should start', env.errors);
  const parentIdentity = JSON.parse(readFileSync(marker, 'utf8')), childIdentity = JSON.parse(readFileSync(childMarker, 'utf8'));
  const write = fs.writeFileSync;
  fs.writeFileSync = function (path, ...args) {
    if (typeof path === 'string' && /\/\.neomind\/controlled\/checks\/[^/]+\.log\.[^/]+\.tmp$/.test(path.replaceAll('\\', '/')))
      throw Object.assign(new Error('Injected check-log persistence failure.'), { code: 'EIO' });
    return write.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { await env.closeOwner(); }
  finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  await shutdownNative(env.root); await env.closeBridge();
  process.stdout.write(`${JSON.stringify({ root: env.root, workflow_id: initial.workflow_id,
    process_identities: [{ pid: parentIdentity.pid, created_at: parentIdentity.created_at, role: 'check-root' },
      { pid: childIdentity.pid, created_at: childIdentity.created_at, role: 'descendant' }] })}\n`);
  process.exit(0);
}
async function until(root, workflow, predicate, message, errors = []) {
  const deadline = Date.now() + (process.platform === 'win32' ? 180000 : 60000);
  let snapshot;
  do {
    snapshot = controlledStatus(root, workflow);
    if (predicate(snapshot)) return snapshot;
    if (snapshot.status === 'blocked') assert.fail(`${message}: ${JSON.stringify({ blocker: snapshot.blocker, phase: snapshot.phase,
      attempts: snapshot.attempts.map(attempt => ({ stage: attempt.stage, state: attempt.state, outcome: attempt.report?.outcome })),
      checks: snapshot.checks.map(check => ({ title: check.title, passed: check.passed, exit_code: check.exit_code })), events: snapshot.events.slice(-5), errors })}`);
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify({ status: snapshot.status, phase: snapshot.phase, errors })}`);
}
const submit = (root, name) => startControlledWorkflow(root, { requirement: `Scenario: ${name}\nCreate and independently verify the requested scalar.`, request_id: `fixture-${name}` });
async function submitContinuation(root, name) {
  const workflow = beginWorkflow(root, { requirement: `Scenario: ${name}\nCreate and independently verify the requested scalar.`, execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: `legacy-${name}`, objective: 'Freeze the original scalar contract before its controlled continuation.' });
  const handle = openAssignment(root, packet.open_input).handle;
  const { risk, checks, ...plan } = planFor(name);
  planNativeSoftware(root, handle, { ...plan, process: 'software-tools', checks: checks.map(({ negative_controls, ...check }) => check) });
  return startControlledWorkflow(root, { workflow_id: workflow.meta.id });
}

function countRecordReads(root, action) {
  const original = fs.readFileSync, prefix = safePath(root, '.neomind/records').replaceAll('\\', '/').toLowerCase() + '/', seen = new Map();
  fs.readFileSync = function (path, ...args) {
    if (typeof path === 'string' && path.replaceAll('\\', '/').toLowerCase().startsWith(prefix)) seen.set(path, (seen.get(path) ?? 0) + 1);
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: action(), reads: [...seen.values()].reduce((a, b) => a + b, 0), maximum: Math.max(0, ...seen.values()) }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

test('controlled execution mode is explicit and distinct from unsigned native modes', () => {
  assert.ok(executionModes.includes('neomind-controlled'));
});

test('a final acceptance mismatch preserves external edits and reports a typed gate without closing or charging product repair', async t => {
  const name = 'finalexternal', env = await setup(t, { [name]: { highRisk: true, finalizationExternalEdit: true } });
  const initial = await startControlledWorkflow(env.root, { requirement: `Scenario: ${name}\nCreate the scalar and independently check and review it.`, request_id: 'final-external-edit' });
  const deadline = Date.now() + (process.platform === 'win32' ? 180000 : 60000);
  let stopped;
  while (Date.now() < deadline) {
    stopped = controlledStatus(env.root, initial.workflow_id);
    if (stopped.status === 'blocked') break;
    await delay(25);
  }
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.blocker.code, 'ACCEPTANCE_INCOMPLETE');
  assert.ok(stopped.blocker.findings.length > 0); assert.match(stopped.blocker.message, /baseline|changed|artifact|output/i);
  assert.equal(JSON.parse(readFileSync(safePath(env.root, `.neomind/controlled/traces/${stopped.blocker.trace_id}.json`), 'utf8')).event, 'acceptance-failure');
  assert.equal(stopped.final_report_id, undefined); assert.equal(stopped.repair_budget.product, 0);
  assert.equal(stopped.pending_artifact_repair, undefined); assert.deepEqual(env.errors, []);
  assert.equal(readFileSync(safePath(env.root, `${name}/src/value.txt`), 'utf8'), 'External user content after review\n');
  const parent = getRecord(env.root, initial.workflow_id);
  assert.notEqual(parent.meta.status, 'accepted'); assert.equal(parent.meta.data.final_report_id ?? null, null);
});

test('bound native Cornell plan consumes its exact prepared source through empty MCP input and closes after real independent checks', async t => {
  const name = 'preparedcornell', seed = researchFixture(t).input;
  const { schema_version, requirement_id, expected_requirement_revision, workflow_id, task_id, owner, output_dir, ...professional } = seed;
  professional.sources = [{ id: 'S1', title: 'Actual finite ordered-pair source', uri: `${name}/reference.md` }];
  professional.practice = { ...professional.practice }; delete professional.practice.solution_path; delete professional.practice.starter;
  professional.explanations[0].body = '[inferred] Three letters and two digits yield six ordered pairs [S1].\n\n```json\n{"stdout":"six ordered pairs\\n"}\n```\n\nThe Markdown line breaks remain real text [S1].';
  const env = await setup(t, { [name]: { preparedCornell: true, preparedResearch: professional } });
  const prepared = `prepared/${name}.json`, sourceBytes = readFileSync(safePath(env.root, prepared)), sourceHash = hash(sourceBytes);
  const initial = await startControlledWorkflow(env.root, { requirement: `Scenario: ${name}\nCompile the existing prepared professional JSON source into a Cornell note, separate exercises and answers, then independently verify and review the result.`, request_id: 'prepared-native-cornell' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'native Cornell metadata must be bound by the backend and complete without model-owned payload copying', env.errors);
  assert.deepEqual(env.errors, []);
  assert.deepEqual(env.observed.map(item => item.stage), ['planning', 'implementation', 'verification', 'review']);
  const sealed = JSON.parse(readFileSync(safePath(env.root,
    `.neomind/controlled/workflows/${hash(initial.workflow_id)}.${done.epoch_id}.contract.json`), 'utf8'));
  const task = getRecord(env.root, sealed.task_id), { contract } = controlledContractForTask(env.root, task);
  assert.equal(contract.plan.cornell_input_path, prepared); assert.deepEqual(contract.plan.execution_steps, []);
  assert.equal(contract.preserved_hashes[prepared], sourceHash);
  assert.ok(contract.plan.input_paths.includes('.agents/skills/native-cornell/assets/template.md'));
  assert.deepEqual(contract.plan.outputs, ['note.md', 'exercises.md', 'answers.md'].map(path => `${name}/notes/${path}`));
  assert.ok(!env.observed.find(item => item.stage === 'implementation').tools.includes('task_run'));
  const compilerSchema = env.observed.find(item => item.stage === 'implementation').compilerSchema;
  assert.deepEqual(Object.keys(compilerSchema.properties), ['input_path']);
  assert.ok(!compilerSchema.required?.length); assert.equal(compilerSchema.additionalProperties, false);
  assert.deepEqual(readFileSync(safePath(env.root, prepared)), sourceBytes);
  assert.equal(done.cornell_note_ids.length, 1); assert.equal(done.cornell_results.length, 1, 'The second empty compiler call reuses its exact owned generation result.');
  const generated = done.cornell_results[0];
  assert.deepEqual(generated.payload_source, { path: prepared, sha256: sourceHash, size_bytes: sourceBytes.length });
  const note = getRecord(env.root, generated.note_id);
  assert.equal(note.meta.data.demonstration.observed, undefined);
  assert.deepEqual(note.meta.data.demonstration.evidence_ids, []);
  assert.ok(readFileSync(safePath(env.root, note.meta.data.artifact_path), 'utf8').includes(professional.explanations[0].body));
  assert.deepEqual(done.checks.map(check => [check.negative, check.exit_code, check.passed]), [[false, 0, true], [true, 1, true]]);
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
  for (const attempt of done.attempts) {
    const signed = readInvocation(env.root, attempt.invocation_id);
    assert.equal(signed.issuer, 'neomind-vscode-lm'); assert.equal(signed.inference_completed, true);
  }
  const statePath = safePath(env.root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.json`), before = readFileSync(statePath);
  for (const mutate of [
    proof => { delete proof.payload_source; },
    proof => { proof.payload_source.sha256 = 'f'.repeat(64); },
    proof => { proof.payload_source.path = 'prepared/another-source.json'; },
  ]) {
    const changed = JSON.parse(before.toString('utf8')); mutate(changed.cornell_results[0]);
    try {
      atomicWrite(statePath, `${JSON.stringify(changed, null, 2)}\n`);
      const invalid = verify(env.root, task.meta.id, 'accepted');
      assert.equal(invalid.ok, false, 'The primary bundle must not lose or substitute its frozen prepared-source consumption proof.');
      assert.ok(invalid.findings.some(finding => /consume its immutable prepared research source/.test(finding.message)));
    } finally { atomicWrite(statePath, before); }
  }
  assert.equal(verifyControlledTask(env.root, getRecord(env.root, task.meta.id), 'accepted').ok, true);
});

test('backend schedules a report-only post-check pass then fresh full independent verification before acceptance', async t => {
  const env = await setup(t, { factualreport: { highRisk: true, evidenceReport: true } });
  const initial = await submit(env.root, 'factualreport');
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'a deferred final report must use real product evidence without a failed-review repair loop', env.errors);
  assert.equal(done.attempts.filter(item => item.purpose === 'evidence-documentation').length, 1);
  assert.equal(done.attempts.filter(item => item.stage === 'verification').length, 2);
  assert.equal(done.checks.length, 6, 'Two product receipts first, then all four required final receipts.');
  assert.equal(done.repair_budget?.product ?? 0, 0);
  assert.ok(done.checks.every(check => check.passed));
  const documentation = done.attempts.find(item => item.purpose === 'evidence-documentation');
  assert.ok(documentation.documentation_source);
  const prompts = env.observed.find(item => item.stage === 'implementation' && item.attempt === 2);
  assert.ok(prompts.promptLayers.every(text => /evidence-documentation|post-verification documentation purpose/i.test(text)));
  assert.ok(!prompts.tools.includes('task_run')); assert.ok(!prompts.tools.includes('cornell_research_compile'));
  const check = verify(env.root, done.task_id, 'accepted');
  assert.equal(check.ok, true, JSON.stringify(check.findings));
});

test('both real Bridge prompt layers scope readiness to safe checker execution before any diagnostic evidence exists', async t => {
  const env = await setup(t, { readiness: { reviewScope: true, precheckProductFailure: true } });
  const initial = await submitContinuation(env.root, 'readiness');
  const preparing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'the frozen continuation must request independent checker readiness', env.errors);
  assert.equal(preparing.attempts.at(-1).purpose, 'check-review');
  assert.equal(preparing.checks.length, 0);
  assert.deepEqual(env.held.reviewEvidence, []);
  const prompts = env.observed.find(item => item.name === 'readiness' && item.stage === 'review').promptLayers;
  assert.equal(prompts.length, 2, 'Inspect both bound role instructions and the controller request actually delivered to the Bridge.');
  for (const prompt of prompts) {
    assert.match(prompt, /Review purpose: checker-readiness/);
    assert.match(prompt, /negative controls/);
    assert.match(prompt, /safe bounded execution/);
    assert.match(prompt, /not-yet-run evidence is expected/);
    assert.doesNotMatch(prompt, /Independently inspect the delivered artifacts and actual verification evidence|Review the actual change, acceptance criteria and current checks independently/);
  }
  env.held.reviewRelease = true;
  const diagnosed = await until(env.root, initial.workflow_id, () => env.held.postChecksEntered,
    'approved checker readiness must permit actual diagnostic execution', env.errors);
  assert.ok(diagnosed.attempts.some(attempt => attempt.purpose === 'check-review' && attempt.report?.verdict === 'pass'));
  assert.ok(diagnosed.checks.some(check => !check.negative && !check.passed), 'Actual checks diagnose the deliberately incorrect product.');
  assert.ok(diagnosed.checks.some(check => check.negative && check.passed));
  assert.notEqual(diagnosed.status, 'completed');
  assert.equal(diagnosed.final_report_id, undefined);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === diagnosed.epoch_id);
  assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, false, 'Readiness approval cannot substitute for independent passing checks and final review.');
});

test('unsafe checker readiness can still fail without executing any prescribed command', async t => {
  const env = await setup(t, { unsafe: { unsafeChecker: true } });
  const initial = await submitContinuation(env.root, 'unsafe');
  const blocked = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'an unsafe checker must retain the pre-execution gate', env.errors);
  assert.equal(blocked.checks.length, 0);
  assert.ok(blocked.attempts.filter(attempt => attempt.purpose === 'check-review').every(attempt =>
    attempt.report?.verdict === 'fail' && attempt.report.failure_kind === 'checker'));
  assert.ok(blocked.attempts.some(attempt => attempt.purpose === 'check-review'));
  assert.equal(existsSync(safePath(env.root, 'escape.txt')), false, 'The scope-escaping checker was never executed.');
  assert.equal(blocked.final_report_id, undefined);
});

test('final-product review still requires fresh execution evidence and cannot accept a missing-evidence journal', async t => {
  const env = await setup(t, { finalscope: { highRisk: true, holdFinalReview: true } });
  const initial = await submit(env.root, 'finalscope');
  const reviewing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'risk-based final review must follow actual passing verification', env.errors);
  assert.ok(reviewing.checks.length >= 2);
  assert.ok(env.held.reviewEvidence.length >= 2);
  const prompts = env.observed.find(item => item.name === 'finalscope' && item.stage === 'review').promptLayers;
  for (const prompt of prompts) {
    assert.match(prompt, /Review purpose: final-product/);
    assert.match(prompt, /fresh positive and negative execution evidence/);
    assert.match(prompt, /intended-use/);
    assert.match(prompt, /Cornell/);
    assert.doesNotMatch(prompt, /not-yet-run evidence is expected/);
  }
  const path = safePath(env.root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.json`);
  const missing = JSON.parse(readFileSync(path, 'utf8')); missing.checks = [];
  atomicWrite(path, JSON.stringify(missing));
  env.held.reviewRelease = true;
  const blocked = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'a final pass report cannot override lost current check evidence', env.errors);
  assert.equal(blocked.attempts.at(-1).report.verdict, 'pass');
  assert.equal(blocked.final_report_id, undefined);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === blocked.epoch_id);
  assert.notEqual(task.meta.status, 'accepted');
  const validation = verifyControlledTask(env.root, task, 'accepted');
  assert.equal(validation.ok, false);
  assert.ok(validation.findings.some(finding => /execution evidence is missing/.test(finding.message)));
});

test('actual final Reviewer receives only latest Verifier evidence while identical-title failure history remains saved', async t => {
  const env = await setup(t, { evidenceview: { highRisk: true, productFailure: true, holdFinalReview: true } });
  const initial = await submit(env.root, 'evidenceview');
  const reviewing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'final review must observe the separately repaired current verification', env.errors);
  assert.equal(reviewing.checks.length, 4);
  assert.ok(reviewing.checks.some(check => !check.passed), 'The earlier genuine product failure must remain in the journal.');
  assert.equal(env.held.reviewEvidence.length, 2, 'Current evidence must not mix earlier receipts with identical check titles.');
  assert.ok(env.held.reviewEvidence.every(check => check.passed));
  env.held.reviewRelease = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'a sound current review can close without deleting old failed observations', env.errors);
  assert.equal(done.checks.length, 4);
});

test('actual final Reviewer receives the registered bound candidate through the existing signed Bridge tool set', async t => {
  const env = await setup(t, { registrationview: { highRisk: true, holdFinalReview: true, registrationEvidence: true } });
  const initial = await submit(env.root, 'registrationview');
  const reviewing = await until(env.root, initial.workflow_id, () => env.held.reviewEntered,
    'final Reviewer must receive actual registry provenance after checks and registration', env.errors);
  const evidence = env.held.registrationEvidence;
  assert.equal(evidence.registered, true); assert.equal(evidence.id, reviewing.procedure_candidate_id);
  assert.equal(evidence.version, reviewing.procedure_candidate_version); assert.equal(evidence.status, 'candidate');
  assert.equal(evidence.current_code_matches, true); assert.equal(evidence.author_matches_latest_producer, true);
  assert.ok(reviewing.checks.every(check => check.passed)); assert.equal(reviewing.final_report_id, undefined);
  const review = env.observed.find(item => item.name === 'registrationview' && item.stage === 'review');
  assert.equal(review.tools.includes('procedure_registration'), false, 'Existing signed tool names must remain stable.');
  for (const prompt of review.promptLayers) assert.match(prompt, /check_evidence\(\{kind:\"registration\"\}\)/);
  const snapshotPrompt = review.promptLayers.find(prompt => prompt.includes('Current backend registry observation:'));
  assert.ok(snapshotPrompt); assert.ok(snapshotPrompt.includes(evidence.contract_hash)); assert.ok(snapshotPrompt.includes(evidence.created_at));
  env.held.reviewRelease = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'actual registration evidence must remain distinct from required independent review and closure', env.errors);
  assert.equal(done.procedure_candidate_id, evidence.id);
});

test('real signed Bridge/MCP drives normal and risk-based workflows with actual command evidence', async t => {
  const env = await setup(t, { ordinary: {}, sensitive: { highRisk: true } });
  for (const name of ['ordinary', 'sensitive']) {
    const initial = await submit(env.root, name);
    assert.ok(initial.workflow_id); assert.equal(initial.process_contract, 'software-tools/v2');
    const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'workflow should complete', env.errors);
    assert.deepEqual(done.attempts.map(attempt => attempt.stage), name === 'ordinary'
      ? ['planning', 'implementation', 'verification'] : ['planning', 'implementation', 'verification', 'review']);
    assert.equal(new Set(done.attempts.map(attempt => attempt.invocation_id)).size, done.attempts.length);
    for (const attempt of done.attempts) {
      const receipt = readInvocation(env.root, attempt.invocation_id);
      assert.equal(receipt.issuer, 'neomind-vscode-lm'); assert.equal(receipt.inference_completed, true);
      assert.ok(!receipt.native_tool_scope.some(name => ['assignment_open', 'assignment_progress', 'record_update'].includes(name)));
    }
    assert.ok(done.checks.length >= 2, 'actual positive and negative command receipts are required');
    assert.ok(done.checks.every(check => check.passed));
    assert.ok(done.checks.some(check => check.exit_code === 1), 'negative control must execute and reject the bad fixture');
    for (const check of done.checks) assert.equal(hash(readFileSync(join(env.root, check.log_path))), check.log_sha256);
    assert.equal(getRecord(env.root, done.workflow_id).meta.data.phase, 'completed');
    assert.equal(getRecord(env.root, done.final_report_id).meta.data.assurance, 'invocation-bound-local');
    const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === done.workflow_id && record.meta.data.epoch_id === done.epoch_id);
    assert.ok(task, 'The completed epoch needs its own bound execution task.');
    assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true, 'Public task verification must agree with controller acceptance.');
    for (const check of done.checks) {
      const evidence = getRecord(env.root, check.evidence_id);
      assert.equal(evidence.meta.type, 'evidence');
      assert.equal(evidence.meta.data.kind, 'controlled-execution-evidence');
      assert.equal(evidence.meta.data.workflow_id, done.workflow_id);
      assert.equal(evidence.meta.data.controlled_epoch_id, done.epoch_id);
      assert.equal(evidence.meta.data.task_id, task.meta.id);
      assert.equal(evidence.meta.data.execution_invocation_id, check.invocation_id);
      assert.equal(evidence.meta.data.controlled_check_id, check.id);
      assert.ok(evidence.meta.links.some(link => link.type === 'evidence-for' && link.target === check.evidence_input.check_id));
    }
    const output = safePath(env.root, planFor(name).outputs[0]), prior = readFileSync(output);
    try {
      atomicWrite(output, '2\n');
      const stale = verify(env.root, task.meta.id, 'accepted');
      assert.equal(stale.ok, false, 'An accepted flag cannot preserve evidence against changed implementation bytes.');
      assert.ok(stale.findings.some(finding => finding.code === 'controlled-acceptance'));
    } finally { atomicWrite(output, prior); }
    assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true, 'Restoring the exact bound bytes restores current acceptance.');
    const journalPath = safePath(env.root, `.neomind/controlled/workflows/${hash(done.workflow_id)}.json`), journalBytes = readFileSync(journalPath);
    const unresolved = [
      ['producer after Verifier', journal => {
        const producer = journal.attempts.find(attempt => attempt.stage === 'implementation');
        journal.attempts = [...journal.attempts.filter(attempt => attempt !== producer), producer];
      }],
      ...['starting', 'running'].map(state => [`unfinished ${state} invocation`, journal => {
        journal.attempts.push({ id: 'unresolved-attempt', request_id: 'unresolved-request', stage: 'implementation', role: 'developer', state });
      }]),
      ['unresolved command intent', journal => {
        journal.check_intents ??= [];
        journal.check_intents.push({ id: 'unresolved-check', attempt_id: journal.attempts.find(attempt => attempt.stage === 'verification').id,
          title: 'Unreconciled command', baseline: {}, state: 'running', pid: process.pid });
      }],
    ];
    for (const [reason, change] of unresolved) {
      try {
        const journal = JSON.parse(journalBytes.toString('utf8')); change(journal);
        atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
        const rejected = verify(env.root, task.meta.id, 'accepted');
        assert.equal(rejected.ok, false, `Genuine completed receipts cannot override ${reason}.`);
        assert.ok(rejected.findings.some(finding => finding.code === 'controlled-acceptance'));
      } finally { atomicWrite(journalPath, journalBytes); }
    }
    assert.deepEqual(readFileSync(journalPath), journalBytes);
    assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true, 'Exact journal restoration recovers the valid signed execution.');
    const repeated = await submit(env.root, name);
    assert.equal(repeated.workflow_id, done.workflow_id); assert.equal(repeated.attempts.length, done.attempts.length);
  }
  assert.equal(env.errors.length, 0);
});

test('a successful observation loop reconciles once through a fresh real Reviewer without waiving its gate', async t => {
  const env = await setup(t, { 'observation-recovery': { highRisk: true, observationLoop: true } });
  const initial = await submit(env.root, 'observation-recovery');
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'the existing one-shot protocol recovery must allow a fresh independent Reviewer to finish', env.errors);
  assert.deepEqual(done.attempts.map(attempt => attempt.stage), ['planning', 'implementation', 'verification', 'review', 'review']);
  assert.deepEqual(done.repair_budget, { schema_version: 1, product: 0, protocol: 1, environment: 0 });
  assert.equal(done.repairs, 0);
  const reviews = done.attempts.filter(attempt => attempt.stage === 'review');
  assert.notEqual(reviews[0].invocation_id, reviews[1].invocation_id);
  assert.equal(reviews[0].report.outcome, 'blocked'); assert.equal(reviews[0].report.verdict, undefined);
  assert.match(getRecord(env.root, reviews[0].report_id).body, /partial professional result/i);
  const interrupted = readInvocation(env.root, reviews[0].invocation_id), completed = readInvocation(env.root, reviews[1].invocation_id);
  assert.equal(interrupted.issuer, 'neomind-vscode-lm'); assert.equal(interrupted.inference_completed, false);
  assert.match(interrupted.error, /^CONTROLLED_OBSERVATION_LOOP:/);
  assert.match(interrupted.error, /Validate scalar policy observation/, 'Professional selector text cannot convert trusted protocol recovery into a hard policy failure.');
  assert.equal(completed.issuer, 'neomind-vscode-lm'); assert.equal(completed.inference_completed, true);
  assert.equal(reviews[1].report.verdict, 'pass');
  const repair = done.events.filter(event => event.kind === 'repair');
  assert.equal(repair.length, 1); assert.equal(repair[0].summary, 'Backend routes protocol to review.');
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === done.epoch_id);
  const authority = controlledContractForTask(env.root, task);
  assert.equal(authority.contract.reviewer_required, true);
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
  assert.equal(readFileSync(safePath(env.root, 'observation-recovery/src/value.txt'), 'utf8'), '1\n');
  assert.equal(env.errors.length, 0);
});

test('repeated successful observation loops cannot reset or exceed the existing protocol recovery allowance', async t => {
  const env = await setup(t, { 'observation-exhaustion': { highRisk: true, observationLoop: true, repeatObservationLoop: true } });
  const initial = await submit(env.root, 'observation-exhaustion');
  const stopped = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'a second refused professional result must stop within the unchanged recovery allowance', env.errors);
  assert.equal(stopped.phase, 'review'); assert.equal(stopped.blocker.kind, 'protocol');
  assert.match(stopped.blocker.message, /^Protocol reconciliation budget exhausted\./);
  assert.deepEqual(stopped.repair_budget, { schema_version: 1, product: 0, protocol: 1, environment: 0 });
  assert.equal(stopped.repairs, 0); assert.equal(stopped.final_report_id, undefined);
  const reviews = stopped.attempts.filter(attempt => attempt.stage === 'review');
  assert.equal(reviews.length, 2); assert.notEqual(reviews[0].invocation_id, reviews[1].invocation_id);
  assert.ok(reviews.every(attempt => attempt.report.outcome === 'blocked' && attempt.report.verdict === undefined));
  assert.ok(reviews.every(attempt => readInvocation(env.root, attempt.invocation_id).error.startsWith('CONTROLLED_OBSERVATION_LOOP:')));
  assert.equal(stopped.events.filter(event => event.kind === 'repair').length, 1);
  assert.equal(readFileSync(safePath(env.root, 'observation-exhaustion/src/value.txt'), 'utf8'), '1\n');
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === stopped.epoch_id);
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, false, 'Repeated reads never substitute for the required review.');
  assert.equal(env.errors.length, 0);
});

test('product and checker defects route repairs to the correct bounded stage', async t => {
  const env = await setup(t, { product: { productFailure: true }, checker: { checkerFailure: true } });
  for (const name of ['product', 'checker']) {
    const initial = await submit(env.root, name);
    const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'repair should complete', env.errors);
    assert.equal(done.repairs, 1);
    assert.deepEqual(done.attempts.map(attempt => attempt.stage), name === 'product'
      ? ['planning', 'implementation', 'verification', 'implementation', 'verification']
      : ['planning', 'implementation', 'verification', 'verification']);
    assert.ok(done.checks.some(check => !check.passed));
    const lastVerifier = done.attempts.filter(attempt => attempt.stage === 'verification').at(-1);
    assert.ok(done.checks.filter(check => check.attempt_id === lastVerifier.id).every(check => check.passed));
  }
  assert.equal(env.errors.length, 0);
});

test('prose claims and an always-exit-zero checker cannot close a controlled workflow', async t => {
  const env = await setup(t, { falseproof: { exitZeroChecker: true } });
  const initial = await submit(env.root, 'falseproof');
  const done = await until(env.root, initial.workflow_id, run => ['blocked', 'uncertain'].includes(run.status), 'false evidence must be rejected', env.errors);
  assert.notEqual(done.status, 'completed'); assert.equal(done.final_report_id, undefined);
  assert.ok(done.checks.some(check => !check.passed));
  assert.notEqual(getRecord(env.root, initial.workflow_id).meta.data.phase, 'completed');
});

test('pause and owner restart retain checkpoint artifacts and resume the same workflow', async t => {
  const env = await setup(t, { resumed: { holdImplementation: true } });
  const initial = await submit(env.root, 'resumed');
  await until(env.root, initial.workflow_id, () => env.held.entered, 'implementation should reach the controlled pause point', env.errors);
  const paused = await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'pause' });
  assert.equal(paused.status, 'paused');
  assert.equal(readFileSync(join(env.root, 'resumed/src/value.txt'), 'utf8'), '1\n');
  assert.equal(paused.final_report_id, undefined);
  await env.restart();
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'checkpoint should resume', env.errors);
  assert.equal(done.workflow_id, initial.workflow_id);
  assert.equal(done.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.ok(done.attempts.some(attempt => attempt.state === 'interrupted'));
  assert.equal(loadRecords(env.root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
});

test('owner close waits for actual checker-tree cancellation and durable failed evidence before returning, then resumes the same workflow', async t => {
  const env = await setup(t, { closingchecker: { slowChecker: true } });
  const initial = await submit(env.root, 'closingchecker'), marker = safePath(env.root, 'closingchecker/verify/running.json');
  await until(env.root, initial.workflow_id, run => run.check_intents?.some(intent => intent.state === 'running') && existsSync(marker),
    'actual owned checker and descendant must be running before owner close', env.errors);
  const owned = JSON.parse(readFileSync(marker, 'utf8')), started = Date.now();
  const closing = env.closeOwner();
  await assert.rejects(controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' }));
  await assert.rejects(startControlledWorkflow(env.root, { requirement: 'No admission during shutdown.', request_id: 'shutdown-race' }));
  await closing;
  assert.equal(loadRecords(env.root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
  assert.ok(Date.now() - started < 8000, 'Owned command cancellation and persistence must be bounded.');
  const stopped = controlledStatus(env.root, initial.workflow_id);
  assert.equal(stopped.status, 'interrupted');
  assert.ok(stopped.check_intents.every(intent => intent.state === 'completed'), 'Owner close must wait for domain persistence, not only cancelled MCP delivery.');
  assert.equal(stopped.checks.length, 1);
  const check = stopped.checks[0], log = JSON.parse(readFileSync(safePath(env.root, check.log_path), 'utf8'));
  assert.equal(check.cancelled, true); assert.equal(check.passed, false); assert.equal(log.result.cancelled, true);
  assert.equal(getRecord(env.root, check.evidence_id).meta.data.result, 'fail');
  const alive = pid => {
    try {
      process.kill(pid, 0);
      return !(process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')));
    } catch { return false; }
  };
  const deadline = Date.now() + 3000;
  while ((alive(owned.pid) || alive(owned.child)) && Date.now() < deadline) await delay(20);
  assert.equal(alive(owned.pid), false); assert.equal(alive(owned.child), false);
  assert.equal(stopped.final_report_id, undefined);
  await env.restart();
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'a durably cancelled attempt must permit explicit same-workflow continuation with fresh checks', env.errors);
  assert.equal(done.workflow_id, initial.workflow_id); assert.equal(done.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.equal(done.checks[0].id, check.id); assert.equal(done.checks[0].cancelled, true, 'Historical cancellation must not be rewritten as success.');
  assert.ok(done.checks.slice(1).every(item => item.passed));
});

test('trusted orphan maintenance preserves UNKNOWN history, rejects unsafe evidence, replays idempotently and requires fresh signed verification', { timeout: 240000 }, async t => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['test/controlled-workflow.test.mjs'], {
    cwd: process.cwd(), env: { ...process.env, NEOMIND_TEST_ORPHAN_OWNER: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const packet = JSON.parse(Buffer.concat(output).toString().trim()), root = realpathSync.native(packet.root), workflow = packet.workflow_id;
  assert.equal(dirname(root), realpathSync.native(tmpdir())); assert.ok(root.includes('neomind-controlled-flow-'));
  let cleanup;
  t.after(async () => { if (cleanup) await cleanup(); else rmSync(root, { recursive: true, force: true }); });
  const state = safePath(root, `.neomind/controlled/workflows/${hash(workflow)}.json`), original = JSON.parse(readFileSync(state, 'utf8'));
  const contract = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(workflow)}.${original.epoch_id}.contract.json`), 'utf8'));
  const pending = original.check_intents.filter(intent => intent.state !== 'completed');
  assert.equal(pending.length, 1); assert.equal(original.status, 'interrupted');
  assert.ok(original.attempts.some(attempt => attempt.stage === 'verification' && attempt.state === 'completed' && attempt.report.verdict === 'pass'));
  const interrupted = original.attempts.at(-1), nativePath = safePath(root, `.neomind/native/receipts/${interrupted.invocation_id}.json`), nativeBytes = readFileSync(nativePath);
  assert.equal(readInvocation(root, interrupted.invocation_id).state, 'interrupted');
  const input = { workflow_id: workflow, expected_revision: original.revision, assessment: {
    operator: 'codex-maintenance-operator', project_effects: 'none-observed', external_effects: 'authorized-disposable-os-temp-only',
    command_and_delegate_reviewed: true, process_identities: packet.process_identities } };
  const assertUnchanged = () => assert.deepEqual(readFileSync(state), Buffer.from(JSON.stringify(original, null, 2) + '\n'));
  const { randomUUID } = await import('node:crypto');
  const unlinked = safePath(root, reconciliationPath(randomUUID())); fs.mkdirSync(dirname(unlinked), { recursive: true });
  try {
    fs.writeFileSync(unlinked, JSON.stringify({ outcome: 'pass', claim: 'An arbitrary file is not a runtime-linked reconciliation.' }));
    const recognized = readCheckReconciliations(root, original, contract);
    assert.deepEqual(recognized, []); assert.equal(unresolvedControlledChecks(original, recognized).length, 1);
  } finally { fs.unlinkSync(unlinked); }
  assert.throws(() => reconcileInterruptedControlledChecks(root, { ...input, expected_revision: original.revision + 1 }), /exact inactive interrupted revision/); assertUnchanged();
  assert.throws(() => reconcileInterruptedControlledChecks(root, { ...input, assessment: { ...input.assessment,
    process_identities: [...packet.process_identities, { pid: process.pid, created_at: new Date(performance.timeOrigin).toISOString(), role: 'descendant' }] } }), /Every known observed process/); assertUnchanged();
  const source = safePath(root, 'orphaned/src/value.txt'), sourceBytes = readFileSync(source);
  try { atomicWrite(source, 'changed\n'); assert.throws(() => reconcileInterruptedControlledChecks(root, input), /baseline changed/); }
  finally { atomicWrite(source, sourceBytes); }
  assertUnchanged();
  const fakeResult = safePath(root, `.neomind/controlled/checks/${pending[0].id}.log`);
  try { fs.writeFileSync(fakeResult, '{"result":"not-authoritative"}'); assert.throws(() => reconcileInterruptedControlledChecks(root, input), /result or partial result file/); }
  finally { fs.unlinkSync(fakeResult); }
  assertUnchanged();
  const pilot = safePath(root, `.neomind/controlled/pilots/${pending[0].id}`);
  try { fs.mkdirSync(pilot, { recursive: true }); assert.throws(() => reconcileInterruptedControlledChecks(root, input), /pilot results or partial artifacts/); }
  finally { fs.rmdirSync(pilot); }
  try { const corrupt = JSON.parse(nativeBytes); corrupt.signature = 'invalid'; atomicWrite(nativePath, JSON.stringify(corrupt));
    assert.throws(() => reconcileInterruptedControlledChecks(root, input), /signature|receipt|trusted/i); }
  finally { atomicWrite(nativePath, nativeBytes); }
  assertUnchanged();
  const env = await setup({ after(fn) { cleanup = fn; } }, { orphaned: {} }, root);
  const repeated = await startControlledWorkflow(root, { workflow_id: workflow });
  assert.equal(repeated.status, 'interrupted');
  await delay(100);
  assert.equal(env.observed.length, 0, 'manager_run repeated intake must not dispatch or replay an unresolved orphan.');
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).attempts, original.attempts);
  await env.closeOwner(); await env.closeBridge();
  assertUnchanged();
  const result = reconcileInterruptedControlledChecks(root, input), afterBytes = readFileSync(state), acknowledged = JSON.parse(afterBytes);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.assurance, 'unsigned-local-maintenance-attestation'); assert.equal(result.replayed, false);
  assert.deepEqual(acknowledged.check_intents, original.check_intents); assert.deepEqual(acknowledged.checks, original.checks);
  assert.deepEqual(readFileSync(nativePath), nativeBytes);
  const ledgerPath = safePath(root, reconciliationPath(result.id)), ledgerBytes = readFileSync(ledgerPath);
  const ledgers = readCheckReconciliations(root, acknowledged, contract);
  const oldVerifier = original.attempts.find(attempt => attempt.stage === 'verification' && attempt.state === 'completed');
  assert.throws(() => assertFreshVerifierAfterReconciliation(acknowledged, ledgers, oldVerifier.id, original.checks), /fresh independent Verifier/);
  assert.deepEqual(reconcileInterruptedControlledChecks(root, { ...input, assessment: { ...input.assessment,
    process_identities: [...input.assessment.process_identities].reverse() } }), { ...result, replayed: true });
  assert.deepEqual(readFileSync(state), afterBytes); assert.deepEqual(readFileSync(ledgerPath), ledgerBytes);
  try { fs.appendFileSync(ledgerPath, ' '); assert.throws(() => reconcileInterruptedControlledChecks(root, input), /immutable reconciliation ledger changed/); }
  finally { fs.writeFileSync(ledgerPath, ledgerBytes); }
  await env.restart();
  const acknowledgedReceipt = await startControlledWorkflow(root, { workflow_id: workflow });
  assert.equal(acknowledgedReceipt.status, 'interrupted');
  await delay(100);
  assert.equal(env.observed.length, 0, 'A ledger alone is not an explicit resume or command replay request.');
  const resumed = await controlControlledWorkflow(root, { workflow_id: workflow, action: 'resume' });
  assert.equal(resumed.workflow_id, workflow);
  assert.equal(verify(root, contract.task_id, 'verified').ok, false, 'A queued replacement may not reuse the older passing Verifier.');
  const done = await until(root, workflow, run => run.status === 'completed', 'fresh actual verification/review must complete the reconciled workflow', env.errors);
  const latestVerifier = done.attempts.findLast(attempt => attempt.stage === 'verification');
  assert.equal(latestVerifier.state, 'completed'); assert.ok(done.checks.filter(check => check.attempt_id === latestVerifier.id).every(check => check.passed));
  assert.equal(done.checks.some(check => check.id === pending[0].id), false, 'No execution result may be fabricated for the unknown historical check.');
  assert.deepEqual(done.check_intents.find(intent => intent.id === pending[0].id), pending[0]);
  assert.equal(verify(root, contract.task_id, 'accepted').ok, true);
  const completedBytes = readFileSync(state);
  assert.deepEqual(reconcileInterruptedControlledChecks(root, input), { ...result, replayed: true }, 'Historical response replay works after completion with a live new owner.');
  assert.deepEqual(readFileSync(state), completedBytes); assert.deepEqual(readFileSync(ledgerPath), ledgerBytes);
});

test('preserved read-only delegated checker dependency is captured by positive and negative execution after owner restart without widening writes', async t => {
  const env = await setup(t, { readonlybaseline: { readOnlyBaseline: true, holdImplementation: true } });
  const dependency = 'scripts/verify-leetcode-exercise.mjs', original = readFileSync(join(env.root, dependency));
  const hiddenInput = '.agents/skills/helpers/assets/oracle.json', originalHidden = readFileSync(join(env.root, hiddenInput));
  const initial = await submit(env.root, 'readonlybaseline');
  const held = await until(env.root, initial.workflow_id, () => env.held.entered,
    'explicit read-only dependency baselines must pass planning without granting write scope', env.errors);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === held.epoch_id);
  assert.deepEqual(task.meta.data.allowed_paths, ['readonlybaseline/src/value.txt']);
  assert.deepEqual(task.meta.data.verification_paths, ['readonlybaseline/verify']);
  assert.ok(!task.meta.data.allowed_paths.includes(dependency)); assert.ok(!task.meta.data.verification_paths.includes(dependency));
  const contractPath = safePath(env.root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.${held.epoch_id}.contract.json`);
  const frozenBytes = readFileSync(contractPath), contract = JSON.parse(frozenBytes);
  assert.equal(contract.preserved_hashes[dependency], hash(original));
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'pause' });
  await env.restart();
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed',
    'a preserved dependency must remain readable and independently evidenced after restart', env.errors);
  assert.equal(done.workflow_id, initial.workflow_id); assert.equal(done.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.deepEqual(readFileSync(contractPath), frozenBytes, 'Restart must not rewrite a frozen contract or its hash.');
  assert.deepEqual(readFileSync(join(env.root, dependency)), original);
  assert.equal(done.checks.length, 2); assert.ok(done.checks.every(check => check.passed));
  for (const check of done.checks) {
    assert.equal(check.baseline[dependency], hash(original));
    const snapshot = JSON.parse(readFileSync(safePath(env.root, check.evidence_input.input_snapshot.manifest_path), 'utf8'));
    assert.equal(snapshot.files[dependency].hash, hash(original));
    assert.equal(snapshot.files[hiddenInput].hash, hash(originalHidden));
    const evidence = getRecord(env.root, check.evidence_id);
    assert.equal(evidence.meta.data.file_baseline[dependency], hash(original));
    const log = JSON.parse(readFileSync(safePath(env.root, check.log_path), 'utf8'));
    assert.match(log.result.stdout, /readonly delegate observed scalar:/);
    assert.equal(check.exit_code, check.negative ? 1 : 0);
  }
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
  atomicWrite(join(env.root, dependency), original.toString() + '// outside edit\n');
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, false, 'External dependency edits must invalidate current acceptance evidence.');
  atomicWrite(join(env.root, dependency), original.toString());
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
});

test('a preserved public directory with private descendants is refused before any check input blobs or task effects', async t => {
  const env = await setup(t, { privatebaseline: { readOnlyBaseline: true, privateBaselineDirectory: true } });
  const initial = await submit(env.root, 'privatebaseline');
  const blocked = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'read-only directories must not recursively capture private descendants', env.errors);
  assert.equal(blocked.checks.length, 0); assert.equal(blocked.contract_hash, undefined);
  assert.ok(env.errors.some(error => /Read-only check baselines must name exact existing ordinary/.test(JSON.stringify(error.result))));
  assert.equal(loadRecords(env.root).some(record => record.meta.data.epoch_id === blocked.epoch_id && record.meta.type === 'task'), false);
  assert.equal(loadRecords(env.root).some(record => ['check', 'evidence'].includes(record.meta.type)), false);
  assert.equal(existsSync(safePath(env.root, '.neomind/evidence/inputs/blobs')), false);
  assert.doesNotMatch(JSON.stringify(env.errors), /PRIVATE_BASELINE_CANARY/);
});

test('an exact approved public GitHub skill input cannot overlap producer or checker write authority', async t => {
  const env = await setup(t, { conflictinginput: { readOnlyBaseline: true, conflictingReadInput: true } });
  const initial = await submit(env.root, 'conflictinginput');
  const blocked = await until(env.root, initial.workflow_id, run => run.status === 'blocked',
    'read-only approval must reject conflicting write scope before contract effects', env.errors);
  assert.equal(blocked.contract_hash, undefined); assert.equal(blocked.checks.length, 0);
  assert.ok(env.errors.some(error => /Approved read-only inputs must be outside all producer and checker write scopes/.test(JSON.stringify(error.result))));
  assert.equal(loadRecords(env.root).some(record => record.meta.data.epoch_id === blocked.epoch_id && record.meta.type === 'task'), false);
  assert.equal(readFileSync(safePath(env.root, '.github/skills/helpers/assets/oracle.json'), 'utf8'), '{"expected":1}\n');
});

test('parallel workflows retain their own tasks, artifacts, reports and receipt correlations', async t => {
  const env = await setup(t, { left: {}, right: {} });
  const initial = await Promise.all([submit(env.root, 'left'), submit(env.root, 'right')]);
  assert.notEqual(initial[0].workflow_id, initial[1].workflow_id);
  const done = await Promise.all(initial.map(run => until(env.root, run.workflow_id, value => value.status === 'completed', 'parallel workflow should complete', env.errors)));
  for (const run of done) for (const attempt of run.attempts) {
    assert.equal(readInvocation(env.root, attempt.invocation_id).workflow_id, run.workflow_id);
    assert.equal(getRecord(env.root, attempt.report_id).meta.data.workflow_id, run.workflow_id);
  }
  assert.notEqual(done[0].final_report_id, done[1].final_report_id);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === done[0].workflow_id && record.meta.data.epoch_id === done[0].epoch_id);
  const journalPath = safePath(env.root, `.neomind/controlled/workflows/${hash(done[0].workflow_id)}.json`), original = readFileSync(journalPath);
  const foreign = done[1].attempts.find(attempt => attempt.stage === 'verification');
  assert.equal(readInvocation(env.root, foreign.invocation_id).state, 'completed', 'The substituted receipt is genuine and signed, not corrupt JSON.');
  try {
    const journal = JSON.parse(original.toString('utf8')), verifier = journal.attempts.find(attempt => attempt.stage === 'verification');
    verifier.invocation_id = foreign.invocation_id; verifier.request_id = foreign.request_id; verifier.report_id = foreign.report_id;
    atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
    const swapped = verify(env.root, task.meta.id, 'accepted');
    assert.equal(swapped.ok, false, 'A completed signed Verifier from another workflow/epoch cannot satisfy this task.');
    assert.ok(swapped.findings.some(finding => finding.code === 'controlled-acceptance' && /signed task, epoch, stage and request/.test(finding.message)));
  } finally { atomicWrite(journalPath, original); }
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, true);
  assert.equal(env.errors.length, 0);
});

test('duplicate reports save once and retained late callbacks cannot alter an advanced workflow', async t => {
  const env = await setup(t, { callbacks: { holdImplementation: true } });
  const initial = await submit(env.root, 'callbacks');
  const held = await until(env.root, initial.workflow_id, () => env.held.entered, 'producer should remain active for callback replay', env.errors);
  const attempt = held.attempts.at(-1), context = ownedContext(env.root, attempt.request_id);
  assert.ok(context, 'Only the actual owned attempt supplies its private backend callback.');
  const payload = { outcome: 'completed', summary: 'implementation completed with actual scoped artifacts.',
    findings: ['Independent implementation result recorded.'], artifacts: planFor('callbacks').outputs };
  const saveReport = context.callbacks.saveReport;
  await saveReport(payload);
  const records = () => loadRecords(env.root).filter(record => record.meta.data.kind === 'controlled-work-record' && record.meta.data.invocation_id === attempt.invocation_id);
  assert.equal(records().length, 1);
  assert.deepEqual(await saveReport(payload), { saved: true, outcome: 'completed' });
  assert.equal(records().length, 1, 'A response retry must reuse its durable report.');
  await assert.rejects(async () => saveReport({ ...payload, summary: 'A different result cannot replace the saved report.' }), /already saved a different report/);
  assert.equal(records().length, 1);
  env.held.release = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'the model should finish using its already-saved identical report', env.errors);
  const journalPath = safePath(env.root, `.neomind/controlled/workflows/${hash(done.workflow_id)}.json`), before = readFileSync(journalPath), count = loadRecords(env.root).length;
  await assert.rejects(async () => saveReport(payload), /ended or changed owner/);
  assert.deepEqual(readFileSync(journalPath), before, 'A late result cannot append events or alter accepted state.');
  assert.equal(loadRecords(env.root).length, count, 'A late result cannot create another report or evidence record.');
  assert.deepEqual(env.errors, [], 'A replay must not force a model-facing protocol error and repair.');
});

test('controlled continuation creates separate execution lineage and preserves legacy task, contract and evidence bytes', async t => {
  const env = await setup(t, { legacy: { holdImplementation: true } }), fixturePlan = planFor('legacy');
  const workflow = beginWorkflow(env.root, { requirement: 'Scenario: legacy\nCreate and independently verify the requested scalar.', execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(env.root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: 'legacy-continuation-fixture', objective: 'Define the actual bounded software contract before its controlled execution continuation.' });
  const handle = openAssignment(env.root, packet.open_input).handle;
  const { risk, checks, ...semantic } = fixturePlan;
  const original = planNativeSoftware(env.root, handle, { ...semantic, process: 'software-tools',
    checks: checks.map(({ negative_controls, ...check }) => check) });
  const legacyContract = readNativeSoftwareContract(env.root, workflow.meta.id);
  const oldEvidence = createRecord(env.root, { type: 'evidence', title: 'Historical failed check retained for continuation lineage', owner: 'verifier', status: 'failed',
    links: [{ type: 'evidence-for', target: original.check_ids[0] }, { type: 'documents', target: original.task_id }],
    data: { workflow_id: workflow.meta.id, task_id: original.task_id, result: 'fail' },
    body: '# Historical observation\nNo successful verification is claimed for this legacy evidence.\n' });
  const historicalPaths = [getRecord(env.root, original.task_id).path, oldEvidence.path,
    `.neomind/native/software-workflows/${hash(workflow.meta.id)}.contract.json`];
  const historical = historicalPaths.map(path => ({ path, bytes: readFileSync(safePath(env.root, path)) }));
  await startControlledWorkflow(env.root, { workflow_id: workflow.meta.id, request_id: 'controlled-legacy-lineage-fixture' });
  const running = await until(env.root, workflow.meta.id, () => env.held.entered, 'continuation should reach its separately bound producer', env.errors);
  const task = loadRecords(env.root).find(record => record.meta.type === 'task' && record.meta.data.workflow_id === workflow.meta.id && record.meta.data.epoch_id === running.epoch_id);
  assert.ok(task); assert.notEqual(task.meta.id, original.task_id);
  assert.ok(task.meta.links.some(link => link.type === 'derives-from' && link.target === original.task_id));
  for (const id of legacyContract.requirement_ids) assert.ok(task.meta.links.some(link => link.type === 'satisfies' && link.target === id), id);
  for (const criterion of legacyContract.plan.acceptance_criteria) assert.ok(task.meta.data.acceptance_criteria.includes(criterion), criterion);
  assert.equal(readInvocation(env.root, running.attempts.at(-1).invocation_id).task_id, task.meta.id);
  const paused = await controlControlledWorkflow(env.root, { workflow_id: workflow.meta.id, action: 'pause' });
  assert.equal(paused.status, 'paused');
  for (const { path, bytes } of historical) assert.deepEqual(readFileSync(safePath(env.root, path)), bytes, path);
  assert.notEqual(getRecord(env.root, original.task_id).meta.status, 'accepted');
  assert.equal(verify(env.root, task.meta.id, 'accepted').ok, false, 'Lineage and an implementation artifact alone cannot accept the continuation.');
  assert.equal(env.errors.length, 0);
});

test('changing a controlled role model affects the next invocation without invalidating current receipt evidence', async t => {
  const env = await setup(t, { frozen: { holdImplementation: true } });
  const initial = await submit(env.root, 'frozen');
  const running = await until(env.root, initial.workflow_id, () => env.held.entered, 'producer should be active', env.errors);
  const old = readInvocation(env.root, running.attempts.at(-1).invocation_id);
  setRoleModel(env.root, { role: 'developer', model: 'next-worker', provider: 'fixture-worker' });
  const map = readAgentMap(env.root), current = map.nodes.find(node => node.invocation_id === old.id);
  assert.equal(current.source, 'controlled-runtime'); assert.equal(current.state, 'running');
  assert.ok(map.edges.some(edge => edge.kind === 'handoff' && edge.to === current.id && edge.source === 'controlled-runtime'));
  env.held.release = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'policy update must preserve active provenance', env.errors);
  assert.equal(readInvocation(env.root, old.id).requested_model, old.requested_model);
  assert.equal(done.status, 'completed');
});

test('completed signed verification uses one fresh record inventory and observes next-call evidence or requirement edits', async t => {
  const env = await setup(t, { metadata: {} });
  const initial = await submit(env.root, 'metadata');
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'real signed fixture must complete before authority snapshot checks', env.errors);
  for (let index = 0; index < 64; index++) {
    const at = new Date().toISOString(), meta = { schema_version: 1, id: `CONTROLLED-KNW-${9000 + index}`, type: 'knowledge', title: `Unrelated history ${index}`,
      owner: 'manager', status: 'draft', revision: 1, created_at: at, updated_at: at, links: [], data: {} };
    atomicWrite(safePath(env.root, `.neomind/records/${meta.id}.md`), `---\n${JSON.stringify(meta)}\n---\n# Independent unrelated history\n`);
  }
  const records = loadRecords(env.root), task = records.find(record => record.meta.type === 'task' && record.meta.data.epoch_id === done.epoch_id);
  assert.ok(task); assert.ok(done.checks.length >= 2);
  const contract = countRecordReads(env.root, () => controlledContractForTask(env.root, task));
  assert.equal(contract.reads, records.length); assert.equal(contract.maximum, 1);
  const accepted = countRecordReads(env.root, () => verifyControlledTask(env.root, task, 'accepted'));
  assert.equal(accepted.result.ok, true, JSON.stringify(accepted.result.findings));
  assert.equal(accepted.reads, records.length, 'All contract/report/check/evidence metadata lookups share one freshly read store.');
  assert.equal(accepted.maximum, 1);
  const rewrite = record => atomicWrite(safePath(env.root, record.path), `---\n${JSON.stringify(record.meta)}\n---\n${record.body}`);
  const requirement = getRecord(env.root, contract.result.contract.requirement_ids[0]), requirementPath = safePath(env.root, requirement.path), originalRequirement = readFileSync(requirementPath);
  try {
    requirement.body += '\nUser changed the accepted requirement after the previous call.\n'; rewrite(requirement);
    const changed = verifyControlledTask(env.root, task, 'accepted');
    assert.equal(changed.ok, false); assert.match(changed.findings[0].message, /requirement baseline changed/);
  } finally { fs.writeFileSync(requirementPath, originalRequirement); }
  assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, true);
  const evidence = getRecord(env.root, done.checks[0].evidence_id), evidencePath = safePath(env.root, evidence.path), originalEvidence = readFileSync(evidencePath);
  try {
    evidence.meta.data.result = 'fail'; rewrite(evidence);
    assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, false, 'An earlier accepted read cannot cache a passing evidence value.');
    fs.writeFileSync(evidencePath, originalEvidence); fs.unlinkSync(evidencePath);
    const deleted = verifyControlledTask(env.root, task, 'accepted'); assert.equal(deleted.ok, false); assert.match(deleted.findings[0].message, /Record not found/);
  } finally { fs.writeFileSync(evidencePath, originalEvidence); }
  const duplicate = safePath(env.root, '.neomind/records/duplicate-evidence.md');
  try {
    fs.writeFileSync(duplicate, originalEvidence);
    const changed = verifyControlledTask(env.root, task, 'accepted'); assert.equal(changed.ok, false); assert.match(changed.findings[0].message, /Duplicate record ID/);
    assert.throws(() => controlledContractForTask(env.root, task), /Duplicate record ID/);
  } finally { fs.unlinkSync(duplicate); }
  const signed = done.attempts.find(attempt => attempt.stage === 'verification'), receiptPath = safePath(env.root, `.neomind/native/receipts/${signed.invocation_id}.json`), originalReceipt = readFileSync(receiptPath);
  try {
    const receipt = JSON.parse(originalReceipt); receipt.signature = 'invalid-current-signature'; atomicWrite(receiptPath, JSON.stringify(receipt));
    assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, false, 'Signed receipt files are re-read rather than included in the metadata snapshot.');
  } finally { fs.writeFileSync(receiptPath, originalReceipt); }
  assert.equal(verifyControlledTask(env.root, task, 'accepted').ok, true);
});
