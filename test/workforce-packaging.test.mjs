import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distributionTarget, lockedDependencyInventory, archiveRuntime, packedArchive, nativeTarCommand, packageSmokeWorkspace, assertPackageRuntimeIsolated } from '../scripts/package-runtime.mjs';
import * as runtimePackaging from '../scripts/package-runtime.mjs';
import { spawnSync } from 'node:child_process';
import { writeReleaseIndex } from '../scripts/package-release.mjs';
import { parse as parseYaml } from 'yaml';
import { bootstrapWindowsGuardian } from '../scripts/bootstrap-engine.mjs';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('exact WorkForce branch push packages candidates after the same native CI regression without publishing', () => {
  const ci = parseYaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const job = ci.jobs.verify;
  assert.deepEqual(job.strategy.matrix.os, ['windows-latest', 'ubuntu-latest']);
  assert.ok(job['timeout-minutes'] >= 90);
  const tests = job.steps.filter(step => step.run === 'npm test');
  assert.equal(tests.length, 1, 'Candidate packaging reuses one full regression per platform.');
  const build = job.steps.find(step => step.run === 'npm run release:artifacts');
  assert.ok(job.steps.indexOf(build) > job.steps.indexOf(tests[0]));
  const smoke = job.steps.find(step => step.name === 'Verify the extracted native WorkForce candidate');
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const reports = job.steps.find(step => step.name === 'Index native WorkForce validation reports');
  for (const step of [build, smoke, reports, upload]) {
    assert.ok(step, 'Native build, extracted smoke and retained reports are all required.');
    assert.match(step.if, /github\.event_name == 'push'/);
    assert.match(step.if, /github\.ref == 'refs\/heads\/codex\/workforce-vmodel'/);
    assert.match(step.if, /github\.ref == 'refs\/heads\/codex\/workforce-vscode-native'/);
  }
  assert.match(build.if, /^success\(\)/);
  assert.match(smoke.if, /^success\(\)/);
  assert.match(smoke.run, /--runtime-archive/);
  assert.match(smoke.env.WORKFORCE_NATIVE_TARGET, /windows-x64.*linux-x64/);
  assert.match(reports.run, /writeReleaseIndex/);
  assert.ok(job.steps.indexOf(reports) > job.steps.indexOf(smoke));
  assert.ok(job.steps.indexOf(upload) > job.steps.indexOf(reports));
  assert.match(upload.if, /^always\(\)/);
  assert.equal(upload.with.path, 'artifacts/workforce-v*/');
  assert.ok(job.steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses)));
  for (const value of Object.values(ci.jobs))
    assert.equal(Object.values(value.permissions ?? {}).includes('write'), false);
  assert.doesNotMatch(JSON.stringify(ci), /gh release create|vsce publish|npm publish/);
});

test('every core CI entry keeps the complete suite and fails before testing a failed build', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'npm run build && node --test --test-concurrency=2 test/*.test.mjs');
  assert.doesNotMatch(pkg.scripts.test, /--test-(?:name|skip|timeout)/);
  for (const file of ['ci.yml', 'release-candidate.yml', 'self-hosted-linux.yml']) {
    const workflow = parseYaml(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps);
    const core = steps.filter(step => step.run === 'npm test');
    assert.equal(core.length, 1, `${file} runs one complete core regression.`);
    const direct = steps.filter(step => step.run?.includes('node --test'));
    assert.equal(direct.length, file === 'ci.yml' ? 1 : 0, 'Only separate Ubuntu transport diagnostics supplement canonical core validation.');
  }
});

test('native-core CI does not require deferred M7 gateway preparation, model access or service qualification', () => {
  const ci = parseYaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = ci.jobs.verify.steps;
  assert.equal(steps.some(step => /managed-gateway|WF_REQUIRE_GATEWAY_ARCHIVE|prepare-managed/.test(JSON.stringify(step))), false);
  assert.equal(ci.jobs.verify.strategy.matrix.os.length, 2);
});

