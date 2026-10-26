import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync, statSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { initialize, hash } from '../dist/storage.js';
import { toolCatalog, ensureToolPolicy } from '../dist/tools.js';
import { pluginRegistration, setPluginEnabled } from '../dist/plugin-control.js';
import { installProject, updateProject } from '../dist/installer.js';
import { readPluginConnections, setPluginConnection, pluginClientConnectionEnabled } from '../dist/plugin-connections.js';

function put(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function fixture(t, ids = ['context7', 'playwright', 'rea']) {
  const base = mkdtempSync(join(tmpdir(), 'neomind connections-')), root = join(base, 'project');
  mkdirSync(root); initialize(root, { project_id: 'CONNECTIONS', platforms: ['codex', 'copilot'] });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const policy = ensureToolPolicy(root);
  put(join(root, '.neomind/tools.json'), JSON.stringify({ ...policy, approved_providers: ids }));
  for (const id of ids) {
    const tool = toolCatalog.find(item => item.id === id), installed = join(root, `.neomind/tools/${id}/${tool.version}`);
    const pkg = join(installed, 'node_modules', tool.package), script = join(pkg, id === 'rea' ? 'scripts/rea.mjs' : 'cli.mjs');
    const source = '// Private configuration fixture; never executed or presented as live MCP proof.\n';
    put(script, source);
    put(join(pkg, 'package.json'), JSON.stringify({ name: tool.package, version: tool.version, bin: id === 'rea' ? 'scripts/rea.mjs' : 'cli.mjs' }));
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${tool.package}`]: { version: tool.version, integrity: tool.integrity } } });
    put(join(installed, 'package-lock.json'), lock);
    put(join(root, `.neomind/tool-locks/${id}-${tool.version}.json`), lock);
    if (id === 'rea') {
      put(join(root, '.neomind/rea.json'), JSON.stringify({ schema_version: 1, enabled: true, package: tool.package, version: tool.version,
        integrity: tool.integrity, node_command: realpathSync(process.execPath), entry_sha256: hash(source) }));
      put(join(installed, 'observed.json'), JSON.stringify({ version: tool.version, entry_sha256: hash(source), server: { name: 'rea', version: tool.version },
        observed_at: new Date().toISOString(), catalog_count: tool.tools.length,
        tools: tool.tools.map(name => ({ name, input_schema_sha256: hash('{}'), output_schema_sha256: null })) }));
    } else {
      const server = { command: process.execPath, args: [script, ...(id === 'playwright' ? ['--headless', '--isolated'] : [])], env: { DO_NOT_TRACK: '1' } };
      put(join(root, `.neomind/plugins/${id}-probe.json`), JSON.stringify({ schema_version: 1, plugin: id, at: new Date().toISOString(), tool_count: tool.tools.length,
        baseline: hash(JSON.stringify({ version: tool.version, integrity: tool.integrity, server: { ...server, command: 'node' }, executable: hash(source), dependency_lock: hash(lock) })) }));
    }
    assert.equal(pluginRegistration(root, id).status, 'ready', `${id} private registration fixture`);
  }
  return { root, base, targets: { copilotVscode: join(base, 'profile/mcp.json'), copilotCli: join(base, 'copilot/mcp-config.json') } };
}
const status = (root, targets, plugin, client) => readPluginConnections(root, targets).find(item => item.plugin === plugin && item.client === client);
function change(root, targets, plugin, client, connected) { return setPluginConnection(root, { plugin, client, connected }, targets); }

test('per-client connection formats preserve comments, unrelated credentials and restrictive permissions', t => {
  const { root, targets } = fixture(t);
  const user = '// Keep my user profile comment\n{\n  "inputs": [{"id":"token","password":true}],\n  "servers": {"private": {"command":"private-server", "env":{"SECRET":"do-not-expose"}}},\n}\n';
  put(targets.copilotVscode, user);
  if (process.platform !== 'win32') chmodSync(targets.copilotVscode, 0o600);
  change(root, targets, 'context7', 'copilot-vscode', true);
  const configured = readFileSync(targets.copilotVscode, 'utf8');
  assert.match(configured, /Keep my user profile comment/);
  assert.deepEqual(parseJsonc(configured).servers.private, parseJsonc(user).servers.private);
  assert.deepEqual(parseJsonc(configured).inputs, parseJsonc(user).inputs);
  assert.equal(parseJsonc(configured).servers.context7.type, 'stdio');
  if (process.platform !== 'win32') assert.equal(statSync(targets.copilotVscode).mode & 0o777, 0o600);
  change(root, targets, 'playwright', 'copilot-cli', true);
  const cli = JSON.parse(readFileSync(targets.copilotCli, 'utf8'));
  assert.equal(cli.mcpServers.playwright.type, 'local');
  assert.deepEqual(cli.mcpServers.playwright.tools, toolCatalog.find(item => item.id === 'playwright').tools);
  assert.ok(cli.mcpServers.playwright.args.includes('--isolated'));
  const report = status(root, targets, 'context7', 'copilot-vscode');
  assert.equal(report.status, 'connected'); assert.equal(report.verified_live, false); assert.equal(report.applies_to, 'next-client-session');
  assert.doesNotMatch(JSON.stringify(readPluginConnections(root, targets)), /do-not-expose|private-server|mcp-config\.json/);
  assert.doesNotMatch(readFileSync(join(root, '.neomind/plugin-connections.json'), 'utf8'), /do-not-expose|private-server/);
  change(root, targets, 'context7', 'copilot-vscode', false);
  assert.equal(parseJsonc(readFileSync(targets.copilotVscode, 'utf8')).servers.context7, undefined);
  assert.equal(pluginClientConnectionEnabled(root, 'context7', 'copilot-vscode'), false);
});

test('Codex block changes preserve every byte outside the managed block and explicit disconnect survives updates', t => {
  const { root, targets } = fixture(t);
  const path = join(root, '.codex/config.toml'), original = '# User comments\r\nmodel = "custom"\r\n[projects."D:/notes"]\r\ntrust_level = "trusted"\r\n[mcp_servers.private]\r\ncommand = "private"\r\nenv = { TOKEN = "preserved" }\r\n';
  put(path, original);
  const first = change(root, targets, 'context7', 'codex', true);
  assert.equal(first.status, 'connected');
  const configured = readFileSync(path, 'utf8');
  assert.ok(configured.startsWith(original));
  assert.deepEqual(parseToml(configured).mcp_servers.context7.enabled_tools, ['resolve-library-id', 'query-docs']);
  assert.equal(parseToml(configured).mcp_servers.private.env.TOKEN, 'preserved');
  change(root, targets, 'context7', 'codex', false);
  assert.ok(readFileSync(path, 'utf8').startsWith(original));
  assert.equal(parseToml(readFileSync(path, 'utf8')).mcp_servers.context7, undefined);
  assert.equal(pluginClientConnectionEnabled(root, 'context7', 'codex'), false);
  assert.equal(pluginClientConnectionEnabled(root, 'rea', 'codex'), true);
});

test('existing exact generated REA entries can be adopted and disconnected; authored overrides are preserved', t => {
  const { root, targets } = fixture(t);
  const registration = pluginRegistration(root, 'rea'), path = join(root, '.codex/config.toml');
  const block = `# BEGIN NEOMIND rea\n[mcp_servers.rea]\ncommand = ${JSON.stringify(registration.server.command)}\nargs = ${JSON.stringify(registration.server.args)}\nenabled_tools = ${JSON.stringify(registration.tools)}\nenv = { ${Object.entries(registration.server.env).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }\n# END NEOMIND rea`;
  put(path, `# before\n${block}\n# after\n`);
  assert.equal(status(root, targets, 'rea', 'codex').status, 'connected');
  change(root, targets, 'rea', 'codex', true);
  change(root, targets, 'rea', 'codex', false);
  assert.equal(readFileSync(path, 'utf8'), '# before\n\n# after\n');
  const authored = '# Keep authored command\n[mcp_servers.rea]\ncommand = "my-wrapper"\nargs = []\n';
  put(path, authored);
  assert.throws(() => change(root, targets, 'rea', 'codex', true), /authored|changed/i);
  assert.throws(() => change(root, targets, 'rea', 'codex', false), /authored|changed/i);
  assert.equal(readFileSync(path, 'utf8'), authored);
});

test('hash ownership refuses edited entries and preserves unrelated changes', t => {
  const { root, targets } = fixture(t);
  change(root, targets, 'context7', 'copilot-cli', true);
  const initial = JSON.parse(readFileSync(targets.copilotCli, 'utf8'));
  initial.mcpServers.context7.command = 'authored-wrapper';
  put(targets.copilotCli, JSON.stringify(initial));
  assert.equal(status(root, targets, 'context7', 'copilot-cli').status, 'conflict');
  assert.throws(() => change(root, targets, 'context7', 'copilot-cli', false), /authored|changed/i);
  assert.equal(JSON.parse(readFileSync(targets.copilotCli, 'utf8')).mcpServers.context7.command, 'authored-wrapper');
  change(root, targets, 'playwright', 'copilot-vscode', true);
  const other = JSON.parse(readFileSync(targets.copilotVscode, 'utf8'));
  other.inputs = [{ id: 'keep' }]; put(targets.copilotVscode, JSON.stringify(other));
  change(root, targets, 'playwright', 'copilot-vscode', false);
  assert.deepEqual(JSON.parse(readFileSync(targets.copilotVscode, 'utf8')).inputs, [{ id: 'keep' }]);
});

test('unselected targets, disabled providers and changed native targets do not create client settings', t => {
  const { root, targets, base } = fixture(t);
  assert.equal(change(root, {}, 'context7', 'copilot-vscode', false).status, 'unselected');
  assert.equal(status(root, {}, 'context7', 'copilot-vscode').status, 'unselected');
  setPluginEnabled(root, 'context7', false);
  assert.throws(() => change(root, targets, 'context7', 'copilot-cli', true), /enable|verify/i);
  assert.equal(existsSync(targets.copilotCli), false);
  assert.throws(() => change(root, { codex: join(base, 'outside.toml') }, 'rea', 'codex', true), /belong/i);
  assert.equal(existsSync(join(base, 'outside.toml')), false);
  change(root, targets, 'rea', 'copilot-cli', true);
  assert.throws(() => change(root, { ...targets, copilotCli: join(base, 'other/mcp.json') }, 'rea', 'copilot-cli', true), /target changed/i);
});

test('malformed JSONC, duplicate keys, malformed TOML and mixed managed blocks fail without touching bytes', t => {
  const { root, targets } = fixture(t);
  for (const content of ['{broken', '{"servers":[],}', '{"servers":{},"servers":{}}']) {
    put(targets.copilotVscode, content);
    assert.equal(status(root, targets, 'rea', 'copilot-vscode').status, 'blocked');
    assert.throws(() => change(root, targets, 'rea', 'copilot-vscode', true), /malformed|object|duplicate/i);
    assert.equal(readFileSync(targets.copilotVscode, 'utf8'), content);
  }
  const path = join(root, '.codex/config.toml');
  for (const content of ['model = [', '# BEGIN NEOMIND rea\n[unrelated]\nvalue = 1\n# END NEOMIND rea\n']) {
    put(path, content);
    assert.equal(status(root, targets, 'rea', 'codex').status, 'blocked');
    assert.throws(() => change(root, targets, 'rea', 'codex', true), /malformed|unrelated/i);
    assert.equal(readFileSync(path, 'utf8'), content);
  }
});

test('linked targets and directories fail closed and malformed receipts block all mutation', t => {
  const { root, targets, base } = fixture(t);
  const real = join(base, 'real'), linked = join(base, 'linked'); mkdirSync(real);
  try { symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This account cannot create links.'); throw error; }
  const unsafe = { copilotCli: join(linked, 'mcp.json') };
  assert.equal(status(root, unsafe, 'rea', 'copilot-cli').status, 'blocked');
  assert.throws(() => change(root, unsafe, 'rea', 'copilot-cli', true), /without links/i);
  assert.equal(existsSync(join(real, 'mcp.json')), false);
  assert.throws(() => change(root, { copilotCli: real }, 'rea', 'copilot-cli', true), /regular file/i);
  put(join(root, '.neomind/native/receipts/broken.json'), '{"state":"completed"}');
  assert.throws(() => change(root, targets, 'rea', 'codex', true));
  assert.equal(existsSync(join(root, '.codex/config.toml')), false);
});

test('read status is side-effect free and cannot claim saved configuration is a live session', t => {
  const { root, targets } = fixture(t);
  const result = readPluginConnections(root, targets);
  assert.equal(result.length, 12);
  assert.ok(result.every(row => row.verified_live === false));
  assert.equal(existsSync(join(root, '.neomind/plugin-connections.json')), false);
  assert.equal(existsSync(join(root, '.codex')), false);
  change(root, targets, 'rea', 'copilot-cli', true);
  setPluginEnabled(root, 'rea', false);
  assert.equal(status(root, targets, 'rea', 'copilot-cli').status, 'conflict');
  // A disabled provider can still disconnect an unchanged owned client entry.
  assert.equal(change(root, targets, 'rea', 'copilot-cli', false).status, 'disconnected');
});

test('installer-owned Context7 and Playwright entries are adopted and updates preserve explicit disconnects', t => {
  const { root, targets } = fixture(t, ['context7', 'playwright']);
  assert.deepEqual(installProject(root).conflicts, []);
  const toml = join(root, '.codex/config.toml');
  assert.ok(parseToml(readFileSync(toml, 'utf8')).mcp_servers.context7);
  assert.equal(status(root, targets, 'context7', 'codex').status, 'connected');
  assert.equal(change(root, targets, 'context7', 'codex', false).status, 'disconnected');
  assert.deepEqual(updateProject(root).conflicts, []);
  assert.equal(parseToml(readFileSync(toml, 'utf8')).mcp_servers.context7, undefined);
  const workspaceTargets = { ...targets, copilotVscode: join(root, '.vscode/mcp.json') };
  assert.equal(status(root, workspaceTargets, 'playwright', 'copilot-vscode').status, 'connected');
  const profiles = () => readdirSync(join(root, '.github/agents')).map(name => readFileSync(join(root, '.github/agents', name), 'utf8')).join('\n');
  assert.match(profiles(), /playwright\//);
  assert.equal(change(root, workspaceTargets, 'playwright', 'copilot-vscode', false).status, 'disconnected');
  assert.deepEqual(updateProject(root).conflicts, []);
  assert.equal(parseJsonc(readFileSync(workspaceTargets.copilotVscode, 'utf8')).servers.playwright, undefined);
  // Copilot CLI shares these agent profiles and still has its own connection preference.
  assert.match(profiles(), /playwright\//);
  assert.equal(change(root, workspaceTargets, 'playwright', 'copilot-cli', false).status, 'disconnected');
  assert.deepEqual(updateProject(root).conflicts, []);
  assert.doesNotMatch(profiles(), /playwright\//);
  assert.equal(change(root, targets, 'context7', 'codex', true).status, 'connected');
  assert.deepEqual(updateProject(root).conflicts, []);
  assert.ok(parseToml(readFileSync(toml, 'utf8')).mcp_servers.context7);
  assert.equal((readFileSync(toml, 'utf8').match(/^\[mcp_servers\.context7\]/gm) ?? []).length, 1);
});

test('successful disconnect releases a profile while pending disconnect retains recoverable ownership', t => {
  const { root, targets, base } = fixture(t);
  const nextTargets = { ...targets, copilotVscode: join(base, 'profile-next/mcp.json') };
  const ledgerPath = join(root, '.neomind/plugin-connections.json');
  change(root, targets, 'context7', 'copilot-vscode', true);
  // Switching profiles while an existing managed entry is registered is refused.
  assert.throws(() => change(root, nextTargets, 'context7', 'copilot-vscode', true), /target changed/i);
  // Simulate a process exit after its disconnect intent was saved but before
  // the target mutation: the entry hash remains usable for the retry.
  const pending = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  pending.preferences['copilot-vscode:context7'] = false;
  put(ledgerPath, JSON.stringify(pending));
  assert.throws(() => change(root, nextTargets, 'context7', 'copilot-vscode', true), /target changed/i);
  assert.equal(change(root, targets, 'context7', 'copilot-vscode', false).status, 'disconnected');
  const finished = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(finished.entries['copilot-vscode:context7'], undefined);
  assert.equal(finished.preferences['copilot-vscode:context7'], false);
  assert.equal(change(root, nextTargets, 'context7', 'copilot-vscode', true).status, 'connected');
  const edited = JSON.parse(readFileSync(nextTargets.copilotVscode, 'utf8'));
  edited.servers.context7.command = 'authored-after-connect'; put(nextTargets.copilotVscode, JSON.stringify(edited));
  assert.throws(() => change(root, nextTargets, 'context7', 'copilot-vscode', false), /authored|changed/i);
  assert.throws(() => change(root, targets, 'context7', 'copilot-vscode', true), /target changed/i);
});

test('scalar or array ownership metadata fails closed instead of restoring legacy connection defaults', t => {
  const { root, targets } = fixture(t);
  for (const saved of [true, [], { schema_version: 1, preferences: true, entries: {} },
    { schema_version: 1, preferences: {}, entries: true }, { schema_version: 1, preferences: [], entries: {} },
    { schema_version: 1, preferences: {}, entries: [] }, { schema_version: 1, preferences: null, entries: {} }]) {
    put(join(root, '.neomind/plugin-connections.json'), JSON.stringify(saved));
    assert.ok(readPluginConnections(root, targets).every(item => item.status === 'blocked'));
    assert.throws(() => pluginClientConnectionEnabled(root, 'context7', 'codex'), /malformed/i);
    assert.throws(() => change(root, targets, 'context7', 'codex', true), /malformed/i);
    assert.equal(existsSync(join(root, '.codex/config.toml')), false);
  }
});

test('Windows connect and disconnect retain the protected security descriptor of credential-bearing MCP settings', { skip: process.platform !== 'win32' }, t => {
  const { root, targets } = fixture(t);
  put(targets.copilotVscode, '{"servers":{"private":{"command":"private","env":{"SECRET":"private-fixture-only"}}}}\n');
  const env = { ...process.env, NEOMIND_TEST_MCP_ACL: targets.copilotVscode };
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    '$acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ' +
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $acl.AddAccessRule($rule); " +
    '[System.IO.File]::SetAccessControl($env:NEOMIND_TEST_MCP_ACL,$acl)'],
  { env, stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  const descriptor = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $acl=[System.IO.File]::GetAccessControl($env:NEOMIND_TEST_MCP_ACL); " +
    '$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)'],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 }).trim();
  const original = descriptor();
  assert.match(original, /D:P/);
  change(root, targets, 'context7', 'copilot-vscode', true);
  assert.equal(descriptor(), original);
  assert.equal(parseJsonc(readFileSync(targets.copilotVscode, 'utf8')).servers.private.env.SECRET, 'private-fixture-only');
  change(root, targets, 'context7', 'copilot-vscode', false);
  assert.equal(descriptor(), original);
});

test('Windows inherited MCP permissions remain exact across connection changes', { skip: process.platform !== 'win32' }, t => {
  const { root, targets } = fixture(t);
  put(targets.copilotVscode, '{"servers":{"private":{"command":"private","env":{"SECRET":"fixture-only"}}}}\n');
  const env = { ...process.env, NEOMIND_TEST_MCP_ACL: targets.copilotVscode, NEOMIND_TEST_MCP_PARENT: dirname(targets.copilotVscode) };
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    '$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ' +
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); " +
    "$guests=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-546'); " +
    "$deny=New-Object System.Security.AccessControl.FileSystemAccessRule($guests,'WriteData','ContainerInherit,ObjectInherit','None','Deny'); $acl.AddAccessRule($deny); " +
    '[System.IO.Directory]::SetAccessControl($env:NEOMIND_TEST_MCP_PARENT,$acl)'],
  { env, stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  const facts = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $acl=[System.IO.File]::GetAccessControl($env:NEOMIND_TEST_MCP_ACL); " +
    '$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group; ' +
    '$bytes=[Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm($sections)); $hasher=[Security.Cryptography.SHA256]::Create(); ' +
    '[pscustomobject]@{fingerprint=([BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace("-","").ToLowerInvariant()); protected=$acl.AreAccessRulesProtected; inherited=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | Where-Object {$_.IsInherited}).Count} | ConvertTo-Json -Compress'],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 }));
  const original = facts();
  assert.equal(original.protected, false); assert.ok(original.inherited >= 2);
  change(root, targets, 'context7', 'copilot-vscode', true);
  assert.deepEqual(facts(), original, 'Owner/group/ordered DACL/protection must survive inherited configuration replacement.');
  change(root, targets, 'context7', 'copilot-vscode', false);
  assert.deepEqual(facts(), original);
});

