import { existsSync, lstatSync, readFileSync, readdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomicWrite, hash, now, readConfig, safePath, withOperationLock } from './storage.js';
import { invocationIsActive, readInvocation } from './routing.js';
import { readToolPolicy, installProvider, readInstalledProvider, toolCatalog, closeCapabilitySessions, type ProviderId } from './tools.js';
import { configureRea, reaPin, reaRegistration, reaStatus, probeRea, readReaConfiguration } from './rea.js';
import { loadCodeGraphConfiguration, adapterNodeCommand } from './adapters.js';

type Server = { command: string; args: string[]; env?: Record<string, string> };
export interface PluginRegistration {
  status: 'ready' | 'disabled' | 'missing' | 'blocked'; server?: Server; tools: string[]; reason?: string;
}
export interface PluginStatus {
  id: ProviderId; name: string; version: string; enabled: boolean; installed: boolean;
  availability: 'disabled' | 'missing' | 'installed' | 'ready' | 'blocked'; reason?: string;
  last_probe?: { at: string; status: 'passed'; tool_count: number };
}
const names: Record<ProviderId, string> = { rea: 'REA', codegraph: 'CodeGraph', context7: 'Context7', playwright: 'Playwright' };
function provider(id: string) {
  const item = toolCatalog.find(tool => tool.id === id);
  if (!item) throw new Error('Unknown plug-in. Choose REA, CodeGraph, Context7 or Playwright.');
  return item;
}
/** Shared by plug-in policy and client-connection mutations. Invalid receipts fail closed. */
export function withPluginConfigurationLock<T>(root: string, action: () => T): T {
  readConfig(root);
  return withOperationLock(root, 'native-dispatch', () => withOperationLock(root, 'routing-policy', () => {
    assertIdle(root);
    readToolPolicy(root); // Reject a malformed policy before any write.
    return action();
  }));
}
function assertIdle(root: string) {
  const path = safePath(root, '.neomind/native/receipts');
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path).filter(name => name.endsWith('.json')))
    if (invocationIsActive(readInvocation(root, entry.slice(0, -5))))
      throw new Error('Plug-in configuration cannot change while an invocation is active. Interrupt or reconcile it first.');
}
function enabled(root: string, id: ProviderId): boolean {
  if (!readToolPolicy(root)?.approved_providers.includes(id)) return false;
  if (id !== 'rea') return true;
  return readReaConfiguration(root)?.enabled === true;
}
function installation(root: string, id: ProviderId) {
  const found = readInstalledProvider(root, id);
  // The inspected metadata alone cannot establish an executable entry.
  const entry = id === 'codegraph' ? found.launch.command : found.launch.args[0]!;
  if (!existsSync(entry) || !lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) throw new Error('Installed plug-in executable is unavailable.');
  return found;
}
function serverFor(root: string, id: ProviderId): Server {
  if (id === 'codegraph') {
    const configuration = loadCodeGraphConfiguration(root);
    if (!configuration) throw new Error('CodeGraph requires its approved conformance report and exact configured launch.');
    return { command: configuration.command, args: configuration.args,
      env: { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_NO_DAEMON: '1' } };
  }
  const { launch } = installation(root, id);
  return { ...launch, command: 'node', args: id === 'playwright' ? [...launch.args, '--headless', '--isolated'] : launch.args,
    env: { DO_NOT_TRACK: '1' } };
}
function probePath(root: string, id: ProviderId) { return safePath(root, `.neomind/plugins/${id}-probe.json`); }
function baseline(root: string, id: ProviderId, server: Server): string {
  if (id === 'codegraph') {
    const config = loadCodeGraphConfiguration(root);
    if (!config) throw new Error('Missing CodeGraph conformance.');
    return hash(JSON.stringify({ server, report: config.report_hash, executable: hash(readFileSync(server.command)) }));
  }
  const item = provider(id), { base } = installation(root, id);
  const executable = server.args[0]!;
  // A probe runs in real Node while the panel runs in Electron. The portable Node
  // launcher and the absolute Node executable refer to the same script contract.
  return hash(JSON.stringify({ version: item.version, integrity: item.integrity, server: { ...server, command: 'node' },
    executable: hash(readFileSync(executable)), dependency_lock: hash(readFileSync(join(base, 'package-lock.json'))) }));
}
function observation(root: string, id: ProviderId, server: Server): PluginStatus['last_probe'] {
  const path = probePath(root, id);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.schema_version !== 1 || value.plugin !== id || value.baseline !== baseline(root, id, server) ||
        typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || value.at.length > 32 ||
        !Number.isSafeInteger(value.tool_count) || value.tool_count < provider(id).tools.length || value.tool_count > 2048) return undefined;
    return { at: value.at, status: 'passed', tool_count: value.tool_count };
  } catch { return undefined; }
}
/** A registration contains local launch details for client configuration; never put it in status/UI payloads. */
export function pluginRegistration(root: string, id: string): PluginRegistration {
  const item = provider(id), tools = [...item.tools];
  try {
    readConfig(root);
    if (!enabled(root, item.id)) return { status: 'disabled', tools };
    if (item.id === 'codegraph') {
      try { return { status: 'ready', tools, server: serverFor(root, item.id) }; }
      catch {
        try { installation(root, item.id); }
        catch { return { status: 'missing', tools, reason: 'Install pinned CodeGraph, then Verify to run its isolated conformance checks.' }; }
        return { status: 'blocked', tools, reason: process.platform === 'win32'
          ? 'Verify CodeGraph to run its isolated C/C++ conformance checks and configure the approved MCP launch.'
          : 'This CodeGraph native adapter requires Windows conformance. Linux native registration is not yet supported.' };
      }
    }
    try { installation(root, item.id); }
    catch { return { status: 'missing', tools, reason: 'Install the pinned plug-in and verify its dependency baseline.' }; }
    if (item.id === 'rea') {
      const result = reaRegistration(root);
      return { ...result, tools };
    }
    let server;
    try { server = serverFor(root, item.id); }
    catch { return { status: 'blocked', tools, reason: 'CodeGraph needs a current approved conformance report and configured launch for this platform.' }; }
    if (!observation(root, item.id, server)) return { status: 'missing', tools, reason: 'Probe the installed plug-in to verify its MCP connection and required tools.' };
    return { status: 'ready', tools, server };
  } catch { return { status: 'blocked', tools, reason: 'The project or plug-in configuration is invalid. Review configuration before changing connections.' }; }
}
export function readPluginControlStatus(root: string): { schema_version: 1; plugins: PluginStatus[] } {
  return { schema_version: 1, plugins: toolCatalog.map(item => {
    const registration = pluginRegistration(root, item.id);
    let isEnabled = false, isInstalled = false, last_probe: PluginStatus['last_probe'];
    try { isEnabled = enabled(root, item.id); } catch { /* Status reports the sanitized blocker. */ }
    if (item.id === 'codegraph') {
      try { isInstalled = Boolean(loadCodeGraphConfiguration(root)); } catch { /* A new managed install may still be present. */ }
    }
    if (!isInstalled) try { installation(root, item.id); isInstalled = true; }
    catch { /* A broken baseline is not an installed verified plug-in. */ }
    if (registration.status === 'ready') {
      if (item.id === 'rea') {
        const state = reaStatus(root);
        if (state.observation) last_probe = { at: state.observation.observed_at, status: 'passed', tool_count: state.observation.catalog_count };
      } else last_probe = observation(root, item.id, registration.server!);
    }
    const availability = registration.status === 'missing' && isInstalled ? 'installed' : registration.status;
    return { id: item.id, name: names[item.id], version: item.version, enabled: isEnabled, installed: isInstalled,
      availability, ...(registration.reason ? { reason: registration.reason } : {}), ...(last_probe ? { last_probe } : {}) };
  }) };
}
/** Toggle approval only. No install, subprocess or network side effects. */
export function setPluginEnabled(root: string, id: string, value: boolean): ReturnType<typeof readPluginControlStatus> {
  const item = provider(id);
  if (typeof value !== 'boolean') throw new Error('Plug-in enabled must be a boolean.');
  withPluginConfigurationLock(root, () => {
    const policy = readToolPolicy(root) ?? { schema_version: 1 as const, automatic_install: true, approved_providers: [] as ProviderId[] };
    // Parse the complete REA configuration before changing policy, preserving the verified baseline.
    let rea: Record<string, unknown> | undefined;
    if (item.id === 'rea') {
      const path = safePath(root, '.neomind/rea.json');
      const previous = readReaConfiguration(root);
      if (previous) rea = { ...previous };
      rea = { ...(rea ?? { schema_version: 1, ...reaPin }), enabled: value };
      delete rea.node; // Node version constraint is pin metadata, not a saved configuration property.
      atomicWrite(path, JSON.stringify(rea, null, 2) + '\n');
    }
    const approved = policy.approved_providers.filter(provider => provider !== item.id);
    if (value) approved.push(item.id);
    atomicWrite(safePath(root, '.neomind/tools.json'), JSON.stringify({ ...policy, approved_providers: approved }, null, 2) + '\n');
  });
  // Invocation gateway rechecks policy before every call; close cached sessions too.
  if (!value) void closeCapabilitySessions(root);
  return readPluginControlStatus(root);
}
export async function installPlugin(root: string, id: string): Promise<ReturnType<typeof readPluginControlStatus>> {
  const item = provider(id);
  if (process.versions.electron) return runPluginNodeWorker(root, 'install', item.id);
  withPluginConfigurationLock(root, () => {
    if (!enabled(root, item.id)) throw new Error('Enable the plug-in before installing it.');
    // Explicit install never silently changes automatic-install or network policy.
    installProvider(root, item.id);
  });
  if (item.id === 'rea') await configureRea(root, { enabled: true });
  return readPluginControlStatus(root);
}
/** Target-free handshake and tools/list only; never invokes browser, indexing or analysis tools. */
export async function probePlugin(root: string, id: string): Promise<ReturnType<typeof readPluginControlStatus>> {
  const item = provider(id);
  if (process.versions.electron) return runPluginNodeWorker(root, 'probe', item.id);
  if (item.id === 'codegraph') {
    let configured = false;
    try { configured = Boolean(loadCodeGraphConfiguration(root)); } catch { /* Explicit Verify may regenerate conformance. */ }
    if (!configured) await configureInstalledCodeGraph(root);
  }
  let server!: Server, digest!: string;
  withPluginConfigurationLock(root, () => {
    if (!enabled(root, item.id)) throw new Error('Enable the plug-in before probing it.');
    if (item.id !== 'rea') { server = serverFor(root, item.id); digest = baseline(root, item.id, server); }
  });
  if (item.id === 'rea') { await probeRea(root); return readPluginControlStatus(root); }
  const client = new Client({ name: 'neomind-plugin-control', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...server, cwd: root,
    env: { ...getDefaultEnvironment(), ...server.env }, stderr: 'pipe', maxBufferSize: 2 * 1024 * 1024 });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 20_000 });
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000 });
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new Error('Duplicate tool names.');
        names.add(tool.name);
      }
      if (names.size > 2048 || Buffer.byteLength(JSON.stringify(result.tools)) > 1024 * 1024) throw new Error('Catalog exceeds bounds.');
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor || !item.tools.every(name => names.has(name))) throw new Error('Required tools are missing.');
    withPluginConfigurationLock(root, () => {
      if (!enabled(root, item.id) || digest !== baseline(root, item.id, server)) throw new Error('Configuration changed during probe.');
      atomicWrite(probePath(root, item.id), JSON.stringify({ schema_version: 1, plugin: item.id, baseline: digest,
        at: now(), tool_count: names.size }, null, 2) + '\n');
    });
  } catch { throw new Error('Plug-in MCP verification failed. Check its pinned installation, prerequisite and required tools.'); }
  finally { await client.close().catch(() => {}); }
  return readPluginControlStatus(root);
}

