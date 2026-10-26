import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { initialize } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { createNativeBridge, ensureNativeSigningIdentity, shutdownNative } from '../dist/native.js';

const digest = value => createHash('sha256').update(value).digest('hex');
function keyPair() {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKey, id: digest(publicKey) };
}
function project(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-signing-')));
  initialize(root, { project_id: 'SIGNING-BOOTSTRAP', name: 'Native signing bootstrap fixture' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative(root);
    assert.equal(dirname(resolve(root)), parent);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function write(root, path, data) {
  const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data, { mode: 0o600 });
}
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const privatePath = '.neomind/cache/native/private-key.pem';
const pendingPath = '.neomind/cache/native/pending-key.pem';
const trustPath = '.neomind/native/trust.json';
function verifyIdentity(root, id) {
  const trust = JSON.parse(read(root, trustPath));
  const actual = createPublicKey(createPrivateKey(read(root, privatePath))).export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(digest(actual), id);
  assert.equal(read(root, `.neomind/native/keys/${id}.pem`), actual);
  assert.ok(trust.keys.includes(id));
  assert.equal(existsSync(join(root, pendingPath)), false);
  if (process.platform !== 'win32') assert.equal(statSync(join(root, privatePath)).mode & 0o777, 0o600);
  return trust;
}

test('first signing bootstrap publishes matching trust and remains idempotent', t => {
  const root = project(t), first = ensureNativeSigningIdentity(root);
  verifyIdentity(root, first.key_id);
  const privateBefore = read(root, privatePath), trustBefore = read(root, trustPath);
  assert.deepEqual(ensureNativeSigningIdentity(root), first);
  assert.equal(read(root, privatePath), privateBefore);
  assert.equal(read(root, trustPath), trustBefore);
  assert.deepEqual(Object.keys(first), ['key_id']);
});

test('orphaned cached key with no trust or receipt history rotates rather than being trusted', t => {
  const root = project(t), old = keyPair();
  write(root, privatePath, old.privateKey);
  write(root, `.neomind/native/keys/${old.id}.pem`, old.publicKey);
  const fresh = ensureNativeSigningIdentity(root);
  assert.notEqual(fresh.key_id, old.id);
  const trust = verifyIdentity(root, fresh.key_id);
  assert.equal(trust.keys.includes(old.id), false);
  assert.equal(read(root, `.neomind/cache/native/retired/${old.id}.pem`), old.privateKey);
  assert.equal(read(root, `.neomind/native/keys/${old.id}.pem`), old.publicKey);
  assert.equal(ensureNativeSigningIdentity(root).key_id, fresh.key_id);
});

test('existing receipt history prevents recreating missing trust or replacing the cached identity', t => {
  const root = project(t), old = keyPair(), historical = '{"historical":"immutable fixture"}\n';
  write(root, privatePath, old.privateKey);
  write(root, '.neomind/native/receipts/historical.json', historical);
  assert.throws(() => ensureNativeSigningIdentity(root), { code: 'NATIVE_SIGNING_HISTORY_REQUIRES_TRUST' });
  assert.equal(read(root, privatePath), old.privateKey);
  assert.equal(read(root, '.neomind/native/receipts/historical.json'), historical);
  assert.equal(existsSync(join(root, trustPath)), false);
  assert.equal(existsSync(join(root, pendingPath)), false);
  assert.equal(existsSync(join(root, '.neomind/cache/native/retired')), false);
});

test('malformed authored trust is preserved and never replaced by bootstrap', t => {
  for (const trust of ['{broken', JSON.stringify({ schema_version: 2, keys: [] }), JSON.stringify({ keys: [42] })]) {
    const root = project(t), old = keyPair();
    write(root, privatePath, old.privateKey); write(root, trustPath, trust);
    assert.throws(() => ensureNativeSigningIdentity(root), { code: 'NATIVE_SIGNING_TRUST_INVALID' });
    assert.equal(read(root, privatePath), old.privateKey); assert.equal(read(root, trustPath), trust);
    assert.equal(existsSync(join(root, pendingPath)), false);
  }
});

test('a valid registry excluding the cached key is a restriction, even without receipts', t => {
  const root = project(t), old = keyPair(), trust = JSON.stringify({ schema_version: 1, keys: [], authored: 'retain' });
  write(root, privatePath, old.privateKey); write(root, trustPath, trust);
  assert.throws(() => ensureNativeSigningIdentity(root), { code: 'NATIVE_SIGNING_KEY_UNTRUSTED' });
  assert.equal(read(root, trustPath), trust); assert.equal(read(root, privatePath), old.privateKey);
  assert.equal(existsSync(join(root, '.neomind/cache/native/retired')), false);
});

test('corrupt private or pending key material is preserved with static diagnostics', t => {
  for (const path of [privatePath, pendingPath]) {
    const root = project(t), invalid = 'fixture-invalid-private-material';
    write(root, path, invalid);
    assert.throws(() => ensureNativeSigningIdentity(root), error => {
      assert.equal(error.code, 'NATIVE_SIGNING_KEY_INVALID');
      assert.equal(error.message.includes(invalid), false); return true;
    });
    assert.equal(read(root, path), invalid);
    assert.equal(existsSync(join(root, trustPath)), false);
  }
});

test('an interrupted bootstrap resumes its pending identity and preserves unrelated trust', t => {
  const root = project(t), old = keyPair(), pending = keyPair(), prior = keyPair();
  write(root, privatePath, old.privateKey); write(root, pendingPath, pending.privateKey);
  write(root, trustPath, JSON.stringify({ schema_version: 1, keys: [prior.id, pending.id], authored: 'keep me' }));
  write(root, `.neomind/native/keys/${pending.id}.pem`, pending.publicKey);
  const result = ensureNativeSigningIdentity(root);
  assert.equal(result.key_id, pending.id);
  const trust = verifyIdentity(root, result.key_id);
  assert.deepEqual(trust.keys, [prior.id, pending.id]); assert.equal(trust.authored, 'keep me');
  assert.equal(read(root, `.neomind/cache/native/retired/${old.id}.pem`), old.privateKey);
});

test('pending bootstrap cannot reauthorize the same orphaned cached key', t => {
  const root = project(t), old = keyPair();
  write(root, privatePath, old.privateKey); write(root, pendingPath, old.privateKey);
  assert.throws(() => ensureNativeSigningIdentity(root), { code: 'NATIVE_SIGNING_KEY_UNTRUSTED' });
  assert.equal(read(root, privatePath), old.privateKey); assert.equal(read(root, pendingPath), old.privateKey);
  assert.equal(existsSync(join(root, trustPath)), false);
});

test('arbitrary pending key cannot override an existing trust restriction', t => {
  const root = project(t), old = keyPair(), pending = keyPair(), trust = JSON.stringify({ schema_version: 1, keys: [], authored: 'restricted' });
  write(root, privatePath, old.privateKey); write(root, pendingPath, pending.privateKey); write(root, trustPath, trust);
  assert.throws(() => ensureNativeSigningIdentity(root), { code: 'NATIVE_SIGNING_KEY_UNTRUSTED' });
  assert.equal(read(root, privatePath), old.privateKey); assert.equal(read(root, pendingPath), pending.privateKey);
  assert.equal(read(root, trustPath), trust);
  assert.equal(existsSync(join(root, `.neomind/native/keys/${pending.id}.pem`)), false);
});

test('actual native receipt creation succeeds after safe orphan recovery and validates its signature', async t => {
  const root = project(t), old = keyPair(); write(root, privatePath, old.privateKey);
  const native = createNativeBridge({ runtime: async () => { throw new Error('Fixture stops before any model or transport launch.'); } });
  const receipt = await native.start(root, { role: 'manager', prompt: 'Signing bootstrap fixture only.' });
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.inference_completed, false);
  assert.notEqual(receipt.key_id, old.id);
  assert.equal(readInvocation(root, receipt.id).signature, receipt.signature);
  verifyIdentity(root, receipt.key_id);
});

test('concurrent bootstrap processes serialize and agree on one recovered identity', async t => {
  const root = project(t), old = keyPair(); write(root, privatePath, old.privateKey);
  const module = pathToFileURL(resolve('dist/native.js')).href;
  const source = `import {ensureNativeSigningIdentity} from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(ensureNativeSigningIdentity(process.argv[1])));`;
  const results = await Promise.all(Array.from({ length: 3 }, () => new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Signing fixture child timed out.')); }, 30000);
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(error)); else done(JSON.parse(out)); });
  })));
  assert.equal(new Set(results.map(x => x.key_id)).size, 1);
  assert.notEqual(results[0].key_id, old.id); verifyIdentity(root, results[0].key_id);
  assert.deepEqual(readdirSync(join(root, '.neomind/cache/native/retired')), [`${old.id}.pem`]);
});
