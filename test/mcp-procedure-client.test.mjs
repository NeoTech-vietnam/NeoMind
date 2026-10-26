import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, hash, readConfig } from '../dist/storage.js';
import { canonicalJson, readInvocation } from '../dist/routing.js';
import { procedureExecutionClient } from '../dist/mcp.js';

function signedReceiptFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-procedure-client-'));
  initialize(root, { project_id: 'PROCEDURE-CLIENT' });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  // Synthetic signed test identities exercise production signature loading only.
  // They never claim real model inference, native launch or engineering acceptance.
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = hash(publicKey);
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), publicKey);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ schema_version: 1, keys: [keyId] }));
  return issuer => {
    const id = randomUUID(), path = `.neomind/native/receipts/${id}.json`;
    const unsigned = { schema_version: 1, issuer, id, receipt_path: path,
      project_id: readConfig(root).project_id, key_id: keyId,
      execution_mode: issuer.endsWith('vscode-lm') ? 'vscode-extension-host' : 'native',
      state: 'interrupted', inference_completed: false, role: 'developer' };
    writeFileSync(join(root, path), JSON.stringify({ ...unsigned,
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), pair.privateKey).toString('base64') }));
    return readInvocation(root, id);
  };
}

test('MCP procedure compatibility follows the verified signed receipt issuer for strict workflows', t => {
  const receipt = signedReceiptFixture(t);
  for (const namespace of ['neomind', 'taskforces', 'verythinker']) {
    const codex = receipt(`${namespace}-codex-app-server`);
    const vscode = receipt(`${namespace}-vscode-lm`);
    assert.equal(procedureExecutionClient('strict', codex), 'codex', `${namespace} Codex receipt`);
    assert.equal(procedureExecutionClient('strict', vscode), 'copilot', `${namespace} VS Code receipt`);
    // Signed identity takes precedence even when a conflicting workflow label is supplied.
    assert.equal(procedureExecutionClient('copilot-native', codex), 'codex');
    assert.equal(procedureExecutionClient('codex-native', vscode), 'copilot');
  }
});

test('unsigned MCP procedure compatibility follows saved native workflow mode', () => {
  assert.equal(procedureExecutionClient('codex-native'), 'codex');
  assert.equal(procedureExecutionClient('copilot-native'), 'copilot');
  assert.equal(procedureExecutionClient('codex-native', null), 'codex');
  assert.equal(procedureExecutionClient('copilot-native', null), 'copilot');
});
