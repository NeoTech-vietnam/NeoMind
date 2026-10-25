import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite, initialize, readConfig, safePath } from '../dist/storage.js';
import { controlledRepairBudget } from '../dist/controlled-workflow.js';

function fixture(t) {
  const parent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(parent, 'neomind-repair-config-')));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('new projects default to one repair and honor only explicitly valid bounded allowances', t => {
  for (const repair_attempts of [undefined, 1, 2, 3]) {
    const root = fixture(t);
    const config = initialize(root, { repair_attempts });
    assert.equal(config.repair_attempts, repair_attempts ?? 1);
    assert.equal(readConfig(root).repair_attempts, repair_attempts ?? 1);
  }
  const existing = fixture(t);
  initialize(existing);
  const before = readFileSync(safePath(existing, '.neomind/config.json'));
  assert.equal(initialize(existing, { repair_attempts: 3 }).repair_attempts, 1);
  assert.deepEqual(readFileSync(safePath(existing, '.neomind/config.json')), before,
    'Initialization never overwrites an existing project policy.');
});

test('invalid initial and saved repair allowances fail validation instead of being silently ignored', t => {
  for (const invalid of [0, 4, -1, 1.5, '3', null, NaN, Infinity]) {
    const root = fixture(t);
    assert.throws(() => initialize(root, { repair_attempts: invalid }), /invalid project configuration/);
    assert.equal(existsSync(safePath(root, '.neomind/config.json')), false, 'Invalid policy is never persisted.');
  }
  const root = fixture(t), config = initialize(root, { repair_attempts: 3 });
  for (const invalid of [0, 4, 1.5, '3', null]) {
    atomicWrite(safePath(root, '.neomind/config.json'), JSON.stringify({ ...config, repair_attempts: invalid }));
    assert.throws(() => readConfig(root), /invalid project configuration/);
  }
});

test('raising a saved allowance to three retains consumed controlled repair counters and history', t => {
  const root = fixture(t), config = initialize(root);
  const saved = { repairs: 1, repair_budget: { schema_version: 1, product: 1, protocol: 0, environment: 1 },
    events: [{ kind: 'repair', summary: 'Backend routes implementation to implementation.' },
      { kind: 'blocked', summary: 'Product/checker repair budget exhausted. Preserve this observation.' }] };
  const path = safePath(root, '.neomind/controlled/workflows/saved-repair-budget.json');
  atomicWrite(path, JSON.stringify(saved));
  const before = readFileSync(path);
  atomicWrite(safePath(root, '.neomind/config.json'), JSON.stringify({ ...config, repair_attempts: 3 }));
  assert.equal(readConfig(root).repair_attempts, 3);
  const resumed = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(controlledRepairBudget(resumed), saved.repair_budget);
  assert.equal(resumed.repairs, 1, 'Changing the allowance does not refund the consumed repair.');
  assert.deepEqual(resumed.events, saved.events, 'Prior failure and repair history remain intact.');
  assert.deepEqual(readFileSync(path), before, 'Policy reads and budget inspection do not rewrite the journal.');

  const legacy = { repairs: 1, events: [{ kind: 'repair', summary: 'Backend routes implementation to implementation.' }] };
  assert.deepEqual(controlledRepairBudget(legacy), { schema_version: 1, product: 1, protocol: 0, environment: 0 });
  assert.equal(legacy.repairs, 1, 'Legacy counter reconciliation retains known product usage.');
});
