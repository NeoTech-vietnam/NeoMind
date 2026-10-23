import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { atomicWrite, hash, now, readConfig, safePath, withOperationLock } from './storage.js';

export const reaPin = {
  package: 'rea-agents', version: '6.7.0',
  integrity: 'sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==',
  node: '^22.19.0 || ^24.11.0 || >=26.0.0',
} as const;
export const reaToolAllowlist = ['binary_session', 'analyze_javascript_application', 'inspect_analysis_view', 'get_evidence_bundle'] as const;
const configurationPath = '.neomind/rea.json';
const baseRelative = `.neomind/tools/rea/${reaPin.version}`;
const observationPath = `${baseRelative}/observed.json`;
interface ReaConfiguration {
  schema_version: 1; enabled: boolean; package: string; version: string; integrity: string;
  node_command?: string; node_version?: string; entry_sha256?: string;
  skill_hashes?: Record<string, string>;
}
export type ReaRegistration = { status: 'disabled' | 'missing'; reason?: string } |
  { status: 'ready'; server: { command: string; args: string[]; env?: Record<string, string> } };
export interface ReaSkillBundle {
  name: string; files: Array<{ path: string; content: string; sha256: string }>;
  provenance: { package: string; version: string; integrity: string; repository: string; commit?: string };
}
function configuration(root: string): ReaConfiguration | null {
  const path = safePath(root, configurationPath);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['schema_version', 'enabled', 'package', 'version', 'integrity', 'node_command', 'node_version', 'entry_sha256', 'skill_hashes'].includes(key)) ||
      value.schema_version !== 1 || typeof value.enabled !== 'boolean' || value.package !== reaPin.package ||
      value.version !== reaPin.version || value.integrity !== reaPin.integrity ||
      (value.node_command !== undefined && (typeof value.node_command !== 'string' || !isAbsolute(value.node_command))) ||
      (value.node_version !== undefined && typeof value.node_version !== 'string') ||
      (value.entry_sha256 !== undefined && (typeof value.entry_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.entry_sha256))))
    throw new Error('Invalid pinned REA configuration.');
  if (value.skill_hashes !== undefined && (!value.skill_hashes || typeof value.skill_hashes !== 'object' || Array.isArray(value.skill_hashes) ||
      Object.entries(value.skill_hashes).some(([path, digest]) => !/^(?:SKILL\.md|LICENSE|ORIGIN\.json|references\/[A-Za-z0-9_.-]+\.md)$/.test(path) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))))
    throw new Error('Invalid REA skill baseline.');
  return value;
}
export function reaConfigured(root: string): boolean { return configuration(root)?.enabled === true; }
function regularWithin(base: string, path: string): string {
  const child = relative(base, path);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error('REA file escapes its verified directory.');
  let current = path;
  while (current !== base) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('REA files must not follow symbolic links.');
    current = dirname(current);
  }
  if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink() || !lstatSync(path).isFile())
    throw new Error('REA requires regular installed files.');
  return path;
}
function installed(root: string) {
  const base = safePath(root, baseRelative), packageRoot = join(base, 'node_modules', reaPin.package);
  const manifest = JSON.parse(readFileSync(regularWithin(base, join(packageRoot, 'package.json')), 'utf8'));
  const lockBytes = readFileSync(regularWithin(base, join(base, 'package-lock.json')));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const baseline = safePath(root, `.neomind/tool-locks/rea-${reaPin.version}.json`);
  if (manifest.name !== reaPin.package || manifest.version !== reaPin.version ||
      lock.packages?.[`node_modules/${reaPin.package}`]?.integrity !== reaPin.integrity ||
      !existsSync(baseline) || !readFileSync(baseline).equals(lockBytes)) throw new Error('Pinned REA installation or dependency baseline does not match.');
  const entry = regularWithin(packageRoot, join(packageRoot, 'scripts', 'rea.mjs'));
  return { packageRoot, entry, entry_sha256: hash(readFileSync(entry)) };
}
function launch(root: string) {
  const config = configuration(root);
  if (!config?.enabled) throw new Error('REA is disabled. Configure the pinned integration explicitly.');
  const runtime = installed(root);
  if (!config.node_command || !config.entry_sha256 || runtime.entry_sha256 !== config.entry_sha256 ||
      !lstatSync(config.node_command).isFile() || realpathSync(config.node_command) !== config.node_command)
    throw new Error('REA launcher is missing or changed. Reconfigure the verified runtime.');
  return { command: config.node_command, args: [runtime.entry, 'mcp'],
    env: { DO_NOT_TRACK: '1', REA_MCP_MAX_RESPONSE_BYTES: '10485760' } };
}
function observed(root: string) {
  const saved = JSON.parse(readFileSync(safePath(root, observationPath), 'utf8'));
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (saved.version !== reaPin.version || saved.entry_sha256 !== configuration(root)?.entry_sha256 ||
      saved.server?.name !== 'rea' || saved.server?.version !== reaPin.version ||
      !Number.isSafeInteger(saved.catalog_count) || saved.catalog_count < reaToolAllowlist.length || saved.catalog_count > 2048 ||
      typeof saved.observed_at !== 'string' || saved.observed_at.length > 32 || !Number.isFinite(Date.parse(saved.observed_at)) ||
      !Array.isArray(saved.tools) || saved.tools.length !== reaToolAllowlist.length ||
      !reaToolAllowlist.every(name => saved.tools.some((tool: { name: string; input_schema_sha256?: unknown; output_schema_sha256?: unknown }) =>
        tool.name === name && digest(tool.input_schema_sha256) && (tool.output_schema_sha256 === null || digest(tool.output_schema_sha256)))))
    throw new Error('REA saved discovery does not match its verified runtime.');
  return { observed_at: saved.observed_at, catalog_count: saved.catalog_count,
    server: { name: 'rea', version: reaPin.version }, tools: saved.tools.map((tool: { name: string; input_schema_sha256: string; output_schema_sha256: string | null }) =>
      ({ name: tool.name, input_schema_sha256: tool.input_schema_sha256, output_schema_sha256: tool.output_schema_sha256 })) };
}
export function reaRegistration(root: string): ReaRegistration {
  try {
    if (!configuration(root)?.enabled) return { status: 'disabled' };
    const server = launch(root);
    observed(root);
    return { status: 'ready', server };
  } catch { return { status: 'missing', reason: 'REA installation, launcher or discovery baseline is unavailable. Configure and probe the pinned runtime.' }; }
}
export function reaStatus(root: string) {
  const registration = reaRegistration(root);
  let observation;
  if (registration.status === 'ready') {
    observation = { ...observed(root), scope: 'Saved target-free handshake and schema discovery; no target execution attestation.' };
  }
  return { ...registration, pin: reaPin, ...(observation ? { observation } : {}), native_boundary: 'Direct client tools are unsigned and use client permissions; the strict gateway retains receipt and role checks.' };
}
export function reaToolsForRole(root: string, role: string): string[] {
  return ['researcher', 'codebase-analyst'].includes(role) && reaRegistration(root).status === 'ready' ? [...reaToolAllowlist] : [];
}
function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}
function noActiveInvocations(root: string): void {
  const directory = safePath(root, '.neomind/native/receipts');
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const state = JSON.parse(readFileSync(safePath(root, `.neomind/native/receipts/${file}`), 'utf8')).state;
    if (!['completed', 'failed', 'interrupted', 'blocked', 'orphaned'].includes(state))
      throw new Error('Active or malformed native receipts prevent REA configuration changes.');
  }
}
export async function configureRea(root: string, input: { enabled: boolean; install?: boolean }) {
  readConfig(root);
  if (!input || typeof input.enabled !== 'boolean' || (input.install !== undefined && typeof input.install !== 'boolean') ||
      Object.keys(input).some(key => !['enabled', 'install'].includes(key)) || (input.install && !input.enabled))
    throw new Error('REA configuration requires enabled and an optional explicit install flag.');
  if (input.enabled && process.versions.electron) throw new Error('Configure REA from the supported Node CLI, not the Electron extension host.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (input.enabled && !(major! >= 26 || (major === 24 && minor! >= 11) || (major === 22 && minor! >= 19)))
    throw new Error('Node does not meet the pinned REA runtime requirement.');
  const automation = safePath(root, '.neomind/automation.json');
  if (input.install && existsSync(automation) && JSON.parse(readFileSync(automation, 'utf8')).network_policy === 'local-only')
    throw new Error('Local-only policy disables REA package downloads. Use an already verified installation or explicitly change network policy.');
  const { ensureToolPolicy, installProvider } = await import('./tools.js');
  let saved: ReaConfiguration;
  withOperationLock(root, 'native-dispatch', () => {
    noActiveInvocations(root);
    const previous = configuration(root);
    saved = { schema_version: 1, enabled: input.enabled, package: reaPin.package, version: reaPin.version, integrity: reaPin.integrity,
      ...(previous?.entry_sha256 ? { entry_sha256: previous.entry_sha256 } : {}),
      ...(previous?.skill_hashes ? { skill_hashes: previous.skill_hashes } : {}),
      ...(input.enabled ? { node_command: realpathSync(process.execPath), node_version: process.version } :
        previous?.node_command ? { node_command: previous.node_command, node_version: previous.node_version } : {}) };
    if (input.enabled) {
      const policy = ensureToolPolicy(root);
      if (!policy.approved_providers.includes('rea')) atomicWrite(safePath(root, '.neomind/tools.json'), JSON.stringify({ ...policy, approved_providers: [...policy.approved_providers, 'rea'] }, null, 2) + '\n');
    }
    atomicWrite(safePath(root, configurationPath), JSON.stringify(saved, null, 2) + '\n');
  });
  if (input.install) installProvider(root, 'rea');
  if (input.enabled) {
    let runtime;
    try { runtime = installed(root); } catch { return reaStatus(root); }
    if (saved!.entry_sha256 && saved!.entry_sha256 !== runtime.entry_sha256) throw new Error('Pinned REA entry changed. Reinstall the reviewed package before reconfiguration.');
    const bundle = originalSkillBundle(root);
    const skillHashes = Object.fromEntries(bundle.files.map(file => [file.path, file.sha256]));
    if (saved!.skill_hashes && !sameHashes(saved!.skill_hashes, skillHashes)) throw new Error('Pinned REA skill bytes changed. Reinstall the reviewed package before reconfiguration.');
    withOperationLock(root, 'native-dispatch', () => {
      noActiveInvocations(root);
      if (JSON.stringify(configuration(root)) !== JSON.stringify(saved!)) throw new Error('REA configuration changed concurrently; retry.');
      atomicWrite(safePath(root, configurationPath), JSON.stringify({ ...saved!, entry_sha256: runtime.entry_sha256, skill_hashes: skillHashes }, null, 2) + '\n');
    });
    await probeRea(root);
  }
  return reaStatus(root);
}
export interface ReaConnection { client: Client; tools: Map<string, Tool>; launch: { command: string; args: string[] } }
export async function connectRea(root: string, options: { signal?: AbortSignal } = {}): Promise<ReaConnection> {
  const server = launch(root);
  const transport = new StdioClientTransport({ ...server, cwd: root,
    env: { ...getDefaultEnvironment(), ...server.env }, stderr: 'pipe', maxBufferSize: 12 * 1024 * 1024 });
  transport.stderr?.on('data', () => {}); // Drain private diagnostics without publishing them.
  const client = new Client({ name: 'neomind-rea', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: 20_000, signal: options.signal });
    if (client.getServerVersion()?.name !== 'rea' || client.getServerVersion()?.version !== reaPin.version) throw new Error('REA server identity does not match its pin.');
    const tools = new Map<string, Tool>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000, signal: options.signal });
      for (const tool of result.tools) {
        if (tools.has(tool.name)) throw new Error('Duplicate REA tool names.');
        tools.set(tool.name, tool);
      }
      if (tools.size > 2048 || Buffer.byteLength(JSON.stringify([...tools.values()])) > 8 * 1024 * 1024) throw new Error('REA catalog exceeds supported bounds.');
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor || !reaToolAllowlist.every(name => tools.has(name))) throw new Error('REA required static tools are missing.');
    return { client, tools, launch: server };
  } catch {
    await client.close().catch(() => {});
    throw new Error('REA MCP connection or discovery failed. Check the pinned runtime and Node prerequisite.');
  }
}
export async function callReaTool(root: string, connection: ReaConnection, name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}) {
  if (!(reaToolAllowlist as readonly string[]).includes(name) || !connection.tools.has(name)) throw new Error('REA tool is outside the reviewed and observed static allowlist.');
  if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) throw new Error('REA arguments exceed supported bounds.');
  const definition = connection.tools.get(name)!;
  const validator = new AjvJsonSchemaValidator();
  if (name === 'analyze_javascript_application') {
    args = { detail: 'summary', analysis_timeout_ms: 45_000, max_heap_mb: 256, max_semantic_nodes: 50_000, ...args };
    if (Number(args.analysis_timeout_ms) > 45_000 || Number(args.max_heap_mb) > 512 || Number(args.max_semantic_nodes) > 100_000)
      throw new Error('REA strict analysis resource budget exceeds the supported limit.');
  }
  if (!validator.getValidator(definition.inputSchema as JsonSchemaType)(args).valid) throw new Error('REA arguments do not match the observed input schema.');
  if (name === 'analyze_javascript_application') {
    const path = resolve(root, String(args.input_path)), local = relative(root, path);
    const privateName = (part: string) => part.startsWith('.') || /^(?:node_modules|credentials?|secrets?)(?:\.|$)/i.test(part) || /\.(?:pem|key|pfx|p12)$/i.test(part);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || local.split(/[\\/]/).some(privateName))
      throw new Error('REA target escapes the assigned public project files.');
    let cursor = resolve(root);
    for (const segment of local.split(sep)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('REA target must not follow symbolic links.');
    }
    if (!lstatSync(path).isDirectory()) throw new Error('REA strict analysis requires a public artifact directory; archive and standalone-file targets are unsupported.');
    let files = 0, bytes = 0, entries = 0;
    const inspect = (item: string, depth = 0): void => {
      if (++entries > 2048 || depth > 32) throw new Error('REA target exceeds the directory traversal budget.');
      const stat = lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error('REA target must not follow symbolic links.');
      if (stat.isDirectory()) {
        for (const entry of readdirSync(item)) {
          if (privateName(entry)) throw new Error('REA target includes private or dependency files; select a public artifact directory.');
          inspect(join(item, entry), depth + 1);
        }
      } else {
        if (!stat.isFile() || ++files > 512 || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024)
          throw new Error('REA target exceeds the initial strict adapter bounds.');
      }
    };
    inspect(path);
    if (Array.isArray(args.source_paths)) for (const selected of args.source_paths) {
      if (typeof selected !== 'string' || isAbsolute(selected) || selected.split(/[\\/]/).some(part => !part || part === '..' || privateName(part)))
        throw new Error('REA selected sources must be explicit public relative artifact paths.');
      regularWithin(path, resolve(path, selected));
    }
  }
  if (name === 'inspect_analysis_view' && (!args.source || typeof args.source !== 'object' || (args.source as { kind?: string }).kind !== 'retained-evidence'))
    throw new Error('The strict REA adapter accepts same-session retained Evidence views only.');
  const result = await connection.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000, signal: options.signal });
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('REA result exceeds the gateway limit. Select summary detail or a smaller retained-evidence view.');
  if (definition.outputSchema && result.structuredContent && !validator.getValidator(definition.outputSchema as JsonSchemaType)(result.structuredContent).valid)
    throw new Error('REA response does not match the observed output schema.');
  return result;
}
export async function probeRea(root: string, options: { signal?: AbortSignal } = {}) {
  const connection = await connectRea(root, options);
  try {
    const identity = await callReaTool(root, connection, 'binary_session', {}, options);
    if (identity.isError) throw new Error('REA identity probe failed. Engine availability is not established.');
    const observed = { version: reaPin.version, entry_sha256: installed(root).entry_sha256, observed_at: now(),
      server: connection.client.getServerVersion(), tools: reaToolAllowlist.map(name => {
        const tool = connection.tools.get(name)!;
        return { name, input_schema_sha256: hash(JSON.stringify(tool.inputSchema)), output_schema_sha256: tool.outputSchema ? hash(JSON.stringify(tool.outputSchema)) : null };
      }), catalog_count: connection.tools.size, scope: 'Actual MCP handshake, schema discovery and target-free identity only; engines and target execution remain separate.' };
    atomicWrite(safePath(root, observationPath), JSON.stringify(observed, null, 2) + '\n');
    return observed;
  } finally { await connection.client.close(); }
}
function originalSkillBundle(root: string): ReaSkillBundle {
  const { packageRoot } = installed(root), folder = join(packageRoot, 'skills/reverse-engineer-anything');
  const files: ReaSkillBundle['files'] = [];
  let size = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('REA skill bundle must not follow symbolic links.');
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) throw new Error('REA skill bundle contains unsupported files.');
      const bytes = readFileSync(regularWithin(folder, path)); size += bytes.length;
      if (bytes.length > 128 * 1024 || size > 1024 * 1024 || files.length >= 64) throw new Error('REA skill bundle exceeds supported bounds.');
      files.push({ path: relative(folder, path).split(sep).join('/'), content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), sha256: hash(bytes) });
    }
  };
  visit(folder);
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error('REA original skill is missing.');
  const available = new Set(files.map(file => file.path));
  for (const file of files) for (const match of file.content.matchAll(/\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)) {
    const link = match[1]!;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link)) continue;
    if (link.startsWith('/') || link.includes('\\')) throw new Error('REA Markdown reference escapes its original skill folder.');
    const normalized: string[] = [];
    for (const part of [...file.path.split('/').slice(0, -1), ...link.split('/')]) {
      if (part === '..') { if (!normalized.length) throw new Error('REA Markdown reference escapes its original skill folder.'); normalized.pop(); }
      else if (part && part !== '.') normalized.push(part);
    }
    if (!available.has(normalized.join('/'))) throw new Error('REA Markdown reference is missing from its original skill folder.');
  }
  const license = readFileSync(regularWithin(packageRoot, join(packageRoot, 'LICENSE')));
  files.push({ path: 'LICENSE', content: license.toString('utf8'), sha256: hash(license) });
  const provenance = { package: reaPin.package, version: reaPin.version, integrity: reaPin.integrity, repository: 'morluto/rea' };
  const origin = JSON.stringify({ ...provenance, note: 'Original published skill/reference/license bytes. npm supplied no gitHead; no repository-commit equivalence is asserted.' }, null, 2) + '\n';
  files.push({ path: 'ORIGIN.json', content: origin, sha256: hash(origin) });
  return { name: 'reverse-engineer-anything', files, provenance };
}
export function readReaSkillBundle(root: string): ReaSkillBundle | null {
  if (reaRegistration(root).status !== 'ready') return null;
  const bundle = originalSkillBundle(root), baseline = configuration(root)?.skill_hashes;
  if (!baseline || !sameHashes(baseline, Object.fromEntries(bundle.files.map(file => [file.path, file.sha256]))))
    throw new Error('Pinned REA skill bytes changed. Reconfigure only after reinstalling the reviewed package.');
  return bundle;
}