/** The extension host runs Electron; all package/probe subprocesses require a real Node CLI. */
export function pluginWorkerLaunch(root: string, action: 'install' | 'probe', id: string,
  host = { executable: process.execPath, electron: Boolean(process.versions.electron) }): { command: string; args: string[] } {
  provider(id);
  if (action !== 'install' && action !== 'probe') throw new Error('Unknown plug-in worker action.');
  const command = adapterNodeCommand(root, host);
  if (command !== 'node' && !/^node(?:\.exe)?$/i.test(basename(command))) throw new Error('A real Node CLI is required for plug-in installation and verification.');
  return { command, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'plugins', action, id, '--project', resolve(root)] };
}
async function runPluginNodeWorker(root: string, action: 'install' | 'probe', id: ProviderId) {
  withPluginConfigurationLock(root, () => {
    if (!enabled(root, id)) throw new Error('Enable the plug-in before installing or probing it.');
    if (action === 'install') {
      const item = provider(id), metadata = safePath(root, `.neomind/tools/${id}/${item.version}/node_modules/${item.package}/package.json`);
      const automation = safePath(root, '.neomind/automation.json');
      if (!existsSync(metadata) && existsSync(automation) && JSON.parse(readFileSync(automation, 'utf8')).network_policy === 'local-only')
        throw new Error('Local-only policy disables approved provider package downloads.');
    }
  });
  const launch = pluginWorkerLaunch(root, action, id);
  try {
    await new Promise<void>((resolveResult, reject) => {
      const child = spawn(launch.command, launch.args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: getDefaultEnvironment() });
      let output = '', bytes = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error('Plug-in worker timed out.')); }, 360_000);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { child.kill(); reject(new Error('Plug-in worker output exceeded its bound.')); }
        else output += chunk.toString();
      });
      child.stderr.on('data', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new Error('Real Node worker could not start.')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error('Plug-in worker failed.')); return; }
        try {
          const result = JSON.parse(output);
          if (!Array.isArray(result.status?.plugins) || result.status.plugins.length !== toolCatalog.length) throw new Error('Invalid worker status.');
          resolveResult();
        } catch { reject(new Error('Plug-in worker did not return a valid status.')); }
      });
    });
  } catch { throw new Error('Plug-in operation could not complete in the Node worker. Check the plug-in policy, runtime prerequisite and pinned installation.'); }
  return readPluginControlStatus(root);
}

