import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parse as parseYaml } from 'yaml';
import { initialize, createRecord, getRecord, hash } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { managedRun } from '../dist/managed.js';
import { createMcpServer } from '../dist/mcp.js';
import { installProject } from '../dist/installer.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const profileIds = ['coordinator', 'explorer', 'researcher', 'planner', 'architect',
  'implementer', 'debugger', 'verifier', 'reviewer'];

function project(t) {
  const base = mkdtempSync(join(tmpdir(), 'neomind activity mcp-'));
  const root = join(base, 'project'), elsewhere = join(base, 'caller elsewhere');
  mkdirSync(elsewhere);
  initialize(root, { project_id: 'ACTIVITY-MCP', platforms: ['copilot'] });
  ensureRoutingPolicy(root);
  t.after(() => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert.ok(base.startsWith(join(tmpdir(), 'neomind activity mcp-')));
    rmSync(base, { recursive: true, force: true });
  });
  return { root, elsewhere };
}

async function connect(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'activity-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

function payload(response) {
  const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); }
  catch { return { error: text }; }
}

async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, payload(response).error);
  return payload(response);
}

// Activity files are the sole permitted change: records, policies, installed files,
// receipt storage and every other existing byte must survive both APIs unchanged.
function protectedInventory(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === '.neomind/runs/agent-activity') return [];
      assert.equal(entry.isSymbolicLink(), false);
      return entry.isDirectory() ? protectedInventory(root, path)
        : [[path, hash(readFileSync(join(root, path)))]];
    });
}

async function workflow(root, mode, request = mode) {
  const result = await managedRun(root, {
    requirement: `Inspect local activity behavior for ${request}.`, request_id: request, execution_mode: mode,
  });
  assert.equal(result.invocation, undefined, 'The fixture performs no model inference.');
  assert.equal(result.handoff.agent, 'NeoMind Coordinator Agent');
  return result;
}

test('MCP advertises unsigned activity as a local mutation and the map as a read-only projection', async t => {
  const { root } = project(t), client = await connect(t, root);
  const tools = (await client.listTools()).tools;
  const activity = tools.find(tool => tool.name === 'agent_activity');
  assert.ok(activity, 'Native clients can discover the activity writer.');
  assert.equal(activity.annotations.readOnlyHint, false);
  assert.equal(activity.annotations.destructiveHint, false);
  assert.equal(activity.annotations.openWorldHint, false);
  assert.equal(tools.find(tool => tool.name === 'agent_map').annotations.readOnlyHint, true);
  assert.deepEqual(new Set(activity.inputSchema.required),
    new Set(['workflow_id', 'assignment_id', 'profile_id', 'state', 'summary']));
  assert.deepEqual(new Set(activity.inputSchema.properties.profile_id.enum), new Set(profileIds));
  assert.equal(existsSync(join(root, '.neomind/runs/agent-activity')), false);
});

for (const mode of ['copilot-native', 'lightweight']) {
  test(`MCP ${mode} activity reaches the universe before final reports and preserves engineering state`, async t => {
    const { root } = project(t), run = await workflow(root, mode), client = await connect(t, root);
    const workflowId = run.workflow.workflow_id;
    assert.ok(workflowId);
    const before = protectedInventory(root), original = getRecord(root, workflowId);
    const input = { workflow_id: workflowId, assignment_id: 'trace-entrypoints', profile_id: 'explorer',
      summary: 'Trace entrypoint ownership', invocation_id: 'actual-client-session-fixture' };
    const dispatched = await call(client, 'agent_activity', { ...input, state: 'dispatched' });
    assert.match(dispatched.id, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(dispatched.observed_at)));
    assert.equal(dispatched.source, 'native-activity');
    assert.equal(dispatched.execution_mode, 'unsigned-native-progress');
    assert.equal(dispatched.role, 'codebase-analyst');
    assert.equal(dispatched.signature, undefined);
    const id = `progress:${workflowId}:${input.assignment_id}`;
    const waiting = await call(client, 'agent_map');
    assert.equal(waiting.nodes.find(node => node.id === id).state, 'waiting', 'Dispatch is not a claim of execution.');
    const running = await call(client, 'agent_activity', { ...input, state: 'running' });
    const active = await call(client, 'agent_map');
    const node = active.nodes.find(node => node.id === id);
    assert.ok(node, 'A real MCP activity call projects before an assignment report exists.');
    assert.equal(node.kind, 'agent');
    assert.equal(node.label, 'NeoMind Explorer Agent');
    assert.equal(node.profile_id, 'explorer');
    assert.equal(node.role, 'codebase-analyst');
    assert.equal(node.state, 'running');
    assert.equal(node.source, 'native-activity');
    assert.equal(node.source_id, running.id);
    assert.equal(node.reported_at, running.observed_at);
    assert.equal(node.expired, false);
    assert.equal(node.confirmed_model, null);
    assert.equal(node.requested_model, null);
    assert.equal(node.provider, null);
    assert.equal(node.execution_mode, 'unsigned-native-progress');
    assert.ok(active.edges.some(edge => edge.kind === 'handoff' && edge.from === workflowId && edge.to === id &&
      edge.source === 'native-activity' && edge.evidence_id === dispatched.id));
    assert.deepEqual(protectedInventory(root), before);
    const completed = await call(client, 'agent_activity', { ...input, state: 'completed', summary: 'Returned source findings' });
    const final = await call(client, 'agent_map');
    assert.equal(final.nodes.find(node => node.id === id).state, 'completed');
    assert.ok(final.edges.some(edge => edge.kind === 'report' && edge.from === id && edge.to === workflowId &&
      edge.source === 'native-activity' && edge.evidence_id === completed.id));
    assert.deepEqual(getRecord(root, workflowId), original, 'Progress does not advance acceptance or closure.');
    assert.deepEqual(protectedInventory(root), before);
    assert.equal(existsSync(join(root, '.neomind/native/receipts')), false);
  });
}