test('Windows native short-path aliases can update credential-bearing MCP settings', { skip: process.platform !== 'win32' }, t => {
  const { root, targets } = fixture(t);
  put(targets.copilotVscode, '{"servers":{"private":{"command":"private","env":{"SECRET":"fixture-only"}}}}\n');
  const nativeShortPath = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $files=New-Object -ComObject Scripting.FileSystemObject; $files.GetFile($env:NEOMIND_TEST_MCP_ACL).ShortPath"],
  { env: { ...process.env, NEOMIND_TEST_MCP_ACL: targets.copilotVscode }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 }).trim();
  const shortPath = nativeShortPath();
  if (shortPath.toLowerCase() === targets.copilotVscode.toLowerCase()) { t.skip('Host does not expose a distinct native short alias.'); return; }
  assert.equal(realpathSync.native(shortPath), realpathSync.native(targets.copilotVscode));
  const selected = { ...targets, copilotVscode: shortPath };
  assert.equal(change(root, selected, 'context7', 'copilot-vscode', true).status, 'connected');
  assert.equal(existsSync(targets.copilotVscode), true, 'Replacing an 8.3 alias must retain its original long filename.');
  assert.equal(parseJsonc(readFileSync(targets.copilotVscode, 'utf8')).servers.private.env.SECRET, 'fixture-only');
  assert.equal(status(root, targets, 'context7', 'copilot-vscode').status, 'connected');
  assert.equal(status(root, { ...targets, copilotVscode: nativeShortPath() }, 'context7', 'copilot-vscode').status, 'connected');
  assert.equal(change(root, targets, 'context7', 'copilot-vscode', false).status, 'disconnected');
  assert.equal(change(root, targets, 'context7', 'copilot-vscode', true).status, 'connected');
  assert.equal(change(root, { ...targets, copilotVscode: nativeShortPath() }, 'context7', 'copilot-vscode', false).status, 'disconnected');
  const absent = join(dirname(shortPath), 'new-client', 'mcp-config.json');
  const originalAbsent = join(dirname(targets.copilotVscode), 'new-client', 'mcp-config.json');
  assert.equal(change(root, { ...targets, copilotCli: absent }, 'context7', 'copilot-cli', true).status, 'connected');
  assert.equal(existsSync(originalAbsent), true);
  assert.equal(change(root, { ...targets, copilotCli: originalAbsent }, 'context7', 'copilot-cli', false).status, 'disconnected');
});

