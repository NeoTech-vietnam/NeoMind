import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as domain from '../dist/native-request.js';
import { nativeLocalRequestSchema, nativeRequestControlSchema } from '../dist/native-local-contract.js';
import { initialize, loadRecords, getRecord } from '../dist/storage.js';

const require = createRequire(import.meta.url);
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');

test('an actual failed checker routes product repair to the parent model and preserves old failed evidence', { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-repair-'));
  let runner;
  t.after(async () => { await runner?.dispose(); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'WF-REPAIR', repair_attempts: 1 });
  writeFileSync(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'hello');\n");
  const calls = [], retained = []; let implementations = 0;
  const vscode = { CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }, lm: {
    tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
      properties: Object.fromEntries(['agentName', 'prompt', 'description', 'model'].map(key => [key, { type: 'string' }])) } }],
    selectChatModels: async () => [{ id: 'worker', vendor: 'endpoint', name: 'Worker' }],
    async invokeTool(_name, { input }) {
      calls.push(input);
      if (input.agentName === 'WF.FnD') {
        implementations++;
        if (implementations === 2) {
          const request = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request');
          const saved = domain.getNativeRequest(root, request.meta.id);
          for (const check of saved.check_history ?? []) if (check.evidence_id) {
            const record = getRecord(root, check.evidence_id);
            retained.push({ id: record.meta.id, bytes: readFileSync(join(root, record.path)) });
          }
          assert.match(input.prompt, /check\.cjs|AssertionError/);
        }
        writeFileSync(join(root, 'product.txt'), implementations === 1 ? 'wrong' : 'hello');
      }
      // Host-outcome seam: the real independent process must reject the first
      // product even if model reports claim pass. This is not desktop evidence.
      return { content: [{ value: JSON.stringify({ summary: 'Observed scoped work', verdict: 'pass', findings: [] }) }] };
    },
  } };
  runner = createLocalRequestRunner(vscode, { ...domain, nativeLocalRequestSchema }, root, {
    modelForRole: role => role === 'WF.FnD' ? { id: 'worker', vendor: 'endpoint' } : undefined,
  });
  const result = await runner.run({ requirement: 'Create a verified hello text product', plan: {
    summary: 'Write hello and verify independently', requirements: ['Exact hello'], design: 'UTF-8 text', outputs: ['product.txt'],
    checks: [{ title: 'Actual assertion', level: 'acceptance', command: [process.execPath, 'check.cjs'] }],
  } }, {});
  assert.equal(result.status, 'accepted');
  assert.equal(implementations, 2);
  assert.deepEqual(calls.map(call => call.agentName), ['WF.FnD', 'WF.Reviewer', 'WF.Tester', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']);
  assert.equal(calls[0].model, 'Worker (endpoint)');
  assert.equal(calls[3].model, undefined, 'Repair inherits the Coordinator model without changing the saved worker preference');
  assert.equal(loadRecords(root).filter(item => item.meta.data.kind === 'workforce-request').length, 1);
  const request = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request');
  const saved = domain.getNativeRequest(root, request.meta.id);
  assert.equal(saved.check_history[0].result.exit_code, 1);
  assert.equal(saved.checks[0].result.exit_code, 0);
  assert.equal(retained.length, 1);
  for (const prior of retained) {
    const record = getRecord(root, prior.id);
    assert.deepEqual(readFileSync(join(root, record.path)), prior.bytes);
    assert.equal(record.meta.status, 'draft');
  }
});

