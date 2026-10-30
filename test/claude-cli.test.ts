import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeTurn, claudeArgs, claudeEnvironment, resolveClaudeExecutable, runClaudeTurn, verifyClaudeInit, type ClaudePolicy, type ClaudeTurnRequest } from '../src/adapters/claude-cli.js';
import { ClaudeStream, claudeUsage } from '../src/adapters/claude-stream.js';
import { allocateProcessScope, stopExistingWorkerScope } from '../src/adapters/worker-scope.js';
import { windowsProcessInfo } from '../src/platform/windows-helper.js';

const windows = process.platform === 'win32';
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.js');
const readOnly: ClaudePolicy = { args: ['--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config'], settings: { permissions: { deny: ['WebFetch'] } }, tools: ['Read', 'Glob', 'Grep'], permissionMode: 'dontAsk' };
const init = (overrides: Record<string, unknown> = {}) => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-5-5', tools: ['Read'], mcp_servers: [], permissionMode: 'dontAsk', cwd: process.cwd(), ...overrides });

test('Claude usage counts cached prompt tokens as input, like Codex', () => {
  assert.deepEqual(claudeUsage({ input_tokens: 8, output_tokens: 223, cache_read_input_tokens: 12507, cache_creation_input_tokens: 6355, output_tokens_details: { thinking_tokens: 87 } }),
    { inputTokens: 18870, outputTokens: 223, cachedInputTokens: 12507, cacheWriteInputTokens: 6355, reasoningOutputTokens: 87, totalTokens: 19093 });
  assert.equal(claudeUsage({ input_tokens: 3, output_tokens: 4 }).totalTokens, 7);
});

test('the Claude stream keeps texts, tool errors and the result and rejects protocol violations', () => {
  const stream = new ClaudeStream();
  assert.throws(() => stream.accept(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [] } })), /before init/);
  stream.accept(init());
  stream.accept(JSON.stringify({ type: 'rate_limit_event', session_id: 's1' }));
  stream.accept(JSON.stringify({ type: 'assistant', session_id: 's1', parent_tool_use_id: null, message: { model: 'claude-haiku-5-5', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hello' }] } }));
  stream.accept(JSON.stringify({ type: 'user', session_id: 's1', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } }));
  assert.throws(() => new ClaudeStream().accept('not json'), /Malformed/);
  assert.throws(() => stream.accept(init()), /Duplicate/);
  assert.throws(() => stream.accept(JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [] } })), /another session/);
  assert.throws(() => stream.accept(JSON.stringify({ type: 'assistant', session_id: 's1', parent_tool_use_id: 'toolu_1', message: { content: [] } })), /sub-agent/);
  stream.accept(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: '{"a":1}', structured_output: { a: 1 },
    usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.5, permission_denials: [{ tool_name: 'Write', tool_use_id: 't', tool_input: {} }] }));
  assert.deepEqual(stream.messages, ['hello']);
  assert.deepEqual(stream.toolErrors, ['denied']);
  assert.deepEqual([...stream.models], ['claude-haiku-5-5']);
  assert.deepEqual(stream.final?.structuredOutput, { a: 1 });
  assert.deepEqual(stream.final?.permissionDenials, [{ tool: 'Write', toolUseId: 't' }]);
  assert.equal(stream.final?.costUsd, 0.5);
  assert.throws(() => stream.accept(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [] } })), /after its result/);
});

