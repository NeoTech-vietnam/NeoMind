import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readRoutingPolicy } from '../dist/routing.js';
import { configureWorkForceModelCatalog, setRoleModel } from '../dist/model-control.js';

test('a valid catalog can be connected before repairing retained unsupported role selections without overwriting them', t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-catalog-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); initialize(root);
  const retained = { ...ensureRoutingPolicy(root), strong_model: 'retained-old-strong', worker_models: ['retained-old-worker'],
    role_models: { reviewer: { model: 'authored-reviewer', provider: 'customendpoint', effort: 'medium' } } };
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify(retained));
  const path = join(root, 'catalog.json'), catalog = [{ vendor: 'customendpoint', apiKey: 'fixture-not-used', models: [
    { id: 'top-models', url: 'http://127.0.0.1:1/v1' }, { id: 'worker-models', url: 'http://127.0.0.1:1/v1' }] }];
  writeFileSync(path, JSON.stringify(catalog));
  const selected = configureWorkForceModelCatalog(root, { path });
  assert.equal(selected.selections_valid, false); assert.equal(selected.unresolved_roles.length, 6);
  assert.deepEqual(selected.available_models, ['top-models', 'worker-models']);
  const stored = readRoutingPolicy(root), { language_models_file, ...unchanged } = stored;
  assert.equal(language_models_file, realpathSync(path)); assert.deepEqual(unchanged, retained);
  for (const role of ['manager', 'requirements', 'architect', 'developer', 'reviewer', 'verifier'])
    setRoleModel(root, { role, model: role === 'developer' ? 'worker-models' : 'top-models', provider: 'customendpoint' });
  assert.equal(configureWorkForceModelCatalog(root, { path }).selections_valid, true);
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(catalog), 'User catalog and credential bytes remain untouched.');
});
