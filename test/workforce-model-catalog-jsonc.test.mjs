import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, readConfig, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readRoutingPolicy } from '../dist/routing.js';
import { configureWorkForceModelCatalog, setRoleModel } from '../dist/model-control.js';
import { configuredOpenCodeEndpoint } from '../dist/opencode-engine.js';
import { vscodeSelection } from '../dist/vscode-policy.js';
import { adapterOutputs } from '../dist/adapters.js';

function project(t, { native = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'wf-jsonc-model-catalog-'));
  const root = join(temporary, 'project'), user = join(temporary, 'VS Code User');
  mkdirSync(root); mkdirSync(user);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  // Catalog routing belongs to the preserved engine transport. Native Local
  // uses the VS Code inventory and must not acquire a catalog prerequisite.
  initialize(root, { platforms: ['copilot'], execution_engine: 'opencode',
    ...(native ? { copilot_integration: 'local' } : {}) });
  const policy = { ...ensureRoutingPolicy(root), strong_model: 'top-models', worker_models: ['worker-models'],
    strong_provider: '9Router', worker_provider: '9Router' };
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify(policy));
  return { root, path: join(user, 'chatLanguageModels.json') };
}

test('selected User-style JSONC catalog works through configuration, endpoint, model setter and Copilot generation without changing its bytes', t => {
  const { root, path } = project(t);
  const source = `// VS Code accepts comments and trailing commas in its model catalog.
[
  {
    "name": "9Router", "vendor": "customendpoint",
    "apiKey": "fixture-key//literal,]}",
    "models": [
      { "id": "top-models", "name": "Top Models", "url": "http://127.0.0.1:20128/v1", },
      { "id": "worker-models", "name": "Worker Models", "url": "http://127.0.0.1:20128/v1", },
    ],
  },
]
`;
  writeFileSync(path, source);
  const selected = configureWorkForceModelCatalog(root, { path });
  assert.equal(selected.selections_valid, true);
  assert.equal(readRoutingPolicy(root).language_models_file, realpathSync.native(path));
  assert.deepEqual(configuredOpenCodeEndpoint(root, 'developer'), { model: 'worker-models', provider: '9Router',
    baseURL: 'http://127.0.0.1:20128/v1', apiKey: 'fixture-key//literal,]}' });
  assert.equal(setRoleModel(root, { role: 'developer', model: 'Worker Models', provider: '9Router' }).model, 'worker-models');
  assert.deepEqual(vscodeSelection(root, 'developer', 'worker-models'), { vendor: 'customendpoint', id: 'worker-models' });
  const manager = adapterOutputs(root, readConfig(root)).find(item => item.path.endsWith('/workforce-pm.agent.md'));
  assert.match(manager.content, /model: "Top Models \(customendpoint\)"/);
  assert.doesNotMatch(JSON.stringify(selected), /fixture-key/);
  assert.equal(readFileSync(path, 'utf8'), source, 'The selected User catalog, comments and credential bytes remain unchanged.');
});

test('native Local profiles inherit VS Code selection even when a historical catalog is unreadable', t => {
  const { root, path } = project(t, { native: true });
  const source = '[{"apiKey":"fixture-native-catalog-secret" malformed';
  writeFileSync(path, source);
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify({ ...readRoutingPolicy(root), language_models_file: path }));
  const before = readFileSync(safePath(root, '.workforce/routing.json'), 'utf8');
  const profiles = adapterOutputs(root, readConfig(root)).filter(item => item.path.startsWith('.github/agents/'));
  assert.equal(profiles.filter(profile => /^user-invocable: true$/m.test(profile.content)).length, 6);
  const manager = profiles.find(item => item.path.endsWith('/workforce-pm.agent.md'));
  assert.match(manager.content, /workforceNativeRequest/);
  for (const profile of profiles) assert.doesNotMatch(profile.content, /^model:|fixture-native-catalog-secret/m);
  assert.equal(readFileSync(path, 'utf8'), source);
  assert.equal(readFileSync(safePath(root, '.workforce/routing.json'), 'utf8'), before);
});

