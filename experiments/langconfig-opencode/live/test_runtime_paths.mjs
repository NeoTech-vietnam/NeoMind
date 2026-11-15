import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDataRoot } from './runtime_paths.mjs';

const data = requireDataRoot();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
assert.throws(() => requireDataRoot(''));
assert.throws(() => requireDataRoot('relative'));
assert.throws(() => requireDataRoot(path.join(data, 'missing-directory')));
assert.throws(() => requireDataRoot(repo));
assert.throws(() => requireDataRoot(path.dirname(repo)));
const tmp = await mkdtemp(path.join(data, 'tmp', 'paths-'));
try {
  await symlink(repo, path.join(tmp, 'repo-link'));
  assert.throws(() => requireDataRoot(path.join(tmp, 'repo-link')));
  await mkdir(path.join(tmp, 'safe'));
  await symlink(path.join(tmp, 'safe'), path.join(tmp, 'safe-link'));
  assert.equal(requireDataRoot(path.join(tmp, 'safe-link')), path.join(tmp, 'safe'));
  await symlink(repo, path.join(tmp, 'safe', 'runs'));
  assert.throws(() => requireDataRoot(path.join(tmp, 'safe')));
} finally { await rm(tmp, { recursive: true }); }
console.log('PASS data root validation');
