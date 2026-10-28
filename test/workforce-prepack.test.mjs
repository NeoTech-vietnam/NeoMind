import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  .find(path => path && existsSync(path));
function fixture(t, { bootstrapFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-prepack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'output'));
  copyFileSync(fileURLToPath(new URL('../scripts/prepack.mjs', import.meta.url)), join(root, 'scripts/prepack.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workforce-prepack-fixture', version: '1.0.0', private: true,
    files: ['product.txt'], scripts: { build: 'node scripts/build.mjs', prepack: 'node scripts/prepack.mjs' } }));
  writeFileSync(join(root, 'scripts/build.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('build-ran.txt','observed');writeFileSync('product.txt','built-product');console.log(JSON.stringify({build:'actual-fixture-child'}));\n");
  writeFileSync(join(root, 'scripts/bootstrap-engine.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('bootstrap-ran.txt','observed');console.log(JSON.stringify({bootstrap:'actual-fixture-child'}));" +
    (bootstrapFailure ? 'process.exitCode=23;\n' : '\n'));
  return root;
}
function pack(root) {
  assert.ok(npm, 'The actual npm CLI is available.');
  return spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', join(root, 'output')], {
    cwd: root, env: process.env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000,
  });
}
test('actual npm pack retains build/bootstrap execution and emits exactly one parseable JSON value', t => {
  const root = fixture(t), result = pack(root);
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.length, 1); assert.equal(metadata[0].filename, 'workforce-prepack-fixture-1.0.0.tgz');
  assert.ok(metadata[0].files.some(item => item.path === 'product.txt'));
  assert.equal(readFileSync(join(root, 'product.txt'), 'utf8'), 'built-product');
  assert.equal(readFileSync(join(root, 'build-ran.txt'), 'utf8'), 'observed');
  assert.equal(readFileSync(join(root, 'bootstrap-ran.txt'), 'utf8'), 'observed');
  assert.match(result.stderr, /actual-fixture-child/);
  assert.equal(readdirSync(join(root, 'output')).length, 1);
});
test('a failed actual bootstrap prevents npm pack and preserves its nonzero prepack exit', t => {
  const root = fixture(t, { bootstrapFailure: true }), result = pack(root);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(root, 'build-ran.txt'), 'utf8'), 'observed');
  assert.equal(readFileSync(join(root, 'bootstrap-ran.txt'), 'utf8'), 'observed');
  assert.deepEqual(readdirSync(join(root, 'output')), []);
  const direct = spawnSync(process.execPath, [join(root, 'scripts/prepack.mjs')], {
    cwd: root, env: { ...process.env, npm_execpath: npm }, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000,
  });
  assert.equal(direct.status, 23); assert.equal(direct.stdout, '');
  assert.match(direct.stderr, /prepack engine bootstrap failed/);
});