test('real JSONC syntax errors are rejected at every catalog entrypoint without exposing catalog secrets or changing routing', t => {
  const { root, path } = project(t), secret = 'fixture-sensitive-catalog-value';
  const policy = { ...readRoutingPolicy(root), language_models_file: path };
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify(policy));
  const before = readFileSync(safePath(root, '.workforce/routing.json'), 'utf8');
  const malformed = [
    `[{"apiKey":"${secret}" "models":[]}]`,
    `[{"apiKey":"${secret}", "models": [}]`,
    `[{"apiKey":"${secret}", "models": [],}] invalid`,
    `[{"apiKey":"${secret}`,
    '',
  ];
  for (const source of malformed) {
    writeFileSync(path, source);
    for (const read of [
      () => configureWorkForceModelCatalog(root, { path }),
      () => configuredOpenCodeEndpoint(root, 'manager'),
      () => setRoleModel(root, { role: 'developer', model: 'worker-models', provider: '9Router' }),
      () => vscodeSelection(root, 'developer', 'worker-models'),
      () => adapterOutputs(root, readConfig(root)),
    ]) {
      assert.throws(read, error => {
        assert.match(error.message, /catalog/i);
        assert.equal(error.message.includes(secret), false, 'A syntax error must never echo source or credentials.');
        assert.doesNotMatch(error.message, /Unexpected token|Unexpected end|position \d+/);
        return true;
      });
    }
    assert.equal(readFileSync(path, 'utf8'), source);
    assert.equal(readFileSync(safePath(root, '.workforce/routing.json'), 'utf8'), before);
  }
});

test('BOM and JSONC support retain ambiguous model rejection and endpoint credential restrictions', t => {
  const { root, path } = project(t);
  const policy = { ...readRoutingPolicy(root), language_models_file: path };
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify(policy));
  const group = { name: '9Router', vendor: 'customendpoint', apiKey: 'fixture-private-value', models: [
    { id: 'top-models', name: 'Top Models', url: 'http://127.0.0.1:20128/v1' },
    { id: 'worker-models', name: 'Worker Models', url: 'http://127.0.0.1:20128/v1' },
  ] };
  const writeCatalog = values => writeFileSync(path, `\uFEFF/* User profile */[\n${values.map(value => JSON.stringify(value)).join(',\n')},\n]\n`);
  writeCatalog([group]);
  assert.equal(configureWorkForceModelCatalog(root, { path }).selections_valid, true);
  assert.equal(configuredOpenCodeEndpoint(root, 'manager').model, 'top-models');
  writeCatalog([group, group]);
  assert.throws(() => configureWorkForceModelCatalog(root, { path }), /no unambiguous supported custom endpoint/);
  assert.throws(() => configuredOpenCodeEndpoint(root, 'manager'), /one supported custom endpoint/);
  assert.throws(() => vscodeSelection(root, 'manager', 'top-models'), /exactly one catalog vendor/);
  assert.throws(() => setRoleModel(root, { role: 'manager', model: 'top-models', provider: '9Router' }), /exactly one catalog vendor and ID/);
  assert.throws(() => adapterOutputs(root, readConfig(root)), /exactly one entry/);
  for (const url of ['https://user:fixture-url-secret@example.invalid/v1', 'http://remote.invalid/v1', 'https://example.invalid/v1?key=fixture-url-secret']) {
    writeCatalog([{ ...group, models: group.models.map(model => ({ ...model, url })) }]);
    assert.throws(() => configuredOpenCodeEndpoint(root, 'manager'), /one supported custom endpoint/);
    assert.throws(() => configureWorkForceModelCatalog(root, { path }), /no unambiguous supported custom endpoint/);
  }
});
