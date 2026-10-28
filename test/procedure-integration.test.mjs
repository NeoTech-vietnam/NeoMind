// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRecord, getRecord, loadRecords } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { registerProcedure, resolveProcedure, validateProcedureParameters } from '../dist/procedures.js';
import { beginWorkflow } from '../dist/manager.js';
import { nativeRun } from '../dist/managed.js';
import { createMcpServer } from '../dist/mcp.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const effects = { write_roots: ['reports'], network: false, publication: false };
const tools = { node: process.versions.node };

function fixture(t, { registered = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-procedure-integration-'));
  initialize(root, { project_id: 'PROCEDURE-INTEGRATION', platforms: ['codex', 'copilot'] });
  ensureRoutingPolicy(root);
  t.after(() => {
    const absolute = resolve(root);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.match(absolute.split(/[\\/]/).at(-1), /^neomind-procedure-integration-/);
    rmSync(absolute, { recursive: true, force: true });
  });
  for (const path of ['scripts', 'notes', 'checks']) mkdirSync(join(root, path), { recursive: true });
  for (const name of ['cornell-inventory.mjs', 'cornell-inventory-check.mjs'])
    copyFileSync(fileURLToPath(new URL(`../examples/procedures/${name}`, import.meta.url)), join(root, 'scripts', name));
  for (const [name, content] of [['note', '# Research note\nAn observed study result with source references.\n'],
    ['practice', '# Practice\nExplain the observed result using a concrete example.\n'],
    ['answers', '# Answers\nCheck the example against the inspected study result.\n']])
    writeFileSync(join(root, 'notes', `${name}.md`), content);
  const manifest = {
    id: 'cornell-inventory', version: '1.0.0', title: 'Cornell artifact inventory',
    description: 'Inventory the separate current research note, practice questions and answers without rewriting their content.',
    task_family: 'cornell-inventory', keywords: ['cornell', 'inventory', 'research', 'practice', 'answers'],
    author: 'synthetic-script-author', script: 'scripts/cornell-inventory.mjs', verification_script: 'scripts/cornell-inventory-check.mjs',
    parameters: { note: { type: 'string', path: true }, practice: { type: 'string', path: true },
      answers: { type: 'string', path: true }, output: { type: 'string', path: true }, include_bytes: { type: 'boolean' } },
    outputs: [{ path: '{output}', min_bytes: 50 }],
    environment: { platforms: [process.platform], clients: ['cli', 'codex', 'copilot'], node_major_min: 24, tools },
    effects,
  };
  if (registered) registerProcedure(root, manifest);
  return { root, manifest };
}
function parameters(name, include_bytes = true) {
  return { note: 'notes/note.md', practice: 'notes/practice.md', answers: 'notes/answers.md',
    output: `reports/${name}.json`, include_bytes };
}
let inputSequence = 0;
function cli(root, args, data, { failure = false } = {}) {
  const options = [...args, '--project', root];
  if (data !== undefined) {
    const path = join(root, `integration-input-${++inputSequence}.json`);
    writeFileSync(path, JSON.stringify(data)); options.push('--data-file', path);
  }
  const child = spawnSync(process.execPath, [cliPath, ...options], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.error, undefined, child.error?.message);
  if (failure) { assert.notEqual(child.status, 0, child.stdout); return JSON.parse(child.stderr.trim().split(/\r?\n/).at(-1)); }
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function request(name, extra = {}) {
  return { request: 'Inventory the Cornell research note, practice questions and answers using the reviewed local procedure.',
    request_id: name, intent_id: 'cornell-inventory', parameters: parameters(name),
    environment: { client: 'cli', tools }, scope: { allowed_paths: ['reports'], network: false, publication: false }, ...extra };
}
function reviewActualNegativeCase(root, manifest) {
  assert.throws(() => validateProcedureParameters(root, manifest, { ...parameters('invalid'), include_bytes: 'yes' }), /wrong type|boolean|type/i);
  const invalid = parameters('duplicate-artifacts'); invalid.practice = invalid.note;
  const negative = spawnSync(process.execPath, [join(root, manifest.script)], {
    cwd: root, input: JSON.stringify({ parameters: invalid, outputs: [invalid.output] }), encoding: 'utf8', timeout: 10_000,
  });
  assert.notEqual(negative.status, 0); assert.match(negative.stderr, /Separate learning artifacts/);
  assert.equal(existsSync(join(root, invalid.output)), false);
  writeFileSync(join(root, 'checks/negative-case.json'), JSON.stringify({
    method: 'Actual supplied example generator process with duplicate input artifact paths',
    exit_code: negative.status, observed_error: negative.stderr,
  }));
  return cli(root, ['procedure', 'review', manifest.id], { reviewer: 'synthetic-independent-reviewer', verdict: 'pass',
    rationale: 'Synthetic integration review verifies actual duplicate-path rejection, parameter validation and the separate output checker; no human or native-client review is attested.',
    negative_cases: [{ name: 'Duplicate learning artifact paths rejected by the actual script', evidence_path: 'checks/negative-case.json' }] });
}
async function mcpClient(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'procedure-integration-local-fixture', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
function ok(result) { assert.equal(result.isError, undefined, result.content?.[0]?.text); return JSON.parse(result.content[0].text); }
function denied(result, expected) { assert.equal(result.isError, true); assert.match(result.content[0].text, expected); }

test('CLI discovers and registers existing scripts as candidates without executing them', t => {
  const { root, manifest } = fixture(t, { registered: false });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/cornell-inventory.mjs' } }));
  const found = cli(root, ['procedure', 'discover']);
  assert.equal(found.scripts.length, 2); assert.equal(found.package_commands.length, 1);
  assert.equal(cli(root, ['procedure', 'register'], manifest).status, 'candidate');
  assert.equal(cli(root, ['procedure', 'list'])[0].id, manifest.id);
  const prepared = cli(root, ['work', 'prepare'], request('candidate-only'));
  assert.equal(prepared.decision, 'adapt'); assert.equal(prepared.execution_authorized, false);
  assert.equal(prepared.candidates[0].reasons.some(reason => reason.code === 'NOT_QUALIFIED'), true);
  const run = cli(root, ['work', 'run'], { ...request('candidate-only'), actor: 'synthetic-local-runner', authorized_effects: effects });
  assert.equal(run.executed, false); assert.equal(run.status, 'needs-specialist');
  assert.equal(resolveProcedure(root, manifest.id).runs.length, 0);
  assert.equal(existsSync(join(root, 'reports')), false);
});

test('CLI qualifies actual checked example executions and reuses them with stable requests while preserving conflicts', t => {
  const { root, manifest } = fixture(t);
  assert.equal(reviewActualNegativeCase(root, manifest).status, 'reviewed');
  // These are real local Node processes over synthetic workspace artifacts, not observed native-agent pilots.
  for (const [index, includeBytes] of [true, false, true].entries()) {
    const name = `qualification-${index}`;
    const run = cli(root, ['procedure', 'run', manifest.id], { parameters: parameters(name, includeBytes),
      request_id: name, actor: 'synthetic-local-runner', client: 'cli', mode: 'pilot', observation: 'local-process',
      authorized_effects: effects, tool_versions: tools });
    assert.equal(run.status, 'succeeded'); assert.equal(run.observation, 'local-process');
    assert.equal(run.generator.exit_code, 0); assert.equal(run.verification.exit_code, 0);
    const inventory = JSON.parse(readFileSync(join(root, `reports/${name}.json`), 'utf8'));
    assert.equal(Object.hasOwn(inventory.artifacts[0], 'bytes'), includeBytes);
  }
  assert.equal(cli(root, ['procedure', 'qualify', manifest.id], { actor: 'synthetic-coordinator' }).status, 'eligible');
  const input = request('reuse-current');
  assert.equal(cli(root, ['work', 'prepare'], input).decision, 'exact');
  const runInput = { ...input, actor: 'synthetic-local-runner', authorized_effects: effects };
  const first = cli(root, ['work', 'run'], runInput);
  assert.equal(first.executed, true); assert.equal(first.run.status, 'succeeded');
  const repeated = cli(root, ['work', 'run'], runInput);
  assert.equal(repeated.executed, false); assert.equal(repeated.replayed, true);
  const { replayed: firstReplay, ...firstSavedRun } = first.run;
  const { replayed: secondReplay, ...repeatedSavedRun } = repeated.run;
  assert.equal(firstReplay, false); assert.equal(secondReplay, true);
  assert.deepEqual(repeatedSavedRun, firstSavedRun);
  assert.deepEqual(repeated.preparation, first.preparation);
  const changed = cli(root, ['work', 'run'], { ...runInput, request: 'Different intent under the previous request identity.' }, { failure: true });
  assert.match(changed.error, /different request or payload|different payload/i);
  const originalBytes = readFileSync(join(root, input.parameters.output));
  const conflict = cli(root, ['work', 'run'], { ...runInput, request_id: 'new-request-same-output' });
  assert.equal(conflict.executed, false); assert.equal(conflict.preparation.decision, 'blocked');
  assert.equal(conflict.preparation.candidates[0].reasons.some(reason => reason.code === 'OUTPUT_CONFLICT'), true);
  assert.deepEqual(readFileSync(join(root, input.parameters.output)), originalBytes);
});

test('real MCP exposes procedure contracts and refuses unauthenticated, missing and noncurrent producer execution before effects', async t => {
  const { root, manifest } = fixture(t), client = await mcpClient(t, root);
  const catalog = (await client.listTools()).tools;
  for (const name of ['procedure_list', 'procedure_discover', 'procedure_resolve', 'procedure_register',
    'procedure_review', 'procedure_qualify', 'procedure_run', 'work_prepare']) assert.ok(catalog.some(tool => tool.name === name));
  assert.ok(catalog.find(tool => tool.name === 'procedure_run').inputSchema.properties.tool_versions);
  assert.ok(catalog.find(tool => tool.name === 'work_prepare').inputSchema.properties.input);
  assert.equal(ok(await client.callTool({ name: 'procedure_list', arguments: {} }))[0].status, 'candidate');
  const prepared = ok(await client.callTool({ name: 'work_prepare', arguments: { input: request('mcp-search') } }));
  assert.equal(prepared.candidates[0].id, manifest.id); assert.equal(prepared.execution_authorized, false);
  const args = { procedure_id: manifest.id, parameters: parameters('must-not-run'), request_id: 'mcp-must-not-run', mode: 'pilot', tool_versions: tools };
  denied(await client.callTool({ name: 'procedure_run', arguments: args }), /require|authenticated|bound|Strict|session/i);
  denied(await client.callTool({ name: 'procedure_register', arguments: { manifest } }), /require|authenticated|bound|Strict|session/i);
  const workflow = beginWorkflow(root, { requirement: 'Keep procedure execution under the actual current producer assignment.', execution_mode: 'copilot-native' });
  async function actor(assignment_id, task_id) {
    const packet = ok(await client.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
      profile_id: 'implementer', role: 'developer', assignment_id,
      objective: 'Run only the assigned reviewed procedure when the current task producer and task gates permit execution.',
      ...(task_id ? { task_id } : {}) } }));
    return ok(await client.callTool({ name: 'assignment_open', arguments: { packet: { id: packet.id, claim_token: packet.claim_token } } })).handle;
  }
  const unbound = await actor('unbound-task-producer');
  const captureArguments = { manifest: { ...manifest, id: 'captured-inventory' }, reported_assignment: unbound };
  const capture = ok(await client.callTool({ name: 'procedure_register', arguments: captureArguments }));
  assert.equal(capture.author, unbound.id);
  const source = getRecord(root, capture.candidate_record_id);
  assert.equal(source.meta.data.workflow_id, workflow.meta.id);
  assert.equal(source.meta.data.procedure_contract_hash, capture.contract_hash);
  assert.equal(source.meta.data.qualification, 'candidate-only');
  assert.equal(ok(await client.callTool({ name: 'procedure_register', arguments: captureArguments })).candidate_record_id, source.meta.id);
  assert.equal(loadRecords(root).filter(record => record.meta.data.kind === 'procedure-candidate').length, 1);
  denied(await client.callTool({ name: 'procedure_run', arguments: { ...args, reported_assignment: unbound } }), /bound to an in-progress task/);
  const task = createRecord(root, { type: 'task', title: 'Current scoped script producer', owner: 'developer', status: 'in-progress',
    data: { workflow_id: workflow.meta.id, invocation_id: 'different-actual-producer', allowed_paths: ['reports'] } });
  const noncurrent = await actor('noncurrent-task-producer', task.meta.id);
  denied(await client.callTool({ name: 'procedure_run', arguments: { ...args, reported_assignment: noncurrent } }), /current task producer/);
  assert.equal(resolveProcedure(root, manifest.id).runs.length, 0);
  assert.equal(existsSync(join(root, 'reports')), false);
});

