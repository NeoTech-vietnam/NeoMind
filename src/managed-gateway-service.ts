import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createManagedGatewayClient, type ManagedGatewayPolicy } from './managed-gateway-client.js';
import { routerBaseUrl } from './router-probe.js';
import { gatewayHash, initializeManagedGatewayRoot, managedGatewayPath, ManagedGatewayError,
  readManagedGatewayJson, verifyManagedGatewayArtifact, writeManagedGatewayJson } from './managed-gateway-artifact.js';

export interface ManagedGatewaySecretStore { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void> }
export interface ManagedGatewayServiceOptions { privateRoot: string; nodeCommand: string; secretStore: ManagedGatewaySecretStore; artifact?: string }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: unknown) => { try { if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false; process.kill(Number(pid), 0); return true; } catch { return false; } };
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback port.');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
/** Owns the shipped upstream process; no accounts are imported, no CLI hooks
 * run, and model requests are not repeated by this lifecycle service. */
export function createManagedGatewayService(options: ManagedGatewayServiceOptions) {
  const root = initializeManagedGatewayRoot(options.privateRoot), prefix = `workforce.gateway.${gatewayHash(root)}`;
  if (!isAbsolute(options.nodeCommand) || !lstatSync(options.nodeCommand).isFile()) throw new ManagedGatewayError('GATEWAY_NODE_REQUIRED', 'Select an installed supported Node executable for the managed gateway.');
  let child: ChildProcess | undefined, starting: Promise<{ baseUrl: string; generation: string }> | undefined;
  let endpoint: { baseUrl: string; generation: string } | undefined, adminCookie: string | undefined, apiKey: string | undefined;
  let selectedArtifact = options.artifact, stopped = false;
  const active = new Map<string, AbortController>();
  const preparingCombos = new Map<string, Promise<string>>();
  const clientId = randomUUID(), registration = `clients/${clientId}.json`;
  function registerClient() {
    if (!existsSync(managedGatewayPath(root, registration))) writeManagedGatewayJson(root, registration, { schema_version: 1, owner_pid: process.pid });
  }
  function clients() {
    const directory = managedGatewayPath(root, 'clients');
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).filter(name => {
      const file = `clients/${name}`, row = readManagedGatewayJson(root, file);
      if (alive(row.owner_pid)) return true;
      unlinkSync(managedGatewayPath(root, file)); return false;
    });
  }
  async function secret(name: string): Promise<string> {
    const key = `${prefix}.${name}`, existing = await options.secretStore.get(key);
    if (existing) return existing;
    const value = randomBytes(32).toString('hex'); await options.secretStore.store(key, value); return value;
  }
  async function admin(path: string, init: RequestInit = {}): Promise<any> {
    if (!endpoint) throw new ManagedGatewayError('GATEWAY_NOT_STARTED', 'Start the managed gateway before changing its owned settings.');
    const response = await fetch(`${endpoint.baseUrl}${path}`, { ...init, redirect: 'error',
      headers: { ...(adminCookie ? { cookie: adminCookie } : {}), 'content-type': 'application/json', ...init.headers } });
    if (!response.ok) { await response.body?.cancel(); throw new ManagedGatewayError('GATEWAY_ADMIN_AUTHORIZATION', `Owned gateway administration failed (HTTP ${response.status}).`); }
    return response.json();
  }
  async function login(password: string): Promise<void> {
    if (!endpoint) return;
    const response = await fetch(`${endpoint.baseUrl}/api/auth/login`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)(auth_token=[^;]+)/)?.[1];
    await response.body?.cancel();
    if (!response.ok || !cookie) throw new ManagedGatewayError('GATEWAY_ADMIN_AUTHORIZATION', 'The owned gateway dashboard password must be restored through its legitimate login flow.');
    adminCookie = cookie;
  }
  function metadata(): any {
    try { return readManagedGatewayJson(root, 'service.json'); } catch { return undefined; }
  }
  function leases(): { path: string; owner_pid: number; generation: string }[] {
    const directory = managedGatewayPath(root, 'leases');
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
      const selected = `leases/${name}`, row = readManagedGatewayJson(root, selected);
      if (!alive(row.owner_pid)) { unlinkSync(managedGatewayPath(root, selected)); return []; }
      return [{ path: selected, owner_pid: row.owner_pid, generation: row.generation }];
    });
  }
  function save(state: string, extra: Record<string, unknown> = {}) {
    if (endpoint) writeManagedGatewayJson(root, 'service.json', { schema_version: 1, state, owner_pid: process.pid,
      child_pid: child?.pid, ...endpoint, artifact: selectedArtifact, ...extra });
  }
  async function start(): Promise<{ baseUrl: string; generation: string }> {
    const password = await secret('dashboard-password');
    const existing = metadata();
    if (existing?.state === 'ready' && alive(existing.child_pid)) {
      if (typeof existing.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(existing.generation)) throw new ManagedGatewayError('GATEWAY_METADATA_CHANGED', 'The owned gateway generation metadata changed.');
      endpoint = { baseUrl: new URL(routerBaseUrl(existing.baseUrl)).origin, generation: existing.generation }; selectedArtifact = existing.artifact;
      await login(password); apiKey = await options.secretStore.get(`${prefix}.inference-key`);
      if (!apiKey) throw new ManagedGatewayError('GATEWAY_KEY_REQUIRED', 'Restore the owned WorkForce gateway key before using this connection.');
      return endpoint;
    }
    selectedArtifact = readManagedGatewayJson(root, 'active-artifact.json').id ?? selectedArtifact;
    const artifact = verifyManagedGatewayArtifact(root, selectedArtifact!);
    const generation = randomUUID(), run = managedGatewayPath(root, `runs/${generation}`), app = join(run, 'app');
    mkdirSync(run, { recursive: true, mode: 0o700 });
    // Next can write runtime caches. Run a private copy, preserving the exact
    // reviewed artifact and previous generation for rollback/REA evidence.
    cpSync(join(artifact.directory, 'node_modules/9router/app'), app, { recursive: true, dereference: false, errorOnExist: true });
    const data = managedGatewayPath(root, 'data'), home = managedGatewayPath(root, 'home');
    for (const directory of [data, home, join(home, 'AppData/Roaming'), join(home, 'AppData/Local')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const probe = join(data, `.workforce-write-${randomUUID()}`); copyFileSync(managedGatewayPath(root, 'owner.json'), probe); unlinkSync(probe);
    const port = await freePort(); endpoint = { baseUrl: `http://127.0.0.1:${port}`, generation };
    const supervisor = join(run, 'workforce-supervisor.cjs');
    // This preload owns lifecycle only. It does not implement routing, OAuth,
    // inference, retries or the upstream dashboard. No service imported from a
    // descriptor is ever killed by PID; its own generation handles shutdown.
    writeFileSync(supervisor, `'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=${JSON.stringify(root)},generation=${JSON.stringify(generation)};
const clients=path.join(root,'clients'),intent=path.join(root,'shutdown-'+generation+'.json');
const alive=pid=>{try{if(!Number.isSafeInteger(pid)||pid<1)return false;process.kill(pid,0);return true}catch{return false}};
function finish(){try{const file=path.join(root,'service.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.generation===generation){const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...state,state:'stopped'}),{mode:0o600});fs.renameSync(tmp,file)}}catch{}process.exit(0)}
setInterval(()=>{try{if(fs.existsSync(intent)){const value=JSON.parse(fs.readFileSync(intent,'utf8'));if(value.generation===generation)return finish()}
const files=fs.existsSync(clients)?fs.readdirSync(clients).filter(name=>/^[a-f0-9-]{36}\\.json$/.test(name)):[];
if(!files.some(name=>{try{return alive(JSON.parse(fs.readFileSync(path.join(clients,name),'utf8')).owner_pid)}catch{return true}}))finish()}catch{}},1000).unref();
`, { flag: 'wx', mode: 0o600 });
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
      DATA_DIR: data, HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
      INITIAL_PASSWORD: password, JWT_SECRET: await secret('jwt-secret') };
    child = spawn(options.nodeCommand, ['--require', supervisor, '--require', join(app, 'custom-server.js'), join(app, 'server.js')], { cwd: app, env: environment, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: 'ignore' });
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; }); save('starting', { artifact_fingerprint: artifact.fingerprint });
    const deadline = Date.now() + 60000; let ready = false;
    while (Date.now() < deadline && !spawnFailed && child.exitCode === null && child.signalCode === null) {
      try { const response = await fetch(`${endpoint.baseUrl}/api/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        const health = await response.json(); if (response.ok && health?.ok === true) { ready = true; break; } } catch { /* Owned startup only; no model was sent. */ }
      await pause(100);
    }
    if (!ready) { await stop({ cancelActive: true }); throw new ManagedGatewayError('GATEWAY_START_FAILED', 'The pinned gateway did not become ready. Its account data and previous artifact were retained.'); }
    await login(password);
    // Freeze automatic media defaults. Vision fallback requires an explicit
    // authorized selection, and nothing is silently sent to an upstream default.
    const initialPolicy = !existsSync(managedGatewayPath(root, 'upstream-policy-initialized.json'));
    await admin('/api/settings', { method: 'PATCH', body: JSON.stringify({ requireLogin: true, requireApiKey: true, tunnelEnabled: false,
      tailscaleEnabled: false, tunnelDashboardAccess: false, pxpipeAutoInstall: false,
      ...(initialPolicy ? { rtkEnabled: false, capacityAdapter: { vision: { enabled: false, models: [] }, pdf: { enabled: false, models: [] },
        audioInput: { enabled: false, models: [] }, videoInput: { enabled: false, models: [] } } } : {}) }) });
    if (initialPolicy) writeManagedGatewayJson(root, 'upstream-policy-initialized.json', { schema_version: 1, rtk: 'off-until-explicit-upstream-configuration',
      media_adapters: 'off-until-explicit-authorized-configuration' });
    const database = join(data, 'db/data.sqlite');
    if (!existsSync(database) || !lstatSync(database).isFile() || lstatSync(database).isSymbolicLink()) {
      await stop({ cancelActive: true }); throw new ManagedGatewayError('GATEWAY_DATA_LOCATION', 'The upstream service did not use its owned DATA_DIR; it was stopped without adopting global accounts.');
    }
    apiKey = await options.secretStore.get(`${prefix}.inference-key`);
    if (!apiKey) { const key = await admin('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'WorkForce managed native provider' }) });
      if (typeof key.key !== 'string') throw new ManagedGatewayError('GATEWAY_KEY_REQUIRED', 'The owned gateway did not issue its inference key.');
      apiKey = key.key; await options.secretStore.store(`${prefix}.inference-key`, key.key); }
    save('ready', { artifact_fingerprint: artifact.fingerprint, data_location_confirmed: true }); return endpoint;
  }
  async function ensureStarted() {
    if (stopped) stopped = false;
    registerClient();
    if (endpoint && metadata()?.state === 'ready' && metadata()?.generation === endpoint.generation && (child ? child.exitCode === null && child.signalCode === null : alive(metadata()?.child_pid))) return endpoint;
    starting ??= (async () => {
      const lock = managedGatewayPath(root, 'startup-lock.json'), token = randomUUID(), deadline = Date.now() + 180000;
      const ownerOfLock = () => {
        try {
          const info = lstatSync(lock);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new ManagedGatewayError('GATEWAY_METADATA_CHANGED', 'The owned startup lock changed.');
          return JSON.parse(readFileSync(lock, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      };
      while (Date.now() < deadline) {
        const shared = metadata();
        if (shared?.state === 'ready' && alive(shared.child_pid)) return start();
        if (['starting', 'draining'].includes(shared?.state) && alive(shared.child_pid)) {
          if (!alive(shared.owner_pid)) writeManagedGatewayJson(root, `shutdown-${shared.generation}.json`, { generation: shared.generation });
          await pause(100); continue;
        }
        if (existsSync(lock)) {
          const owner = ownerOfLock();
          if (!owner) continue;
          if (!alive(owner.owner_pid)) { try { unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
          else await pause(100);
          continue;
        }
        const candidateName = `startup-${randomUUID()}.candidate`, candidate = managedGatewayPath(root, candidateName);
        writeManagedGatewayJson(root, candidateName, { schema_version: 1, owner_pid: process.pid, token });
        try { linkSync(candidate, lock); }
        catch (error) {
          unlinkSync(candidate);
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = ownerOfLock();
          if (!owner) continue;
          if (!alive(owner.owner_pid)) { try { unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } continue; }
          await pause(100); continue;
        }
        unlinkSync(candidate);
        try {
          return await start();
        } catch (error) { await stop({ cancelActive: true }); throw error; }
        finally {
          try { if (ownerOfLock()?.token === token) unlinkSync(lock); } catch {}
        }
      }
      throw new ManagedGatewayError('GATEWAY_START_IN_PROGRESS', 'Another owned host is still preparing this gateway; no model request was submitted.');
    })().finally(() => { starting = undefined; }); return starting;
  }
  async function acquire(signal?: AbortSignal) {
    const selected = await ensureStarted(), before = metadata();
    if (before?.state !== 'ready' || before.generation !== selected.generation) throw new ManagedGatewayError('GATEWAY_DRAINING', 'The gateway is finishing an authorized update; no model request was submitted.');
    const id = randomUUID(), controller = new AbortController(), file = `leases/${id}.json`;
    writeManagedGatewayJson(root, file, { schema_version: 1, owner_pid: process.pid, generation: selected.generation }); active.set(id, controller);
    let released = false;
    const release = () => { if (released) return; released = true; active.delete(id); try { unlinkSync(managedGatewayPath(root, file)); } catch {} };
    if (metadata()?.state !== 'ready' || metadata()?.generation !== selected.generation) { release(); throw new ManagedGatewayError('GATEWAY_DRAINING', 'The gateway changed before admission; no model request was submitted.'); }
    return { ...selected, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, release };
  }
  async function stop(input: { cancelActive?: boolean } = {}): Promise<void> {
    stopped = true;
    if (input.cancelActive) for (const controller of active.values()) controller.abort();
    if (!child) {
      if (!endpoint) return;
      const existing = metadata();
      if (existing?.generation !== endpoint.generation) { endpoint = undefined; return; }
      if (leases().length && !input.cancelActive) throw new ManagedGatewayError('GATEWAY_IN_USE', 'Active model calls keep their gateway generation.');
      // Ask the authenticated, privately owned generation to exit itself.
      // Never send a process signal to a PID read from a persisted descriptor.
      writeManagedGatewayJson(root, 'service.json', { ...existing, state: 'draining', owner_pid: process.pid });
      writeManagedGatewayJson(root, `shutdown-${endpoint.generation}.json`, { generation: endpoint.generation });
      const until = Date.now() + 5000; while (alive(existing.child_pid) && Date.now() < until) await pause(25);
      endpoint = undefined; return;
    }
    save('draining');
    const deadline = Date.now() + (input.cancelActive ? 5000 : 60000);
    while (leases().length && Date.now() < deadline) await pause(25);
    if (leases().length && !input.cancelActive) { save('ready'); throw new ManagedGatewayError('GATEWAY_IN_USE', 'Active model calls keep their current gateway generation. Update after they settle.'); }
    const owned = child;
    if (owned.pid && owned.exitCode === null && owned.signalCode === null) {
      if (process.platform === 'win32') await new Promise<void>(accept => {
        const killer = spawn('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', () => accept()); killer.once('exit', () => accept());
      });
      else { try { process.kill(-owned.pid, 'SIGTERM'); } catch { owned.kill(); } }
      const until = Date.now() + 5000; while (owned.exitCode === null && owned.signalCode === null && Date.now() < until) await pause(25);
      if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
    }
    save('stopped'); child = undefined; endpoint = undefined; adminCookie = undefined;
  }
  async function activateArtifact(id: string) {
    verifyManagedGatewayArtifact(root, id);
    if (leases().length) throw new ManagedGatewayError('GATEWAY_IN_USE', 'Gateway activation waits for current invocations to settle.');
    await stop();
    const current = readManagedGatewayJson(root, 'active-artifact.json').id;
    const backup = `backups/${randomUUID()}`; mkdirSync(managedGatewayPath(root, backup), { recursive: true, mode: 0o700 });
    if (existsSync(managedGatewayPath(root, 'data'))) cpSync(managedGatewayPath(root, 'data'), managedGatewayPath(root, `${backup}/data`), { recursive: true });
    writeManagedGatewayJson(root, 'previous-artifact.json', { id: current, backup });
    writeManagedGatewayJson(root, 'active-artifact.json', { id }); selectedArtifact = id; return { id, previous: current, backup, activated: true };
  }
  async function rollback() {
    const previous = readManagedGatewayJson(root, 'previous-artifact.json');
    // Database migrations are additive upstream. Preserve both private backups;
    // never overwrite newer account data silently during an artifact rollback.
    return activateArtifact(previous.id);
  }
  function matchingCombo(row: any, receipt: any, settings: any): boolean {
    return row?.name === receipt.shadow && row?.id === receipt.upstream_id && JSON.stringify(row.models) === JSON.stringify(receipt.members) &&
      (row.kind ?? null) === receipt.kind && JSON.stringify(settings.comboStrategies?.[receipt.shadow]) === JSON.stringify(receipt.strategy);
  }
  async function validateCombo(shadow: string): Promise<boolean> {
    try {
      if (!/^wf_combo_[a-f0-9]{40}$/.test(shadow)) return false;
      const receipt = readManagedGatewayJson(root, `combos/${shadow.slice(9)}.json`);
      if (receipt.state !== 'ready') return false;
      const [rows, settings] = await Promise.all([admin('/api/combos'), admin('/api/settings')]);
      return matchingCombo(rows.combos?.find((row: any) => row.name === shadow), receipt, settings);
    } catch { return false; }
  }
  async function prepareCombo(name: string, members: readonly string[], signal?: AbortSignal): Promise<string> {
    await ensureStarted();
    if (signal?.aborted) throw new ManagedGatewayError('GATEWAY_CANCELLED', 'Combo preparation was cancelled before inference.');
    const [listed, settings] = await Promise.all([admin('/api/combos'), admin('/api/settings')]);
    const original = listed.combos?.find((row: any) => row.name === name);
    if (!original || JSON.stringify(original.models) !== JSON.stringify(members) || !members.length || members.some(model => typeof model !== 'string' || !model.includes('/')))
      throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'The upstream combo does not match the exact approved direct-model pool.');
    const specific = settings.comboStrategies?.[name], strategyName = typeof specific === 'string' ? specific : specific?.strategy ?? settings.comboStrategy ?? 'fallback';
    if (!['fallback', 'round-robin'].includes(strategyName)) throw new ManagedGatewayError('GATEWAY_COMBO_STRATEGY', 'This native gateway qualifies fallback and round-robin combos; choose one before using this route.');
    const strategy = { strategy: strategyName, stickyRoundRobinLimit: Number.isSafeInteger(specific?.stickyRoundRobinLimit) ? specific.stickyRoundRobinLimit : settings.comboStickyRoundRobinLimit ?? 1 };
    const body = { schema_version: 1, original: name, members: [...members], kind: original.kind ?? null, strategy };
    const digest = gatewayHash(JSON.stringify(body)).slice(0, 40), shadow = `wf_combo_${digest}`, receiptPath = `combos/${digest}.json`;
    const pending = preparingCombos.get(shadow); if (pending) return pending;
    const operation = (async () => {
      let receipt: any;
      try { receipt = readManagedGatewayJson(root, receiptPath); } catch { /* A new immutable shadow has no receipt yet. */ }
      let row = listed.combos?.find((row: any) => row.name === shadow);
      if (!receipt) {
        if (row) throw new ManagedGatewayError('GATEWAY_COMBO_OWNERSHIP', 'A matching upstream name already exists without an owned WorkForce receipt; it was preserved.');
        receipt = { ...body, shadow, state: 'creating', upstream_id: null };
        writeManagedGatewayJson(root, receiptPath, receipt);
      } else if (JSON.stringify({ schema_version: receipt.schema_version, original: receipt.original, members: receipt.members, kind: receipt.kind, strategy: receipt.strategy }) !== JSON.stringify(body))
        throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'The owned combo receipt changed.');
      if (receipt.state === 'ready') {
        if (!matchingCombo(row, receipt, settings)) throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'An owned upstream combo or strategy was edited; no inference was submitted.');
        return shadow;
      }
      if (!row) {
        try { row = await admin('/api/combos', { method: 'POST', body: JSON.stringify({ name: shadow, models: [...members], kind: body.kind }) }); }
        catch {
          // Local durable intent + exact SQLite read reconciles a lost response;
          // it never repeats the POST or invents an upstream operation identity.
          const current = await admin('/api/combos'); row = current.combos?.find((row: any) => row.name === shadow);
          if (!row) throw new ManagedGatewayError('GATEWAY_COMBO_UNCERTAIN', 'Owned combo creation could not be reconciled; no model request was submitted.');
        }
      }
      if (row.name !== shadow || JSON.stringify(row.models) !== JSON.stringify(members) || (row.kind ?? null) !== body.kind || typeof row.id !== 'string')
        throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'The created upstream combo differs from the owned intent.');
      const fresh = await admin('/api/settings');
      await admin('/api/settings', { method: 'PATCH', body: JSON.stringify({ comboStrategies: { ...(fresh.comboStrategies ?? {}), [shadow]: strategy } }) });
      receipt = { ...receipt, state: 'ready', upstream_id: row.id };
      writeManagedGatewayJson(root, receiptPath, receipt);
      if (!await validateCombo(shadow)) throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'The owned combo changed before model admission.');
      return shadow;
    })().finally(() => preparingCombos.delete(shadow));
    preparingCombos.set(shadow, operation); return operation;
  }
  return { ensureStarted, acquire, stop, activateArtifact, rollback, prepareCombo, validateCombo,
    status: () => { const saved = metadata(); return { state: ['starting', 'ready', 'draining', 'stopped'].includes(saved?.state) ? saved.state : 'stopped',
      generation: typeof saved?.generation === 'string' && /^[a-f0-9-]{36}$/.test(saved.generation) ? saved.generation : null,
      artifact: typeof saved?.artifact === 'string' && /^9router-[0-9.a-z-]+$/.test(saved.artifact) ? saved.artifact : null,
      active_calls: leases().length, process_owned: !!child, accounts: 'not-imported', data_location_confirmed: saved?.data_location_confirmed === true }; },
    client: (policy?: ManagedGatewayPolicy) => {
      if (!endpoint) throw new ManagedGatewayError('GATEWAY_NOT_STARTED', 'Start the managed gateway before requesting its client.');
      return createManagedGatewayClient(endpoint, { getApiKey: () => apiKey, getAdminCookie: () => adminCookie, prepareCombo, validateCombo, ...(policy ? { policy } : {}) });
    },
    dashboardAccess: async () => ({ url: `${(await ensureStarted()).baseUrl}/dashboard`, password: await secret('dashboard-password') }),
    getApiKey: () => apiKey, getAdminCookie: () => adminCookie,
    dispose: async () => {
      for (const controller of active.values()) controller.abort();
      const until = Date.now() + 5000; while (active.size && Date.now() < until) await pause(25);
      try { unlinkSync(managedGatewayPath(root, registration)); } catch {}
      if (clients().length) { child?.unref(); child = undefined; endpoint = undefined; return; }
      await stop({ cancelActive: true });
    } };
}