test('unchanged product findings exhaust only the configured repair allowance and never run unchecked acceptance', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-repair-bound-'));
  let runner;
  t.after(async () => { await runner?.dispose(); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'WF-REPAIR-BOUND', repair_attempts: 1 });
  const calls = [];
  const vscode = { CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }, lm: {
    tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
      properties: Object.fromEntries(['agentName', 'prompt', 'description'].map(key => [key, { type: 'string' }])) } }],
    async invokeTool(_name, { input }) {
      calls.push(input);
      writeFileSync(join(root, 'product.txt'), 'incomplete');
      return { content: [{ value: JSON.stringify({ summary: 'Concrete unresolved implementation defect', verdict: 'findings', findings: ['Required content is not implemented.'] }) }] };
    },
  } };
  runner = createLocalRequestRunner(vscode, { ...domain, nativeLocalRequestSchema }, root);
  const result = await runner.run({ requirement: 'Create a verified text product', plan: {
    summary: 'Write hello and verify', requirements: ['Exact hello'], design: 'UTF-8 text', outputs: ['product.txt'],
    checks: [{ title: 'Must not execute after failed implementation', level: 'acceptance', command: [process.execPath, '-e', 'process.exit(0)'] }],
  } }, {});
  assert.equal(result.status, 'findings');
  assert.equal(result.request.accepted, false);
  assert.equal(calls.length, 2, 'one actual attempt plus one configured repair');
  assert.ok(calls.every(call => call.agentName === 'WF.FnD'));
  const request = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request');
  const saved = domain.getNativeRequest(root, request.meta.id);
  assert.equal(saved.repair_attempts, 1);
  assert.equal(saved.checks[0].execution_id, undefined);
  assert.equal(saved.final_report_id, undefined);
  assert.equal(result.request.roles[0].findings[0], 'Required content is not implemented.');
});

test('an explicit environment correction rechecks unchanged independently inspected products without more model calls', { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-recheck-'));
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Etc/GMT+1';
  let runner;
  t.after(async () => {
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    await runner?.dispose(); rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'WF-RECHECK' });
  writeFileSync(join(root, 'check.cjs'), "require('node:assert/strict').equal(process.env.TZ,'UTC');\n");
  let calls = 0;
  const vscode = { CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }, lm: {
    tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
      properties: Object.fromEntries(['agentName', 'prompt', 'description'].map(key => [key, { type: 'string' }])) } }],
    async invokeTool(_name, { input }) {
      calls++;
      if (input.agentName === 'WF.FnD') writeFileSync(join(root, 'product.txt'), 'hello');
      return { content: [{ value: JSON.stringify({ summary: 'Inspected scoped product', verdict: 'pass', findings: [] }) }] };
    },
  } };
  runner = createLocalRequestRunner(vscode, { ...domain, nativeLocalRequestSchema, nativeRequestControlSchema }, root, { automaticRepair: false });
  assert.equal((await runner.run({ requirement: 'Create a checked text product', plan: {
    summary: 'Write hello and run the environment-specific check', requirements: ['Exact hello'], design: 'UTF-8 text', outputs: ['product.txt'],
    checks: [{ title: 'UTC environment check', level: 'acceptance', command: [process.execPath, 'check.cjs'] }],
  } }, {})).status, 'findings');
  const request = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request');
  writeFileSync(join(root, 'product.txt'), 'changed');
  assert.throws(() => domain.recheckNativeRequest(root, request.meta.id), /Changed or incomplete/);
  writeFileSync(join(root, 'product.txt'), 'hello');
  process.env.TZ = 'UTC';
  const selected = domain.getNativeRequest(root, request.meta.id);
  const status = await runner.control({ request_key: selected.request_key, action: 'status' });
  assert.equal(status.request.request_key, selected.request_key);
  assert.equal(JSON.stringify(status).includes(request.meta.id), false);
  const result = await runner.control({ request_key: selected.request_key, action: 'recheck' }, {});
  assert.equal(result.status, 'accepted');
  assert.equal(calls, 3, 'unchanged successful roles are retained, not reinvoked');
  const saved = domain.getNativeRequest(root, request.meta.id);
  assert.equal(saved.check_history[0].result.exit_code, 1);
  assert.equal(saved.checks[0].result.exit_code, 0);
  const repeated = await runner.control({ request_key: selected.request_key, action: 'recheck' }, {});
  assert.equal(repeated.status, 'accepted');
  assert.equal(calls, 3);
  assert.equal(domain.getNativeRequest(root, request.meta.id).checks[0].execution_id, saved.checks[0].execution_id);
});
