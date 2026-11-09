import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNativeMcpCapabilities, nativeMcpCapabilitiesMatchInventory } from '../dist/native-mcp-capabilities.js';
import { nativeLocalWorkerProfile } from '../dist/native-local-contract.js';
const require = createRequire(import.meta.url);
const { createNativeMcpHost } = require('../extensions/vscode-model-bridge/native-mcp-host.cjs');
const sha = content => createHash('sha256').update(content).digest('hex');
const tool = (extra = {}) => ({ name: 'mcp_fixture_lookup', fullReferenceName: 'fixture/lookup',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, ...extra });
const row = () => ({ id: 'fixture', label: 'Fixture MCP', roles: ['WF.FnD'],
  tools: [{ name: 'mcp_fixture_lookup', reference: 'fixture/lookup' }] });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-mcp-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let approved = [row()];
  const vscode = { lm: { tools: [tool()] } };
  const api = { resolveNativeMcpCapabilities, nativeMcpCapabilitiesMatchInventory, nativeLocalWorkerProfile };
  const hostOptions = { readApprovedConnectors: () => approved, ...options };
  const host = createNativeMcpHost(vscode, api, root, hostOptions);
  return { root, vscode, host, api, hostOptions, setApproved: value => { approved = value; } };
}

test('host creates an owned immutable hidden profile from runtime base tools and exact native MCP references', t => {
  const f = fixture(t), binding = f.host.prepare('WF.FnD', ['fixture']);
  assert.ok(f.host.isPrepared(binding));
  assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.profile.tools));
  assert.ok(Object.isFrozen(binding.snapshots[0].tools[0].input_schema));
  assert.equal(binding.profile.role, 'WF.FnD');
  assert.equal(binding.profile.name, `WF.FnD Worker MCP ${binding.fingerprint.slice(0, 16)}`);
  assert.equal(binding.profile.path, `.github/agents/.workforce-wf-fnd-${binding.fingerprint}.agent.md`);
  assert.deepEqual(binding.profile.tools, ['read', 'search', 'edit', 'execute', 'fixture/lookup']);
  const content = readFileSync(join(f.root, binding.profile.path), 'utf8');
  assert.equal(sha(content), binding.profile.sha256);
  assert.match(content, /^user-invocable: false$/m); assert.match(content, /^agents: \[\]$/m);
  assert.equal(content.includes('mcp_fixture_lookup'), false);
  assert.equal(content.includes('fixture/lookup'), true);
  assert.equal(f.host.isPrepared(structuredClone(binding)), false);
});

test('same owned variant is reused but a different host cannot adopt a fabricated prepared token', t => {
  const f = fixture(t), first = f.host.prepare('WF.FnD', ['fixture']), again = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(first.profile.sha256, again.profile.sha256); assert.equal(first.fingerprint, again.fingerprint);
  assert.equal(readdirSync(join(f.root, '.github/agents')).length, 1);
  const other = createNativeMcpHost(f.vscode, f.api, f.root, f.hostOptions);
  assert.equal(other.isPrepared(first), false);
  const adopted = other.prepare('WF.FnD', ['fixture']);
  assert.ok(other.isPrepared(adopted)); assert.equal(adopted.profile.sha256, first.profile.sha256);
});

test('missing optional MCP references produce an explicit ordinary fallback without a generated profile', t => {
  const f = fixture(t); f.vscode.lm.tools = [tool({ fullReferenceName: undefined })];
  const binding = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(binding.profile, undefined); assert.deepEqual(binding.snapshots, []);
  assert.equal(binding.fallback, 'ordinary-work'); assert.equal(binding.resolution.state, 'unavailable');
  assert.ok(binding.observations.some(item => item.reason === 'native-tool-unavailable'));
  assert.equal(existsSync(join(f.root, '.github')), false); assert.ok(f.host.isPrepared(binding));
});

test('fresh inventory checks detect disappearance, schema changes and approval revocation before dispatch', t => {
  const f = fixture(t), binding = f.host.prepare('WF.FnD', ['fixture']);
  f.vscode.lm.tools = [tool({ inputSchema: { type: 'object' } })];
  assert.equal(f.host.isPrepared(binding), false);
  const changed = f.host.prepare('WF.FnD', ['fixture']); assert.notEqual(changed.fingerprint, binding.fingerprint);
  f.vscode.lm.tools = []; assert.equal(f.host.isPrepared(changed), false);
  const fallback = f.host.prepare('WF.FnD', ['fixture']); assert.equal(fallback.profile, undefined);
  f.vscode.lm.tools = [tool()]; f.setApproved([]);
  assert.equal(f.host.isPrepared(binding), false);
  assert.equal(f.host.prepare('WF.FnD', ['fixture']).profile, undefined);
});

