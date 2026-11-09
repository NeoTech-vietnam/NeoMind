import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as domain from '../dist/native-request.js';
import { initialize, loadRecords, readConfig, requestFolderForWorkflow } from '../dist/storage.js';
import { nativeLocalRequestSchema, nativeRequestControlSchema, nativeWorkerProfiles } from '../dist/native-local-contract.js';

const require = createRequire(import.meta.url), { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const temporary = resolve('artifacts/test-temp');
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(read, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await pause(20); }
  assert.fail('The actual checker did not reach its bounded finalization checkpoint.');
}

for (const userEdit of [true, false]) test(`lost final state commit preserves immutable command log and evidence without replay: ${userEdit ? 'concurrent user edit' : 'unchanged inputs'}`, { timeout: 90000 }, async t => {
  mkdirSync(temporary, { recursive: true });
  const base = mkdtempSync(join(temporary, 'native-durable-finalization-')), root = join(base, 'project'); mkdirSync(root);
  let owner, runner;
  t.after(async () => {
    if (owner?.exitCode === null && owner.signalCode === null) {
      const exited = new Promise(done => owner.once('exit', done)); owner.kill('SIGKILL'); await exited;
    }
    await runner?.dispose(); assert.equal(dirname(resolve(base)), temporary);
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  initialize(root, { project_id: 'WF-LOST-CHECK-COMMIT' });
  writeFileSync(join(root, 'product.txt'), 'complete\n');
  const effect = join(base, 'effect.txt');
  writeFileSync(join(root, 'check.cjs'), `const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('product.txt','utf8'),'complete\\n');fs.writeFileSync(${JSON.stringify(effect)},'exactly once',{flag:'wx'});console.log('COMMITTED_ONCE');\n`);
  const opened = domain.openNativeRequest(root, { requirement: 'Preserve actual command evidence after interrupted publication.', context: ['check.cjs'] });
  domain.planNativeRequest(root, opened.request_ref, { summary: 'One product and one real independent check', requirements: ['Exact complete plus newline'],
    design: 'Independent current reports and direct Node assertion', outputs: ['product.txt'],
    checks: [{ title: 'Once-only independent command', command: [process.execPath, 'check.cjs'], level: 'acceptance' }] });
  for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const job = domain.nextNativeAssignment(root, opened.request_ref);
    domain.recordNativeResult(root, { request_ref: opened.request_ref, assignment_ref: job.assignment_ref,
      raw_result: { content: [{ value: JSON.stringify({ summary: 'Inspected current product independently', verdict: 'pass', findings: [] }) }] },
      invocation: { transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: role,
        native_agent_name: nativeWorkerProfiles[role], host_call_id: randomUUID(), status: 'returned' } });
  }
  const statePath = join(root, '.workforce', requestFolderForWorkflow(root, opened.request_ref).directory, 'native/execution.json');
  const ownerFile = join(base, 'owner.mjs');
  writeFileSync(ownerFile, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{runNativeChecks}from${JSON.stringify(pathToFileURL(resolve('dist/native-request.js')).href)};
const rename=fs.renameSync;fs.renameSync=function(from,to){if(String(to)===${JSON.stringify(statePath)}){const next=JSON.parse(fs.readFileSync(from,'utf8'));if(next.checks?.[0]?.evidence_id){process.send({phase:'after-evidence-before-state'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}}return rename.call(this,from,to);};syncBuiltinESMExports();
await runNativeChecks(${JSON.stringify(root)},${JSON.stringify(opened.request_ref)});\n`);
  const imports = process.execArgv.flatMap((arg, index, argv) => arg === '--import'
    ? ['--import', argv[index + 1].startsWith('file:') ? argv[index + 1] : pathToFileURL(resolve(argv[index + 1])).href] : []);
  owner = spawn(process.execPath, [...imports, ownerFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let checkpoint = false, stderr = '';
  owner.on('message', value => { if (value?.phase === 'after-evidence-before-state') checkpoint = true; });
  owner.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
  await until(() => checkpoint || owner.exitCode !== null); assert.equal(checkpoint, true, stderr);
  const before = domain.getNativeRequest(root, opened.request_ref), executionId = before.checks[0].execution_id;
  assert.equal(before.checks[0].result, undefined); assert.ok(before.checks[0].durable_job);
  const evidence = loadRecords(root).find(record => record.meta.data.execution_id === executionId && record.meta.type === 'evidence');
  assert.ok(evidence); assert.equal(evidence.meta.status, 'verified');
  const evidencePath = join(root, evidence.path), logPath = join(root, evidence.meta.data.log_path);
  const evidenceBytes = readFileSync(evidencePath), logBytes = readFileSync(logPath);
  assert.match(logBytes.toString(), /State: passed/);
  const exited = new Promise(done => owner.once('exit', done)); owner.kill('SIGKILL'); await exited;
  if (userEdit) writeFileSync(join(root, 'product.txt'), 'concurrent user edit\n');
  const calls = [], vscode = { CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {}
  }, lm: { tools: [], invokeTool() { calls.push('model'); assert.fail('No additional model is authorized by a lost command-state acknowledgment.'); } } };
  runner = createLocalRequestRunner(vscode, { ...domain, readConfig, nativeLocalRequestSchema, nativeRequestControlSchema, nativeWorkerProfiles }, root);
  const result = await runner.control({ request_key: opened.request_key, action: 'recheck' }, {});
  assert.deepEqual(readFileSync(logPath), logBytes, 'A changed current revision cannot rewrite the immutable earlier command log.');
  assert.deepEqual(readFileSync(evidencePath), evidenceBytes, 'The already committed independent evidence must retain its exact bytes.');
  assert.equal(result.request.accepted, !userEdit); assert.equal(result.status, userEdit ? 'uncertain' : 'accepted');
  if (userEdit) assert.equal(result.error.code, 'EDITOR_INPUTS_CHANGED');
  else assert.equal(result.error, undefined);
  const after = domain.getNativeRequest(root, opened.request_ref);
  assert.equal(after.checks[0].execution_id, executionId); assert.equal(after.checks[0].result.exit_code, 0);
  assert.equal(after.checks[0].state, userEdit ? 'uncertain' : 'passed'); assert.equal(after.checks[0].evidence_id, evidence.meta.id);
  assert.equal(readFileSync(join(root, 'product.txt'), 'utf8'), userEdit ? 'concurrent user edit\n' : 'complete\n');
  assert.equal(readFileSync(effect, 'utf8'), 'exactly once'); assert.deepEqual(calls, []);
  assert.equal(after.check_history, undefined);
  assert.equal(loadRecords(root).filter(record => record.meta.data.execution_id === executionId && record.meta.type === 'evidence').length, 1);
  await runner.control({ request_key: opened.request_key, action: 'recheck' }, {});
  assert.deepEqual(readFileSync(logPath), logBytes); assert.deepEqual(readFileSync(evidencePath), evidenceBytes);
  assert.equal(readFileSync(effect, 'utf8'), 'exactly once'); assert.deepEqual(calls, []);
});
