import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareManagedGateway } from '../scripts/prepare-managed-gateway.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-gateway-release-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'pinned.tgz'), modulePath = join(root, 'artifact.mjs'), output = join(root, 'resources');
  const license = 'Exact published package notice\n', bytes = 'PINNED_CLOSURE_ARCHIVE';
  writeFileSync(archive, bytes);
  writeFileSync(modulePath, `import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';
export const MANAGED_GATEWAY_PIN={package:'9router',version:'0.5.116',repository:'https://github.com/example/upstream',commit:'fixture',license:'MIT',integrity:'sha512-fixture'};
export async function installManagedGateway(root,options){
if(options.allowDownload!==false||!options.archivePath)throw Error('Release test must reuse pinned local bytes');
const bytes=readFileSync(options.archivePath);if(bytes.toString()!==${JSON.stringify(bytes)})throw Error('GATEWAY_INTEGRITY');
const directory=join(root,'artifacts','fixture'),pkg=join(directory,'node_modules','9router');mkdirSync(pkg,{recursive:true});
writeFileSync(join(directory,'9router-0.5.116.tgz'),bytes);writeFileSync(join(pkg,'LICENSE'),${JSON.stringify(license)});
return{directory,tarball_sha512:'sha512-fixture',files:[{path:'actual-fixture-entry'}],licenses:[{package:'fixture-dependency',version:'1',license:'MIT'}]};}
`);
  return { root, archive, modulePath, output, license, bytes };
}
test('release preparation copies exact verified closure and published notice without npm/hooks or user accounts', async t => {
  const f = fixture(t), result = await prepareManagedGateway({ outputDirectory: f.output, archivePath: f.archive, modulePath: f.modulePath,
    fetch() { throw Error('No release-test network'); } });
  assert.equal(readFileSync(join(f.output, '9router-0.5.116.tgz'), 'utf8'), f.bytes);
  assert.equal(readFileSync(join(f.output, 'LICENSE.9router.txt'), 'utf8'), f.license);
  assert.equal(result.archive_sha256, createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(result.license_sha256, createHash('sha256').update(f.license).digest('hex'));
  assert.equal(result.closure_file_count, 1); assert.deepEqual(result.licenses, [{ package: 'fixture-dependency', version: '1', license: 'MIT' }]);
  assert.doesNotMatch(readFileSync(join(f.output, 'manifest.json'), 'utf8'), /apiKey|Bearer|accounts\.json/);
  assert.equal(readFileSync(join(f.output, 'manifest.json'), 'utf8').includes(f.root), false, 'No machine-private staging path is packaged.');
  // The prepared archive is itself a valid repeat-cache input. No download is needed.
  assert.deepEqual(await prepareManagedGateway({ outputDirectory: f.output, modulePath: f.modulePath }), result);
});
test('a rejected upstream archive never publishes partial native resources or replaces the previously verified notice', async t => {
  const f = fixture(t); mkdirSync(f.output); writeFileSync(join(f.output, 'LICENSE.9router.txt'), 'PREVIOUS_VERIFIED_NOTICE');
  writeFileSync(f.archive, 'WRONG_BYTES');
  await assert.rejects(prepareManagedGateway({ outputDirectory: f.output, archivePath: f.archive, modulePath: f.modulePath }), /GATEWAY_INTEGRITY/);
  assert.equal(existsSync(join(f.output, '9router-0.5.116.tgz')), false);
  assert.equal(existsSync(join(f.output, 'manifest.json')), false);
  assert.equal(readFileSync(join(f.output, 'LICENSE.9router.txt'), 'utf8'), 'PREVIOUS_VERIFIED_NOTICE');
});
