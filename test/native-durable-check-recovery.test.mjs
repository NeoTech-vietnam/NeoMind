import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as domain from '../dist/native-request.js';
import { initialize, loadRecords, readConfig, requestFolderForWorkflow } from '../dist/storage.js';
import { readDurableCommandResult } from '../dist/durable-command.js';
import { nativeLocalRequestSchema, nativeRequestControlSchema, nativeWorkerProfiles } from '../dist/native-local-contract.js';

const require = createRequire(import.meta.url), { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const temporary = resolve('artifacts/test-temp');
const pause = ms => new Promise(done => setTimeout(done, ms));
const pass = { content: [{ value: JSON.stringify({ summary: 'Observed independent current product', verdict: 'pass', findings: [] }) }] };
async function until(read, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = read(); if (value) return value; await pause(20); } assert.fail('Owned native command readiness deadline exceeded'); }
function project(t, script, extras = {}) {
  mkdirSync(temporary, { recursive: true }); const base = mkdtempSync(join(temporary, 'native-durable-recovery-')), root = join(base, 'project'); mkdirSync(root);
  const owners = [], runners = []; t.after(async () => { for (const owner of owners) if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    await Promise.all(runners.map(runner => runner.dispose())); assert.equal(dirname(resolve(base)), temporary); rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  initialize(root, { project_id: 'WF-NATIVE-DURABLE' }); writeFileSync(join(root, 'product.txt'), 'complete\n'); writeFileSync(join(root, 'check.cjs'), script(base));
  for (const [path, contents] of Object.entries(extras.files ?? {})) writeFileSync(join(root, path), contents);
  const opened = domain.openNativeRequest(root, { title: 'Retain a real command across its owner death', requirement: 'Preserve one product and current independent evidence', context: ['check.cjs'] });
  domain.planNativeRequest(root, opened.request_ref, { summary: 'Read exact product and execute existing checker', requirements: ['Exact complete plus newline'],
    design: 'One text product with independent roles and direct Node assertions', outputs: ['product.txt'], checks: [{ title: 'Real once-only effect check', command: [process.execPath, 'check.cjs'], level: 'acceptance' }, ...(extras.checks ?? [])] });
  for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) { const job = domain.nextNativeAssignment(root, opened.request_ref);
    domain.recordNativeResult(root, { request_ref: opened.request_ref, assignment_ref: job.assignment_ref, raw_result: pass,
      invocation: { transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: role, native_agent_name: nativeWorkerProfiles[role], host_call_id: randomUUID(), status: 'returned' } }); }
  const calls = [], vscode = { CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
    lm: { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'], properties: Object.fromEntries(['agentName', 'prompt', 'description'].map(n => [n, { type: 'string' }])) } }],
      invokeTool() { calls.push('model'); assert.fail('Retained current independent evidence must not invoke another model'); } } };
  const runner = () => { const result = createLocalRequestRunner(vscode, { ...domain, readConfig, nativeLocalRequestSchema, nativeRequestControlSchema, nativeWorkerProfiles }, root); runners.push(result); return result; };
  return { base, root, opened, owners, runner, calls, saved: () => domain.getNativeRequest(root, opened.request_ref) };
}
function launchOwner(app, body) {
  const ownerFile = join(app.base, 'owner-' + randomUUID() + '.mjs');
  writeFileSync(ownerFile, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import*as domain from${JSON.stringify(pathToFileURL(resolve('dist/native-request.js')).href)};\n` + body);
  const imports = process.execArgv.flatMap((arg, index, argv) => arg === '--import'
    ? ['--import', argv[index + 1].startsWith('file:') ? argv[index + 1] : pathToFileURL(resolve(argv[index + 1])).href] : []);
  const owner = spawn(process.execPath, [...imports, ownerFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); app.owners.push(owner); return owner;
}
const binding = (state, check) => ({ workflow_id: state.request_ref, epoch_id: `${state.plan_hash}:${check.durable_generation}`,
  attempt_id: check.execution_id, operation_id: check.record_id, kind: 'check' });

// Native model outcomes are controlled above; the owner, checker and guardian
// processes and filesystem effects below are actual OS execution.
test('a real completed checker survives owner kill before record finalization and closes the same request without repeating its effect', { timeout: 90000 }, async t => {
  const app = project(t, base => `const fs=require('node:fs'),assert=require('node:assert/strict');
fs.writeFileSync(${JSON.stringify(join(base, 'effect.txt'))},'exactly once',{flag:'wx'});
assert.equal(fs.readFileSync('product.txt','utf8'),'complete\\n');console.log('REAL_NATIVE_EFFECT_ONCE');\n`);
  const ownerFile = join(app.base, 'owner.mjs'), moduleUrl = pathToFileURL(resolve('dist/native-request.js')).href;
  writeFileSync(ownerFile, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{runNativeChecks}from${JSON.stringify(moduleUrl)};
const rename=fs.renameSync;fs.renameSync=function(from,to){if(String(to).endsWith('.log')){process.send({phase:'before-log-finalization'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}return rename.call(this,from,to);};syncBuiltinESMExports();
await runNativeChecks(${JSON.stringify(app.root)},${JSON.stringify(app.opened.request_ref)});\n`);
  const imports = process.execArgv.flatMap((arg, index, argv) => arg === '--import'
    ? ['--import', argv[index + 1].startsWith('file:') ? argv[index + 1] : pathToFileURL(resolve(argv[index + 1])).href] : []);
  const owner = spawn(process.execPath, [...imports, ownerFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); app.owners.push(owner);
  let blocked = false, stderr = ''; owner.on('message', m => { if (m?.phase === 'before-log-finalization') blocked = true; }); owner.stderr.on('data', bytes => { if (stderr.length < 8192) stderr += bytes; });
  await until(() => blocked || owner.exitCode !== null); assert.equal(blocked, true, stderr);
  assert.equal(readFileSync(join(app.base, 'effect.txt'), 'utf8'), 'exactly once');
  const before = app.saved(); assert.equal(before.checks[0].state, 'running'); assert.equal(before.checks[0].result, undefined);
  const exited = new Promise(done => owner.once('exit', done)); owner.kill('SIGKILL'); await exited;
  const foreign = domain.openNativeRequest(app.root, { title: 'Foreign request', requirement: 'Do not borrow another execution', context: ['check.cjs'] });
  domain.planNativeRequest(app.root, foreign.request_ref, { ...before.plan, outputs: ['foreign/product.txt'] });
  const foreignPath = join(app.root, '.workforce', requestFolderForWorkflow(app.root, foreign.request_ref).directory, 'native/execution.json');
  const foreignState = JSON.parse(readFileSync(foreignPath, 'utf8'));
  for (const name of ['execution_id', 'durable_job', 'durable_generation', 'baseline', 'generated_inputs']) foreignState.checks[0][name] = before.checks[0][name];
  foreignState.checks[0].state = 'running'; writeFileSync(foreignPath, JSON.stringify(foreignState, null, 2) + '\n');
  const rejected = await app.runner().control({ request_key: foreign.request_key, action: 'recheck' }, {});
  assert.equal(rejected.error.code, 'EDITOR_EFFECTS_UNCONFIRMED'); assert.equal(rejected.request.accepted, false);
  assert.equal(app.saved().checks[0].result, undefined, 'Foreign binding cannot consume or relabel the original command outcome');
  const physical = realpathSync.native(app.root), identity = `${userInfo().username}\0${process.platform === 'win32' ? physical.toLowerCase() : physical}`;
  const resultPath = join(app.base, '.workforce-private', require('node:crypto').createHash('sha256').update(identity).digest('hex'), 'commands', before.checks[0].durable_job.id, 'result.json');
  const originalReceipt = readFileSync(resultPath), altered = JSON.parse(originalReceipt); altered.payload.result.stdout += 'FORGED';
  writeFileSync(resultPath, JSON.stringify(altered));
  const unauthenticated = await app.runner().control({ request_key: before.request_key, action: 'recheck' }, {});
  assert.equal(unauthenticated.error.code, 'EDITOR_EFFECTS_UNCONFIRMED'); assert.equal(unauthenticated.request.accepted, false);
  assert.equal(app.saved().checks[0].result, undefined); assert.equal(readFileSync(join(app.base, 'effect.txt'), 'utf8'), 'exactly once');
  writeFileSync(resultPath, originalReceipt);
  const result = await app.runner().control({ request_key: before.request_key, action: 'recheck' }, {});
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  const after = app.saved(); assert.equal(after.request_ref, before.request_ref); assert.equal(after.checks[0].execution_id, before.checks[0].execution_id);
  assert.equal(after.checks[0].result.exit_code, 0); assert.match(after.checks[0].result.stdout, /REAL_NATIVE_EFFECT_ONCE/);
  assert.ok(after.checks[0].durable_job); assert.deepEqual(app.calls, []); assert.equal(after.assignments.length, 3);
  assert.equal(readFileSync(join(app.base, 'effect.txt'), 'utf8'), 'exactly once'); assert.equal(after.check_history, undefined);
  assert.equal(loadRecords(app.root).filter(r => r.meta.data.kind === 'workforce-request').length, 2, 'Only the intentional foreign negative request was added');
});

test('owner disconnect stops a real checker and same-request recovery runs one fresh check without another model', { timeout: 90000 }, async t => {
  const app = project(t, base => `const fs=require('node:fs'),assert=require('node:assert/strict');
const path=${JSON.stringify(join(base, 'starts.txt'))};fs.appendFileSync(path,'start\\n');
if(fs.readFileSync(path,'utf8').trim().split(/\\n/).length===1){fs.writeFileSync(${JSON.stringify(join(base, 'started.json'))},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);}
else{assert.equal(fs.readFileSync('product.txt','utf8'),'complete\\n');fs.writeFileSync(${JSON.stringify(join(base, 'committed.txt'))},'once',{flag:'wx'});console.log('FRESH_NATIVE_DURABLE_CHECK');}\n`);
  const owner = launchOwner(app, `await domain.runNativeChecks(${JSON.stringify(app.root)},${JSON.stringify(app.opened.request_ref)});\n`);
  await until(() => existsSync(join(app.base, 'started.json'))); const before = app.saved(); assert.ok(before.checks[0].durable_job);
  const exited = new Promise(done => owner.once('exit', done)); owner.kill('SIGKILL'); await exited;
  const receipt = await until(() => readDurableCommandResult(app.root, before.checks[0].durable_job, binding(before, before.checks[0])));
  assert.equal(receipt.durable_reason, 'owner-disconnected'); assert.equal(receipt.cancelled, true);
  assert.ok(receipt.exit_code !== null || receipt.signal !== null, 'The actual checker close must be observed');
  const result = await app.runner().control({ request_key: before.request_key, action: 'recheck' }, {});
  assert.equal(result.status, 'accepted', JSON.stringify(result)); const after = app.saved();
  assert.equal(after.check_history.length, 1); assert.equal(after.check_history[0].execution_id, before.checks[0].execution_id);
  assert.notEqual(after.checks[0].execution_id, before.checks[0].execution_id); assert.equal(after.checks[0].result.exit_code, 0);
  assert.equal(readFileSync(join(app.base, 'starts.txt'), 'utf8'), 'start\nstart\n'); assert.equal(readFileSync(join(app.base, 'committed.txt'), 'utf8'), 'once');
  assert.deepEqual(app.calls, []); assert.equal(after.assignments.length, 3); assert.equal(after.request_ref, before.request_ref);
});

test('a signed caller cancellation cannot become editor recovery when its owner dies before finalization', { timeout: 90000 }, async t => {
  const app = project(t, base => `require('node:fs').writeFileSync(${JSON.stringify(join(base, 'started.json'))},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n`);
  const owner = launchOwner(app, `const cancel=new AbortController();process.on('message',m=>{if(m?.cancel)cancel.abort();});const rename=fs.renameSync;
fs.renameSync=function(from,to){if(String(to).endsWith('.log')){process.send({phase:'before-log-finalization'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}return rename.call(this,from,to);};syncBuiltinESMExports();
await domain.runNativeChecks(${JSON.stringify(app.root)},${JSON.stringify(app.opened.request_ref)},{signal:cancel.signal});\n`);
  let blocked = false; owner.on('message', m => { if (m?.phase === 'before-log-finalization') blocked = true; });
  await until(() => existsSync(join(app.base, 'started.json')));
  const early = await app.runner().control({ request_key: app.opened.request_key, action: 'recheck' }, {});
  assert.equal(early.error.code, 'EDITOR_EFFECTS_UNCONFIRMED'); assert.equal(app.saved().checks[0].result, undefined);
  owner.send({ cancel: true }); await until(() => blocked);
  const before = app.saved(), exited = new Promise(done => owner.once('exit', done)); owner.kill('SIGKILL'); await exited;
  const result = await app.runner().control({ request_key: before.request_key, action: 'recheck' }, {});
  assert.equal(result.error.code, 'NATIVE_CHECK_CANCELLED'); assert.equal(result.status, 'cancelled'); assert.deepEqual(app.calls, []);
  const after = app.saved(); assert.equal(after.checks[0].execution_id, before.checks[0].execution_id);
  assert.equal(after.check_history, undefined); assert.equal(after.editor_generation, undefined); assert.equal(after.accepted, false);
  assert.equal(after.interruption, undefined, 'Authenticated caller cancellation resolves only the prior effects uncertainty');
  assert.equal(after.interruption_history.at(-1).code, 'EDITOR_EFFECTS_UNCONFIRMED');
});

test('a newer controller continues only unstarted checks and a late old controller cannot interrupt it', { timeout: 90000 }, async t => {
  const firstEffect = base => join(base, 'first-effect.txt');
  const app = project(t, base => `require('node:fs').writeFileSync(${JSON.stringify(firstEffect(base))},'once',{flag:'wx'});console.log('FIRST_COMPLETE');\n`, {
    files: { 'second.cjs': "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'complete\\n');console.log('SECOND_COMPLETE');\n" },
    checks: [{ title: 'Second independent check', command: [process.execPath, 'second.cjs'], level: 'acceptance' }],
  });
  const release = join(app.base, 'release-old-owner'), messages = [];
  const owner = launchOwner(app, `const read=fs.readFileSync;let paused=false;fs.readFileSync=function(path,...args){const bytes=read.call(this,path,...args);if(!paused&&String(path).endsWith('result.json')){paused=true;process.send({phase:'receipt-ready'});while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}return bytes;};syncBuiltinESMExports();
try{await domain.runNativeChecks(${JSON.stringify(app.root)},${JSON.stringify(app.opened.request_ref)});}catch(e){process.send({old_error:e.code});try{domain.interruptNativeRequest(${JSON.stringify(app.root)},${JSON.stringify(app.opened.request_ref)},{code:'NATIVE_BACKEND_FAILED',category:'backend',editor_generation:0});}catch(stale){process.send({stale_interrupt:stale.code});}}process.disconnect();\n`);
  owner.on('message', m => messages.push(m)); await until(() => messages.some(m => m.phase === 'receipt-ready'));
  const result = await app.runner().control({ request_key: app.opened.request_key, action: 'recheck' }, {});
  assert.equal(result.status, 'accepted', JSON.stringify(result)); const after = app.saved(); assert.equal(after.editor_generation, 1);
  const statePath = join(app.root, '.workforce', requestFolderForWorkflow(app.root, app.opened.request_ref).directory, 'native/execution.json');
  const savedBytes = readFileSync(statePath), exited = new Promise(done => owner.once('exit', done)); writeFileSync(release, 'release'); await exited;
  assert.equal(messages.some(m => m.old_error === 'EDITOR_OWNERSHIP_CHANGED'), true);
  assert.equal(messages.some(m => m.stale_interrupt === 'EDITOR_OWNERSHIP_CHANGED'), true);
  assert.deepEqual(readFileSync(statePath), savedBytes); assert.equal(app.saved().interruption, undefined);
  assert.equal(readFileSync(firstEffect(app.base), 'utf8'), 'once'); assert.deepEqual(app.calls, []);
  assert.equal(after.check_history, undefined); assert.equal(after.checks.length, 2); assert.ok(after.checks.every(check => check.result.exit_code === 0));
});

test('real editor disposal intent survives owner death after signed cancellation but before its outer checkpoint', { timeout: 90000 }, async t => {
  const app = project(t, base => `const fs=require('node:fs');const path=${JSON.stringify(join(base, 'starts.txt'))};fs.appendFileSync(path,'start\\n');
if(fs.readFileSync(path,'utf8').trim().split(/\\n/).length===1){fs.writeFileSync(${JSON.stringify(join(base, 'started.json'))},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);}else{fs.writeFileSync(${JSON.stringify(join(base, 'committed.txt'))},'once',{flag:'wx'});console.log('FRESH_AFTER_EDITOR_DISPOSAL');}\n`);
  // Prepare only the existing check phase through public backend controls.
  // All professional outcomes were already retained; no model is simulated live.
  domain.interruptNativeRequest(app.root, app.opened.request_ref, { code: 'EDITOR_CLOSED', category: 'cancellation' });
  domain.recheckNativeRequest(app.root, app.opened.request_ref);
  const requestUrl = pathToFileURL(resolve('dist/native-local-contract.js')).href, storageUrl = pathToFileURL(resolve('dist/storage.js')).href,
    runnerPath = resolve('extensions/vscode-model-bridge/local-request.cjs');
  const owner = launchOwner(app, `import{createRequire}from'node:module';import*as contract from${JSON.stringify(requestUrl)};import{readConfig}from${JSON.stringify(storageUrl)};
const{createLocalRequestRunner}=createRequire(import.meta.url)(${JSON.stringify(runnerPath)});const vscode={CancellationTokenSource:class{constructor(){const fns=new Set();this.token={isCancellationRequested:false,onCancellationRequested:fn=>{fns.add(fn);return{dispose:()=>fns.delete(fn)}}};this.cancel=()=>{this.token.isCancellationRequested=true;for(const fn of fns)fn();};}dispose(){}},lm:{tools:[],invokeTool(){throw new Error('No model expected');}}};
const runner=createLocalRequestRunner(vscode,{...domain,...contract,readConfig},${JSON.stringify(app.root)});process.on('message',m=>{if(m?.dispose)void runner.dispose();});const rename=fs.renameSync;
fs.renameSync=function(from,to){if(String(to).endsWith('.log')){process.send({phase:'before-log-finalization'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}return rename.call(this,from,to);};syncBuiltinESMExports();
await runner.control({request_key:${JSON.stringify(app.opened.request_key)},action:'recheck'},{});process.disconnect();\n`);
  let blocked = false; owner.on('message', m => { if (m?.phase === 'before-log-finalization') blocked = true; });
  await until(() => existsSync(join(app.base, 'started.json'))); owner.send({ dispose: true }); await until(() => blocked);
  const before = app.saved(); assert.equal(before.interruption.code, 'EDITOR_CLOSED'); assert.equal(before.interruption.editor_checkpoint, undefined);
  const receipt = readDurableCommandResult(app.root, before.checks[0].durable_job, binding(before, before.checks[0]));
  assert.equal(receipt.durable_reason, 'cancelled', 'This is the signed ordinary cancellation race, not raw owner-disconnect inference');
  const exited = new Promise(done => owner.once('exit', done)); owner.kill('SIGKILL'); await exited;
  const result = await app.runner().control({ request_key: before.request_key, action: 'recheck' }, {});
  assert.equal(result.status, 'accepted', JSON.stringify(result)); const after = app.saved();
  assert.equal(after.check_history[0].execution_id, before.checks[0].execution_id);
  assert.equal(after.assignments.length, 3); assert.deepEqual(app.calls, []); assert.equal(after.repair_attempts, before.repair_attempts);
  assert.equal(readFileSync(join(app.base, 'starts.txt'), 'utf8'), 'start\nstart\n'); assert.equal(readFileSync(join(app.base, 'committed.txt'), 'utf8'), 'once');
});