/** Use the existing shipped fixture runner, never a user-supplied command or remote script. */
async function configureInstalledCodeGraph(root: string): Promise<void> {
  let base!: string, launch!: { command: string; args: string[] };
  withPluginConfigurationLock(root, () => {
    if (!enabled(root, 'codegraph')) throw new Error('Enable CodeGraph before verifying it.');
    if (process.platform !== 'win32') throw new Error('CodeGraph native conformance currently supports Windows only.');
    if (process.versions.electron) throw new Error('Run CodeGraph verification with the supported Node CLI.');
    ({ base, launch } = installation(root, 'codegraph'));
  });
  const temporaryRoot = realpathSync(tmpdir()), folder = mkdtempSync(join(temporaryRoot, 'neomind-codegraph-control-'));
  const report = join(folder, 'report.json');
  try {
    const script = fileURLToPath(new URL('../scripts/codegraph-check.mjs', import.meta.url));
    const status = await new Promise<number | null>((resolveResult, reject) => {
      const child = spawn(process.execPath, [script, '--package-root', base, '--out', report], {
        cwd: root, stdio: 'ignore', windowsHide: true,
        env: { ...getDefaultEnvironment(), DO_NOT_TRACK: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_NO_DAEMON: '1' },
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('CodeGraph conformance timed out.')); }, 240_000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('CodeGraph conformance runner could not start.')); });
      child.once('close', code => { clearTimeout(timer); resolveResult(code); });
    });
    if (status !== 0) throw new Error('CodeGraph fixture conformance did not pass all twelve checks. Review the installed package and platform prerequisites.');
    const { configureCodeGraph } = await import('./installer.js');
    withPluginConfigurationLock(root, () => {
      if (!enabled(root, 'codegraph') || installation(root, 'codegraph').base !== base) throw new Error('CodeGraph changed during conformance.');
      configureCodeGraph(root, report, launch.command, [...launch.args, 'serve', '--mcp', '--path', resolve(root)]);
    });
  } finally {
    const target = realpathSync(folder);
    if (dirname(target) === temporaryRoot && basename(target).startsWith('neomind-codegraph-control-')) rmSync(target, { recursive: true, force: true });
  }
}
