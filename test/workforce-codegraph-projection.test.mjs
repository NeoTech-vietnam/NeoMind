import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { prepareWorkForceCodeGraphProjection, workForceCodeGraphProjectionCurrent, closeWorkForceCodeGraphProjection,
  codeGraphProjectionServer, mapWorkForceCodeGraphResult } from '../dist/workforce-codegraph-projection.js';

const temporary = resolve('artifacts/test-temp');
function fixture(t) {
  mkdirSync(temporary, { recursive: true }); const root = mkdtempSync(join(temporary, 'wf-codegraph-projection-'));
  const physical = realpathSync.native(root), key = createHash('sha256').update(`${userInfo().username}\0${process.platform === 'win32' ? physical.toLowerCase() : physical}`).digest('hex');
  const privatePath = join(temporary, '.workforce-private', key), projections = [];
  t.after(() => {
    for (const projection of projections) closeWorkForceCodeGraphProjection(projection);
    assert.equal(dirname(root), temporary); assert.equal(dirname(privatePath), join(temporary, '.workforce-private'));
    rmSync(privatePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const put = (path, value) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, value); };
  const prepare = (scopes, previous) => { const result = prepareWorkForceCodeGraphProjection(root, scopes, previous); if (result.available && !projections.includes(result.projection)) projections.push(result.projection); return result; };
  return { root, put, prepare };
}

test('CodeGraph snapshot contains only scoped ordinary public sources, never runtime, credentials or dependencies', { timeout: 30000 }, t => {
  const { root, put, prepare } = fixture(t);
  put('src/main.ts', 'export const current = 42;'); put('elsewhere/other.ts', 'export const other = 1;');
  for (const path of ['.workforce/native/key.ts', '.neomind/config.ts', '.workforce-private/key.ts', '.codegraph/config.json', '.opencode/auth.json', '.git/secret.ts', '.env', 'node_modules/dependency.ts', 'src/credentials.json', 'src/secrets.ts']) put(path, 'SECRET-NOT-FOR-INDEX');
  const narrow = prepare(['src']); assert.equal(narrow.available, true);
  assert.deepEqual(narrow.projection.files.map(file => file.path), ['src/main.ts']);
  assert.equal(readFileSync(join(narrow.projection.root, 'src/main.ts'), 'utf8'), 'export const current = 42;');
  assert.equal(existsSync(join(narrow.projection.root, 'elsewhere')), false);
  const all = prepare(['.']); assert.equal(all.available, true);
  assert.deepEqual(all.projection.files.map(file => file.path), ['elsewhere/other.ts', 'src/main.ts']);
  assert.equal(existsSync(join(all.projection.root, '.workforce')), false);
  assert.equal(prepare(['.workforce/native/key.ts']).available, false);
  assert.equal(workForceCodeGraphProjectionCurrent(narrow.projection), true);
  assert.equal(readFileSync(join(root, '.workforce/native/key.ts'), 'utf8'), 'SECRET-NOT-FOR-INDEX');
});

test('scope and current source bytes bind cache reuse; changed or corrupted snapshots must be refreshed', { timeout: 30000 }, t => {
  const { put, prepare } = fixture(t); put('src/main.ts', 'export const current = 1;'); put('other/next.ts', 'export const next = 2;');
  const first = prepare(['src']); assert.equal(first.available, true);
  assert.equal(prepare(['src'], first.projection).projection, first.projection);
  put('src/main.ts', 'export const current = 3;');
  assert.equal(workForceCodeGraphProjectionCurrent(first.projection), false);
  const changed = prepare(['src'], first.projection); assert.equal(changed.available, true);
  assert.notEqual(changed.projection.baseline, first.projection.baseline);
  assert.equal(readFileSync(join(changed.projection.root, 'src/main.ts'), 'utf8'), 'export const current = 3;');
  writeFileSync(join(changed.projection.root, 'src/main.ts'), 'Altered provider cache.');
  assert.equal(workForceCodeGraphProjectionCurrent(changed.projection), false);
  const refreshed = prepare(['src'], changed.projection); assert.equal(refreshed.available, true);
  assert.notEqual(refreshed.projection.root, changed.projection.root);
  assert.equal(refreshed.projection.baseline, changed.projection.baseline);
  assert.equal(readFileSync(join(refreshed.projection.root, 'src/main.ts'), 'utf8'), 'export const current = 3;');
  const wider = prepare(['src', 'other'], refreshed.projection); assert.equal(wider.available, true);
  assert.notEqual(wider.projection.baseline, refreshed.projection.baseline);
});

test('unsupported launcher and oversized source cannot silently fall back to original project indexing', { timeout: 30000 }, t => {
  const { root, put, prepare } = fixture(t); put('src/main.c', 'int main(void){return 0;}');
  const result = prepare(['src']); assert.equal(result.available, true);
  const original = { command: process.execPath, args: ['pinned-provider.mjs', 'serve', '--mcp', '--path', root], env: { REVIEWED_VALUE: 'same' } };
  const rewritten = codeGraphProjectionServer(root, original, result.projection);
  assert.equal(rewritten.args.at(-1), result.projection.root); assert.deepEqual(rewritten.args.slice(0, -1), original.args.slice(0, -1));
  assert.deepEqual(rewritten.env, original.env); assert.equal(original.args.at(-1), root);
  for (const server of [ { ...original, args: ['serve', '--mcp'] }, { ...original, args: [...original.args, '--path', root] },
    { ...original, args: ['serve', '--mcp', '--path', dirname(root)] }, { ...original, command: 'guessed-launcher' } ])
    assert.equal(codeGraphProjectionServer(root, server, result.projection), undefined);
  put('src/large.ts', 'x'.repeat(8 * 1024 * 1024 + 1));
  const unavailable = prepare(['src']); assert.equal(unavailable.available, false); assert.match(unavailable.next_action, /project_search/);
  assert.equal(readFileSync(join(root, 'src/main.c'), 'utf8'), 'int main(void){return 0;}');
});

test('captured path provenance maps exact source identities without claiming output string replacement is isolation', { timeout: 30000 }, t => {
  const { put, prepare } = fixture(t); put('src/main.cpp', 'int answer(){return 42;}');
  const result = prepare(['src']); assert.equal(result.available, true);
  const mapped = mapWorkForceCodeGraphResult(result.projection, { content: [{ type: 'text', text: `Source ${join(result.projection.root, 'src/main.cpp')}: answer()` }],
    structuredContent: { path: join(result.projection.root, 'src/main.cpp'), uri: pathToFileURL(join(result.projection.root, 'src/main.cpp')).href } });
  assert.equal(mapped.result.structuredContent.path, 'src/main.cpp'); assert.match(mapped.result.content[0].text, /Source src\/main.cpp/);
  assert.equal(mapped.source_projection.baseline, result.projection.baseline); assert.match(mapped.source_projection.limitation, /not an OS sandbox/);
  assert.equal(mapped.result.structuredContent.uri, 'src/main.cpp');
  assert.equal(JSON.stringify(mapped).includes(result.projection.root), false);
});

test('source projections reject exact symbolic and hard links without following external data', { timeout: 30000 }, t => {
  const { root, put, prepare } = fixture(t); put('public.ts', 'export const publicValue = true;'); put('private.txt', 'External fixture data.');
  linkSync(join(root, 'private.txt'), join(root, 'linked.ts'));
  assert.equal(prepare(['linked.ts']).available, false);
  try { symlinkSync(join(root, 'private.txt'), join(root, 'symbolic.ts')); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; return; }
  assert.equal(prepare(['symbolic.ts']).available, false);
  assert.equal(readFileSync(join(root, 'private.txt'), 'utf8'), 'External fixture data.');
});