test('Ubuntu repeated engine diagnostics supplement full regression and stop before packaging on any failure', () => {
  const ci = parseYaml(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = ci.jobs.verify.steps, core = steps.find(step => step.run === 'npm test');
  const diagnostic = steps.find(step => step.name === 'Repeat Ubuntu engine admission and transport diagnostics');
  assert.equal(diagnostic.if, "success() && matrix.os == 'ubuntu-latest'"); assert.equal(diagnostic.shell, 'bash');
  assert.match(diagnostic.run, /for attempt in 1 2 3; do/);
  assert.match(diagnostic.run, /node --test --test-concurrency=2 test\/opencode-async-turn\.test\.mjs test\/opencode-tool-transport\.test\.mjs \|\| exit "\$\?"/);
  assert.doesNotMatch(diagnostic.run, /diagnostics\/|--test-(?:name|skip|timeout)|test\/\*|PAID|LIVE|GATED/);
  assert.ok(steps.indexOf(diagnostic) > steps.indexOf(core));
  assert.ok(steps.indexOf(diagnostic) < steps.findIndex(step => step.name === 'Inspect package contents'));
});

test('portable assets identify only their actually supported native targets', () => {
  assert.deepEqual(distributionTarget('win32', 'x64'), { platform: 'win32', arch: 'x64', target: 'windows-x64', execution: 'vscode-native/v1', transport: 'vscode-local' });
  assert.equal(distributionTarget('linux', 'x64').target, 'linux-x64');
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'arm64'], ['win32', 'ia32']]) assert.throws(() => distributionTarget(platform, arch), /Windows x64 and Linux x64 only/);
});

test('native distribution excludes legacy execution dependencies and rejects accidentally bundled engines', t => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['opencode-ai', '@opencode-ai/sdk']) {
    assert.equal(pkg.dependencies[name], undefined, 'Legacy engine dependencies must not install in the native product.');
    assert.equal(pkg.devDependencies[name], '1.19.4', 'Historical source regression remains installable with dev dependencies.');
  }
  assert.equal(typeof runtimePackaging.assertNativeOnlyRuntime, 'function');
  const root = mkdtempSync(join(tmpdir(), 'workforce-native-distribution-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { yaml: '2.9.1' } }));
  assert.equal(runtimePackaging.assertNativeOnlyRuntime(root), true);
  mkdirSync(join(root, 'resources/opencode-bootstrap'), { recursive: true });
  assert.throws(() => runtimePackaging.assertNativeOnlyRuntime(root), /legacy|OpenCode/i);
  rmSync(join(root, 'resources'), { recursive: true });
  mkdirSync(join(root, 'node_modules/opencode-windows-x64'), { recursive: true });
  assert.throws(() => runtimePackaging.assertNativeOnlyRuntime(root), /legacy|OpenCode/i);
  rmSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'node_modules/ordinary/node_modules/@opencode-ai/sdk'), { recursive: true });
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/ordinary/node_modules/@opencode-ai/sdk': { version: '1.19.4' },
  } }));
  assert.throws(() => runtimePackaging.assertNativeOnlyRuntime(root), /legacy|OpenCode/i, 'A nested installed engine dependency cannot hide behind a regular package.');
});

test('native-core runtime rejects accidentally bundled deferred M7 activation and gateway resources', t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-deferred-m7-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"dependencies":{}}');
  for (const path of ['resources/managed-gateway', 'extensions/vscode-model-bridge/managed-gateway-host.cjs',
    'extensions/vscode-model-bridge/native-rea-provider.cjs', 'scripts/prepare-managed-gateway.mjs']) {
    const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true });
    if (path === 'resources/managed-gateway') mkdirSync(target); else writeFileSync(target, 'Deferred M7 sentinel');
    assert.throws(() => runtimePackaging.assertNativeOnlyRuntime(root), /deferred M7|managed gateway/i);
    rmSync(target, { recursive: true, force: true });
  }
});
test('real installed-package smoke isolation cannot borrow the checkout development SDK through Node parent lookup', t => {
  assert.match(import.meta.resolve('@opencode-ai/sdk/v2/client'), /\/node_modules\/@opencode-ai\/sdk\//,
    'The source regression SDK exists, making this a meaningful negative control.');
  const root = packageSmokeWorkspace(); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'missing-sdk.mjs'), "import '@opencode-ai/sdk/v2/client';\n");
  const result = spawnSync(process.execPath, [join(root, 'missing-sdk.mjs')], { cwd: root, windowsHide: true, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.throws(() => packageSmokeWorkspace(fileURLToPath(new URL('../artifacts', import.meta.url))), /outside the source checkout/);
  assert.throws(() => assertPackageRuntimeIsolated(fileURLToPath(new URL('../artifacts', import.meta.url))), /--runtime-archive|outside the source checkout/);
  assert.throws(() => assertPackageRuntimeIsolated(fileURLToPath(new URL('..', import.meta.url))), /--runtime-archive|outside the source checkout/);
  assert.equal(assertPackageRuntimeIsolated(root), true);
});

