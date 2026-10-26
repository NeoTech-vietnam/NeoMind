import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, hash } from '../dist/storage.js';
import { controlledReadBaselineAllowed, assertControlledReadBaseline } from '../dist/controlled-read-baselines.js';
import { createControlledMcpServer } from '../dist/controlled-tools.js';

const hidden = '.agents/skills/helpers/assets/oracle.json';
const plan = () => ({ allowed_paths: ['src/product.mjs'], verification_paths: ['checks'],
  preservation_paths: ['scripts/verify-leetcode-exercise.mjs', 'fixtures/reference'], input_paths: [hidden] });

test('check baselines distinguish declared public preservation and exact hidden approval from write scope without mutation', () => {
  const source = plan(), frozenBytes = JSON.stringify(source), fingerprint = hash(frozenBytes);
  for (const path of ['src/product.mjs', 'checks/verify.mjs', 'scripts/verify-leetcode-exercise.mjs',
    'fixtures/reference/boundary.json', hidden]) assert.equal(controlledReadBaselineAllowed(source, path), true, path);
  for (const path of ['scripts/unrelated.mjs', 'fixtures/other.json', '.agents/skills/helpers/assets/unapproved.json',
    `${hidden}/descendant`, 'fixtures/reference/.env', 'fixtures/reference/private-key.pem'])
    assert.equal(controlledReadBaselineAllowed(source, path), false, path);
  assert.equal(JSON.stringify(source), frozenBytes); assert.equal(hash(JSON.stringify(source)), fingerprint);
  assert.deepEqual(source.allowed_paths, ['src/product.mjs']); assert.deepEqual(source.verification_paths, ['checks']);
});

test('preservation declarations cannot approve credentials, client configuration or arbitrary hidden trees for capture', () => {
  for (const path of ['.env', '.vscode/settings.json', '.codex/config.toml', '.neomind/auth.json',
    'assets/secrets.json', 'assets/credentials.json', '.agents/skills/helpers/assets/secrets.json']) {
    const source = { ...plan(), preservation_paths: [path], input_paths: [] };
    assert.equal(controlledReadBaselineAllowed(source, path), false, path);
  }
  assert.equal(controlledReadBaselineAllowed({ ...plan(), preservation_paths: ['.agents'], input_paths: [] }, hidden), false);
  assert.equal(controlledReadBaselineAllowed({ ...plan(), input_paths: ['.agents/skills/helpers/assets'] }, hidden), false);
});

test('actual producer and verifier MCP servers cannot write preserved public or approved hidden baseline dependencies', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-readonly-baselines-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'READBASE', name: 'Read baseline authority' });
  for (const dir of ['scripts', '.agents/skills/helpers/assets']) mkdirSync(join(root, dir), { recursive: true });
  const publicPath = 'scripts/verify-leetcode-exercise.mjs';
  writeFileSync(join(root, publicPath), 'original public dependency\n'); writeFileSync(join(root, hidden), '{"oracle":1}\n');
  assert.doesNotThrow(() => assertControlledReadBaseline(root, plan(), publicPath));
  assert.doesNotThrow(() => assertControlledReadBaseline(root, plan(), hidden));
  writeFileSync(join(root, 'scripts/.env'), 'PRIVATE_BASELINE_CANARY=must-not-be-captured\n');
  assert.throws(() => assertControlledReadBaseline(root, { ...plan(), preservation_paths: ['scripts'] }, 'scripts'), /exact existing ordinary/);
  for (const [stage, role] of [['implementation', 'developer'], ['verification', 'verifier']]) {
    const actor = { workflow_id: 'READBASE-KNW-0001', task_id: 'READBASE-TASK-0001', invocation_id: `bound-${role}`,
      stage, role, implementation_paths: plan().allowed_paths, verification_paths: plan().verification_paths,
      approved_inputs: [hidden], read_paths: ['.'] };
    const server = createControlledMcpServer(root, actor, { assertActive() {}, saveReport: () => ({ saved: true }) });
    const client = new Client({ name: 'readonly-baseline-mcp', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
      for (const path of [publicPath, hidden]) {
        assert.equal((await client.callTool({ name: 'project_read', arguments: { path } })).isError, undefined);
        const result = await client.callTool({ name: 'task_file_write', arguments: { path, content: 'unauthorized overwrite' } });
        assert.equal(result.isError, true); assert.match(JSON.stringify(result), /SCOPE_DENIED|PRIVATE_PATH/);
      }
    } finally { await client.close(); await server.close(); }
  }
  assert.equal(readFileSync(join(root, publicPath), 'utf8'), 'original public dependency\n');
  assert.equal(readFileSync(join(root, hidden), 'utf8'), '{"oracle":1}\n');
});
