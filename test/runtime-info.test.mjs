import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as api from '../dist/index.js';
import { createMcpServer } from '../dist/mcp.js';

test('build fingerprint changes for loaded code and guidance but ignores project data', t => {
  assert.equal(typeof api.getRuntimeBuildFingerprint, 'function');
  const root = mkdtempSync(join(tmpdir(), 'neomind-build-identity-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'resources/guides'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"test"}');
  writeFileSync(join(root, 'dist/index.js'), 'export const value = 1;');
  writeFileSync(join(root, 'resources/guides/copilot-native.md'), 'first guidance');
  const before = api.getRuntimeBuildFingerprint(root);
  writeFileSync(join(root, 'unrelated.json'), 'workspace data');
  assert.equal(api.getRuntimeBuildFingerprint(root), before);
  writeFileSync(join(root, 'dist/index.js'), 'export const value = 2;');
  assert.notEqual(api.getRuntimeBuildFingerprint(root), before);
  const code = api.getRuntimeBuildFingerprint(root);
  writeFileSync(join(root, 'resources/guides/copilot-native.md'), 'updated guidance');
  assert.notEqual(api.getRuntimeBuildFingerprint(root), code);
});

test('actual MCP reports its startup build and unique instance without an assignment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-live-build-'));
  api.initialize(root, { project_id: 'LIVE-BUILD', platforms: ['copilot'] });
  const server = createMcpServer(root);
  const client = new Client({ name: 'live-build-test', version: '1' });
  const [caller, host] = InMemoryTransport.createLinkedPair();
  await server.connect(host); await client.connect(caller);
  t.after(async () => { await client.close(); await server.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const result = await client.callTool({ name: 'runtime_info', arguments: {} });
  assert.equal(result.isError, undefined);
  const identity = JSON.parse(result.content[0].text);
  assert.equal(identity.schema_version, 1);
  assert.equal(resolve(identity.project_root), resolve(root));
  assert.match(identity.build_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(identity.server_instance_id, /^[a-f0-9-]{36}$/);
  assert.equal(identity.build_fingerprint, api.getRuntimeBuildFingerprint(identity.runtime_root));
  assert.equal(Number.isNaN(Date.parse(identity.started_at)), false);
});
