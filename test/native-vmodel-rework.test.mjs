// Real native request/repair/check storage fed through the production panel and
// SVG client. Only the VS Code model call and editor DOM are simulated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import * as api from '../dist/index.js';
import { documentFixture, descendants, universe } from './helpers/workforce-ui.mjs';
const require = createRequire(import.meta.url);
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const { activateVModelPanel } = require('../extensions/vscode-model-bridge/v-model-panel.cjs');
const { observeNativeQueue } = require('../extensions/vscode-model-bridge/local-activity.cjs');
const clientSource = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/v-model-panel.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const report = (verdict = 'pass', findings = []) => ({ summary: 'Observed bounded arithmetic fixture.', verdict, findings });
const opaque = Object.freeze({ host: Symbol('native tool context') });
function cancellation() { return { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }; }

async function panelFixture(t, onInvoke) {
  const base = mkdtempSync(join(tmpdir(), 'wf-vmodel-rework-')), root = realpathSync.native(join(base, 'project', '..'));
  const project = join(root, 'project'); mkdirSync(project);
  api.initialize(project, { project_id: 'WF-UI-REWORK' });
  const commands = new Map(), saved = new Map(), snapshots = [], seen = [], nativeFailures = [];
  let receive, client, elements, closePanel, runner;
  const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => 'vscode-webview://owned-fixture' });
  const context = { subscriptions: [], workspaceState: { get: key => saved.get(key), async update(key, value) { saved.set(key, value); } } };
  const vscode = { ViewColumn: { Beside: -2 }, Uri: { file: uri, joinPath: (base, file) => uri(join(base.fsPath, file)) },
    CancellationTokenSource: class { constructor() { this.token = cancellation(); } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
      async executeCommand() { assert.fail('This display proof never opens files or runs an editor command'); } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(project) }], onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
    window: { showErrorMessage(message) { assert.fail(message); }, showWarningMessage(message) { assert.fail(message); },
      createWebviewPanel() { return { onDidDispose(callback) { closePanel = callback; }, dispose() { closePanel?.(); },
        webview: { cspSource: 'vscode-webview://owned-fixture', asWebviewUri: value => value,
          onDidReceiveMessage(callback) { receive = callback; return { dispose() {} }; },
          async postMessage(message) { if (message.type === 'snapshot') snapshots.push(structuredClone(message)); client?.(message); },
          set html(html) {
            const fixture = documentFixture([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])); elements = fixture.elements;
            runInNewContext(clientSource, { document: fixture.document, window: { WorkForceUniverse: universe,
              addEventListener(_event, listener) { client = data => listener({ data }); } },
              acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage: message => { void receive(message); } }) });
          } } }; } },
    lm: { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'], properties:
      Object.fromEntries(['agentName', 'prompt', 'description', 'model'].map(key => [key, { type: 'string' }])) } }],
      async invokeTool(name, options) { assert.equal(name, 'runSubagent'); assert.equal(options.toolInvocationToken, opaque);
        await tick(); try { return { content: [{ value: JSON.stringify(await onInvoke(options.input, app)) }] }; }
        catch (error) { nativeFailures.push(error.stack); throw error; } } } };
  const runtime = { ...api, async runNativeChecks(...args) {
    const pending = api.runNativeChecks(...args);
    let ended = false; void pending.finally(() => { ended = true; }).catch(() => {});
    const deadline = Date.now() + 10000;
    while (!existsSync(app.checkStarted) && !ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(app.checkStarted), true, 'The real passing checker reached its owned observation barrier');
    await app.refresh(); app.capture('actual-check-running'); writeFileSync(app.checkRelease, 'release'); return pending;
  } };
  const app = { root: project, base, vscode, runtime, snapshots, seen, nativeFailures,
    checkStarted: join(base, 'check-started'), checkRelease: join(base, 'check-release'),
    async refresh() { await receive({ type: 'refresh' }); await tick(); },
    capture(phase) { const selected = snapshots.at(-1)?.requests[0];
      const diagram = elements.get('v-model');
      const row = { phase, request_ref: selected?.workflow_id, status: selected?.status,
        states: Object.fromEntries(descendants(diagram).filter(node => node.getAttribute('data-stage')).map(node => [node.dataset.stage, node.dataset.state])),
        review: elements.get('review').dataset.state, activity: elements.get('activity').textContent,
        repair: descendants(diagram).find(node => node.classList.contains('v-rework'))?.dataset.state,
        evidence: elements.get('evidence').textContent };
      seen.push(row); return row;
    } };
  activateVModelPanel(vscode, context, async () => runtime);
  await commands.get('workforce.vModel.open')(); await tick(); await app.refresh();
  runner = createLocalRequestRunner(vscode, runtime, project); app.runner = runner;
  t.after(async () => { await runner.dispose(); closePanel?.(); rmSync(base, { recursive: true, force: true }); });
  return app;
}
const input = { requirement: 'Provide sum(a,b) with exact integer addition and preserve the existing checker.', title: 'Bounded UI rework proof', context: ['sum.test.mjs'],
  plan: { summary: 'A small independently checked arithmetic module', requirements: ['sum(2,3) returns 5', 'sum(-2,3) returns 1'],
    design: 'A named pure function; no dependencies', outputs: ['sum.mjs'],
    checks: [{ title: 'Existing independent sum assertions', level: 'unit', command: [process.execPath, '--test', 'sum.test.mjs'] }] } };

