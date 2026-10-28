import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { initialize, createRecord } from '../dist/storage.js';
import { initializeLegacy } from './helpers/legacy-project.mjs';
import { hostRequest, readHost, serveHost } from '../dist/vscode-wire.js';
import { stableHostDescriptorPath } from '../dist/host-authority.js';

const temporary = resolve('artifacts/test-temp'), wire = new URL('../dist/vscode-wire.js', import.meta.url).href;
const children = new Map();
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', done); });
}
function project(t, legacy = false) {
  mkdirSync(temporary, { recursive: true }); const base = mkdtempSync(join(temporary, 'wf-host-authority-'));
  const root = join(base, 'project'), a = join(base, 'temp-a'), b = join(base, 'temp-b');
  for (const path of [root, a, b]) mkdirSync(path);
  if (legacy) {
    initializeLegacy(root); createRecord(root, { type: 'knowledge', title: 'Preserved historical migration input', body: 'Original bytes.\n' });
    const path = join(root, '.neomind/config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...config, execution_engine: 'opencode' }, null, 2) + '\n');
  } else initialize(root, { execution_engine: 'opencode' });
  const privateRoot = dirname(dirname(stableHostDescriptorPath(root)));
  children.set(root, []);
  t.after(async () => { for (const child of children.get(root) ?? []) await stopChild(child); children.delete(root);
    assert.equal(dirname(base), temporary); assert.equal(dirname(dirname(privateRoot)), base);
    rmSync(privateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, a, b, base };
}
function child(t, root, temporaryDirectory, source) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', source, root], { cwd: root, windowsHide: true,
    env: { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; processChild.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
  children.get(root)?.push(processChild);
  t.after(() => stopChild(processChild));
  const message = () => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host fixture response timed out: ${stderr}`)), 60000);
    processChild.once('message', value => { clearTimeout(timer); done(value); });
    processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`Host fixture exited ${code}: ${stderr}`)); });
  });
  return { process: processChild, message };
}
const ownerScript = `import{serveHost,readHost}from${JSON.stringify(wire)};
const host=await serveHost(process.argv[1],async(operation,input)=>({owner:process.pid,operation,value:input.value}));
process.send({ready:true,instance:host.instance,pid:process.pid});process.on('message',async value=>{if(value==='close'){await host.close();process.send({closed:true},()=>process.disconnect());}});`;

test('different TEMP processes discover one stable owner and cannot publish a second host for the same WorkForce project', { timeout: 120000 }, async t => {
  const { root, a, b } = project(t), owner = child(t, root, a, ownerScript), ready = await owner.message();
  assert.equal(ready.ready, true);
  const descriptor = readHost(root); assert.equal(descriptor.instance, ready.instance);
  assert.match(descriptor.owner_created_at, /^(?:win32:\d+|linux:[a-f0-9-]{36}:\d+)$/);
  assert.equal(stableHostDescriptorPath(root).includes('temp-a'), false);
  const client = child(t, root, b, `import{readHost,hostRequest,serveHost}from${JSON.stringify(wire)};
const root=process.argv[1],descriptor=readHost(root);const result=await hostRequest(descriptor,'poll',{value:'cross-temp'});
let refused=false;try{const unexpected=await serveHost(root,async()=>({}));await unexpected.close();}catch(error){refused=/owner is active|already enabled/.test(error.message);}
process.send({instance:descriptor.instance,result,refused},()=>process.disconnect());`);
  const result = await client.message();
  assert.equal(result.instance, ready.instance); assert.equal(result.result.owner, ready.pid);
  assert.equal(result.result.value, 'cross-temp'); assert.equal(result.refused, true);
  assert.equal((await hostRequest(readHost(root), 'poll', { value: 'still-original' })).owner, ready.pid);
  const closing = owner.message(); owner.process.send('close'); await closing;
});

test('upgrade and storage migration reject an idle stable owner launched with another TEMP before touching package or history bytes', { timeout: 120000 }, async t => {
  const { root, a, b } = project(t, true), owner = child(t, root, a, ownerScript); await owner.message();
  const manifest = { name: 'host-authority-consumer', version: '1.0.0', devDependencies: { workforce: '0.2.0-alpha.1' } };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  mkdirSync(join(root, 'node_modules/workforce/dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules/workforce/package.json'), JSON.stringify({ name: 'workforce', version: '0.2.0-alpha.1', bin: { workforce: 'dist/cli.js' } }));
  writeFileSync(join(root, 'node_modules/workforce/dist/cli.js'), 'Original installed sentinel.');
  const npm = join(root, 'fixture-npm.mjs'), marker = join(root, 'npm-must-not-run');
  writeFileSync(npm, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(99);`);
  const before = readFileSync(join(root, '.neomind/config.json'));
  const client = child(t, root, b, `import{upgradeProject}from${JSON.stringify(new URL('../dist/upgrade.js', import.meta.url).href)};
import{migrateStorage}from${JSON.stringify(new URL('../dist/migration.js', import.meta.url).href)};
const root=process.argv[1];let upgrade=false,migration=false;
try{upgradeProject(root,'0.2.0-alpha.2',{npm_cli:${JSON.stringify(npm)}});}catch(error){upgrade=/owner is active/.test(error.message);}
try{migrateStorage(root,{activate_workforce:true});}catch(error){migration=/owner is active/.test(error.message);}
process.send({upgrade,migration},()=>process.disconnect());`);
  assert.deepEqual(await client.message(), { upgrade: true, migration: true });
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(root, '.workforce')), false);
  assert.deepEqual(readFileSync(join(root, '.neomind/config.json')), before);
  assert.equal(readFileSync(join(root, 'node_modules/workforce/dist/cli.js'), 'utf8'), 'Original installed sentinel.');
  const closing = owner.message(); owner.process.send('close'); await closing;
});

test('an indeterminate stable creation identity is never reclaimed merely because its PID is present', { timeout: 60000 }, async t => {
  const { root } = project(t), host = await serveHost(root, async () => ({})), descriptor = readHost(root);
  await host.close(); const path = stableHostDescriptorPath(root);
  const bytes = JSON.stringify({ ...descriptor, owner_created_at: 'indeterminate' }); writeFileSync(path, bytes, { mode: 0o600 });
  await assert.rejects(serveHost(root, async () => ({})), /indeterminate/);
  assert.equal(readFileSync(path, 'utf8'), bytes, 'Unknown identity never authorizes unlinking the previous authority.');
});

test('an actual exited owner can be replaced across TEMP only after its original creation identity is proved absent', { timeout: 60000 }, async t => {
  const { root, a } = project(t), owner = child(t, root, a, ownerScript); await owner.message();
  const previous = readHost(root), path = stableHostDescriptorPath(root);
  const exited = new Promise(done => owner.process.once('exit', done)); owner.process.kill('SIGKILL'); await exited;
  assert.equal(existsSync(path), true, 'A crash leaves the durable authority to reconcile.');
  const replacement = await serveHost(root, async () => ({ replacement: true }));
  try {
    const current = readHost(root); assert.notEqual(current.instance, previous.instance);
    assert.equal(current.pid, process.pid); assert.notEqual(current.owner_created_at, previous.owner_created_at);
    assert.equal((await hostRequest(current, 'poll', {})).replacement, true);
  } finally { await replacement.close(); }
});
