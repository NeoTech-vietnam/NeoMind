import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, loadRecords } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { createMcpServer } from '../dist/mcp.js';
import { readAgentActivity } from '../dist/agent-activity.js';

const objective = 'Inspect existing exercise tooling and preserve its actual scope before selecting a reusable procedure.';
function parsed(response) { return JSON.parse(response.content[0].text); }
function accepted(response) {
  assert.equal(response.isError, undefined, 'The requested MCP fixture operation must succeed.');
  return parsed(response);
}
function refused(response, secrets = []) {
  assert.equal(response.isError, true, 'The operation must be refused.');
  const message = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  for (const secret of secrets) assert.equal(message.includes(secret), false, 'Refusals must not expose packet or access credentials.');
  return message;
}

test('VS Code Local assignment setup and saved-packet recovery supply real handoffs without credentials on bootstrap', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-local-handoff-'));
  initialize(root, { project_id: 'LOCAL-HANDOFF', profile: 'software', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: objective, execution_mode: 'copilot-native' });
  const other = beginWorkflow(root, { requirement: 'Keep a separate native increment isolated during recovery.', execution_mode: 'codex-native' });
  const strict = beginWorkflow(root, { requirement: 'Preserve signed invocation requirements during assignment recovery.', execution_mode: 'strict' });
  const server = createMcpServer(root), client = new Client({ name: 'local-handoff-contract-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => {
    await client.close(); await server.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const directory = join(root, '.neomind/native/reported-assignments');
  const packetBytes = id => readFileSync(join(directory, `${id}.json`), 'utf8');
  const metadata = (id, profile = 'explorer', role = 'codebase-analyst', workflowId = workflow.meta.id) => ({
    workflow_id: workflowId, profile_id: profile, role, assignment_id: id, objective,
  });
  const tools = (await client.listTools()).tools;
  await t.test('initial setup and recovery advertise no premature access credential', () => {
    for (const name of ['assignment_bootstrap', 'assignment_recover']) {
      const schema = tools.find(item => item.name === name)?.inputSchema;
      assert.ok(schema, 'A credential-free setup/recovery tool must be available.');
      assert.equal(Object.hasOwn(schema.properties, 'reported_assignment'), false);
      assert.equal(schema.additionalProperties, false);
    }
  });
  if (!tools.some(item => item.name === 'assignment_bootstrap') || !tools.some(item => item.name === 'assignment_recover')) return;

  await t.test('the screenshot label and empty token receive a useful validation refusal before any packet exists', async () => {
    const before = loadRecords(root).length;
    const response = await call('assignment_claim', { assignment_id: 'explorer-recovery-0062', claim_token: '' });
    const message = refused(response);
    assert.match(message, /packet\.id|server-issued|assignment_prepare|Coordinator/i);
    assert.match(message, /claim.token|claim_token/i);
    assert.equal(existsSync(directory), false, 'A malformed claim must not create an issuer or assignment.');
    assert.equal(loadRecords(root).length, before);
    assert.equal(readAgentActivity(root).events.length, 0);
  });

  let coordinator;
  await t.test('Local Coordinator gets its own exact opening input without supplying or inventing any credential', async () => {
    coordinator = accepted(await call('assignment_bootstrap', { ...metadata('coordinator-resume', 'coordinator', 'manager'), task_id: null }));
    assert.equal(coordinator.state, 'prepared');
    assert.match(coordinator.id, /^local-report-[a-f0-9]{40}$/);
    assert.match(coordinator.claim_token, /^[a-f0-9]{64}$/);
    assert.deepEqual(coordinator.open_input, { packet: { id: coordinator.id, claim_token: coordinator.claim_token } });
    assert.equal(Boolean(JSON.parse(packetBytes(coordinator.id)).task_id), false);
    assert.equal(packetBytes(coordinator.id).includes(coordinator.claim_token), false, 'Saved assignment metadata must not contain its claim secret.');
    assert.equal(coordinator.handoff.agent, 'NeoMind Coordinator Agent');
    assert.ok(coordinator.handoff.prompt.includes(coordinator.id));
    assert.ok(coordinator.handoff.prompt.includes(coordinator.claim_token));
    assert.match(coordinator.handoff.prompt, /assignment_open/);
  });
  if (!coordinator) return;
  const coordinatorSession = accepted(await call('assignment_open', coordinator.open_input));
  assert.equal(accepted(await call('assignment_context', { reported_assignment: coordinatorSession.handle })).role, 'manager');

  await t.test('credential-free bootstrap cannot reissue an already claimed Coordinator packet', async () => {
    const before = packetBytes(coordinator.id);
    refused(await call('assignment_bootstrap', { ...metadata('coordinator-resume', 'coordinator', 'manager'), task_id: '' }), [coordinator.claim_token, coordinatorSession.handle.token]);
    assert.equal(packetBytes(coordinator.id), before);
  });

  let explorer;
  await t.test('the authenticated Coordinator still prepares compatible worker handoffs through the existing interface', async () => {
    explorer = accepted(await call('assignment_prepare', { ...metadata('inspect-existing-tooling'), reported_assignment: coordinatorSession.handle }));
    assert.equal(explorer.handoff.agent, 'NeoMind Explorer Agent');
    assert.equal(explorer.state, 'prepared');
    assert.ok(explorer.handoff.prompt.includes(workflow.meta.id));
    assert.ok(explorer.handoff.prompt.includes(objective));
    assert.ok(explorer.handoff.prompt.includes(explorer.id));
    assert.ok(explorer.handoff.prompt.includes(explorer.claim_token));
    assert.deepEqual(explorer.open_input, { packet: { id: explorer.id, claim_token: explorer.claim_token } });
  });
  if (!explorer) return;
  const initialPacket = packetBytes(explorer.id), issuerPath = join(directory, 'issuer.key');
  const issuerBytes = readFileSync(issuerPath), initialRecords = loadRecords(root).length;
  const initialEvents = readAgentActivity(root).events;

  await t.test('a new session recovers an unclaimed saved packet without stored tokens or any state rewrite', async () => {
    const recovered = accepted(await call('assignment_recover', { workflow_id: workflow.meta.id, packet_id: explorer.id }));
    assert.equal(recovered.id, explorer.id);
    assert.equal(recovered.claim_token, explorer.claim_token);
    assert.deepEqual(recovered.open_input, explorer.open_input);
    assert.deepEqual(recovered.handoff, explorer.handoff);
    assert.equal(packetBytes(explorer.id), initialPacket);
    assert.deepEqual(readFileSync(issuerPath), issuerBytes);
    assert.equal(loadRecords(root).length, initialRecords);
    assert.deepEqual(readAgentActivity(root).events, initialEvents, 'Recovering a prepared packet adds no lifecycle observation beyond actual prior opens.');
  });

  await t.test('recovery refuses a packet from another workflow and refuses closed or strict work', async () => {
    refused(await call('assignment_recover', { workflow_id: other.meta.id, packet_id: explorer.id }), [explorer.claim_token]);
    refused(await call('assignment_bootstrap', metadata('strict-refusal', 'explorer', 'codebase-analyst', strict.meta.id)));
    refused(await call('assignment_recover', { workflow_id: strict.meta.id, packet_id: explorer.id }), [explorer.claim_token]);
    const closing = beginWorkflow(root, { requirement: 'Preserve a closed workflow and its prepared assignment history.', execution_mode: 'copilot-native' });
    const pending = accepted(await call('assignment_bootstrap', metadata('closed-refusal', 'explorer', 'codebase-analyst', closing.meta.id)));
    const pendingBytes = packetBytes(pending.id);
    // Fixture setup only: the autonomous-cycle test establishes real closure
    // through manager_finish. Keep this test focused on stored closed-state refusal.
    const closingPath = join(root, closing.path), closingBytes = readFileSync(closingPath, 'utf8');
    assert.match(closingBytes, /^  phase: /m);
    writeFileSync(closingPath, closingBytes.replace(/^  phase: .+$/m, '  phase: completed'));
    refused(await call('assignment_recover', { workflow_id: closing.meta.id, packet_id: pending.id }), [pending.claim_token]);
    assert.equal(packetBytes(pending.id), pendingBytes);
    assert.equal(packetBytes(explorer.id), initialPacket);
  });

  await t.test('missing issuer never causes credential recovery to create or rotate a key', async () => {
    const held = `${issuerPath}.fixture-held`;
    for (const path of [issuerPath, held]) {
      const child = relative(root, path);
      assert.equal(isAbsolute(child) || child.startsWith('..'), false);
    }
    renameSync(issuerPath, held);
    try {
      refused(await call('assignment_recover', { workflow_id: workflow.meta.id, packet_id: explorer.id }));
      assert.equal(existsSync(issuerPath), false);
      assert.equal(packetBytes(explorer.id), initialPacket);
      assert.deepEqual(readFileSync(held), issuerBytes);
    } finally { renameSync(held, issuerPath); }
  });

  await t.test('Codex receives its actual native profile name and blank optional task bindings are omitted', async () => {
    const packet = accepted(await call('assignment_bootstrap', { ...metadata('codex-inspection', 'explorer', 'codebase-analyst', other.meta.id), task_id: '' }));
    assert.equal(packet.handoff.agent, 'neomind-explorer');
    assert.equal(Boolean(JSON.parse(packetBytes(packet.id)).task_id), false);
    const session = accepted(await call('assignment_open', packet.open_input));
    assert.equal(accepted(await call('assignment_context', { reported_assignment: session.handle })).workflow_id, other.meta.id);
  });

  await t.test('only the actual opening step claims the recovered packet and permits scoped reports', async () => {
    const recovered = accepted(await call('assignment_recover', { workflow_id: workflow.meta.id, packet_id: explorer.id }));
    const session = accepted(await call('assignment_open', recovered.open_input));
    const context = accepted(await call('assignment_context', { reported_assignment: session.handle }));
    assert.equal(context.role, 'codebase-analyst');
    assert.equal(context.workflow_id, workflow.meta.id);
    assert.equal(JSON.parse(packetBytes(explorer.id)).state, 'claimed');
    const before = packetBytes(explorer.id);
    refused(await call('assignment_recover', { workflow_id: workflow.meta.id, packet_id: explorer.id }), [explorer.claim_token, session.handle.token]);
    refused(await call('assignment_bootstrap', metadata('inspect-existing-tooling')), [explorer.claim_token, session.handle.token]);
    assert.equal(packetBytes(explorer.id), before);
    const result = accepted(await call('assignment_result', { reported_assignment: session.handle, result: {
      schema_version: 1, outcome: 'completed',
      summary: 'Inspected the actual assignment recovery contract and confirmed its scoped MCP context without claiming model inference.',
      inputs: ['Read the prepared packet, generated opening input and actual returned context in this isolated MCP fixture.'],
      decisions: [{ decision: 'Use the server-generated opening input and retain the actual returned access handle.', basis: 'Saved packet metadata excludes its claim secret, while the existing issuer can reissue a still-unclaimed packet.' }],
      evidence_refs: [], evidence_notes: ['Actual MCP responses and on-disk packet bytes were inspected; this test does not launch a native model.'],
      limitations: ['The fixture exercises runtime contracts and cannot establish native editor delegation or independent model execution.'],
      lessons: ['Reuse generated packet handoffs and explicit recovery rather than reconstructing credentials from descriptive assignment labels.'],
    } }));
    assert.ok(loadRecords(root).some(record => record.meta.id === result.report_id && record.meta.owner === 'codebase-analyst'));
  });
});