test('MCP refuses strict, missing, non-workflow and cross-workflow activity without leaving observations', async t => {
  const { root } = project(t), client = await connect(t, root);
  const native = await workflow(root, 'copilot-native', 'first-native');
  const other = await workflow(root, 'copilot-native', 'other-native');
  const lightweight = await workflow(root, 'lightweight');
  const strict = beginWorkflow(root, { requirement: 'Retain strict receipt binding.', execution_mode: 'strict' });
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Other workflow task',
    data: { workflow_id: other.workflow.workflow_id }, links: [{ type: 'documents', target: other.workflow.workflow_id }] });
  const requirementId = getRecord(root, native.workflow.workflow_id).meta.data.requirement_id;
  const before = protectedInventory(root);
  const base = { assignment_id: 'bounded-work', profile_id: 'implementer', state: 'running', summary: 'Observed fixture work' };
  const cases = [
    [{ ...base, workflow_id: strict.meta.id }, /unsigned|native or lightweight/i],
    [{ ...base, workflow_id: 'ACTIVITY-MCP-KNW-9999' }, /not found|does not exist|ENOENT/i],
    [{ ...base, workflow_id: requirementId }, /unsigned|native or lightweight/i],
    [{ ...base, workflow_id: native.workflow.workflow_id, task_id: task.meta.id }, /same unsigned workflow/i],
    [{ ...base, workflow_id: lightweight.workflow.workflow_id, task_id: task.meta.id }, /same unsigned workflow/i],
    [{ ...base, workflow_id: native.workflow.workflow_id, profile_id: 'coordinator' }, /Coordinator.*coordinator/i],
  ];
  for (const [input, message] of cases) {
    const response = await client.callTool({ name: 'agent_activity', arguments: input });
    assert.equal(response.isError, true, JSON.stringify(input));
    assert.match(payload(response).error, message);
    assert.deepEqual(protectedInventory(root), before);
  }
  assert.equal(existsSync(join(root, '.neomind/runs/agent-activity')), false);
  assert.equal((await call(client, 'agent_map')).nodes.some(node => node.source === 'native-activity'), false);
});

test('CLI structured JSON and explicit project select activity storage independently of shell cwd', async t => {
  const { root, elsewhere } = project(t), run = await workflow(root, 'lightweight');
  const input = { workflow_id: run.workflow.workflow_id, assignment_id: 'review-json', profile_id: 'reviewer',
    state: 'running', summary: 'Review "quoted" values, C:\\fixture paths and Unicode: dữ liệu',
    invocation_id: 'reviewer-cli-fixture' };
  const before = protectedInventory(root);
  const result = spawnSync(process.execPath, [cli, 'activity', 'report', '--project', root, '--data', JSON.stringify(input)],
    { cwd: elsewhere, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(result.stdout);
  for (const [key, value] of Object.entries(input)) assert.equal(event[key], value, key);
  assert.equal(event.project_id, 'ACTIVITY-MCP');
  assert.equal(event.role, 'reviewer');
  assert.equal(event.source, 'native-activity');
  const saved = JSON.parse(readFileSync(join(root, `.neomind/runs/agent-activity/${event.id}.json`), 'utf8'));
  assert.deepEqual(saved, event);
  const read = spawnSync(process.execPath, [cli, 'map', '--project', root],
    { cwd: elsewhere, encoding: 'utf8', timeout: 30_000 });
  assert.equal(read.status, 0, read.stderr);
  assert.ok(JSON.parse(read.stdout).nodes.some(node => node.source_id === event.id && node.state === 'running'));
  assert.deepEqual(readdirSync(elsewhere), [], 'The caller directory receives no managed state.');
  assert.deepEqual(protectedInventory(root), before);
});

test('installed profiles can report activity and native/lightweight packets explain its lifecycle and limits', async t => {
  const { root } = project(t);
  assert.deepEqual(installProject(root).conflicts, []);
  const files = readdirSync(join(root, '.github/agents')).filter(name => name.endsWith('.agent.md'));
  assert.equal(files.length, 9);
  for (const id of profileIds) {
    const content = readFileSync(join(root, `.github/agents/neomind-${id}.agent.md`), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    assert.ok(header, id);
    const metadata = parseYaml(header[1]);
    assert.ok(metadata.tools.includes('neomind/agent_activity'), `${id} can perform the documented progress operation`);
    assert.equal(metadata['user-invocable'], id === 'coordinator');
    assert.match(content, /Universe activity/);
  }
  for (const mode of ['copilot-native', 'lightweight']) {
    const run = await workflow(root, mode, `packet-${mode}`), prompt = run.handoff.prompt;
    assert.ok(prompt.includes(run.workflow.workflow_id));
    assert.match(prompt, /neomind\/agent_activity/);
    assert.match(prompt, /assignment_id.*profile_id/);
    assert.match(prompt, /dispatched.*launch attempt/);
    assert.match(prompt, /state: running before beginning work/);
    assert.match(prompt, /completed only after.*actual result/);
    assert.match(prompt, /expires after five minutes.*unknown/);
    assert.match(prompt, /never replaces assignment_report, lightweight_checkpoint, checks or saved closure gates/);
    assert.match(prompt, /strict Bridge work.*existing receipts/);
  }
  assert.equal(existsSync(join(root, '.neomind/runs/agent-activity')), false, 'Instructions do not manufacture agent activity.');
  assert.equal(existsSync(join(root, '.neomind/native/receipts')), false);
});