test('actual failed product, saved review finding, same-request repair and fresh checks remain synchronized through the panel', { timeout: 60000 }, async t => {
  let fnd = 0, reviewer = 0, negative;
  const app = await panelFixture(t, async (call, current) => {
    const role = call.agentName.replace(/ Worker$/, '');
    if (role === 'WF.FnD') {
      fnd++; writeFileSync(join(current.root, 'sum.mjs'), fnd === 1 ? 'export const sum=(a,b)=>a-b;\n' : 'export const sum=(a,b)=>a+b;\n');
      await current.refresh(); const view = current.capture(fnd === 1 ? 'initial-implementation' : 'same-request-repair');
      assert.equal(view.states.coding, fnd === 1 ? 'running' : 'repairing');
      if (fnd > 1) { assert.equal(view.review, 'failed'); assert.equal(view.repair, 'repairing'); }
    } else if (role === 'WF.Reviewer') {
      reviewer++; await current.refresh(); const view = current.capture(`independent-review-${reviewer}`); assert.equal(view.review, 'running');
      if (reviewer === 1) {
        // This negative oracle belongs to the test harness, not an execute
        // permission granted to the read-only Reviewer profile.
        const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
        negative = spawnSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd: current.root, encoding: 'utf8', windowsHide: true, env: childEnvironment });
        assert.equal(negative.status, 1); assert.match(negative.stdout, /-1|notStrictEqual|strictEqual|Expected/);
        return report('findings', ['Actual sum(2,3) is -1 instead of 5; the existing independent checker exits 1.']);
      }
    } else { await current.refresh(); const view = current.capture('independent-tester'); assert.equal(view.review, 'completed');
      assert.equal(view.states.unit, 'pending', 'A native Tester call is not a running or passing checker'); }
    return report();
  });
  writeFileSync(join(app.root, 'sum.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import{sum}from'./sum.mjs';import{writeFileSync,existsSync}from'node:fs';test('independent arithmetic',async()=>{assert.equal(sum(2,3),5);assert.equal(sum(-2,3),1);writeFileSync(${JSON.stringify(app.checkStarted)},'started');const deadline=Date.now()+10000;while(!existsSync(${JSON.stringify(app.checkRelease)})&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(${JSON.stringify(app.checkRelease)}),'owned observation barrier released')});\n`);
  const result = await app.runner.run(input, opaque); assert.equal(result.request?.accepted, true, `${JSON.stringify(result)}\n${app.nativeFailures.join('\n')}`);
  assert.equal(fnd, 2); assert.equal(reviewer, 2); assert.equal(negative.status, 1);
  await app.refresh(); const final = app.capture('accepted');
  assert.equal(final.review, 'completed'); assert.equal(final.states.coding, 'completed'); assert.equal(final.states.unit, 'completed');
  assert.equal(final.states.integration, 'not-applicable'); assert.equal(final.repair, 'pending'); assert.match(final.evidence, /passed.*exit 0/);
  assert.ok(app.seen.some(row => row.phase === 'actual-check-running' && row.states.unit === 'running'));
  assert.equal(new Set(app.seen.map(row => row.request_ref).filter(Boolean)).size, 1, 'All states belong to the same real request');
  const state = api.getNativeRequest(app.root, app.snapshots.at(-1).requests[0].workflow_id);
  assert.equal(state.assignments.length, 5); assert.equal(state.assignments.filter(job => job.report?.verdict === 'findings').length, 1);
  const execution = join(app.root, '.workforce', api.requestFolderForWorkflow(app.root, state.request_ref).directory, 'native/execution.json'), preserved = readFileSync(execution);
  writeFileSync(join(app.root, 'sum.mjs'), 'export const sum=()=>0;\n'); await app.refresh(); const changed = app.capture('external-change');
  assert.equal(changed.states.unit, 'uncertain'); assert.equal(changed.review, 'uncertain'); assert.equal(changed.repair, 'pending');
  assert.deepEqual(readFileSync(execution), preserved, 'Read-only UI projection does not rewrite acceptance or history');
});

test('real persisted pending, queued and unobserved assignments remain distinct before a native call', { timeout: 30000 }, async t => {
  const app = await panelFixture(t, () => assert.fail('No model is invoked for this projection proof'));
  const opened = api.openNativeRequest(app.root, { requirement: input.requirement });
  api.planNativeRequest(app.root, opened.request_ref, input.plan); await app.refresh();
  assert.equal(app.capture('pending').states.coding, 'pending');
  const job = api.nextNativeAssignment(app.root, opened.request_ref); await app.refresh();
  assert.equal(app.capture('unobserved-issued').states.coding, 'uncertain');
  const releaseQueue = observeNativeQueue(app.root, opened.request_ref, job.assignment_ref, job.agentName); await app.refresh();
  const queued = app.capture('queued'); assert.equal(queued.states.coding, 'queued'); assert.doesNotMatch(queued.activity, /WF\.FnD running/);
  releaseQueue(); await app.refresh(); assert.equal(app.capture('queue-ended-without-call').states.coding, 'uncertain');
});
