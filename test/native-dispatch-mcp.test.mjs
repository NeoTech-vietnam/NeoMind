import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as runtime from '../dist/index.js';
import { createMcpServer } from '../dist/mcp.js';
import { cornellFixture } from './cornell-fixture.mjs';

const { createNativeDispatchHost } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/native-dispatch.cjs');

test('workflow selector drives real MCP authentication, independent checked stages, Cornell creation and closure without model-authored credentials', async t => {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-host-mcp-')));
  const runtimeRoot = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
  runtime.initialize(root, { project_id: 'HOST-MCP', platforms: ['copilot'] });
  const server = createMcpServer(root);
  runtime.atomicWrite(runtime.safePath(root, '.neomind/automation.json'), JSON.stringify(runtime.nativeAutomationPolicy()));
  const workflow = runtime.beginWorkflow(root, { requirement: 'Deliver a named integer one export with documented usage and independent executable checks.', execution_mode: 'copilot-native' });
  mkdirSync(join(root, '.github/agents'), { recursive: true });
  for (const profile of runtime.agentProfiles) writeFileSync(join(root, `.github/agents/neomind-${profile.id}.agent.md`), `---\nname: "${profile.name}"\n---\nBounded test role.\n`);
  const client = new Client({ name: 'native-host-integration-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  let host;
  t.after(async () => { host?.dispose(); await client.close(); await server.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const calls = [], launches = [], evidence = [];
  const call = async (name, input) => {
    calls.push(name);
    const response = await client.callTool({ name, arguments: input });
    const value = JSON.parse(response.content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
    assert.notEqual(response.isError, true, `${name}: ${value.error ?? 'MCP rejected operation'}`);
    return value;
  };
  const savedResult = { schema_version: 1, outcome: 'completed',
    summary: 'Completed the isolated bounded assignment and saved actual local fixture observations; no native inference is attested.',
    inputs: ['Read the original requirement and backend-issued assignment context.'],
    decisions: [{ decision: 'Use a direct named export and independent integer assertion.', basis: 'The fixed semantic contract needs no dependency or network access.' }],
    evidence_refs: [], evidence_notes: ['This automated fixture executes real MCP authorization and checks, with simulated native editor callbacks.'],
    limitations: ['Native model inference and VS Code account conformance are not established by this fixture.'],
    lessons: ['Keep generated identity fields outside model-authored semantic inputs.'] };
  const state = new Map();
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
    getConfiguration: () => ({ inspect: () => ({ globalValue: runtimeRoot }) }) },
    lm: { tools: [...(await client.listTools()).tools.map(x => ({ name: `mcp_neomind_${x.name}`, inputSchema: x.inputSchema })),
      { name: 'runSubagent', inputSchema: { type: 'object', properties: { agentName: {}, description: {}, prompt: {} }, required: ['prompt', 'description'] } }],
      async invokeTool(name, options) {
        if (name !== 'runSubagent') return { content: [{ value: JSON.stringify(await call(name.replace(/^mcp_neomind_/, ''), options.input)) }] };
        const args = options.input;
        assert.deepEqual(Object.keys(args).sort(), ['agentName', 'description', 'prompt']);
        launches.push(args.agentName);
        const first = args.prompt.split('\n').find(line => line.startsWith('FIRST call assignment_open with exactly this JSON input: '));
        const opened = await call('assignment_open', JSON.parse(first.slice(first.indexOf('{'))));
        const credential = { reported_assignment: opened.handle };
        if (opened.context.role === 'developer') {
          await call('assignment_start', credential);
          mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'docs'), { recursive: true });
          writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
          writeFileSync(join(root, 'docs/value.md'), '# Value\nUse the named import to obtain integer one.\n');
          await call('assignment_result', { ...credential, result: { ...savedResult, submit_task: true,
            changes: [{ path: 'src/value.mjs', description: 'Named integer export.' }, { path: 'docs/value.md', description: 'Public usage documentation.' }] } });
        } else {
          if (opened.context.role === 'check-executor') {
            mkdirSync(join(root, 'test'), { recursive: true });
            writeFileSync(join(root, 'test/value.mjs'), 'import assert from "node:assert/strict";import {value} from "../src/value.mjs";assert.equal(value,1);\n');
            const checked = await call('assignment_check', credential);
            evidence.push(...checked.evidence.map(x => x.meta.id));
            assert.ok(checked.evidence.every(x => x.meta.data.exit_code === 0));
          } else await call('assignment_review', { ...credential, decision: 'pass', findings: [] });
          await call('assignment_result', { ...credential, result: { ...savedResult, evidence_refs: evidence } });
        }
        return { content: [{ value: 'The isolated delegate saved its actual bounded result.' }] };
      } } };
  host = createNativeDispatchHost({ vscode, context: { globalState: { get: (k, fallback) => state.get(k) ?? fallback, update: async (k, v) => state.set(k, v) } }, loadRuntime: async () => runtime });
  const invoke = async (operation = 'advance', parameters) => host.invoke({ toolInvocationToken: { actualFixtureToken: true }, input: {
    workflow_id: workflow.meta.id, ...(operation !== 'advance' ? { operation, parameters } : {}) } }, { isCancellationRequested: false });
  const planned = await invoke('workflow_plan', { process: 'software-tools', rationale: 'This change is limited to Node software and independent checks, without embedded interfaces.',
    title: 'Documented named integer', objective: 'Export integer one with a documented named import and independent acceptance assertion.',
    acceptance_criteria: ['The named export equals integer one.', 'The usage documentation describes the named import.'],
    allowed_paths: ['src/value.mjs', 'docs/value.md'], verification_paths: ['test/value.mjs'], outputs: ['src/value.mjs', 'docs/value.md'], documentation_paths: ['docs/value.md'],
    checks: [{ title: 'Independent integer assertion', command: [process.execPath, 'test/value.mjs'], baseline_paths: ['src/value.mjs', 'docs/value.md', 'test/value.mjs'] }] });
  assert.ok(planned.result.task_id);
  await invoke(); await invoke(); const final = await invoke();
  assert.equal(final.status, 'ready_for_cornell');
  const note = cornellFixture(workflow.meta.id, workflow.meta.data.requirement_id);
  note.demonstration.observed = 'The independent Node assertion actually exited zero on the captured baseline.';
  note.demonstration.evidence_ids = evidence;
  const created = await invoke('note_create', { note });
  assert.ok(created.result.meta.id);
  const closed = await invoke('manager_finish', { no_lesson_reason: 'This isolated fixture verifies an existing protocol and establishes no new publicly reusable lesson.' });
  assert.ok(closed.result.final_report);
  assert.equal(runtime.getRecord(root, workflow.meta.id).meta.data.phase, 'completed');
  assert.deepEqual(launches, ['NeoMind Implementer Agent', 'NeoMind Verifier Agent', 'NeoMind Reviewer Agent']);
  assert.equal(calls.filter(x => x === 'assignment_bootstrap').length, 1);
  assert.equal(calls.includes('assignment_progress'), false);
});
