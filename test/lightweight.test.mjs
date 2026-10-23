import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getRecord, loadRecords } from '../dist/storage.js';
import { initialize } from '../dist/storage.js';
import { managedRun } from '../dist/managed.js';
import { beginWorkflow, workflowStatus, readAutomationPolicy } from '../dist/manager.js';
import { checkpointLightweight, lightweightStatus } from '../dist/lightweight.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createMcpServer, assertGenericRecordMutation } from '../dist/mcp.js';
import { adapterOutputs } from '../dist/adapters.js';
import { vscodeSelection } from '../dist/vscode-policy.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'taskforces-lightweight-'));
  const config = initialize(root, { project_id: 'LIGHT', platforms: ['copilot'] });
  const policy = { ...ensureRoutingPolicy(root), platform: 'copilot', strong_provider: 'copilot',
    worker_provider: 'copilot', worker_models: ['worker-first', 'worker-second'], language_models_file: 'missing-external-catalog.json' };
  writeFileSync(join(root, '.taskforces/routing.json'), JSON.stringify(policy));
  const automation = { ...readAutomationPolicy(root), execution_mode: 'lightweight' };
  writeFileSync(join(root, '.taskforces/automation.json'), JSON.stringify(automation));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config, policy, automation };
}
function checkpoint(workflow, patch = {}) {
  return { workflow_id: workflow.workflow_id, expected_revision: workflow.revision,
    phase: 'execution', risk: 'low', plan: ['Port portable behavior.'], changed_files: ['src/value.ts'],
    checks: [{ command: 'node --test', result: 'passed', output: 'Actual fixture check observation.' }],
    limitations: [], review: { disposition: 'not-needed', reason: 'Low-risk fixture only.' },
    summary: 'Fixture progress.', next_action: 'Finish checks.', ...patch };
}
async function clientFor(t, root, binding) {
  const server = createMcpServer(root, binding);
  const client = new Client({ name: 'lightweight-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const result = response => JSON.parse(response.content[0].text);

test('lightweight intake is idempotent, exact-intent and unsigned; never starts bridge', async t => {
  const { root } = setup(t);
  const input = { requirement: 'Keep portable changes.', request_id: 'same-request' };
  const first = await managedRun(root, input);
  assert.equal(first.handoff.agent, 'Manager Agent');
  assert.match(first.handoff.prompt, /Do not call manager_run recursively/);
  assert.equal(first.invocation, undefined);
  assert.equal(first.workflow.assurance, 'unsigned-native-report');
  const again = await managedRun(root, input);
  assert.equal(again.workflow.workflow_id, first.workflow.workflow_id);
  assert.equal(loadRecords(root).length, 1);
  assert.equal((await managedRun(root, { workflow_id: first.workflow.workflow_id })).workflow.revision, 1);
  await assert.rejects(managedRun(root, { ...input, requirement: 'Different.' }), /different requirement/);
  await assert.rejects(managedRun(root, { workflow_id: first.workflow.workflow_id, requirement: 'Different.' }), /Resumption requirements differ/);
  await assert.rejects(managedRun(root, { workflow_id: first.workflow.workflow_id, execution_mode: 'strict' }), /mode cannot be changed/);
  assert.equal(workflowStatus(root)[0].workflow_id, first.workflow.workflow_id);
});

test('lightweight continuation persists separately from original intent and survives idempotent resumption', async t => {
  const { root } = setup(t);
  const input = { requirement: 'Port portable runtime.', request_id: 'continued-request', message: 'No pipeline or inference.' };
  const first = await managedRun(root, input);
  assert.deepEqual(first.workflow.original_requirements, [input.requirement]);
  assert.deepEqual(first.workflow.continuations, [input.message]);
  assert.ok(first.handoff.prompt.includes(input.message));
  const repeated = await managedRun(root, input);
  assert.equal(repeated.workflow.revision, first.workflow.revision);
  const narrowed = await managedRun(root, { workflow_id: first.workflow.workflow_id, message: 'Implement ONLY two reviewed fixes.' });
  assert.deepEqual(narrowed.workflow.continuations, [input.message, 'Implement ONLY two reviewed fixes.']);
  assert.deepEqual(narrowed.workflow.original_requirements, [input.requirement]);
  assert.equal(narrowed.workflow.revision, first.workflow.revision + 1);
  assert.deepEqual(getRecord(root, first.workflow.workflow_id).meta.data.continuations, narrowed.workflow.continuations);
  const resumed = await managedRun(root, { workflow_id: first.workflow.workflow_id });
  assert.equal(resumed.workflow.revision, narrowed.workflow.revision);
  assert.ok(resumed.handoff.prompt.includes(input.message));
  assert.ok(resumed.handoff.prompt.includes('Implement ONLY two reviewed fixes.'));
  const retried = await managedRun(root, { requirement: input.requirement, request_id: input.request_id });
  assert.equal(retried.handoff.prompt, resumed.handoff.prompt);
  for (const message of ['', '   ', 42, 'x'.repeat(20001)])
    await assert.rejects(managedRun(root, { workflow_id: first.workflow.workflow_id, message }), /Continuation/);
  assert.equal(getRecord(root, first.workflow.workflow_id).meta.revision, narrowed.workflow.revision);
  const completed = checkpointLightweight(root, checkpoint(resumed.workflow, { phase: 'completed' }));
  await assert.rejects(managedRun(root, { workflow_id: completed.workflow_id, message: 'Change completed scope.' }), /immutable/);
  assert.equal(getRecord(root, completed.workflow_id).meta.revision, completed.revision);
});

test('mode validation, disabled manager and saved strict workflows retain their boundaries', async t => {
  const { root, automation } = setup(t);
  await assert.rejects(managedRun(root, { requirement: 'No.', execution_mode: 'unknown' }), /Invalid workflow execution mode/);
  const strict = beginWorkflow(root, { requirement: 'Strict increment.', request_id: 'strict', execution_mode: 'strict' });
  await assert.rejects(managedRun(root, { workflow_id: strict.meta.id, execution_mode: 'lightweight' }), /mode cannot be changed/);
  assert.throws(() => lightweightStatus(strict), /strict workflows cannot be converted/);
  assert.throws(() => checkpointLightweight(root, checkpoint({ workflow_id: strict.meta.id, revision: strict.meta.revision })), /strict workflows/);
  writeFileSync(join(root, '.taskforces/automation.json'), JSON.stringify({ ...automation, manager_enabled: false }));
  await assert.rejects(managedRun(root, { requirement: 'Disabled.' }), /disabled/);
  writeFileSync(join(root, '.taskforces/automation.json'), JSON.stringify({ ...automation, execution_mode: 'unknown' }));
  assert.throws(() => readAutomationPolicy(root), /Invalid manager automation policy/);
});

test('checkpoint validates revision, paths, reports and completion gates; completed reports immutable', async t => {
  const { root } = setup(t);
  const { workflow } = await managedRun(root, { requirement: 'Check gates.' });
  for (const path of ['../escape', '/absolute', 'C:/outside', 'src\\value.ts', 'src//value.ts', 'src/./value.ts'])
    assert.throws(() => checkpointLightweight(root, checkpoint(workflow, { changed_files: [path] })), /canonical project-relative/);
  assert.throws(() => checkpointLightweight(root, checkpoint(workflow, { expected_revision: 0 })), /revision changed/);
  for (const patch of [
    { plan: [] }, { checks: [] }, { checks: [{ command: 'test', result: 'failed', output: 'Failed.' }] },
    { checks: [{ command: 'test', result: 'not-run', output: 'Unavailable.' }] },
    { review: { disposition: 'pending', reason: 'No reviewer.' } },
    { risk: 'elevated' }, { risk: 'strict-required' },
    { review: { disposition: 'completed', reason: 'Failed review.', invocation_id: 'actual-fixture-review', result: 'fail' } },
  ]) assert.throws(() => checkpointLightweight(root, checkpoint(workflow, { phase: 'completed', ...patch })), /Completion needs/);
  assert.throws(() => checkpointLightweight(root, checkpoint(workflow, { review: { disposition: 'completed', reason: 'Missing identity.', result: 'pass' } })), /Actual separate reviewer invocation ID/);
  const saved = checkpointLightweight(root, checkpoint(workflow));
  assert.equal(saved.revision, workflow.revision + 1);
  assert.throws(() => checkpointLightweight(root, checkpoint(workflow)), /revision changed/);
  const completed = checkpointLightweight(root, checkpoint(saved, { phase: 'completed', risk: 'elevated',
    review: { disposition: 'completed', reason: 'Synthetic fixture review, not provider evidence.', invocation_id: 'fixture-separate-review', result: 'pass' } }));
  assert.equal(getRecord(root, completed.workflow_id).meta.status, 'submitted');
  assert.equal(completed.next_action, '');
  assert.throws(() => checkpointLightweight(root, checkpoint(completed)), /immutable/);
  assert.equal((await managedRun(root, { workflow_id: completed.workflow_id })).handoff, undefined);
});

test('unbound MCP exposes lightweight intake/checkpoint without enabling generic mutation or recursive bound intake', async t => {
  const { root } = setup(t);
  const client = await clientFor(t, root);
  const started = result(await client.callTool({ name: 'manager_run', arguments: {
    requirement: 'MCP lightweight request.', requirements: null, execution_mode: 'lightweight', request_id: 'mcp-request',
  } }));
  const response = await client.callTool({ name: 'lightweight_checkpoint', arguments: checkpoint(started.workflow) });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(result(response).revision, 2);
  const generic = await client.callTool({ name: 'record_update', arguments: { id: started.workflow.workflow_id, data: { phase: 'completed' } } });
  assert.equal(generic.isError, true);
  assert.match(result(generic).error, /invocation-bound/);
  assert.throws(() => assertGenericRecordMutation(getRecord(root, started.workflow.workflow_id), { role: 'manager' }), /Reserved workflow/);
  const status = result(await client.callTool({ name: 'manager_status', arguments: { workflow_id: started.workflow.workflow_id } }));
  assert.equal(status.revision, 2);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'lightweight_checkpoint').annotations.readOnlyHint, false);
});

test('generated native manager exposes subagents and MCP checkpoint; built-in Copilot bypasses external catalog', t => {
  const { root, config, policy } = setup(t);
  assert.deepEqual(vscodeSelection(root, 'manager', policy.strong_model), { vendor: 'copilot', id: policy.strong_model });
  const outputs = adapterOutputs(root, config);
  const lightweight = outputs.find(output => output.path === '.github/agents/taskforces-manager.agent.md');
  assert.ok(lightweight);
  assert.ok(lightweight.content.includes(`model: ${JSON.stringify(policy.strong_model)}`));
  assert.match(lightweight.content, /tools: .*agent.*taskforces\/lightweight_checkpoint/);
  assert.match(lightweight.content, /Selected Manager Agent:.*continue the returned handoff.prompt and workflow directly/);
  assert.match(lightweight.content, /Do not launch handoff.agent when it is Manager Agent/);
  const developer = outputs.find(output => output.path === '.github/agents/taskforces-fnd.agent.md');
  assert.ok(developer.content.includes(JSON.stringify(policy.worker_models)));
  const reviewer = outputs.find(output => output.path === '.github/agents/taskforces-reviewer.agent.md');
  assert.ok(reviewer.content.includes(`model: ${JSON.stringify(policy.strong_model)}`));
});

test('CLI resumes and checkpoints file-loaded JSON without PowerShell quoting loss', async t => {
  const { root } = setup(t);
  const { workflow } = await managedRun(root, { requirement: 'Original quoted "intent".', request_id: 'cli' });
  const payload = join(root, 'checkpoint.json');
  writeFileSync(payload, JSON.stringify(checkpoint(workflow)));
  const cli = new URL('../dist/cli.js', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const run = spawnSync(process.execPath, [fileURLToPath(cli), 'workflow', 'checkpoint', workflow.workflow_id,
    '--project', root, '--data', readFileSync(payload, 'utf8')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(JSON.parse(run.stdout).revision, 2);
});