test('Windows unavailable filesystem targets fail without an unbounded parent walk', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t);
  const drive = [...'ZYXWVUTSRQPONMLKJIHGFEDCBA'].find(letter => !existsSync(`${letter}:\\`));
  if (!drive) { t.skip('Host has no unavailable drive letter.'); return; }
  const moduleUrl = new URL('../dist/plugin-connections.js', import.meta.url).href;
  const program = `import {readPluginConnections,setPluginConnection} from ${JSON.stringify(moduleUrl)}; ` +
    'const targets={copilotVscode:process.argv[2]}; ' +
    "if(readPluginConnections(process.argv[1],targets).find(row=>row.plugin==='context7'&&row.client==='copilot-vscode').status!=='blocked')process.exit(1); " +
    "try{setPluginConnection(process.argv[1],{plugin:'context7',client:'copilot-vscode',connected:true},targets);process.exit(2)}catch(error){if(!/filesystem is unavailable/.test(error.message))throw error}";
  execFileSync(process.execPath, ['--input-type=module', '-e', program, root, `${drive}:\\missing\\mcp.json`],
    { stdio: 'pipe', windowsHide: true, timeout: 5000 });
});

test('Windows ACL-copy diagnostics preserve rollback and never echo helper secrets', { skip: process.platform !== 'win32' }, t => {
  const { root, targets } = fixture(t);
  const originalSource = '{"servers":{"private":{"command":"private","env":{"SECRET":"fixture-only"}}}}\n';
  put(targets.copilotVscode, originalSource);
  const originalExec = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, options) => {
    if (options?.env?.NEOMIND_MCP_ACL_TEMP) {
      const error = new Error('PRIVATE_HELPER_MESSAGE');
      error.stdout = Buffer.from(JSON.stringify({ code: 'ACL_DESCRIPTOR_MISMATCH', owner_equal: true, group_equal: true,
        ordered_dacl_equal: false, source_flags: 'AI', copy_flags: 'ARAI', private_raw_descriptor: 'PRIVATE_DESCRIPTOR' }));
      error.stderr = Buffer.from('PRIVATE_HELPER_STDERR');
      throw error;
    }
    return originalExec(command, args, options);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => change(root, targets, 'context7', 'copilot-vscode', true), error => {
      assert.match(error.message, /ownership was restored.*ACL_DESCRIPTOR_MISMATCH/);
      assert.match(error.message, /ordered_dacl_equal=false/);
      assert.doesNotMatch(error.message, /PRIVATE|fixture-only|source\.json|S-1-/);
      return true;
    });
  } finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
  assert.equal(readFileSync(targets.copilotVscode, 'utf8'), originalSource);
  assert.equal(existsSync(join(root, '.neomind/plugin-connections.json')), false);
  assert.equal(readdirSync(dirname(targets.copilotVscode)).some(name => name.endsWith('.tmp')), false);
});

