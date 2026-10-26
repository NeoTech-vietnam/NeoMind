import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRecords, getRecord, createRecord } from '../dist/storage.js';
import { initialize } from '../dist/storage.js';
import { managedRun } from '../dist/managed.js';
import { contextPacket } from '../dist/engineering.js';
import {
  ensureRoutingPolicy,
  readRoutingPolicy,
  roleModelPolicy,
  routingConfigurationHashes,
  routingBindingProblems,
  routingProblems,
  strongRoles,
  workerRoles,
} from '../dist/routing.js';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-routing-'));
  initialize(root);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
test('legacy core projects keep existing API compatibility until routing migration', (t) => {
  const root = project(t);
  assert.equal(readRoutingPolicy(root), null);
  assert.deepEqual(routingProblems(root, 'developer', 'legacy-invocation'), []);
  ensureRoutingPolicy(root);
  assert.match(
    routingProblems(root, 'developer', 'legacy-invocation').join(' '),
    /cannot be verified/,
  );
});
test('one routing file dynamically selects custom strong and worker models', (t) => {
  const root = project(t);
  const policy = ensureRoutingPolicy(root);
  policy.strong_model = 'company-top-tier-model';
  policy.worker_models = ['gpt 4o-mini', 'gemini-2.5-flash-lite'];
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  assert.deepEqual(roleModelPolicy(root, 'reviewer').models, ['company-top-tier-model']);
  assert.deepEqual(roleModelPolicy(root, 'developer').models, [
    'gpt 4o-mini',
    'gemini-2.5-flash-lite',
  ]);
  policy.strong_model = 'top-tier-model';
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  assert.deepEqual(ensureRoutingPolicy(root), policy);
  assert.deepEqual(roleModelPolicy(root, 'manager').models, ['top-tier-model']);
  const task = createRecord(root, {
    type: 'task',
    title: 'Inspect configurable routing',
    owner: 'developer',
    data: { routing_required: true },
  });
  const packet = contextPacket(root, task.meta.id);
  assert.equal(packet.routing.strong_model, 'top-tier-model');
  assert.deepEqual(packet.routing.worker_models, policy.worker_models);
  assert.equal(packet.model_tiers.strong, 'top-tier-model');
});
test('legacy model mappings cannot override the single routing policy', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const path = join(root, '.neomind/config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.models.strong = { claude: 'authored-claude-model', copilot: 'claude-opus-4.6' };
  config.models.economy = { copilot: 'gpt-5.4' };
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(roleModelPolicy(root, 'reviewer').models, ['claude-opus-4.6']);
  config.models.economy.copilot = 'authored-copilot-model';
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(roleModelPolicy(root, 'developer').models, ['gpt-5.4']);
  assert.equal(
    JSON.parse(readFileSync(path, 'utf8')).models.economy.copilot,
    'authored-copilot-model',
  );
});
test('approved provider installations do not invalidate routing policy fingerprints', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const prior = routingConfigurationHashes(root);
  writeFileSync(
    join(root, '.neomind/tool-lock.json'),
    JSON.stringify({ providers: ['codegraph'] }),
  );
  assert.deepEqual(routingConfigurationHashes(root), prior);
  writeFileSync(join(root, '.neomind/tools.json'), JSON.stringify({ approved_providers: [] }));
  assert.notDeepEqual(routingConfigurationHashes(root), prior);
});
test('strategic and routine roles use distinct Copilot models without duplicate fallback', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  for (const role of strongRoles) {
    const policy = roleModelPolicy(root, role);
    assert.deepEqual(policy.models, ['claude-opus-4.6']);
    assert.equal(policy.reasoning_effort, 'high');
  }
  for (const role of workerRoles) {
    const policy = roleModelPolicy(root, role);
    assert.deepEqual(policy.models, ['gpt-5.4']);
    assert.equal(policy.reasoning_effort, 'low');
  }
  assert.throws(() => roleModelPolicy(root, 'unknown'), /Unsupported/);
  assert.match(routingProblems(root, 'reviewer', undefined).join(' '), /bridge-issued/);
});
test('update preserves valid customized routing and rejects invalid settings without rewriting them', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const path = join(root, '.neomind/routing.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  original.strong_model = 'custom-model';
  writeFileSync(path, JSON.stringify(original));
  assert.equal(ensureRoutingPolicy(root).strong_model, 'custom-model');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).strong_model, 'custom-model');
  for (const change of [
    { strong_model: '' },
    { worker_models: [] },
    { worker_models: ['duplicate', 'duplicate'] },
    { strong_effort: 'unsupported' },
    { platform: 'untrusted-runtime' },
    { unexpected: true },
  ]) {
    const invalid = JSON.stringify({ ...original, ...change });
    writeFileSync(path, invalid);
    assert.throws(() => ensureRoutingPolicy(root), /Invalid routing configuration/);
    assert.equal(readFileSync(path, 'utf8'), invalid);
  }
});
test('managed resumption preserves increment identity and reports policy blockers without launching inference', async (t) => {
  const root = project(t);
  const started = await managedRun(root, {
    requirements: [
      'Validate declared integer bounds.',
      'Persist accepted configuration atomically.',
    ],
  });
  assert.match(started.blocker, /Strict native routing must be installed/);
  assert.equal(started.invocation, undefined);
  const workflowId = started.workflow.workflow_id;
  const incrementId = started.workflow.increment_id;
  const resumed = await managedRun(root, { workflow_id: workflowId });
  assert.equal(resumed.workflow.increment_id, incrementId);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.data.kind === 'manager-workflow').length,
    1,
  );
  await assert.rejects(
    managedRun(root, { workflow_id: workflowId, requirement: 'An unrelated new requirement.' }),
    /differ from the saved increment/,
  );
  assert.equal(getRecord(root, workflowId).meta.data.original_requirements.length, 2);
  const policy = ensureRoutingPolicy(root);
  const path = join(root, '.neomind/routing.json');
  policy.worker_models = [];
  writeFileSync(path, JSON.stringify(policy));
  const conflicted = await managedRun(root, { workflow_id: workflowId });
  assert.match(conflicted.blocker, /Invalid routing configuration/);
  assert.equal(conflicted.invocation, undefined);
});
test('workflow-wide strategic binding covers only a target task in that explicitly bound workflow', (t) => {
  const root = project(t);
  const task = createRecord(root, {
    type: 'task',
    title: 'Review planned component',
    data: { workflow_id: 'workflow-a' },
  });
  const scope = { role: 'reviewer', task_id: null, workflow_id: 'workflow-a' };
  const target = { task_id: task.meta.id, workflow_id: 'workflow-a' };
  assert.deepEqual(routingBindingProblems(root, scope, target), []);
  assert.match(
    routingBindingProblems(root, { ...scope, role: 'developer' }, target).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(root, scope, { task_id: task.meta.id }).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(
      root,
      { ...scope, workflow_id: 'workflow-b' },
      { ...target, workflow_id: 'workflow-b' },
    ).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(root, { ...scope, task_id: 'another-task' }, target).join(' '),
    /different task/,
  );
});