test('Claude arguments put the transport flags first and refuse policies that override them', () => {
  const sessionId = randomUUID(), base = { workspace: process.cwd(), model: 'claude-haiku-5-5', effort: 'low', sessionId, resume: false, policy: readOnly };
  const args = claudeArgs({ ...base, outputSchema: { type: 'object' } });
  // zod emits the 2020-12 dialect marker, which Claude Code refuses; only the marker is dropped.
  const zodSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string' } } };
  const sent = claudeArgs({ ...base, outputSchema: zodSchema });
  assert.deepEqual(JSON.parse(sent[sent.indexOf('--json-schema') + 1]!), { type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(args.slice(0, 10), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-5-5', '--effort', 'low', '--session-id', sessionId]);
  assert.deepEqual(args.slice(10, 14), ['--json-schema', '{"type":"object"}', '--settings', '{"permissions":{"deny":["WebFetch"]}}']);
  assert.deepEqual(args.slice(14), readOnly.args);
  assert.deepEqual(claudeArgs({ ...base, resume: true }).slice(8, 10), ['--resume', sessionId]);
  for (const flag of ['--dangerously-skip-permissions', '--model', '--settings=x', '-c', '--fork-session'])
    assert.throws(() => claudeArgs({ ...base, policy: { ...readOnly, args: [flag] } }), /cannot set/);
  assert.throws(() => claudeArgs({ ...base, sessionId: 'not-a-uuid' }), /UUID/);
  assert.throws(() => claudeArgs({ ...base, model: '--model' }), /model/);
  assert.throws(() => claudeArgs({ ...base, effort: 'high; rm' }), /effort/);
});

test('Claude init must match the requested session, model, workspace, permissions and exact tools', () => {
  const actual = { sessionId: 's1', model: 'claude-haiku-5-5', tools: ['Grep', 'Read', 'Glob'], mcpServers: [], permissionMode: 'dontAsk', cwd: process.cwd() };
  const expected = { sessionId: 's1', model: 'claude-haiku-5-5', workspace: process.cwd(), permissionMode: 'dontAsk', tools: ['Read', 'Glob', 'Grep'] };
  verifyClaudeInit(actual, expected);
  verifyClaudeInit({ ...actual, model: 'claude-haiku-5-5-20261001' }, expected);
  if (windows) verifyClaudeInit({ ...actual, cwd: process.cwd().toUpperCase() }, expected);
  assert.throws(() => verifyClaudeInit({ ...actual, sessionId: 's2' }, expected), /different session/);
  assert.throws(() => verifyClaudeInit({ ...actual, model: 'claude-haiku-5-50' }, expected), /model/);
  assert.throws(() => verifyClaudeInit({ ...actual, model: 'claude-opus-5-5' }, expected), /model/);
  assert.throws(() => verifyClaudeInit({ ...actual, cwd: os.tmpdir() }, expected), /working directory/);
  assert.throws(() => verifyClaudeInit({ ...actual, permissionMode: 'acceptEdits' }, expected), /permission mode/);
  assert.throws(() => verifyClaudeInit({ ...actual, mcpServers: [{ name: 'x' }] }, expected), /MCP/);
  assert.throws(() => verifyClaudeInit({ ...actual, tools: [...actual.tools, 'Task'] }, { ...expected, tools: [...expected.tools, 'Task'] }), /delegation/);
  assert.throws(() => verifyClaudeInit({ ...actual, tools: [...actual.tools, 'mcp__x__y'] }, expected), /external/);
  assert.throws(() => verifyClaudeInit({ ...actual, tools: [...actual.tools, 'PowerShell'] }, expected), /do not match/);
  assert.throws(() => verifyClaudeInit({ ...actual, tools: ['Read', 'Glob'] }, expected), /do not match/);
  assert.throws(() => verifyClaudeInit({ ...actual, tools: ['Read', 'Read', 'Glob', 'Grep'] }, expected), /do not match/);
});

test('the Claude worker environment drops parent session linkage but keeps credentials', () => {
  const env = claudeEnvironment({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', DISABLE_AUTOUPDATER: '1' });
});

test('Claude is resolved to a native executable, never an npm shim', () => {
  try {
    const resolved = resolveClaudeExecutable({ PATH: '' });
    assert.ok(path.isAbsolute(resolved.command) && (!windows || /\.exe$/i.test(resolved.command)));
  } catch (error) { assert.match((error as Error).message, /not found/); }
});

const scoped = { skip: !windows && 'Process scope tests run on Windows', timeout: 60000 };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'neomind-claude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls.jsonl');
  const request = async (mode: string, overrides: Partial<ClaudeTurnRequest> = {}): Promise<ClaudeTurnRequest> => ({
    scope: await allocateProcessScope(), workspace: root, model: 'claude-haiku-5-5', effort: 'low', sessionId: randomUUID(), resume: false, prompt: 'say hi',
    policy: readOnly, executable: { command: process.execPath, args: [fake] },
    env: claudeEnvironment({ ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: root, FAKE_CLAUDE_LOG: log, CLAUDECODE: '1' }), ...overrides });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; prompt: string; cwd: string; claudeEnv: string[] });
  return { root, request, calls };
}

test('a Claude turn runs in a process scope, continues its session and returns verified output', scoped, async t => {
  const { root, request, calls } = fixture(t);
  const first = await request('success');
  const turn = await ClaudeTurn.start(first);
  assert.ok(await first.scope.isActive());
  assert.equal(turn.init.model, 'claude-haiku-5-5');
  const result = await turn.wait(() => false);
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, first.sessionId);
  assert.deepEqual(result.messages, ['turn 1: say hi']);
  assert.deepEqual(result.usage, { inputTokens: 1110, outputTokens: 20, cachedInputTokens: 1000, cacheWriteInputTokens: 100, reasoningOutputTokens: 5, totalTokens: 1130 });
  assert.equal(result.costUsd, 0.0012);
  assert.equal(await first.scope.isActive(), false);
  assert.equal(await stopExistingWorkerScope(first.scope.identity), true);

  const second = await runClaudeTurn(await request('success', { sessionId: first.sessionId, resume: true, prompt: 'again', outputSchema: { type: 'object' } }));
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.messages, ['turn 2: again', '{"answer":"ok"}']);
  assert.deepEqual(second.structuredOutput, { answer: 'ok' });

  const [call1, call2] = calls();
  assert.equal(call1!.prompt, 'say hi'); assert.equal(path.resolve(call1!.cwd).toLowerCase(), path.resolve(root).toLowerCase());
  assert.deepEqual(call1!.claudeEnv, []);
  assert.ok(call1!.argv.includes('--session-id') && !call1!.argv.includes('--resume'));
  assert.ok(call2!.argv.includes('--resume') && call2!.argv.includes('--json-schema'));

  const unknown = await runClaudeTurn(await request('success', { sessionId: randomUUID(), resume: true }));
  assert.equal(unknown.status, 'failed'); assert.match(unknown.error!, /No conversation found/);
});