test('Windows ACL copy accepts only an added auto-inherited marker and rejects changed permissions', { skip: process.platform !== 'win32' }, async t => {
  const clearSourceAI = '$observedSource.SetFlags($observedSource.ControlFlags -band (-bnot [int][System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)); ';
  const setCopyAI = '$observedCopy.SetFlags($observedCopy.ControlFlags -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited); ';
  const scenarios = [
    { name: 'OS adds only the auto-inherited marker', accepted: true, mutation: clearSourceAI + setCopyAI },
    { name: 'OS removes the auto-inherited marker', mutation: '$observedSource.SetFlags($observedSource.ControlFlags -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited); $observedCopy.SetFlags($observedCopy.ControlFlags -band (-bnot [int][System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)); ' },
    { name: 'inheritance protection changes', mutation: clearSourceAI + setCopyAI + '$observedCopy.SetFlags($observedCopy.ControlFlags -bxor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected); ' },
    { name: 'owner changes', mutation: clearSourceAI + setCopyAI + "$observedCopy.Owner=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-546'); " },
    { name: 'group changes', mutation: clearSourceAI + setCopyAI + "$observedCopy.Group=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-546'); " },
    { name: 'an ordered ACE changes', mutation: clearSourceAI + setCopyAI + '$observedCopy.DiscretionaryAcl[0].AccessMask=$observedCopy.DiscretionaryAcl[0].AccessMask -bxor 1; ' },
    { name: 'different ACE bytes have case-only Base64 differences', mutation: clearSourceAI + setCopyAI + '$observedSource.DiscretionaryAcl[0].AccessMask=0x1f01ff; $observedCopy.DiscretionaryAcl[0].AccessMask=0x0501ff; ' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, t => {
    const { root, targets } = fixture(t);
    const originalSource = '{"servers":{"private":{"command":"private","env":{"SECRET":"fixture-only"}}}}\n';
    put(targets.copilotVscode, originalSource);
    const originalExec = childProcess.execFileSync;
    childProcess.execFileSync = (command, args, options) => {
      if (options?.env?.NEOMIND_MCP_ACL_TEMP) {
        // Inject descriptor observations at the child-process boundary, then run
        // the production PowerShell copy, comparison and refusal path unchanged.
        const marker = '$copySddl=$copied.GetSecurityDescriptorSddlForm($sections); ';
        const scriptIndex = args.indexOf('-Command') + 1;
        assert.equal(args[scriptIndex].split(marker).length, 2);
        const observation = '$observedSource=[System.Security.AccessControl.RawSecurityDescriptor]::new($sddl); $observedCopy=[System.Security.AccessControl.RawSecurityDescriptor]::new($copySddl); ' +
          scenario.mutation + '$sddl=$observedSource.GetSddlForm($sections); $copySddl=$observedCopy.GetSddlForm($sections); ';
        args = [...args]; args[scriptIndex] = args[scriptIndex].replace(marker, marker + observation);
      }
      return originalExec(command, args, options);
    };
    syncBuiltinESMExports();
    try {
      if (scenario.accepted) {
        assert.equal(change(root, targets, 'context7', 'copilot-vscode', true).status, 'connected');
        assert.equal(change(root, targets, 'context7', 'copilot-vscode', false).status, 'disconnected');
        assert.equal(parseJsonc(readFileSync(targets.copilotVscode, 'utf8')).servers.private.env.SECRET, 'fixture-only');
      } else {
        assert.throws(() => change(root, targets, 'context7', 'copilot-vscode', true), /ACL_DESCRIPTOR_MISMATCH/);
        assert.equal(readFileSync(targets.copilotVscode, 'utf8'), originalSource);
        assert.equal(existsSync(join(root, '.neomind/plugin-connections.json')), false);
      }
    } finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
    assert.equal(readdirSync(dirname(targets.copilotVscode)).some(name => name.endsWith('.tmp')), false);
  });
});
