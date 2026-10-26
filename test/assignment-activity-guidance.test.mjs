import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { createMcpServer } from '../dist/mcp.js';
import { readAgentActivity } from '../dist/agent-activity.js';
import { nativeActivityInstructions } from '../dist/agent-profiles.js';

function accepted(response) {
  assert.ok(!response.isError, 'The scoped operation must succeed without exposing its private response.');
  return JSON.parse(response.content[0].text);
}

test('opened local assignments use derived progress instead of rebuilding raw activity identity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-activity-guidance-'));
  initialize(root, { project_id: 'ACTIVITY-GUIDANCE', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: 'Inspect existing exercise scripts and report progress without guessing assignment identity.', execution_mode: 'copilot-native' });
  const server = createMcpServer(root), client = new Client({ name: 'activity-guidance-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => {
    await client.close(); await server.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const managerPacket = accepted(await call('assignment_bootstrap', { workflow_id: workflow.meta.id,
    profile_id: 'coordinator', role: 'manager', assignment_id: 'coordinator-resume-20261024',
    objective: 'Coordinate the existing bounded inspection and preserve actual specialist identities.' }));
  const manager = accepted(await call('assignment_open', managerPacket.open_input));
  const explorerPacket = accepted(await call('assignment_prepare', { reported_assignment: manager.handle,
    workflow_id: workflow.meta.id, profile_id: 'explorer', role: 'codebase-analyst',
    assignment_id: 'leetcode-tooling-inspection-recovery',
    objective: 'Inspect existing exercise tooling and return actual findings without creating a producer task.' }));
  const explorer = accepted(await call('assignment_open', explorerPacket.open_input));

  await t.test('the observed Coordinator impersonation and correlation errors stay refused with a safe correction', async () => {
    const count = readAgentActivity(root).events.length;
    for (const fields of [
      { profile_id: 'explorer', assignment_id: explorerPacket.assignment_id, invocation_id: explorer.handle.id },
      { profile_id: 'coordinator', assignment_id: managerPacket.assignment_id },
    ]) {
      const response = await call('agent_activity', { reported_assignment: manager.handle,
        workflow_id: workflow.meta.id, ...fields, task_id: workflow.meta.data.requirement_id,
        state: 'running', summary: 'Reporting the observed local assignment progress.' });
      assert.equal(response.isError, true);
      const message = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.match(message, /Reported activity must use its assigned profile/);
      assert.match(message, /assignment_progress/, 'Identity refusal should name the existing safe progress operation.');
      assert.equal(message.includes(manager.handle.token) || message.includes(explorer.handle.token), false);
    }
    assert.equal(readAgentActivity(root).events.length, count);
  });

  await t.test('Coordinator progress derives its reserved key rather than its preparation label', async () => {
    const event = accepted(await call('assignment_progress', { reported_assignment: manager.handle,
      state: 'running', summary: 'Coordinating the bounded tooling inspection.' }));
    assert.equal(event.profile_id, 'coordinator');
    assert.equal(event.assignment_id, 'coordinator');
    assert.equal(event.invocation_id, manager.handle.id);
    assert.equal(event.task_id, undefined, 'An unassigned requirement must not become a task ID.');
  });

  await t.test('Explorer progress derives its own identity and never needs null task placeholders', async () => {
    const event = accepted(await call('assignment_progress', { reported_assignment: explorer.handle,
      state: 'running', summary: 'Inspecting actual reusable scripts in the assigned scope.' }));
    assert.equal(event.profile_id, 'explorer');
    assert.equal(event.assignment_id, explorerPacket.assignment_id);
    assert.equal(event.invocation_id, explorer.handle.id);
    assert.equal(event.task_id, undefined);
  });

  await t.test('opened context advertises the existing minimal progress contract', async () => {
    for (const opened of [manager, explorer]) {
      assert.equal(opened.context.progress_contract?.tool, 'assignment_progress');
      assert.deepEqual(opened.context.progress_contract?.required, ['reported_assignment', 'state', 'summary']);
      assert.deepEqual(opened.context.progress_contract?.derived,
        ['workflow_id', 'profile_id', 'assignment_id', 'invocation_id', 'task_id']);
    }
  });

  await t.test('private handoffs and shared instructions select handle-derived activity', () => {
    for (const packet of [managerPacket, explorerPacket]) assert.ok(packet.handoff.prompt.includes('assignment_progress'),
      'The private handoff must select derived progress without printing its credentials.');
    assert.match(nativeActivityInstructions, /automatically record advisory lifecycle/);
    assert.match(nativeActivityInstructions, /assignment_progress is optional/);
    assert.doesNotMatch(nativeActivityInstructions, /at least every two minutes/);
    assert.doesNotMatch(nativeActivityInstructions, /Each specialist calls agent_activity with its supplied packet/);
  });

  await t.test('composed curator and release roles are not directed to publish manager activity', async () => {
    const count = readAgentActivity(root).events.length;
    for (const role of ['curator', 'release']) {
      const packet = accepted(await call('assignment_prepare', { reported_assignment: manager.handle,
        workflow_id: workflow.meta.id, profile_id: 'coordinator', role,
        assignment_id: `${role}-bounded-specialist`,
        objective: 'Return only the assigned specialist findings without replacing actual Coordinator progress.' }));
      const opened = accepted(await call('assignment_open', packet.open_input));
      assert.equal(opened.context.progress_contract, null);
      assert.equal(packet.handoff.prompt.includes('report your own progress with assignment_progress'), false);
      const response = await call('assignment_progress', { reported_assignment: opened.handle,
        state: 'running', summary: 'Attempting to report a composed specialist as the actual Coordinator.' });
      assert.equal(response.isError, true);
      const message = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.ok(message.includes('assignment_result') && !message.includes('Use assignment_progress'),
        'Composed specialists must receive a supported correction instead of another refused telemetry call.');
    }
    assert.equal(readAgentActivity(root).events.length, count);
  });
});
