import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestListForMonitor } from '../dist/workforce-requests.js';
const require = createRequire(import.meta.url);
const { publicStatus, adaptRuntime } = require('../extensions/vscode-model-bridge/controlled-workflows.cjs');

test('read-only V-model snapshots retain saved evidence without reviving a disconnected stage', t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-v-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.workforce', 'controlled', 'workflows');
  mkdirSync(directory, { recursive: true });
  const workflowId = 'WF-KNW-0001';
  const journalPath = join(directory, createHash('sha256').update(workflowId).digest('hex') + '.json');
  const saved = JSON.stringify({
    schema_version: 1, workflow_id: workflowId, request_id: 'request-1', process_contract: 'workforce/v1',
    title: 'Workflow: Sample product', status: 'running', phase: 'implementation', revision: 5,
    updated_at: '2026-11-08T00:00:00Z', attempts: [{ stage: 'implementation', role: 'developer', state: 'running' }],
    checks: [{ evidence_id: 'WF-EVD-0001', title: 'Check sample', log_path: '.workforce/check.log', passed: true, exit_code: 0 }],
  });
  const admissionPath = join(directory, '..', 'request-admissions.json');
  const admission = JSON.stringify({ schema_version: 1, entries: [] });
  writeFileSync(journalPath, saved);
  writeFileSync(admissionPath, admission);

  const [request] = requestListForMonitor(root).requests;
  assert.equal(request.workflow_id, workflowId);
  assert.equal(request.status, 'uncertain');
  assert.equal(request.stages.find(stage => stage.id === 'coding').state, 'uncertain');
  assert.deepEqual(request.evidence, [{ label: 'Check sample', path: '.workforce/check.log', passed: true, exit_code: 0 }]);
  assert.equal(readFileSync(journalPath, 'utf8'), saved);
  assert.equal(readFileSync(admissionPath, 'utf8'), admission);
});

test('request facade adaptation preserves durable execution identities while using the new request APIs', async () => {
  const calls = [], raw = { workflow_id: 'legacy-workflow', request_id: 'uuid', epoch_id: 'epoch', requirement: 'Build it' };
  const runtime = adaptRuntime({ marker: true,
    requestSubmit: async (...args) => { calls.push(['submit', ...args]); return raw; },
    requestStatus: async (...args) => { calls.push(['status', ...args]); return { requests: [raw] }; },
    requestControl: async (...args) => { calls.push(['control', ...args]); return raw; },
  });
  assert.equal(runtime.marker, true);
  assert.equal((await runtime.startControlledWorkflow('root', { requirement: 'Build it' })).epoch_id, 'epoch');
  assert.deepEqual(await runtime.controlledStatus('root'), [raw]);
  await runtime.controlControlledWorkflow('root', { workflow_id: 'legacy-workflow', action: 'resume', answer: 'docs/input.md' });
  assert.deepEqual(calls[2], ['control', 'root', { workflow_id: 'legacy-workflow', request_id: 'legacy-workflow', action: 'resume', answer: 'docs/input.md' }]);
});

test('request projection retains actual products, milestones and pending inputs while stripping private execution payloads', () => {
  const value = publicStatus({ requests: [{ workflow_id: 'WF-1', request_id: 'uuid', request_key: 'WF-R001', folder: '.workforce/requests/WF-R001',
    title: 'Plain request', secret: 'PRIVATE',
    stages: [{ id: 'coding', state: 'repairing', summary: 'Fix boundary cases', token: 'PRIVATE' }],
    artifacts: [{ path: 'output.md', exists: true, state: 'draft', sha256: 'digest', prompt: 'PRIVATE' }],
    criteria: [{ id: 'accept', text: 'Compile under C11', state: 'running', payload: 'PRIVATE' }],
    review: { state: 'pending', summary: 'Awaiting current revision', token: 'PRIVATE' },
    question: { id: 'issued-question', text: 'Where is source?', reason: 'A source is required.', status: 'pending', token: 'PRIVATE' },
    runtime_health: { state: 'repairing', message: 'Retrying provider', token: 'PRIVATE' },
    dependency_wait: { code: 'prerequisite', attempts: 1, next_condition_check_at: '2026-10-28T12:00:00Z', token: 'PRIVATE' },
  }] }).workflows[0];
  assert.equal(value.request_key, 'WF-R001'); assert.equal(value.artifacts[0].sha256, 'digest');
  assert.equal(value.stages[0].state, 'repairing'); assert.equal(value.question.text, 'Where is source?');
  assert.equal(value.question.id, 'issued-question');
  assert.equal(value.dependency_wait.code, 'prerequisite'); assert.equal(value.dependency_wait.attempts, 1);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
});

test('facade active_agents and acceptance revision reach the active UI without internal journal history', () => {
  const value = publicStatus({ workflow_id: 'WF-1', revision: 8, accepted: false,
    active_agents: [{ id: 'active', role: 'developer', state: 'running', requested_model: 'top-models', confirmed_model: 'top-models', provider: 'customendpoint' }],
    events: [{ summary: 'Internal journal history' }],
  }).workflows[0];
  assert.equal(value.active_invocations[0].requested_model, 'top-models'); assert.equal(value.accepted, false); assert.equal(value.revision, 8);
  assert.equal('events' in value, false);
});

test('active extension manifest separates native tools from the historical request entry', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'workforce-model-bridge'); assert.equal(manifest.publisher, 'workforce'); assert.equal(manifest.version, '0.12.1');
  assert.equal(manifest.engines.vscode, '^1.143.0');
  assert.deepEqual(manifest.contributes.languageModelTools.map(tool => tool.name), ['workforce_request',
    'workforce_native_request', 'workforce_native_role', 'workforce_native_prepare', 'workforce_native_control',
    'workforce_native_capabilities',
    'workforce_native_role_swsd', 'workforce_native_role_p_res', 'workforce_native_role_fnd',
    'workforce_native_role_reviewer', 'workforce_native_role_tester']);
  assert.ok(manifest.contributes.commands.some(command => command.command === 'workforce.pm.openLocal'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'workforce.monitor.legacy'));
  assert.equal(manifest.contributes.commands.some(command => command.command.includes('workflows.open')), false);
});
