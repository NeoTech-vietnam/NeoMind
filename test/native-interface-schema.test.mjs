import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment } from '../dist/assignment-runtime.js';
import { createMcpServer } from '../dist/mcp.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-native-interface-'));
  initialize(root, { project_id: 'NATIVE-INTERFACE', platforms: ['copilot', 'codex'] });
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function accepted(response) {
  assert.equal(Boolean(response.isError), false, 'The valid interface request must succeed without exposing its private response.');
  return JSON.parse(response.content[0].text);
}
function objectBranch(schema) {
  return schema.type === 'object' ? schema : (schema.anyOf ?? []).find(value => value.type === 'object');
}

test('MCP advertises explicit preparation fields and optional native correlation while preserving read-only parser safeguards', async t => {
  const root = fixture(t), server = createMcpServer(root), client = new Client({ name: 'native-interface-schema', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  const schema = tools.find(tool => tool.name === 'work_prepare').inputSchema.properties.input;
  assert.ok(schema.properties, 'The model must see the accepted work preparation fields instead of an opaque record.');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['request', 'request_id', 'intent_id', 'parameters', 'tags', 'outputs',
    'procedure_id', 'procedure_version', 'environment', 'scope', 'limit'].sort());
  assert.deepEqual(schema.required, ['request']); assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.request.maxLength, 20_000);
  assert.equal(schema.properties.environment.additionalProperties, false);
  assert.equal(schema.properties.scope.additionalProperties, false);
  assert.equal(schema.properties.scope.properties.network.type, 'boolean');
  assert.equal(schema.properties.outputs.maxItems, 100);
  assert.equal(schema.properties.limit.minimum, 1); assert.equal(schema.properties.limit.maximum, 100);
  const next = tools.find(tool => tool.name === 'workflow_next').inputSchema;
  const observation = objectBranch(next.properties.observation);
  assert.deepEqual(observation.required.sort(), ['state', 'observation_id'].sort());
  assert.equal(observation.additionalProperties, false);
  const call = input => client.callTool({ name: 'work_prepare', arguments: { input } });
  for (const input of [
    { request: 'Inspect existing scripts for reuse.', workflow_id: 'must-not-be-an-input' },
    { request: 'Inspect existing scripts for reuse.', environment: { workflow_id: 'foreign' } },
    { request: 'Inspect existing scripts for reuse.', scope: { network: 'yes' } },
    { request: ' \t ' },
    { request: 'Inspect existing scripts for reuse.', procedure_version: '1.0.0' },
    { request: 'Inspect existing scripts for reuse.', parameters: { payload: 'x'.repeat(256_001) } },
  ]) assert.equal((await call(input)).isError, true);
  assert.equal(existsSync(join(root, '.neomind/cache/procedures.sqlite')), false, 'Invalid requests must fail before index creation.');
  const request = '  Inspect MixedCase --KeepCase=Value scripts for reuse.  ';
  const parameters = { flag: '--KeepCase=Value', nested: { label: 'MiXeD' } };
  const input = { request, request_id: 'stable-interface-request', parameters,
    environment: { client: 'copilot', tools: { compiler: 'ObservedVersion' } }, scope: { network: false, publication: false }, limit: 1 };
  const prepared = accepted(await call(input));
  assert.equal(prepared.original_request, request); assert.deepEqual(prepared.parameters, parameters);
  assert.equal(prepared.request_id, input.request_id); assert.equal(prepared.execution_authorized, false);
  assert.equal(accepted(await call(input)).context_digest, prepared.context_digest);
});

test('prepared Local Copilot handoffs supply exact native arguments without model overrides or persisted credentials', t => {
  const root = fixture(t);
  const workflow = beginWorkflow(root, { requirement: 'Review the actual bounded software plan through the exact installed native agent.', execution_mode: 'copilot-native' });
  const input = { workflow_id: workflow.meta.id, profile_id: 'reviewer', role: 'reviewer', assignment_id: 'exact-native-reviewer',
    objective: 'Independently inspect the saved software contract and report actual bounded findings with supporting evidence.' };
  const packet = prepareReportedAssignment(root, input), call = packet.handoff.native_call;
  assert.ok(call, 'A prepared Copilot specialist needs an exact ready-to-copy native call.');
  assert.equal(call.tool, 'runSubagent'); assert.equal(call.arguments.agentName, 'NeoMind Reviewer Agent');
  assert.equal(call.arguments.description, 'NeoMind reviewer assignment');
  assert.equal(call.arguments.prompt === packet.handoff.prompt, true, 'The private prompt must remain unchanged.');
  assert.deepEqual(Object.keys(call.arguments).sort(), ['agentName', 'description', 'prompt']);
  const stored = JSON.parse(readFileSync(join(root, '.neomind/native/reported-assignments', `${packet.id}.json`), 'utf8'));
  for (const field of ['claim_token', 'token', 'open_input', 'handoff', 'native_call']) assert.equal(Object.hasOwn(stored, field), false);
  openAssignment(root, packet.open_input);
  assert.equal(prepareReportedAssignment(root, input).handoff.native_call, undefined, 'A claimed legacy packet cannot advertise a fresh launch.');
  const manager = prepareReportedAssignment(root, { ...input, profile_id: 'coordinator', role: 'manager', assignment_id: 'own-coordinator' });
  assert.equal(manager.handoff.native_call, undefined, 'The actual Coordinator continues here instead of spawning itself.');
  const codex = beginWorkflow(root, { requirement: 'Preserve the separate local Codex native dispatch contract.', execution_mode: 'codex-native' });
  const codexPacket = prepareReportedAssignment(root, { ...input, workflow_id: codex.meta.id, assignment_id: 'codex-reviewer' });
  assert.equal(codexPacket.handoff.native_call, undefined); assert.equal(codexPacket.handoff.agent, 'neomind-reviewer');
});
