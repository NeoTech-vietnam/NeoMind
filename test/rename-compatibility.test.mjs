import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { initialize, hash } from '../dist/storage.js';
import { canonicalJson, readInvocation } from '../dist/routing.js';
import { migrateStorage } from '../dist/migration.js';
import { installProject, updateProject } from '../dist/installer.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'taskforces-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'RENAME', platforms: ['codex', 'claude', 'copilot'] });
  return root;
}
function write(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

test('legacy signed receipts retain exact bytes and verify before and after physical migration', t => {
  const root = project(t);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const key = hash(pem);
  write(root, `.taskforces/native/keys/${key}.pem`, pem);
  write(root, '.taskforces/native/trust.json', JSON.stringify({ keys: [key] }));
  const receipts = [];
  for (const issuer of ['verythinker-vscode-lm', 'verythinker-codex-app-server']) {
    const id = randomUUID();
    const unsigned = { schema_version: 1, issuer, id, project_id: 'RENAME', key_id: key,
      receipt_path: `.verythinker/native/receipts/${id}.json`, state: 'completed',
      input_text: 'Historical invocation', output: 'Original historical output' };
    const body = JSON.stringify({ ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') });
    write(root, `.taskforces/native/receipts/${id}.json`, body);
    receipts.push({ id, body, issuer });
  }
  renameSync(join(root, '.taskforces'), join(root, '.verythinker'));
  for (const item of receipts) assert.equal(readInvocation(root, item.id).issuer, item.issuer);
  migrateStorage(root);
  for (const item of receipts) {
    assert.equal(readFileSync(join(root, `.taskforces/native/receipts/${item.id}.json`), 'utf8'), item.body);
    assert.equal(readInvocation(root, item.id).issuer, item.issuer);
  }
  const item = receipts[0];
  write(root, `.taskforces/native/receipts/${item.id}.json`, item.body.replace('Historical invocation', 'Tampered invocation'));
  assert.throws(() => readInvocation(root, item.id), /signature/);
});

test('legacy instruction markers and manifest paths upgrade without duplicate blocks or sibling loss', t => {
  const root = project(t);
  installProject(root);
  const manifestPath = '.taskforces/install-manifest.json';
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.codex/config.toml']) {
    const content = readFileSync(join(root, path), 'utf8').replaceAll('TASKFORCES', 'VERYTHINKER');
    write(root, path, content + '\n# Retain user instructions\n');
  }
  manifest.files = Object.fromEntries(Object.entries(manifest.files).map(([id, entry]) => [
    id.replace(/^\.taskforces\//, '.verythinker/'),
    { ...entry, path: entry.path.replace(/^\.taskforces\//, '.verythinker/') },
  ]));
  write(root, manifestPath, JSON.stringify(manifest));
  const report = updateProject(root);
  assert.deepEqual(report.conflicts, []);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.codex/config.toml']) {
    const content = readFileSync(join(root, path), 'utf8');
    assert.doesNotMatch(content, /VERYTHINKER/);
    assert.match(content, /Retain user instructions/);
  }
  assert.deepEqual(updateProject(root).conflicts, []);
});
