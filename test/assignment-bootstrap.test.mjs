import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, loadRecords } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { createMcpServer } from '../dist/mcp.js';
import { readAgentActivity } from '../dist/agent-activity.js';

function payload(response) { return JSON.parse(response.content[0].text); }
function accepted(response) {
  assert.equal(response.isError, undefined, 'The actual MCP operation must succeed.');
  return payload(response);
}
function refused(response, privateValues) {
  assert.equal(response.isError, true, 'The actual MCP operation must refuse the input.');
  const text = response.content.map(item => item.type === 'text' ? item.text : '').join('\n');
  for (const value of privateValues) assert.equal(text.includes(value), false, 'Error output must not expose a private assignment token.');
  return text;
}

test('MCP bootstrap separates claim packets from private access handles and preserves refusal side effects', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-assignment-bootstrap-'));
  initialize(root, { project_id: 'ASSIGNMENT-BOOTSTRAP', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, {
    requirement: 'Inspect the existing exercise tooling before planning a bounded reusable generation procedure.',
    execution_mode: 'copilot-native',
  });
  const server = createMcpServer(root);
  const client = new Client({ name: 'assignment-bootstrap-contract-fixture', version: '1' });
  const [caller, host] = InMemoryTransport.createLinkedPair();
  await server.connect(host); await client.connect(caller);
  t.after(async () => {
    await client.close(); await server.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const packet = accepted(await call('assignment_prepare', {
    workflow_id: workflow.meta.id, profile_id: 'explorer', role: 'codebase-analyst',
    assignment_id: 'exercise-tooling-inspection',
    objective: 'Inspect existing exercise scripts and document their actual scope before selecting a reusable procedure.',
  }));
  const packetPath = join(root, `.neomind/native/reported-assignments/${packet.id}.json`);
  const preparedBytes = readFileSync(packetPath, 'utf8');
  const preparedRecordCount = loadRecords(root).length;
  const badHandle = { id: packet.id, token: packet.claim_token };
  const openInput = { packet: { id: packet.id, claim_token: packet.claim_token } };
  const noClaimOrActivity = () => {
    assert.equal(readFileSync(packetPath, 'utf8'), preparedBytes, 'Refusal must not claim or rewrite the prepared assignment.');
    assert.equal(loadRecords(root).length, preparedRecordCount, 'Refusal must not create a work report.');
    assert.equal(existsSync(join(root, '.neomind/runs/agent-activity')), false, 'Refusal must not write physical activity.');
  };

  await t.test('bootstrap schemas authenticate only their own packet and reject unrelated outer keys', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['assignment_open', 'assignment_claim']) {
      const schema = tools.find(tool => tool.name === name).inputSchema;
      assert.equal(Object.hasOwn(schema.properties, 'reported_assignment'), false, `${name} must not advertise a premature access handle.`);
      assert.equal(schema.additionalProperties, false, `${name} must reject unrelated input fields rather than silently stripping them.`);
    }
  });

  await t.test('the confirmed packet-plus-outer-claim-token mistake is rejected before claiming', async () => {
    const response = await call('assignment_open', { ...openInput, reported_assignment: badHandle });
    const text = refused(response, [packet.claim_token]);
    assert.match(text, /unrecognized|unknown|reserved|omit.*reported_assignment/i,
      'Bootstrap must identify the unsupported outer field instead of authenticating it as an access handle.');
    noClaimOrActivity();
    const claimResponse = await call('assignment_claim', {
      assignment_id: packet.id, claim_token: packet.claim_token, reported_assignment: badHandle,
    });
    assert.match(refused(claimResponse, [packet.claim_token]), /unrecognized|unknown|reserved|omit.*reported_assignment/i);
    noClaimOrActivity();
  });

  await t.test('a claim token used as an access handle returns actionable authentication diagnostics', async () => {
    const response = await call('assignment_context', { reported_assignment: badHandle });
    refused(response, [packet.claim_token]);
    const failure = payload(response);
    assert.equal(failure.code, 'AUTH_REQUIRED');
    assert.equal(failure.phase, 'authenticate');
    assert.equal(failure.retryable, false);
    assert.match(failure.next_action, /assignment_open/);
    assert.match(failure.next_action, /omit.*reported_assignment/i);
    noClaimOrActivity();
  });

  const opened = accepted(await call('assignment_open', openInput));
  const handle = opened.handle;
  assert.deepEqual(Object.keys(handle).sort(), ['id', 'token']);
  assert.equal(handle.id, packet.id);
  assert.equal(handle.token === packet.claim_token, false, 'Claim and access credentials must remain distinct.');
  assert.equal(JSON.parse(readFileSync(packetPath, 'utf8')).state, 'claimed');
  const openedEvents = readAgentActivity(root).events;
  assert.equal(openedEvents.length, 1, 'A successful actual open records its derived lifecycle once.');

  await t.test('the returned inner handle derives the actual context and progress scope', async () => {
    const context = accepted(await call('assignment_context', { reported_assignment: handle }));
    assert.equal(context.invocation_id, handle.id);
    assert.equal(context.workflow_id, workflow.meta.id);
    assert.equal(context.assignment_id, packet.assignment_id);
    assert.equal(context.role, 'codebase-analyst');
    const event = accepted(await call('assignment_progress', {
      reported_assignment: handle, state: 'running', summary: 'Inspecting the existing exercise generation entry points.',
    }));
    assert.equal(event.invocation_id, handle.id);
    assert.equal(event.workflow_id, workflow.meta.id);
    assert.equal(event.assignment_id, packet.assignment_id);
    assert.equal(readAgentActivity(root).events.length, openedEvents.length + 1);
  });

  await t.test('opening never converts the claim token into an access token or permits unauthenticated progress', async () => {
    const beforeAssignment = readFileSync(packetPath, 'utf8');
    const beforeEvents = readAgentActivity(root).events;
    const beforeRecords = loadRecords(root).length;
    for (const [name, args] of [
      ['assignment_context', {}],
      ['assignment_progress', { state: 'completed', summary: 'An invalid handle must never manufacture completed activity.' }],
    ]) {
      const response = await call(name, { ...args, reported_assignment: badHandle });
      refused(response, [packet.claim_token, handle.token]);
      const failure = payload(response);
      assert.equal(failure.code, 'AUTH_REQUIRED');
      assert.equal(failure.phase, 'authenticate');
      assert.match(failure.next_action, /assignment_open/);
      assert.match(failure.next_action, /omit.*reported_assignment/i);
    }
    assert.equal(readFileSync(packetPath, 'utf8'), beforeAssignment);
    assert.equal(loadRecords(root).length, beforeRecords);
    assert.deepEqual(readAgentActivity(root).events, beforeEvents, 'Authentication refusal must not add or change activity events.');
    assert.equal(accepted(await call('assignment_context', { reported_assignment: handle })).invocation_id, handle.id);
  });
});
