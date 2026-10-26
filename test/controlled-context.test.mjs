import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownedContext, registerControlledContext } from '../dist/controlled-context.js';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'neomind-context-identity-'));
  const first = join(base, 'FirstProject'), second = join(base, 'SecondProject');
  mkdirSync(first); mkdirSync(second);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, first, second };
}
function owner(epoch) {
  const saved = [];
  return { epoch_id: epoch, binding: { workflow_id: `workflow-${epoch}`, role: 'developer', stage: 'implementation',
    implementation_paths: ['src'], verification_paths: ['checks'] }, bindInvocation() {},
    callbacks: { assertActive() {}, saveReport(report) { saved.push(report); } }, saved };
}
function aliasOrSkip(t, target, alias) {
  try { symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('Directory aliases are unavailable on this runner.'); return false; }
    throw error;
  }
}

test('physical project identity resolves registered native TEMP spelling from the canonical host root', t => {
  const { first } = fixture(t), context = owner('temp-spelling');
  const unregister = registerControlledContext(first, 'request', context); t.after(unregister);
  const fromHost = ownedContext(realpathSync.native(first), 'request');
  assert.equal(fromHost, context);
  fromHost.callbacks.saveReport({ summary: 'Saved through the canonical host lookup.' });
  assert.equal(context.saved.length, 1);
});

test('directory aliases share one private owner and cannot register a second owner for the same request', t => {
  const { base, first } = fixture(t), alias = join(base, 'ProjectAlias');
  if (!aliasOrSkip(t, first, alias)) return;
  const context = owner('alias'), unregister = registerControlledContext(alias, 'request', context); t.after(unregister);
  assert.equal(ownedContext(first, 'request'), context);
  assert.equal(ownedContext(alias, 'request'), context);
  assert.throws(() => registerControlledContext(first, 'request', owner('replacement')), /already has an owner/);
  ownedContext(first, 'request').callbacks.saveReport({ summary: 'The physical owner receives the result.' });
  assert.equal(context.saved.length, 1);
  unregister();
  assert.equal(ownedContext(alias, 'request'), undefined);
  const replacement = owner('new-owner'), release = registerControlledContext(first, 'request', replacement); t.after(release);
  unregister();
  assert.equal(ownedContext(alias, 'request'), replacement, 'An obsolete unregister cannot remove a newer owner.');
});

test('Windows case spellings resolve the same physical private owner', { skip: process.platform !== 'win32' }, t => {
  const { first } = fixture(t), swapped = first.replace(/[a-zA-Z]/g, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
  const context = owner('windows-case'), unregister = registerControlledContext(first, 'request', context); t.after(unregister);
  assert.equal(ownedContext(swapped, 'request'), context);
  assert.throws(() => registerControlledContext(swapped, 'request', owner('replacement')), /already has an owner/);
});

test('different physical projects and different requests keep their private owners isolated', t => {
  const { first, second } = fixture(t), a = owner('a'), b = owner('b'), other = owner('other-request');
  for (const [root, request, context] of [[first, 'request', a], [second, 'request', b], [first, 'other', other]])
    t.after(registerControlledContext(root, request, context));
  assert.equal(ownedContext(first, 'request'), a); assert.equal(ownedContext(second, 'request'), b);
  assert.equal(ownedContext(first, 'other'), other); assert.equal(ownedContext(second, 'other'), undefined);
  assert.equal(ownedContext(first, 'missing'), undefined);
});

test('retargeting a directory alias cannot transfer an existing project owner', t => {
  const { base, first, second } = fixture(t), alias = join(base, 'MutableAlias');
  if (!aliasOrSkip(t, first, alias)) return;
  const context = owner('original'), unregister = registerControlledContext(alias, 'request', context); t.after(unregister);
  assert.equal(ownedContext(alias, 'request'), context);
  unlinkSync(alias);
  if (!aliasOrSkip(t, second, alias)) return;
  assert.equal(ownedContext(alias, 'request'), undefined);
  assert.equal(ownedContext(first, 'request'), context);
  const next = owner('new-project'), release = registerControlledContext(alias, 'request', next); t.after(release);
  assert.equal(ownedContext(second, 'request'), next);
  assert.equal(ownedContext(first, 'request'), context);
});

test('missing, removed and non-directory project roots fail closed without exposing other owners', t => {
  const { base, first } = fixture(t), absent = join(base, 'Absent'), file = join(base, 'file.txt');
  writeFileSync(file, 'not a project directory');
  for (const root of [absent, file]) {
    assert.throws(() => registerControlledContext(root, 'request', owner('invalid')), /existing project directory/);
    assert.equal(ownedContext(root, 'request'), undefined);
  }
  assert.equal(ownedContext(first, undefined), undefined); assert.equal(ownedContext(first, null), undefined);
  const unregister = registerControlledContext(first, 'request', owner('removed')); t.after(unregister);
  rmSync(first, { recursive: true });
  assert.equal(ownedContext(first, 'request'), undefined);
});
