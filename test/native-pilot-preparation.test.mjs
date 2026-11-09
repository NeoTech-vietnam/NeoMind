import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repository = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));

test('native pilot preparation exposes the exact product package-management command once while preserving observer commands', { timeout: 30000 }, t => {
  const base = join(repository, 'artifacts/workforce-native-local-proof'), id = randomUUID().slice(0, 8), run = join(base, id);
  const extension = join(run, 'extension'), workspace = join(run, 'workspace'), evidence = join(run, 'evidence');
  for (const path of [extension, evidence, join(workspace, '.vscode'), join(workspace, '.github/agents')]) mkdirSync(path, { recursive: true });
  t.after(() => { const owned = relative(realpathSync.native(base), realpathSync.native(run)); assert.equal(owned, id); assert.equal(isAbsolute(owned), false); rmSync(run, { recursive: true, force: true }); });
  const manifest = { name: 'owned-native-command-proof', contributes: { commands: [{ command: 'workforceM2.inspect', title: 'Owned observer command' }] } };
  writeFileSync(join(extension, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(extension, 'fixture.json'), JSON.stringify({ repository, workspace, evidence }));
  writeFileSync(join(workspace, '.vscode/settings.json'), '{}');
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const script = fileURLToPath(new URL('./vscode-client-driver/native-local/prepare-pilot.mjs', import.meta.url));
  const product = JSON.parse(readFileSync(join(repository, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
  const expected = product.contributes.commands.find(item => item.command === 'workforce.nativePackages.manage'); assert.ok(expected);
  for (let iteration = 0; iteration < 2; iteration++) {
    const child = spawnSync(process.execPath, [script, extension, '--native-entry'], { cwd: repository, env: environment,
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 12000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    const saved = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
    assert.deepEqual(saved.contributes.commands.filter(item => item.command === expected.command), [expected]);
    assert.deepEqual(saved.contributes.commands.find(item => item.command === 'workforceM2.inspect'), manifest.contributes.commands[0]);
    assert.equal(JSON.parse(child.stdout).dispatched, false, 'Preparation cannot invoke a model or UI');
  }
});