test('native handoff exposes corrupt reuse index as an integrity failure and preserves the existing workflow', t => {
  const { root } = fixture(t);
  const workflow = beginWorkflow(root, { requirement: 'Inventory the current Cornell learning artifacts without rewriting the original request.', execution_mode: 'codex-native' });
  const workflowBytes = readFileSync(join(root, workflow.path)), recordCount = loadRecords(root).length;
  mkdirSync(join(root, '.neomind/cache'), { recursive: true });
  writeFileSync(join(root, '.neomind/cache/procedures.sqlite'), 'deliberately corrupt SQLite index for integration regression');
  const result = nativeRun(root, { workflow_id: workflow.meta.id, execution_mode: 'codex-native' });
  assert.match(result.handoff.prompt, /Reuse inspection failed:.*unreadable or corrupt/);
  assert.match(result.handoff.prompt, /integrity\/availability issue, not a successful no-match/);
  assert.match(result.handoff.prompt, /procedure index/);
  assert.match(result.handoff.prompt, /Inventory the current Cornell learning artifacts/);
  assert.equal(getRecord(root, workflow.meta.id).meta.data.execution_mode, 'codex-native');
  assert.equal(loadRecords(root).length, recordCount);
  assert.deepEqual(readFileSync(join(root, workflow.path)), workflowBytes);
});
