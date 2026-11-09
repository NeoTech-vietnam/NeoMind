import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const require = createRequire(import.meta.url);
const { activateMcpFixture, providerId } = require('./vscode-client-driver/native-local/native-mcp-provider.cjs');
const here = dirname(fileURLToPath(import.meta.url)), server = join(here, 'vscode-client-driver/native-local/native-mcp-fixture.cjs');
const nonce = 'da75f0c0f60a459abd14027772f42acc';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fixture(t, gated = false) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-mcp-protocol-')), evidence = join(root, 'evidence'); mkdirSync(evidence);
  const client = new Client({ name: 'owned-native-fixture-test', version: '1.0.0' });
  let gate = join(evidence, 'release-echo.flag');
  if (gated && process.platform === 'win32') {
    const alias = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:WF_FIXTURE_GATE_PARENT); [Console]::Write($folder.ShortPath)'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, WF_FIXTURE_GATE_PARENT: evidence } });
    assert.equal(alias.status, 0, alias.error?.message ?? alias.stderr);
    assert.ok(alias.stdout.trim()); gate = join(alias.stdout.trim(), 'release-echo.flag');
  }
  const args = [server, '--nonce', nonce, '--evidence', evidence, ...(gated ? ['--gate-file', gate] : [])];
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const events = () => readFileSync(join(evidence, 'events.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, evidence, client, gate, events };
}

test('standalone fixture speaks actual MCP initialize/list/call through the installed SDK', async t => {
  const f = await fixture(t), list = await f.client.listTools();
  assert.equal(list.tools.length, 1); assert.equal(list.tools[0].name, 'echo_nonce');
  assert.deepEqual(list.tools[0].inputSchema.properties.nonce.enum, [nonce]);
  const result = await f.client.callTool({ name: 'echo_nonce', arguments: { nonce } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { nonce, marker: 'WF_M6_NATIVE_MCP_ECHO' });
  assert.ok(f.events().some(event => event.event === 'tool-completed' && event.nonce_valid === true));
  const raw = readFileSync(join(f.evidence, 'events.ndjson'), 'utf8');
  assert.equal(raw.includes(nonce), false); assert.equal(raw.includes('arguments'), false);
});

test('invalid supplied content produces an honest tool error without publishing the wrong nonce', async t => {
  const f = await fixture(t), result = await f.client.callTool({ name: 'echo_nonce', arguments: { nonce: 'untrusted-input' } });
  assert.equal(result.isError, true);
  assert.equal(f.events().some(event => event.event === 'tool-completed'), false);
  assert.equal(readFileSync(join(f.evidence, 'events.ndjson'), 'utf8').includes('untrusted-input'), false);
});

test('an owned gate provides a deterministic active tool window for lifecycle tests', async t => {
  const f = await fixture(t, true), call = f.client.callTool({ name: 'echo_nonce', arguments: { nonce } });
  const deadline = Date.now() + 3000;
  while (!f.events().some(event => event.event === 'tool-waiting-for-owned-gate') && Date.now() < deadline) await delay(10);
  assert.ok(f.events().some(event => event.event === 'tool-waiting-for-owned-gate'));
  assert.equal(f.events().find(event => event.event === 'tool-waiting-for-owned-gate').gate_ms, 300000);
  assert.equal(f.events().some(event => event.event === 'tool-completed'), false);
  writeFileSync(f.gate, 'release\n', { flag: 'wx' });
  assert.equal(JSON.parse((await call).content[0].text).nonce, nonce);
});

test('a gate outside the actual owned evidence directory is refused before MCP admission', t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-mcp-gate-scope-')), evidence = join(root, 'evidence'); mkdirSync(evidence);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [server, '--nonce', nonce, '--evidence', evidence, '--gate-file', join(root, 'outside.flag')],
    { input: '', encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(child.status, 2, child.stderr); assert.equal(child.stdout, '');
  assert.equal(existsSync(join(evidence, 'events.ndjson')), false, 'An unowned gate never enters the protocol or records a running tool.');
});

test('fixture provider uses only public registration and requires explicit enable flag plus trusted owned root', t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-mcp-provider-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { subscriptions: [] }, registered = [], writes = [];
  let trusted = true, trustChecks = 0;
  const ensureTrust = () => { trustChecks++; if (!trusted) throw Error('untrusted'); };
  const vscode = { McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
    lm: { registerMcpServerDefinitionProvider(id, provider) { registered.push({ id, provider }); return { dispose() {} }; } } };
  const config = { evidence: root, mcp_fixture_nonce: nonce, mcp_fixture_node: process.execPath };
  assert.equal(activateMcpFixture(vscode, context, config, ensureTrust, (...args) => writes.push(args)), undefined);
  assert.equal(trustChecks, 0); assert.equal(registered.length, 0);
  activateMcpFixture(vscode, context, { ...config, enable_mcp_fixture: true }, ensureTrust, (...args) => writes.push(args));
  assert.equal(registered.length, 1); assert.equal(registered[0].id, providerId); assert.equal(context.subscriptions.length, 1);
  const definition = registered[0].provider.provideMcpServerDefinitions()[0];
  assert.equal(definition.label, 'Native Fixture'); assert.equal(definition.command, process.execPath);
  assert.equal(registered[0].provider.resolveMcpServerDefinition(definition, { isCancellationRequested: true }), undefined);
  assert.equal(registered[0].provider.resolveMcpServerDefinition(definition, {}), definition);
  assert.equal(writes.at(-1)[1].invocation, 'not-observed');
  assert.equal(existsSync(join(root, 'native-mcp')), false);
  trusted = false; assert.throws(() => registered[0].provider.provideMcpServerDefinitions(), /untrusted/);
});