test('edited variant profiles are preserved and optional MCP use is declined', t => {
  const f = fixture(t), binding = f.host.prepare('WF.FnD', ['fixture']);
  const path = join(f.root, binding.profile.path), edited = '# User changed this profile\n';
  writeFileSync(path, edited); assert.equal(f.host.isPrepared(binding), false);
  const fallback = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(fallback.profile, undefined); assert.deepEqual(fallback.snapshots, []);
  assert.ok(fallback.observations.some(item => item.reason === 'profile-modified'));
  assert.equal(readFileSync(path, 'utf8'), edited);
});

test('ownership receipt changes are rejected without replacing either user file', t => {
  const f = fixture(t), binding = f.host.prepare('WF.FnD', ['fixture']);
  const path = join(f.root, '.workforce/native/mcp-profiles', `${binding.fingerprint}.json`), edited = '{"user":"changed"}\n';
  writeFileSync(path, edited); assert.equal(f.host.isPrepared(binding), false);
  const fallback = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(fallback.profile, undefined); assert.equal(readFileSync(path, 'utf8'), edited);
});

test('a pre-existing matching profile without its ownership receipt is preserved without adoption', t => {
  const f = fixture(t), binding = f.host.prepare('WF.FnD', ['fixture']);
  const profilePath = join(f.root, binding.profile.path), original = readFileSync(profilePath, 'utf8');
  const receiptPath = join(f.root, '.workforce/native/mcp-profiles', `${binding.fingerprint}.json`);
  rmSync(receiptPath);
  const fallback = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(fallback.profile, undefined);
  assert.ok(fallback.observations.some(item => item.reason === 'profile-ownership-unproven'));
  assert.equal(existsSync(receiptPath), false); assert.equal(readFileSync(profilePath, 'utf8'), original);
});

test('multiply linked generated profiles cannot be reused or replaced', t => {
  const f = fixture(t), binding = f.host.prepare('WF.FnD', ['fixture']);
  const alias = join(f.root, 'user-profile-copy.md');
  linkSync(join(f.root, binding.profile.path), alias);
  assert.equal(f.host.isPrepared(binding), false);
  const fallback = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(fallback.profile, undefined);
  assert.ok(fallback.observations.some(item => item.reason === 'profile-unsafe-path'));
  assert.equal(sha(readFileSync(alias)), binding.profile.sha256);
});

test('symlinked profile directories cannot redirect generated files outside the selected root', t => {
  const f = fixture(t), outside = mkdtempSync(join(tmpdir(), 'wf-native-mcp-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(f.root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  const fallback = f.host.prepare('WF.FnD', ['fixture']);
  assert.equal(fallback.profile, undefined); assert.deepEqual(readdirSync(outside), []);
  assert.ok(fallback.observations.some(item => item.reason === 'profile-unsafe-path'));
});

test('runtime base renderer must preserve the exact hidden nonrecursive professional profile', t => {
  for (const replace of [text => text.replace('user-invocable: false', 'user-invocable: true'),
    text => text.replace('agents: []', 'agents: ["WF.PM"]'),
    text => text.replace('"execute"', '"workforceNativeRequest"'),
    text => text.replace('"WF.FnD Worker"', '"WF.Tester Worker"')]) {
    const f = fixture(t, { baseProfile: role => replace(nativeLocalWorkerProfile(role)) });
    const result = f.host.prepare('WF.FnD', ['fixture']);
    assert.equal(result.profile, undefined); assert.ok(result.observations.some(item => item.reason === 'base-profile-invalid'));
  }
});

test('empty selections create no variants and policy read failures do not disclose error objects', t => {
  const f = fixture(t), empty = f.host.prepare('WF.FnD', []);
  assert.equal(empty.profile, undefined); assert.equal(empty.resolution.state, 'not-selected');
  assert.ok(f.host.isPrepared(empty)); assert.equal(existsSync(join(f.root, '.github')), false);
  const failing = createNativeMcpHost(f.vscode, f.api, f.root, { readApprovedConnectors() { throw Error('secret token'); } });
  const result = failing.prepare('WF.FnD', ['fixture']);
  assert.equal(result.profile, undefined); assert.equal(result.fallback, 'ordinary-work');
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(failing.isPrepared(result), false);
});