test('a Claude turn fails when the runtime does not match the request', scoped, async t => {
  const { request } = fixture(t);
  for (const [mode, pattern] of [['wrong-model', /model claude-opus-5-5/], ['task-tool', /delegation/], ['mcp', /MCP servers/]] as const) {
    const config = await request(mode);
    await assert.rejects(ClaudeTurn.start(config), pattern);
    assert.equal(await config.scope.isActive(), false);
  }
  await assert.rejects(ClaudeTurn.start(await request('success', { policy: { ...readOnly, tools: ['Read'] } })), /do not match/);
  await assert.rejects(ClaudeTurn.start(await request('success', { policy: { ...readOnly, permissionMode: 'acceptEdits' } })), /permission mode/);
  await assert.rejects(runClaudeTurn(await request('late-model')), /answered with model claude-opus-5-5/);
  // An exit before init names Claude's own error line.
  const rejected = await request('success', { executable: { command: process.execPath, args: [fake, '--json-schema', '{"$schema":"https://json-schema.org/draft/2020-12/schema"}'] } });
  await assert.rejects(ClaudeTurn.start(rejected), /before reporting its configuration: --json-schema is not a valid JSON Schema/);
  assert.equal(await rejected.scope.isActive(), false);
});

test('Claude failures, missing results and permission denials are reported', scoped, async t => {
  const { request } = fixture(t);
  const failed = await runClaudeTurn(await request('failure'));
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Reached maximum number of turns');
  await assert.rejects(runClaudeTurn(await request('no-result')), /before reporting a result/);
  const structured = await runClaudeTurn(await request('success', { outputSchema: { type: 'object' } }));
  assert.equal(structured.messages.at(-1), '{"answer":"ok"}');
  const denied = await runClaudeTurn(await request('denial'));
  assert.equal(denied.status, 'completed');
  assert.deepEqual(denied.permissionDenials, [{ tool: 'Write', toolUseId: 'toolu_denied' }]);
  assert.deepEqual(denied.toolErrors, ['Permission to use Write has been denied.']);
});

test('interrupting a Claude turn stops the whole scope, grandchildren included', scoped, async t => {
  const { request } = fixture(t);
  const config = await request('hang');
  const turn = await ClaudeTurn.start(config);
  let pid: number | undefined;
  for (let n = 0; n < 100 && !pid; n++) { pid = Number(/grandchild (\d+)/.exec((turn as unknown as { stream: ClaudeStream }).stream.messages.join('\n'))?.[1]) || undefined; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(pid);
  assert.equal(windowsProcessInfo(pid)?.state, 'alive');
  let stop = false; setTimeout(() => { stop = true; }, 200);
  await assert.rejects(turn.wait(() => stop), /^Error: Run was interrupted$/);
  assert.equal(await config.scope.isActive(), false);
  assert.notEqual(windowsProcessInfo(pid)?.state, 'alive');
  assert.equal(await stopExistingWorkerScope(config.scope.identity), true);
});