test('npm archive metadata accepts supported CLI envelopes without accepting multiple or escaping files', () => {
  for (const value of [[{ filename: 'workforce.tgz' }], { filename: 'workforce.tgz' }, { workspace: [{ filename: 'workforce.tgz' }] }]) assert.equal(packedArchive(value).filename, 'workforce.tgz');
  assert.throws(() => packedArchive({}), /identify one/);
  assert.throws(() => packedArchive([{ filename: '../outside.tgz' }]), /identify one/);
  assert.throws(() => packedArchive([{ filename: 'one.tgz' }, { filename: 'two.tgz' }]), /identify one/);
});

test('native archive streaming publishes an extractable asset only after compression finishes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-archive-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workforce')); writeFileSync(join(root, 'workforce/product.txt'), 'Useful fixture artifact');
  const output = join(root, 'runtime.tgz'); await archiveRuntime(root, output);
  const listing = spawnSync(nativeTarCommand(), ['-tzf', output], { encoding: 'utf8', windowsHide: true });
  assert.equal(listing.status, 0); assert.match(listing.stdout.replaceAll('\\', '/'), /workforce\/product\.txt/);
});

test('distribution dependency inventory records actual installed lock pins and rejects version drift', t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-inventory-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules/example'), { recursive: true });
  writeFileSync(join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }));
  const lock = { packages: { 'node_modules/example': { version: '1.2.3', integrity: 'sha512-fixture' }, 'node_modules/not-installed': { version: '2', integrity: 'sha512-other' } } };
  assert.deepEqual(lockedDependencyInventory(root, lock), [{ path: 'node_modules/example', name: 'example', version: '1.2.3', integrity: 'sha512-fixture', license: 'MIT' }]);
  lock.packages['node_modules/example'].version = '1.2.4'; assert.throws(() => lockedDependencyInventory(root, lock), /differs from the lock/);
});

test('engine bootstrap is exact, private and integrity locked without private execution configuration', () => {
  const pkg = JSON.parse(readFileSync(new URL('../resources/opencode-bootstrap/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../resources/opencode-bootstrap/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.private, true); assert.deepEqual(pkg.dependencies, { '@opencode-ai/plugin': '1.19.4' });
  assert.equal(lock.packages['node_modules/@opencode-ai/plugin'].version, '1.19.4');
  assert.ok(Object.entries(lock.packages).filter(([path]) => path).every(([, entry]) => typeof entry.integrity === 'string'));
  assert.doesNotMatch(JSON.stringify({ pkg, lock }), /apiKey|Authorization|Bearer |baseURL|127\.0\.0\.1/);
});

test('setup reuses the verified precompiled Windows guardian without recompiling per invocation', { skip: process.platform !== 'win32' }, () => {
  const path = new URL('../resources/opencode-bootstrap/windows-guardian.dll', import.meta.url);
  const before = statSync(path).mtimeMs;
  const first = bootstrapWindowsGuardian(), second = bootstrapWindowsGuardian();
  assert.deepEqual(first, second); assert.equal(statSync(path).mtimeMs, before);
  assert.match(first.assembly_sha256, /^[a-f0-9]{64}$/); assert.match(first.source_sha256, /^[a-f0-9]{64}$/);
});

test('candidate indexing requires both native assets when requested and never claims publication or client acceptance', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-release-index-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(writeReleaseIndex(root, { requirePlatforms: true }), /Both native/);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  for (const target of ['windows-x64', 'linux-x64']) writeFileSync(join(root, `workforce-runtime-${version}-${target}.tgz`), `fixture ${target}`);
  const manifest = await writeReleaseIndex(root, { requirePlatforms: true });
  assert.equal(manifest.tag, `workforce-v${version}`); assert.equal(manifest.published, false); assert.equal(manifest.state, 'candidate');
  assert.equal(manifest.execution, 'vscode-native/v1'); assert.equal(manifest.transport, 'vscode-local'); assert.equal(manifest.engine_version, undefined);
  assert.equal(manifest.complete_platform_set, true); assert.equal(manifest.assets.length, 2);
  assert.ok(manifest.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.match(readFileSync(join(root, 'SHA256SUMS'), 'utf8'), /release-manifest\.json/);
});
