import { existsSync, lstatSync, realpathSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { atomicWrite, hash, readConfig, safePath, withOperationLock, retryWindowsFileOperation } from './storage.js';
import { pluginRegistration, withPluginConfigurationLock } from './plugin-control.js';

const plugins = ['rea', 'codegraph', 'context7', 'playwright'] as const;
const clients = ['codex', 'copilot-vscode', 'copilot-cli'] as const;
export type PluginConnectionClient = typeof clients[number];
type Plugin = typeof plugins[number];
/** Native host supplies these paths. Never accept them from webview messages. */
export interface PluginConnectionTargets { codex?: string; copilotVscode?: string; copilotCli?: string }
export interface PluginConnectionStatus {
  plugin: Plugin; client: PluginConnectionClient;
  status: 'connected' | 'disconnected' | 'unselected' | 'conflict' | 'blocked';
  managed: boolean; configured: boolean; verified_live: false;
  applies_to: 'next-client-session'; reason?: string;
}
interface OwnedEntry {
  target_sha256: string; entry_sha256: string; format: 'json' | 'toml-block';
  created_at: string; previous: 'absent';
}
interface Ledger { schema_version: 1; preferences: Record<string, boolean>; entries: Record<string, OwnedEntry> }
const ledgerRelative = '.neomind/plugin-connections.json';
const key = (plugin: Plugin, client: PluginConnectionClient) => `${client}:${plugin}`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
function validateInput(plugin: string, client?: string): asserts plugin is Plugin {
  if (!(plugins as readonly string[]).includes(plugin) || (client !== undefined && !(clients as readonly string[]).includes(client)))
    throw new Error('Unknown plug-in or MCP client.');
}
function noLinks(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === resolve(path) && !stat.isFile())) throw new Error('MCP configuration must use a regular file without links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('MCP configuration must use a regular file without links.');
    }
    if (dirname(current) === current) break;
  }
}
/** Preserve the existing long filename when a native Windows picker supplies an 8.3 alias. */
function physicalTarget(path: string): string {
  const selected = resolve(path);
  noLinks(selected);
  if (process.platform !== 'win32') return selected;
  let existing = selected;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('MCP configuration filesystem is unavailable.');
    existing = parent;
  }
  return resolve(realpathSync.native(existing), relative(existing, selected));
}
function readText(path: string): string | undefined {
  noLinks(path);
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).size > 1024 * 1024) throw new Error('MCP configuration exceeds the supported size.');
  try { return readFileSync(path, 'utf8'); } catch { throw new Error('MCP configuration cannot be read.'); }
}
class ConfigurationPermissionsError extends Error {
  constructor(readonly diagnostic: string) { super('The existing MCP configuration permissions could not be preserved.'); }
}
/** Fixed diagnostics only: never propagate PowerShell stderr, paths, SIDs, or security descriptors. */
function aclFailureDetail(error: unknown): string {
  const failure = error as { stdout?: unknown; code?: unknown } | null;
  if (failure?.code === 'ETIMEDOUT') return 'ACL_HELPER_TIMEOUT';
  try {
    const output = Buffer.isBuffer(failure?.stdout) ? failure.stdout.toString('utf8') : failure?.stdout;
    if (typeof output !== 'string' || output.length > 4096) return 'ACL_HELPER_FAILED';
    const diagnostic = JSON.parse(output);
    if (diagnostic.code === 'ACL_DESCRIPTOR_MISMATCH') {
      const flags = (value: unknown): string => typeof value === 'string' && /^(?:P|AR|AI)*$/.test(value) ? value : 'other';
      const equal = (value: unknown): string => value === true ? 'true' : value === false ? 'false' : 'unknown';
      return `ACL_DESCRIPTOR_MISMATCH(owner_equal=${equal(diagnostic.owner_equal)},group_equal=${equal(diagnostic.group_equal)},ordered_dacl_equal=${equal(diagnostic.ordered_dacl_equal)},source_flags=${flags(diagnostic.source_flags)},copy_flags=${flags(diagnostic.copy_flags)})`;
    }
    if (diagnostic.code === 'ACL_COPY_FAILED') {
      const stages = ['read-source', 'copy-descriptor', 'verify-descriptor'];
      const kinds = ['UnauthorizedAccessException', 'SecurityException', 'IOException', 'MethodInvocationException'];
      const stage = stages.includes(diagnostic.stage) ? diagnostic.stage : 'unknown';
      const kind = kinds.includes(diagnostic.kind) ? diagnostic.kind : 'other';
      const hresult = Number.isInteger(diagnostic.hresult) && diagnostic.hresult >= -2147483648 && diagnostic.hresult <= 2147483647 ? diagnostic.hresult : 'unknown';
      return `ACL_COPY_FAILED(stage=${stage},kind=${kind},hresult=${hresult})`;
    }
  } catch { /* Non-contract output stays private. */ }
  return 'ACL_HELPER_FAILED';
}
/** Retain restrictive permissions for user settings containing unrelated credentials. */
function writeConfiguration(path: string, value: string, expectedHash: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  let descriptor: number | undefined;
  try {
    if (process.platform === 'win32' && existsSync(path)) {
      // Apply the existing descriptor at CreateNew, before any content exists.
      // In an elevated token, a normally-created temporary file can be owned
      // by Administrators even when the settings file belongs to the user.
      // Changing it afterwards requires WRITE_OWNER absent in Modify-only
      // directories; creation-time security avoids that unnecessary request.
      // Fixed code and environment paths avoid command interpolation and module autoload.
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; $stage='read-source'; try { " +
          '$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group; ' +
          '$acl=[System.IO.File]::GetAccessControl($env:NEOMIND_MCP_ACL_SOURCE); ' +
          "$sddl=$acl.GetSecurityDescriptorSddlForm($sections); $stage='copy-descriptor'; " +
          '$replacement=New-Object System.Security.AccessControl.FileSecurity; $replacement.SetSecurityDescriptorSddlForm($sddl,$sections); ' +
          '$created=[System.IO.FileStream]::new($env:NEOMIND_MCP_ACL_TEMP,[System.IO.FileMode]::CreateNew,[System.Security.AccessControl.FileSystemRights]::Write,[System.IO.FileShare]::None,4096,[System.IO.FileOptions]::None,$replacement); $created.Dispose(); ' +
          // CreateFile can clear the DACL auto-inherited marker. Reapply only
          // Access so the owner/group established at creation stay untouched.
          '$access=New-Object System.Security.AccessControl.FileSecurity; $access.SetSecurityDescriptorSddlForm($sddl,[System.Security.AccessControl.AccessControlSections]::Access); [System.IO.File]::SetAccessControl($env:NEOMIND_MCP_ACL_TEMP,$access); ' +
          "$stage='verify-descriptor'; $copied=[System.IO.File]::GetAccessControl($env:NEOMIND_MCP_ACL_TEMP); $copySddl=$copied.GetSecurityDescriptorSddlForm($sections); " +
          'if ($sddl -cne $copySddl) { ' +
          '$originalRaw=[System.Security.AccessControl.RawSecurityDescriptor]::new($sddl); $copiedRaw=[System.Security.AccessControl.RawSecurityDescriptor]::new($copySddl); ' +
          "function DaclBytes($raw) { if ($null -eq $raw.DiscretionaryAcl) { return 'null' }; $bytes=New-Object byte[] $raw.DiscretionaryAcl.BinaryLength; $raw.DiscretionaryAcl.GetBinaryForm($bytes,0); return [Convert]::ToBase64String($bytes) }; " +
          '$ownerEqual=$originalRaw.Owner.Value -eq $copiedRaw.Owner.Value; $groupEqual=$originalRaw.Group.Value -eq $copiedRaw.Group.Value; $daclEqual=(DaclBytes $originalRaw) -ceq (DaclBytes $copiedRaw); ' +
          // Windows may mark an otherwise identical inherited DACL as auto-inherited.
          // Allow only that unset-to-set control bit transition; ordered ACE bytes,
          // owner, group, protection and every other control bit must remain identical.
          '$autoInherited=[int][System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited; ' +
          '$sourceControl=[int]$originalRaw.ControlFlags; $copyControl=[int]$copiedRaw.ControlFlags; ' +
          '$onlyAutoInherited=$ownerEqual -and $groupEqual -and $daclEqual -and (($sourceControl -band $autoInherited) -eq 0) -and (($copyControl -band $autoInherited) -ne 0) -and (($sourceControl -bxor $copyControl) -eq $autoInherited); ' +
          "if (-not $onlyAutoInherited) { [pscustomobject]@{code='ACL_DESCRIPTOR_MISMATCH'; owner_equal=$ownerEqual; group_equal=$groupEqual; ordered_dacl_equal=$daclEqual; source_flags=([regex]::Match($sddl,'D:([^\\(]*)').Groups[1].Value); copy_flags=([regex]::Match($copySddl,'D:([^\\(]*)').Groups[1].Value)} | ConvertTo-Json -Compress; exit 42 } } " +
          "} catch { $fault=$_.Exception; if ($fault.InnerException) { $fault=$fault.InnerException }; " +
          "[pscustomobject]@{code='ACL_COPY_FAILED';stage=$stage;kind=$fault.GetType().Name;hresult=$fault.HResult} | ConvertTo-Json -Compress; exit 43 }"],
        { env: { ...process.env, NEOMIND_MCP_ACL_SOURCE: path, NEOMIND_MCP_ACL_TEMP: temporary }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
      } catch (error) { throw new ConfigurationPermissionsError(aclFailureDetail(error)); }
      descriptor = openSync(temporary, 'r+');
    } else descriptor = openSync(temporary, 'wx', mode);
    if (hash(readText(path) ?? '') !== expectedHash) throw new Error('MCP configuration changed during this operation.');
    writeFileSync(descriptor, value);
    closeSync(descriptor); descriptor = undefined;
    retryWindowsFileOperation(() => renameSync(temporary, path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function readLedger(root: string): Ledger {
  const source = readText(safePath(root, ledgerRelative));
  if (source === undefined) return { schema_version: 1, preferences: {}, entries: {} };
  try {
    const saved = JSON.parse(source) as Ledger;
    const object = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    if (!object(saved) || Object.keys(saved).some(key => !['schema_version', 'preferences', 'entries'].includes(key)) ||
        saved.schema_version !== 1 || !object(saved.preferences) || !object(saved.entries)) throw new Error();
    const keys = clients.flatMap(client => plugins.map(plugin => key(plugin, client)));
    for (const [id, preference] of Object.entries(saved.preferences)) if (!keys.includes(id) || typeof preference !== 'boolean') throw new Error();
    for (const [id, entry] of Object.entries(saved.entries)) {
      if (!keys.includes(id) || !object(entry) || !/^[a-f0-9]{64}$/.test(entry.target_sha256) || !/^[a-f0-9]{64}$/.test(entry.entry_sha256) ||
          !['json', 'toml-block'].includes(entry.format) || entry.previous !== 'absent' || typeof entry.created_at !== 'string') throw new Error();
    }
    return saved;
  } catch { throw new Error('Plug-in connection ownership metadata is malformed.'); }
}
/** Preserve an explicit disconnect through subsequent installer updates. */
export function pluginClientConnectionEnabled(root: string, plugin: string, client: PluginConnectionClient): boolean {
  validateInput(plugin, client);
  return readLedger(root).preferences[key(plugin, client)] !== false;
}
function target(root: string, client: PluginConnectionClient, trusted: PluginConnectionTargets): string | undefined {
  if (client === 'codex') {
    const fixed = physicalTarget(safePath(root, '.codex/config.toml'));
    if (trusted.codex && physicalTarget(trusted.codex) !== fixed) throw new Error('Codex MCP configuration must belong to this project.');
    return fixed;
  }
  const supplied = client === 'copilot-vscode' ? trusted.copilotVscode : trusted.copilotCli;
  if (!supplied) return undefined;
  if (!isAbsolute(supplied)) throw new Error('MCP target must be selected by the native host.');
  return physicalTarget(supplied);
}
function rejectDuplicateJsonKeys(node: Node | undefined): void {
  if (!node) return;
  if (node.type === 'object') {
    const keys = (node.children ?? []).map(property => property.children?.[0]?.value);
    if (new Set(keys).size !== keys.length) throw new Error('MCP JSON configuration contains duplicate keys.');
  }
  for (const child of node.children ?? []) rejectDuplicateJsonKeys(child);
}
function jsonObject(source: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const object = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !object || typeof object !== 'object' || Array.isArray(object)) throw new Error('MCP JSON configuration is malformed.');
  rejectDuplicateJsonKeys(parseTree(source));
  return object;
}
function tomlObject(source: string): Record<string, unknown> {
  try { return parseToml(source) as Record<string, unknown>; } catch { throw new Error('MCP TOML configuration is malformed.'); }
}
function expected(root: string, plugin: Plugin, client: PluginConnectionClient): unknown | undefined {
  const registration = pluginRegistration(root, plugin);
  if (registration.status !== 'ready' || !registration.server) return undefined;
  const { command, args, env } = registration.server;
  if (client === 'codex') return { command, args, ...(env && Object.keys(env).length ? { env } : {}),
    ...(plugin === 'codegraph' ? { enabled: true } : {}), ...(registration.tools.length ? { enabled_tools: registration.tools } : {}) };
  return { ...(client === 'copilot-cli' ? { type: 'local', tools: registration.tools.length ? registration.tools : ['*'] } : { type: 'stdio' }),
    command, args, ...(env && Object.keys(env).length ? { env } : {}) };
}
interface EntryState { value?: unknown; digest?: string; installerDigest?: string; start?: number; end?: number; managedBlock: boolean; marker?: 'WORKFORCE' | 'NEOMIND' }
function inspect(source: string | undefined, plugin: Plugin, client: PluginConnectionClient): EntryState {
  if (source === undefined) return { managedBlock: false };
  if (client !== 'codex') {
    const object = jsonObject(source);
    const parent = object[client === 'copilot-vscode' ? 'servers' : 'mcpServers'];
    if (parent !== undefined && (!parent || typeof parent !== 'object' || Array.isArray(parent))) throw new Error('MCP server container must be an object.');
    const value = (parent as Record<string, unknown> | undefined)?.[plugin];
    return { value, ...(value !== undefined ? { digest: hash(canonical(value)), installerDigest: hash(JSON.stringify(value)) } : {}), managedBlock: false };
  }
  const object = tomlObject(source);
  const parent = object.mcp_servers;
  if (parent !== undefined && (!parent || typeof parent !== 'object' || Array.isArray(parent))) throw new Error('MCP server container must be a table.');
  const value = (parent as Record<string, unknown> | undefined)?.[plugin];
  const markers = (['WORKFORCE', 'NEOMIND'] as const).filter(marker =>
    source.includes(`# BEGIN ${marker} ${plugin}`) || source.includes(`# END ${marker} ${plugin}`));
  if (markers.length > 1) throw new Error('Managed MCP markers are malformed or mixed.');
  const marker = markers[0] ?? 'WORKFORCE';
  const begin = `# BEGIN ${marker} ${plugin}`, finish = `# END ${marker} ${plugin}`;
  const start = source.indexOf(begin), stop = source.indexOf(finish);
  if (start < 0 && stop < 0) return { value, ...(value !== undefined ? { digest: hash(canonical(value)) } : {}), managedBlock: false };
  if (start < 0 || stop < start || source.indexOf(begin, start + begin.length) >= 0 || source.indexOf(finish, stop + finish.length) >= 0 ||
      (start > 0 && source[start - 1] !== '\n') || !/^(?:\r?\n|$)/.test(source.slice(stop + finish.length))) throw new Error('Managed MCP markers are malformed.');
  const body = tomlObject(source.slice(start + begin.length, stop).trim());
  const blockParent = body.mcp_servers;
  if (Object.keys(body).length !== 1 || !blockParent || typeof blockParent !== 'object' || Object.keys(blockParent).length !== 1 ||
      !Object.hasOwn(blockParent, plugin) || canonical((blockParent as Record<string, unknown>)[plugin]) !== canonical(value))
    throw new Error('Managed MCP block contains unrelated or conflicting settings.');
  const originalBody = source.slice(start + begin.length, stop).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return { value, digest: hash(canonical(value)), installerDigest: hash(originalBody), start, end: stop + finish.length, managedBlock: true, marker };
}
function installerOwns(root: string, plugin: Plugin, client: PluginConnectionClient, path: string, state: EntryState): boolean {
  if (client === 'copilot-cli') return false;
  const relative = client === 'codex' ? '.codex/config.toml' : '.vscode/mcp.json';
  if (path !== physicalTarget(safePath(root, relative))) return false;
  const source = readText(safePath(root, '.neomind/install-manifest.json'));
  if (source === undefined) return false;
  try {
    const manifest = JSON.parse(source), entryKey = client === 'codex' ? plugin : `servers.${plugin}`;
    const entry = manifest.files?.[`${relative}#${entryKey}`];
    return manifest.schema_version === 1 && entry?.path === relative && entry?.key === entryKey &&
      entry?.kind === (client === 'codex' ? 'block' : 'json') && entry?.hash === state.installerDigest;
  } catch { return false; }
}
function canAdopt(root: string, plugin: Plugin, client: PluginConnectionClient, path: string, state: EntryState, proposed: unknown): boolean {
  if (proposed === undefined || state.digest !== hash(canonical(proposed))) return false;
  return installerOwns(root, plugin, client, path, state) ||
    (['rea', 'codegraph'].includes(plugin) && (client !== 'codex' || state.managedBlock));
}
function body(plugin: Plugin, value: unknown): string {
  const server = value as { command: string; args: string[]; env?: Record<string, string>; enabled_tools?: string[]; enabled?: boolean };
  return [`[mcp_servers.${plugin}]`, `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`,
    ...(server.enabled !== undefined ? [`enabled = ${server.enabled}`] : []),
    ...(server.enabled_tools ? [`enabled_tools = ${JSON.stringify(server.enabled_tools)}`] : []),
    ...(server.env ? [`env = { ${Object.entries(server.env).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }`] : [])].join('\n');
}
function edit(source: string | undefined, plugin: Plugin, client: PluginConnectionClient, state: EntryState, value?: unknown): string {
  if (client !== 'codex') return applyEdits(source ?? '{}\n', modify(source ?? '{}\n', [client === 'copilot-vscode' ? 'servers' : 'mcpServers', plugin], value,
    { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source?.includes('\r\n') ? '\r\n' : '\n' } }));
  const marker = state.marker ?? 'WORKFORCE';
  const block = value === undefined ? '' : `# BEGIN ${marker} ${plugin}\n${body(plugin, value)}\n# END ${marker} ${plugin}`;
  if (state.start !== undefined) return `${source!.slice(0, state.start)}${block}${source!.slice(state.end)}`;
  if (state.value !== undefined) throw new Error('Authored Codex MCP tables cannot be replaced or removed.');
  return `${source ?? ''}${source && !source.endsWith('\n') ? '\n' : ''}${source ? '\n' : ''}${block}\n`;
}
function row(plugin: Plugin, client: PluginConnectionClient, status: PluginConnectionStatus['status'], managed = false, configured = false, reason?: string): PluginConnectionStatus {
  return { plugin, client, status, managed, configured, verified_live: false, applies_to: 'next-client-session', ...(reason ? { reason } : {}) };
}
function assess(root: string, plugin: Plugin, client: PluginConnectionClient, trusted: PluginConnectionTargets, ledger: Ledger): PluginConnectionStatus {
  const path = target(root, client, trusted);
  if (!path) return row(plugin, client, 'unselected', false, false, 'Select the client configuration in the native host.');
  const state = inspect(readText(path), plugin, client);
  if (state.value === undefined) return row(plugin, client, 'disconnected');
  const owned = ledger.entries[key(plugin, client)];
  const matched = owned?.target_sha256 === hash(path) && state.digest === owned.entry_sha256;
  const proposed = expected(root, plugin, client);
  const exact = proposed !== undefined && state.digest === hash(canonical(proposed));
  const adoptable = canAdopt(root, plugin, client, path, state, proposed);
  if ((matched || adoptable) && exact) return row(plugin, client, 'connected', matched, true);
  return row(plugin, client, 'conflict', matched, true, matched ? 'Configured entry requires a ready, matching plug-in launch configuration.' : 'An authored or changed MCP entry is preserved.');
}
export function readPluginConnections(root: string, trustedTargets: PluginConnectionTargets = {}): PluginConnectionStatus[] {
  readConfig(root);
  let ledger: Ledger;
  try { ledger = readLedger(root); } catch { return plugins.flatMap(plugin => clients.map(client => row(plugin, client, 'blocked', false, false, 'Connection ownership metadata requires repair.'))); }
  return plugins.flatMap(plugin => clients.map(client => {
    try { return assess(root, plugin, client, trustedTargets, ledger); }
    catch { return row(plugin, client, 'blocked', false, false, 'Client configuration is malformed, unsafe, or unavailable.'); }
  }));
}
/** Configuration evidence only: this never launches a server or claims a live client session. */
export function setPluginConnection(root: string, input: { plugin: string; client: PluginConnectionClient; connected: boolean }, trustedTargets: PluginConnectionTargets = {}): PluginConnectionStatus {
  readConfig(root);
  validateInput(input.plugin, input.client);
  if (typeof input.connected !== 'boolean' || Object.keys(input).some(k => !['plugin', 'client', 'connected'].includes(k))) throw new Error('Invalid plug-in connection request.');
  const plugin = input.plugin as Plugin, client = input.client;
  return withPluginConfigurationLock(root, () => withOperationLock(root, 'plugin-connections', () => {
    const path = target(root, client, trustedTargets);
    if (!path) return row(plugin, client, 'unselected', false, false, 'Select the client configuration in the native host.');
    const proposed = input.connected ? expected(root, plugin, client) : undefined;
    if (input.connected && proposed === undefined) throw new Error('Enable and verify the plug-in before connecting its MCP server.');
    // User-level configurations are shared by projects, so serialize at the target too.
    const lock = `${path}.neomind.lock`;
    noLinks(lock);
    mkdirSync(dirname(path), { recursive: true });
    let descriptor: number;
    try { descriptor = openSync(lock, 'wx'); } catch { throw new Error('The selected MCP configuration is busy. Retry after the other operation completes.'); }
    try {
      const source = readText(path), before = hash(source ?? ''), ledger = readLedger(root), originalLedger = JSON.stringify(ledger);
      const state = inspect(source, plugin, client), id = key(plugin, client), owned = ledger.entries[id];
      if (owned && owned.target_sha256 !== hash(path)) throw new Error('Connection target changed; preserve the previous client configuration and select its original profile.');
      const digest = proposed === undefined ? undefined : hash(canonical(proposed));
      const exact = proposed !== undefined && digest === state.digest;
      const adoptedExpected = !input.connected ? expected(root, plugin, client) : proposed;
      const adoptable = canAdopt(root, plugin, client, path, state, adoptedExpected);
      if (state.value !== undefined && !(owned ? owned.entry_sha256 === state.digest : adoptable)) throw new Error('An authored or changed MCP entry is preserved; review it before managing this connection.');
      if (owned && state.value !== undefined && client === 'codex' && !state.managedBlock) throw new Error('Managed Codex MCP markers changed; the entry is preserved.');
      let next = source;
      if (input.connected && !exact) next = edit(source, plugin, client, state, proposed);
      if (!input.connected && state.value !== undefined) next = edit(source, plugin, client, state);
      ledger.preferences[id] = input.connected;
      if (input.connected) ledger.entries[id] = { target_sha256: hash(path), entry_sha256: digest!, format: client === 'codex' ? 'toml-block' : 'json', created_at: owned?.created_at ?? new Date().toISOString(), previous: 'absent' };
      // Retain a hash-only tombstone until reconnect. A crash between writing
      // the ledger and removing the entry can then be retried without losing ownership.
      else if (!owned && state.digest) ledger.entries[id] = { target_sha256: hash(path), entry_sha256: state.digest,
        format: client === 'codex' ? 'toml-block' : 'json', created_at: new Date().toISOString(), previous: 'absent' };
      // Persist ownership before the target. Interrupted adds can safely be retried; no secret-bearing whole-file backups are stored.
      const ledgerPath = safePath(root, ledgerRelative), ledgerText = readText(ledgerPath);
      if (hash(readText(path) ?? '') !== before || JSON.stringify(readLedger(root)) !== originalLedger) throw new Error('MCP configuration changed during this operation; retry with the current configuration.');
      atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      try {
        if (next !== source && next !== undefined) {
          if (hash(readText(path) ?? '') !== before) throw new Error('MCP configuration changed during this operation.');
          inspect(next, plugin, client); // Validate edited configuration before replacing any bytes.
          writeConfiguration(path, next, before);
        }
      } catch (error) {
        if (ledgerText === undefined) unlinkSync(ledgerPath); else atomicWrite(ledgerPath, ledgerText);
        const detail = error instanceof ConfigurationPermissionsError ? ` ${error.diagnostic}.` : '';
        throw new Error(`MCP configuration could not be updated; existing connection ownership was restored.${detail}`);
      }
      if (!input.connected) {
        // Only a pending disconnect retains ownership. Once removal is verified,
        // release this profile so a later native profile selection can connect.
        if (inspect(readText(path), plugin, client).value !== undefined)
          throw new Error('MCP configuration changed after disconnect; review the selected client configuration.');
        delete ledger.entries[id];
        atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      }
      return input.connected ? row(plugin, client, 'connected', true, true) : row(plugin, client, 'disconnected');
    } finally { closeSync(descriptor); unlinkSync(lock); }
  }));
}
