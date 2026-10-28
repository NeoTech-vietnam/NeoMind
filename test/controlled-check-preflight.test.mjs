// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createControlledMcpServer, ControlledToolError } from '../dist/controlled-tools.js';
import { assertControlledCheckInputs } from '../dist/controlled-check-preflight.js';

const checker = 'checks/check.cjs', product = 'source/value.json', missing = 'checks/invalid-bundle';
const plan = { allowed_paths: ['source'], verification_paths: ['checks'], preservation_paths: ['inputs'], input_paths: [] };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-check-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'CHECK-PREFLIGHT', platforms: ['codex'] });
  const write = (path, content = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(checker, '// independent checker\n'); write(product, '{"value":6}\n');
  return { root, write };
}
const selected = () => [{ baseline_paths: [checker, product] }, { baseline_paths: [checker, missing] }];

test('whole-group preflight identifies a missing negative fixture and its Verifier owner', t => {
  const { root } = fixture(t);
  assert.throws(() => assertControlledCheckInputs(root, plan, selected()), error => {
    assert.ok(error instanceof ControlledToolError);
    assert.equal(error.code, 'CHECK_INPUT_MISSING');
    assert.equal(error.ownership.target_owner, 'verifier');
    assert.deepEqual(error.ownership.missing_paths, [missing]);
    assert.match(error.ownership.next_action, /checker scripts.*invalid fixtures.*verification_paths/);
    assert.match(error.message, /checks\/invalid-bundle/);
    return true;
  });
});

test('existing ordinary fixture directories remain valid without creating semantic content', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, missing));
  assert.equal(assertControlledCheckInputs(root, plan, selected()), undefined);
});

test('missing producer and read-only inputs never authorize the Verifier to write them', t => {
  const { root } = fixture(t);
  for (const [path, owner, action] of [
    ['source/not-delivered.json', 'developer', /must not create or rewrite producer files/],
    ['inputs/unavailable.json', 'protected-acceptance', /Preserve producer and read-only inputs/],
  ]) assert.throws(() => assertControlledCheckInputs(root, plan, [{ baseline_paths: [path] }]), error => {
    assert.equal(error.code, 'CHECK_INPUT_MISSING');
    assert.equal(error.ownership.target_owner, owner);
    assert.deepEqual(error.ownership.missing_paths, [path]);
    assert.match(error.ownership.next_action, action);
    return true;
  });
});

test('undeclared or private inputs fail without exposing their path or partial missing-path inventory', t => {
  const { root } = fixture(t);
  for (const [path, code] of [
    ['elsewhere/PRIVATE_CANARY.json', 'SCOPE_DENIED'],
    ['checks/.env.PRIVATE_CANARY', 'PRIVATE_PATH'],
  ]) assert.throws(() => assertControlledCheckInputs(root, plan, [...selected(), { baseline_paths: [path] }]), error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify({ message: error.message, metadata: error.ownership }), /PRIVATE_CANARY|invalid-bundle/);
    return true;
  });
});

test('linked check inputs remain invalid and do not borrow authority from an owned path', t => {
  const { root } = fixture(t);
  linkSync(join(root, product), join(root, 'checks/hard.json'));
  assert.throws(() => assertControlledCheckInputs(root, plan, [{ baseline_paths: ['checks/hard.json'] }]),
    error => error.code === 'INVALID_FILE');
  try { symlinkSync(join(root, 'source'), join(root, 'checks/link'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  assert.throws(() => assertControlledCheckInputs(root, plan, [{ baseline_paths: ['checks/link/missing.json'] }]),
    error => error.code === 'INVALID_PATH');
});

test('actual MCP check_run returns typed actionable missing-path feedback before its execution callback proceeds', async t => {
  const { root } = fixture(t); let proceeded = 0;
  const server = createControlledMcpServer(root, { workflow_id: 'PREFLIGHT-WORKFLOW', task_id: 'PREFLIGHT-TASK',
    invocation_id: 'bound-verifier', role: 'verifier', stage: 'verification', implementation_paths: ['source'], verification_paths: ['checks'] },
  { assertActive() {}, saveReport() {}, runCheck() {
    assertControlledCheckInputs(root, plan, selected()); proceeded++;
    return { ready: true };
  } });
  const client = new Client({ name: 'check-preflight-mcp', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'check_run', arguments: {} });
  assert.equal(result.isError, true); assert.equal(proceeded, 0);
  const feedback = JSON.parse(result.content[0].text);
  assert.equal(feedback.code, 'CHECK_INPUT_MISSING');
  assert.equal(feedback.target_owner, 'verifier');
  assert.equal(feedback.validation.owner, 'agent-content');
  assert.deepEqual(feedback.missing_paths, [missing]);
  assert.match(feedback.error, /checks\/invalid-bundle/);
  assert.match(feedback.next_action, /Prepare.*fixtures/);
});
