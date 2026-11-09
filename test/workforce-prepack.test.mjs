import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packedArchive } from '../scripts/package-runtime.mjs';

const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  .find(path => path && existsSync(path));
function fixture(t, { gatewayFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-prepack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'output'));
  copyFileSync(fileURLToPath(new URL('../scripts/prepack.mjs', import.meta.url)), join(root, 'scripts/prepack.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workforce-prepack-fixture', version: '1.0.0', private: true,
    files: ['product.txt'], scripts: { build: 'node scripts/build.mjs', prepack: 'node scripts/prepack.mjs' } }));
  writeFileSync(join(root, 'scripts/build.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('build-ran.txt','observed');writeFileSync('product.txt','built-product');console.log(JSON.stringify({build:'actual-fixture-child'}));\n");
  writeFileSync(join(root, 'scripts/prepare-managed-gateway.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('gateway-ran.txt','observed');console.log(JSON.stringify({offline_gateway:'actual-fixture-child'}));" +
    (gatewayFailure ? 'process.exitCode=23;\n' : '\n'));
  writeFileSync(join(root, 'scripts/bootstrap-engine.mjs'), "throw new Error('Legacy bootstrap must never execute during native prepack');\n");
  return root;
}
function pack(root) {
  assert.ok(npm, 'The actual npm CLI is available.');
  return spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', join(root, 'output')], {
    cwd: root, env: process.env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000,
  });
}
test('actual native npm pack builds and prepares offline gateway without executing legacy bootstrap, emitting one JSON value', t => {
  const root = fixture(t), result = pack(root);
  assert.equal(result.status, 0, result.stderr);
  // npm 11 emits an array; npm 12 emits an object keyed by package name.
  // Use the same strict one-archive reader as production packaging.
  const metadata = packedArchive(JSON.parse(result.stdout));
  assert.equal(metadata.name, 'workforce-prepack-fixture'); assert.equal(metadata.version, '1.0.0');
  assert.equal(metadata.filename, 'workforce-prepack-fixture-1.0.0.tgz');
  assert.ok(metadata.files.some(item => item.path === 'product.txt'));
  assert.equal(readFileSync(join(root, 'product.txt'), 'utf8'), 'built-product');
  assert.equal(readFileSync(join(root, 'build-ran.txt'), 'utf8'), 'observed');
  assert.equal(readFileSync(join(root, 'gateway-ran.txt'), 'utf8'), 'observed');
  assert.match(result.stderr, /actual-fixture-child/);
  assert.equal(readdirSync(join(root, 'output')).length, 1);
});
test('a failed actual offline gateway verification prevents npm pack and preserves its nonzero prepack exit', t => {
  const root = fixture(t, { gatewayFailure: true }), result = pack(root);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(root, 'build-ran.txt'), 'utf8'), 'observed');
  assert.equal(readFileSync(join(root, 'gateway-ran.txt'), 'utf8'), 'observed');
  assert.deepEqual(readdirSync(join(root, 'output')), []);
  const direct = spawnSync(process.execPath, [join(root, 'scripts/prepack.mjs')], {
    cwd: root, env: { ...process.env, npm_execpath: npm }, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000,
  });
  assert.equal(direct.status, 23); assert.equal(direct.stdout, '');
  assert.match(direct.stderr, /prepack offline gateway failed/);
});
