import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openCodeConfiguration, openCodeStorage, reconcileOpenCodeOwner } from '../dist/opencode-engine.js';

const temporary = resolve('artifacts/test-temp'), moduleURL = new URL('../dist/opencode-engine.js', import.meta.url).href;
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
function fixture(t) {
  mkdirSync(temporary, { recursive: true }); const root = mkdtempSync(join(temporary, 'wf-owner-supervision-')), storage = openCodeStorage(root).path;
  t.after(() => { assert.equal(dirname(root), temporary); assert.equal(dirname(storage), join(temporary, '.workforce-private'));
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, storage, invocation: randomUUID(), prepared: join(root, 'prepared.json'), ready: join(root, 'ready.json') };
}
async function until(read, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(50); }
  assert.fail('Timed out waiting for actual engine supervision evidence.');
}
function owner(t, root, script) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-4096); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, error: () => error };
}
const config = () => ({ ...openCodeConfiguration({ model: 'worker-models', provider: 'fixture', baseURL: 'http://127.0.0.1:1/v1' },
  { url: 'http://127.0.0.1:1/mcp', authorization: 'Bearer fixture-only' }, []), mcp: {} });

test('actual editor-owner SIGKILL stops the pinned engine and retains authenticated ended proof and session DB', { timeout: 120000 }, async t => {
  const fixtureData = fixture(t), { root, storage, invocation, prepared, ready } = fixtureData;
  const script = `import{startOpenCodeEngine}from${JSON.stringify(moduleURL)};import{writeFileSync}from'node:fs';
const engine=await startOpenCodeEngine(${JSON.stringify(root)},${JSON.stringify(invocation)},${JSON.stringify(config())},undefined,{onPrepared:ref=>writeFileSync(${JSON.stringify(prepared)},JSON.stringify(ref))});
const health=await engine.client.global.health();writeFileSync(${JSON.stringify(ready)},JSON.stringify({ref:engine.supervision,directory:engine.directory,healthy:health.data.healthy}));await new Promise(()=>{});`;
  const running = owner(t, root, script);
  await until(() => { if (running.child.exitCode !== null) assert.fail(`Owner exited before readiness: ${running.error()}`); return existsSync(ready); });
  const actual = JSON.parse(readFileSync(ready, 'utf8')), initial = JSON.parse(readFileSync(prepared, 'utf8'));
  assert.equal(actual.healthy, true); assert.equal(initial.engine, undefined, 'Controller checkpoint precedes the actual engine.');
  assert.ok(actual.ref.engine.pid > 0); assert.match(actual.ref.engine.created_at, /^(win32|linux):/);
  assert.equal(running.child.kill('SIGKILL'), true);
  const reconciled = await until(async () => { const state = await reconcileOpenCodeOwner(root, initial); return state.state === 'stopped' && state; }, 15000);
  assert.match(reconciled.proof_sha256, /^[a-f0-9]{64}$/);
  assert.equal((await reconcileOpenCodeOwner(root, { ...initial, owner: { created_at: initial.owner.created_at, pid: initial.owner.pid } })).state, 'stopped');
  const path = join(storage, `opencode-${invocation}`, 'supervision/ended.json'), proof = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(proof.payload.actual_exit_observed, true); assert.equal(proof.payload.engine_never_started, false); assert.equal(proof.payload.process_tree_closed, true);
  assert.deepEqual(proof.payload.engine, actual.ref.engine);
  assert.equal(existsSync(join(actual.directory, 'data/opencode/opencode.db')), true);
  assert.equal(existsSync(join(actual.directory, 'config/opencode/node_modules')), false);
  assert.equal(JSON.parse(readFileSync(join(actual.directory, 'bootstrap-cleanup.json'), 'utf8')).cleaned, true);
  const readyProof = JSON.parse(readFileSync(join(storage, `opencode-${invocation}`, 'supervision/ready.json'), 'utf8'));
  if (process.platform === 'linux') {
    // An ephemeral TCP port may already belong to the next concurrent engine.
    // Check the owned process creation itself; an address alone is not identity.
    try {
      const stat = readFileSync(`/proc/${actual.ref.engine.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const current = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`;
      assert.ok(current !== actual.ref.engine.created_at || ['Z', 'X'].includes(fields[0]), 'The original engine creation must have stopped.');
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  } else {
    await assert.rejects(fetch(`${readyProof.payload.url}/global/health`, { signal: AbortSignal.timeout(1000) }));
  }
  assert.equal((await reconcileOpenCodeOwner(root, { ...actual.ref, engine: { ...actual.ref.engine, created_at: 'another-process-creation' } })).state, 'uncertain');
  proof.payload.engine.pid++; writeFileSync(path, JSON.stringify(proof));
  assert.equal((await reconcileOpenCodeOwner(root, initial)).state, 'uncertain', 'Tampered ended bytes cannot establish shutdown.');
});

test('owner crash after durable preparation but before admit proves no engine started without claiming an observed process exit', { timeout: 120000 }, async t => {
  const { root, storage, invocation, prepared } = fixture(t);
  const script = `import{startOpenCodeEngine}from${JSON.stringify(moduleURL)};import{writeFileSync}from'node:fs';
await startOpenCodeEngine(${JSON.stringify(root)},${JSON.stringify(invocation)},${JSON.stringify(config())},undefined,{onPrepared:async ref=>{writeFileSync(${JSON.stringify(prepared)},JSON.stringify(ref));await new Promise(()=>{});}});`;
  const running = owner(t, root, script);
  await until(() => { if (running.child.exitCode !== null) assert.fail(`Owner exited before preparation: ${running.error()}`); return existsSync(prepared); });
  const ref = JSON.parse(readFileSync(prepared, 'utf8'));
  assert.equal(running.child.kill('SIGKILL'), true);
  await until(async () => (await reconcileOpenCodeOwner(root, ref)).state === 'stopped', 15000);
  const directory = join(storage, `opencode-${invocation}`), proof = JSON.parse(readFileSync(join(directory, 'supervision/ended.json'), 'utf8'));
  assert.equal(proof.payload.engine_never_started, true); assert.equal(proof.payload.actual_exit_observed, false); assert.equal(proof.payload.engine, null);
  assert.equal(existsSync(join(directory, 'supervision/ready.json')), false);
  assert.equal(existsSync(join(directory, 'data/opencode/opencode.db')), false);
  assert.equal(existsSync(join(directory, 'config/opencode/node_modules')), false);
});

test('actual guardian kills adversarial owned child and grandchild processes before authenticating tree shutdown', { timeout: 60000 }, async t => {
  const { root, storage, invocation, prepared, ready } = fixture(t), heartbeat = join(root, 'heartbeat.txt'), grandchild = join(root, 'grandchild.json');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(process.env.WF_GRANDCHILD,JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync(process.env.WF_HEARTBEAT,'g'),30);`;
  const nested = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>require('node:fs').appendFileSync(process.env.WF_HEARTBEAT,'c'),30);`;
  const server = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:'inherit'});require('node:http').createServer((q,s)=>s.end('fixture')).listen(0,'127.0.0.1',function(){console.log('opencode server listening on http://127.0.0.1:'+this.address().port)});`;
  // A trusted host process fixture exercises the actual same OS guardian with
  // Node source children. It is not a model/provider execution or pin proof.
  const script = `import{runOpenCodeOwnerSupervisor,openCodeStorage}from${JSON.stringify(moduleURL)};import{secureHostPrivateDirectory}from${JSON.stringify(new URL('../dist/vscode-wire.js', import.meta.url).href)};
import{commandEnvironment}from${JSON.stringify(new URL('../dist/command-runner.js', import.meta.url).href)};import{createHash,createHmac,randomBytes}from'node:crypto';import{writeFileSync,readFileSync,mkdirSync}from'node:fs';import{dirname,join}from'node:path';import{spawn,spawnSync}from'node:child_process';
const root=${JSON.stringify(root)},invocation=${JSON.stringify(invocation)},base=openCodeStorage(root).path,directory=join(base,'opencode-'+invocation),path=join(directory,'supervision');for(const p of[dirname(base),base,directory,path])secureHostPrivateDirectory(p);mkdirSync(join(directory,'config/opencode'),{recursive:true});mkdirSync(join(directory,'tmp'));writeFileSync(join(directory,'package.json'),JSON.stringify({type:'commonjs'}));writeFileSync(join(directory,'serve'),${JSON.stringify(server)});
const hash=v=>createHash('sha256').update(v).digest('hex');let birth;if(process.platform==='win32'){const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Diagnostics.Process]::GetProcessById('+process.pid+').StartTime.ToUniversalTime().ToFileTimeUtc().ToString()'],{encoding:'utf8',windowsHide:true});birth='win32:'+r.stdout.trim();}else{const s=readFileSync('/proc/'+process.pid+'/stat','utf8');birth='linux:'+readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+s.slice(s.lastIndexOf(')')+2).split(' ')[19];}
const key=randomBytes(32),instance=randomBytes(32).toString('hex'),spec={schema_version:1,root,invocation_id:invocation,instance,owner:{pid:process.pid,created_at:birth},binary:{path:process.execPath,sha256:hash(readFileSync(process.execPath))},directory,config_directory:join(directory,'config/opencode'),env:commandEnvironment({TEMP:join(directory,'tmp'),TMP:join(directory,'tmp'),TMPDIR:join(directory,'tmp'),WF_HEARTBEAT:${JSON.stringify(heartbeat)},WF_GRANDCHILD:${JSON.stringify(grandchild)}}),module_sha256:hash(readFileSync(new URL(${JSON.stringify(moduleURL)})))};
const bytes=JSON.stringify(spec)+String.fromCharCode(10),ref={schema_version:1,invocation_id:invocation,instance,owner:spec.owner,spec_sha256:hash(bytes),spec_hmac:createHmac('sha256',key).update('workforce-engine-spec-v1'+String.fromCharCode(0)).update(bytes).digest('hex')};writeFileSync(join(path,'key.bin'),key,{mode:0o600});writeFileSync(join(path,'spec.json'),bytes,{mode:0o600});writeFileSync(${JSON.stringify(prepared)},JSON.stringify(ref));
const main='import{runOpenCodeOwnerSupervisor}from'+JSON.stringify(${JSON.stringify(moduleURL)})+';await runOpenCodeOwnerSupervisor(process.argv[1],JSON.parse(process.argv[2]));';
const watcher=spawn(process.execPath,['--input-type=module','-e',main,root,JSON.stringify(ref)],{cwd:directory,detached:true,windowsHide:true,env:commandEnvironment({TEMP:join(directory,'tmp'),TMP:join(directory,'tmp'),TMPDIR:join(directory,'tmp')}),stdio:['ignore','ignore','ignore','ipc']});watcher.on('message',m=>{if(m.type==='waiting')watcher.send({type:'admit',instance});if(m.type==='ready')writeFileSync(${JSON.stringify(ready)},JSON.stringify(m));});await new Promise(()=>{});`;
  const running = owner(t, root, script);
  await until(() => { if (running.child.exitCode !== null) assert.fail(`Owner fixture exited: ${running.error()}`); return existsSync(ready) && existsSync(grandchild) && existsSync(heartbeat); }, 30000);
  const ref = JSON.parse(readFileSync(prepared, 'utf8'));
  assert.equal(running.child.kill('SIGKILL'), true);
  await until(async () => (await reconcileOpenCodeOwner(root, ref)).state === 'stopped', 15000);
  const stopped = readFileSync(heartbeat, 'utf8'); await pause(300);
  assert.equal(readFileSync(heartbeat, 'utf8'), stopped, 'Every child/grandchild stopped before the authenticated ended proof.');
  const proof = JSON.parse(readFileSync(join(storage, `opencode-${invocation}`, 'supervision/ended.json'), 'utf8'));
  assert.equal(proof.payload.process_tree_closed, true); assert.equal(proof.payload.actual_exit_observed, true);
});
