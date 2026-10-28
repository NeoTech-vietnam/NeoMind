import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initialize } from '../dist/storage.js';
import { ensureRoutingPolicy, readRoutingPolicy } from '../dist/routing.js';

const cli = resolve('dist/cli.js');
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-cli-')); initialize(root, { project_id: 'WFCLI', platforms: ['copilot'] }); ensureRoutingPolicy(root);
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function invoke(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--project', root, '--json'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 });
}

test('actual CLI exposes WorkForce request setup/status without submitting or invoking a model', t => {
  const root = project(t), help = invoke(root, '--help');
  assert.equal(help.status, 0); assert.match(help.stdout, /^WorkForce engineering workspace/); assert.match(help.stdout, /request submit/);
  const status = invoke(root, 'request', 'status'); assert.equal(status.status, 0, status.stderr); assert.deepEqual(JSON.parse(status.stdout).requests, []);
  const setup = invoke(root, 'request', 'setup'); assert.equal(setup.status, 0, setup.stderr); assert.equal(JSON.parse(setup.stdout).ready, false);
  assert.deepEqual(JSON.parse(invoke(root, 'request', 'status').stdout).requests, [], 'Read-only setup/status do not admit a workflow.');
});

test('actual CLI configures only a validated catalog pointer and does not echo or copy credentials', t => {
  const root = project(t), catalog = join(root, 'catalog.json'), credential = 'PRIVATE_CLI_CATALOG_CANARY';
  const original = JSON.stringify([{ name: '9router', vendor: 'customendpoint', apiKey: credential,
    models: ['top-models', 'worker-models'].map(id => ({ id, url: 'http://127.0.0.1:1/v1' })) }]);
  writeFileSync(catalog, original);
  const response = invoke(root, 'models', 'catalog', '--catalog-file', catalog); assert.equal(response.status, 0, response.stderr);
  const value = JSON.parse(response.stdout); assert.equal(value.credential_storage, 'existing-user-catalog');
  assert.deepEqual(value.models.sort(), ['top-models', 'worker-models']); assert.equal(readFileSync(catalog, 'utf8'), original);
  assert.equal((response.stdout + response.stderr).includes(credential), false);
  assert.equal(readRoutingPolicy(root).language_models_file, value.path);
  assert.equal(readFileSync(join(root, '.workforce/routing.json'), 'utf8').includes(credential), false);
});

test('actual CLI rejects incomplete submit and answer protocol before any workflow admission', t => {
  const root = project(t);
  const submit = invoke(root, 'request', 'submit'); assert.notEqual(submit.status, 0); assert.match(submit.stderr, /--requirement is required/);
  const answer = invoke(root, 'request', 'resume', 'missing-request', '--answer', 'A source path');
  assert.notEqual(answer.status, 0); assert.match(answer.stderr, /--question-id is required/);
  assert.deepEqual(JSON.parse(invoke(root, 'request', 'status').stdout).requests, []);
});
