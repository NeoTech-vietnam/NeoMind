import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exactRoot, serveHost } from '../dist/vscode-wire.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-wire-privacy-'));
  const key = createHash('sha256').update(`${userInfo().username}\0${exactRoot(root)}`).digest('hex');
  const directory = join(tmpdir(), `neomind-vscode-${key}`);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  });
  return { root, directory };
}

test('Windows owner-only descriptor directory passes the production ACL verifier', { skip: process.platform !== 'win32' }, async t => {
  const { root } = fixture(t);
  const host = await serveHost(root, async () => ({ ok: true }));
  await host.close();
});

test('Windows descriptor directory with an explicit foreign Allow grant is rejected', { skip: process.platform !== 'win32' }, async t => {
  const { root, directory } = fixture(t);
  mkdirSync(directory);
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r',
    `${userInfo().username}:(OI)(CI)F`, '*S-1-1-0:(OI)(CI)R'],
  { stdio: 'ignore', windowsHide: true });
  await assert.rejects(serveHost(root, async () => ({ ok: true })));
  assert.equal(existsSync(join(directory, 'host.json')), false);
});
