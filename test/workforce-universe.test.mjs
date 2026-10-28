import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { publicStatus, adaptRuntime } = require('../extensions/vscode-model-bridge/controlled-workflows.cjs');

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

test('active extension manifest exposes one request tool and the WorkForce entry points', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'workforce-model-bridge'); assert.equal(manifest.publisher, 'workforce'); assert.equal(manifest.version, '0.12.0');
  assert.equal(manifest.engines.vscode, '^1.143.0');
  assert.deepEqual(manifest.contributes.languageModelTools.map(tool => tool.name), ['workforce_request']);
  assert.ok(manifest.contributes.commands.some(command => command.command === 'workforce.pm.openLocal'));
  assert.equal(manifest.contributes.commands.some(command => command.command.includes('workflows.open')), false);
});
