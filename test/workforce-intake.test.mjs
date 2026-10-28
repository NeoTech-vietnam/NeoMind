import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, createRecord, safePath, hash, atomicWrite } from '../dist/storage.js';
import { installProject } from '../dist/installer.js';
import { createMcpServer } from '../dist/mcp.js';
import { agentProfiles } from '../dist/agent-profiles.js';
import { requestSetupStatus, requestStatus, requestSubmit, workForceIntakeContext } from '../dist/workforce-requests.js';
import { serveHost } from '../dist/vscode-wire.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { prepareWorkForceIntake, recordWorkForceAdmission } from '../dist/workforce-intake.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-intake-'));
  initialize(root, { platforms: ['copilot', 'codex'] });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function connection(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'workforce-intake-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
test('fresh WorkForce exposes exactly six named profiles and three content-only entrypoint tools', async t => {
  const root = project(t); installProject(root);
  assert.deepEqual(agentProfiles.map(profile => profile.name), ['WF.PM', 'WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']);
  const policy = JSON.parse(readFileSync(safePath(root, '.workforce/routing.json')));
  assert.equal(policy.strong_model, 'top-models'); assert.deepEqual(policy.worker_models, ['worker-models']);
  assert.equal(policy.strong_provider, 'customendpoint');
  const pm = readFileSync(join(root, '.github/agents/workforce-pm.agent.md'), 'utf8');
  assert.match(pm, /name: "WF.PM"/); assert.match(pm, /workforce\/request_submit/);
  assert.doesNotMatch(pm, /assignment_claim|assignment_open|manager_run|reported_assignment/);
  const config = readFileSync(join(root, '.codex/config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers.workforce\]/); assert.doesNotMatch(config, /manager_run|approval_policy|sandbox_mode/);
  const client = await connection(t, root), names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['request_control', 'request_status', 'request_submit']);
  assert.deepEqual(JSON.parse((await client.callTool({ name: 'request_status', arguments: {} })).content[0].text), { requests: [] });
  assert.equal(requestSetupStatus(root).ready, false, 'discovery/configuration does not establish a working model tool call');
});
test('ordinary requirement and resolved context cross one intake, with a compact receipt and no runtime journal', async t => {
  const root = project(t); ensureRoutingPolicy(root);
  mkdirSync(join(root, 'course'));
  const seen = [], accepted = new Map();
  const host = await serveHost(root, async (operation, input) => {
    assert.equal(operation, 'controlled-start'); seen.push(input);
    if (accepted.has(input.request_id)) return accepted.get(input.request_id);
    const parent = createRecord(root, { type: 'knowledge', title: 'Workflow: Ordinary user request',
      data: { kind: 'manager-workflow', request_id: input.request_id, execution_mode: 'neomind-controlled',
        original_requirement: input.requirement, original_requirements: [input.requirement] } });
    const run = { schema_version: 1, workflow_id: parent.meta.id, epoch_id: randomUUID(), request_id: input.request_id,
      process_contract: 'workforce/v1', transport: 'opencode', status: 'queued', phase: 'intake', revision: 1,
      title: parent.meta.title, requirement: input.requirement, owner_pid: process.pid, owner_instance: host.instance,
      updated_at: new Date().toISOString(), attempts: [], checks: [], events: [{ summary: 'PRIVATE_INTERNAL_JOURNAL' }], repairs: 0, active_invocations: [] };
    atomicWrite(safePath(root, `.workforce/controlled/workflows/${hash(parent.meta.id)}.json`), JSON.stringify(run));
    accepted.set(input.request_id, run);
    return run;
  });
  t.after(() => host.close());
  const client = await connection(t, root), requirement = 'I want a new LeetCode exercise and a Cornell note.';
  const response = await client.callTool({ name: 'request_submit', arguments: { requirement, title: '  ', context: [{ path: 'course', kind: 'directory' }] } });
  assert.ok(!response.isError); const value = JSON.parse(response.content[0].text);
  assert.equal(seen.length, 1); assert.equal(seen[0].requirement, requirement);
  assert.equal(seen[0].title, undefined);
  assert.deepEqual(seen[0].context, [{ path: 'course', kind: 'directory' }]);
  assert.match(value.request_key, /^WF-R0001$/); assert.equal(value.status, 'queued'); assert.equal(value.accepted, false);
  assert.ok(!('events' in value)); assert.ok(!('attempts' in value)); assert.ok(!('requirement' in value));
  // The first reply is deliberately discarded by this caller. A fresh MCP
  // connection retries without an ID and must recover the durable admission.
  const restarted = await connection(t, root);
  const retry = JSON.parse((await restarted.callTool({ name: 'request_submit', arguments: { requirement,
    context: [{ path: pathToFileURL(join(root, 'course')).href }] } })).content[0].text);
  assert.equal(retry.workflow_id, value.workflow_id); assert.equal(retry.request_id, value.request_id);
  assert.equal(accepted.size, 1); assert.equal(seen.length, 2);
  const status = requestStatus(root, value.request_key);
  assert.equal(status.request_id, value.request_id); assert.ok(!('events' in status)); assert.ok(!('checks' in status));
  const saved = accepted.get(value.request_id);
  saved.status = 'waiting'; saved.dependency_wait = { code: 'provider', attempts: 1, next_condition_check_at: '2026-10-28T12:00:00.000Z' };
  saved.blocker = { code: 'WORKFORCE_OPERATIONAL_INCIDENT', kind: 'environment', owner: 'runtime', message: 'Provider unavailable.' };
  const save = () => atomicWrite(safePath(root, `.workforce/controlled/workflows/${hash(saved.workflow_id)}.json`), JSON.stringify(saved));
  save();
  const waiting = requestStatus(root, value.request_key);
  assert.deepEqual(waiting.dependency_wait, saved.dependency_wait); assert.equal(waiting.runtime_health.state, 'waiting');
  assert.match(waiting.current_action, /runtime will check again/); assert.equal(waiting.question, undefined);
  saved.status = 'paused'; save();
  const paused = requestStatus(root, value.request_key);
  assert.equal(paused.dependency_wait, undefined); assert.match(paused.current_action, /Paused/);
});

test('backend resolves actual attachment types and rejects outside paths before dispatch', t => {
  const root = project(t); mkdirSync(join(root, 'course')); writeFileSync(join(root, 'course/note.md'), 'Source context.');
  for (const path of ['course/note.md', join(root, 'course/note.md'), pathToFileURL(join(root, 'course/note.md')).href])
    assert.deepEqual(workForceIntakeContext(root, [{ path, kind: 'directory' }]), [{ path: 'course/note.md', kind: 'file' }]);
  assert.throws(() => workForceIntakeContext(root, [{ path: '../outside.md' }]), /inside this project/);
  assert.throws(() => workForceIntakeContext(root, [{ path: 'missing.md' }]));
  assert.throws(() => workForceIntakeContext(root, [{ path: '.workforce/config.json' }]), /public project source/);
  for (const path of ['.', root, pathToFileURL(root).href])
    assert.deepEqual(workForceIntakeContext(root, [{ path }]), [{ path: '.', kind: 'directory' }]);
});

test('invalid empty requirements are rejected before a durable admission or owner dispatch', async t => {
  const root = project(t), path = safePath(root, '.workforce/controlled/request-admissions.json');
  for (const input of [{ requirement: '   ' }, {}, { requirement: 'One request', requirements: ['Another request'] }]) {
    await assert.rejects(requestSubmit(root, input));
    assert.equal(existsSync(path), false);
  }
});

test('a fresh identical user request has a new admission while lost-reply retries preserve the current intent', t => {
  const root = project(t), input = { requirement: 'Create the next LeetCode exercise with a Cornell note.' };
  const first = prepareWorkForceIntake(root, input, true);
  recordWorkForceAdmission(root, first.request_id, 'completed-history-with-no-status-query');
  assert.equal(prepareWorkForceIntake(root, input).request_id, first.request_id);
  const next = prepareWorkForceIntake(root, input, true);
  assert.notEqual(next.request_id, first.request_id);
  assert.equal(prepareWorkForceIntake(root, input).request_id, next.request_id);
});
