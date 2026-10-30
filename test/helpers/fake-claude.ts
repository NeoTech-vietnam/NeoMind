import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Stand-in for `claude -p --output-format stream-json --verbose`, emitting events shaped like Claude Code 2.1.
 * FAKE_CLAUDE_MODE: success | wrong-model | task-tool | mcp | failure | denial | no-result | late-model | hang.
 * FAKE_CLAUDE_STATE: directory holding session files, so `--resume` only works after `--session-id`. Without it, sessions are
 *   stored like Claude Code's under `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<id>.jsonl` when that variable is set.
 * FAKE_CLAUDE_MODE=flow answers NeoMind prompts: a plan for the planner schema, a passing review citing proof.txt for the
 *   review schema, and a writer turn that creates proof.txt with the Write tool.
 * FAKE_CLAUDE_LOG: file receiving one JSON line per invocation with argv, stdin prompt and cwd.
 */
const argv = process.argv.slice(2), mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const option = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ...event, uuid: randomUUID() })}\n`);

const prompt = await new Promise<string>(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { text += chunk; }); process.stdin.on('end', () => resolve(text)); });
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, prompt, cwd: process.cwd(), claudeEnv: Object.keys(process.env).filter(key => /^CLAUDE/i.test(key)).sort() })}\n`);

const resume = option('--resume'), sessionId = resume ?? option('--session-id') ?? randomUUID();
const requested = option('--model') ?? 'claude-sonnet-5-5', schema = option('--json-schema');
const model = mode === 'wrong-model' ? 'claude-opus-5-5' : requested;
const tools = [...(option('--tools') ?? 'Read,Glob,Grep').split(',').filter(Boolean), ...(schema ? ['StructuredOutput'] : []), ...(mode === 'task-tool' ? ['Task'] : [])];
const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } };
const assistant = (content: unknown[], messageModel = model) => emit({ type: 'assistant', message: { model: messageModel, id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content, usage }, parent_tool_use_id: null, session_id: sessionId });

if (schema && '$schema' in (JSON.parse(schema) as object)) {
  // Claude Code 2.1 validates `--json-schema` without the 2020-12 meta-schema and exits before `init`.
  process.stderr.write('Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"\n');
  process.exit(1);
}
await sleep(200); // A real Claude Code process takes far longer than this before its first event.
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools, mcp_servers: mode === 'mcp' ? [{ name: 'external', status: 'connected' }] : [],
  model, permissionMode: option('--permission-mode') ?? 'default', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.312', output_style: 'default',
  agents: ['general-purpose', 'Explore', 'Plan'], skills: [], plugins: [] });
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: sessionId });

const stateDir = process.env.FAKE_CLAUDE_STATE ?? (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-')) : undefined);
if (stateDir) mkdirSync(stateDir, { recursive: true });
const state = stateDir ? path.join(stateDir, `${sessionId}.jsonl`) : undefined;
let turns = 0;
if (state) {
  if (resume && !existsSync(state)) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: `No conversation found with session ID: ${sessionId}`, permission_denials: [] });
    process.exit(1);
  }
  turns = resume ? (JSON.parse(readFileSync(state, 'utf8')) as { turns: number }).turns : 0;
  writeFileSync(state, JSON.stringify({ turns: turns + 1 }));
}

if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  assistant([{ type: 'text', text: `grandchild ${grandchild.pid}` }]);
  setInterval(() => {}, 1000);
} else {
  await sleep(100);
  if (mode === 'denial') {
    const id = `toolu_${randomUUID()}`;
    assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: path.join(process.cwd(), '..', 'outside.txt'), content: 'x' } }]);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Permission to use Write has been denied.' }] }, parent_tool_use_id: null, session_id: sessionId });
  }
  const text = `turn ${turns + 1}: ${prompt.trim()}`;
  assistant([{ type: 'text', text }], mode === 'late-model' ? 'claude-opus-5-5' : model);
  if (mode === 'flow' && !schema && tools.includes('Write')) {
    const id = `toolu_${randomUUID()}`, file = path.join(process.cwd(), 'proof.txt');
    assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: 'ok\n' } }]);
    writeFileSync(file, 'ok\n');
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File created' }] }, parent_tool_use_id: null, session_id: sessionId });
  }
  const structured = schema ? (mode === 'flow' ? flowOutput(schema) : process.env.FAKE_CLAUDE_OUTPUT ? JSON.parse(process.env.FAKE_CLAUDE_OUTPUT) as unknown : { answer: 'ok' }) : undefined;
  if (structured !== undefined) assistant([{ type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'StructuredOutput', input: structured }]);
  if (mode !== 'no-result') {
    const failed = mode === 'failure';
    emit({ type: 'result', subtype: failed ? 'error_max_turns' : 'success', is_error: failed, session_id: sessionId, num_turns: 2, duration_ms: 300,
      result: failed ? 'Reached maximum number of turns' : structured !== undefined ? JSON.stringify(structured) : text,
      ...(structured !== undefined && !failed ? { structured_output: structured } : {}), usage, total_cost_usd: 0.0012,
      permission_denials: mode === 'denial' ? [{ tool_name: 'Write', tool_use_id: 'toolu_denied', tool_input: {} }] : [] });
  }
  process.exitCode = mode === 'failure' ? 1 : 0;
}

function flowOutput(schema: string): unknown {
  if (schema.includes('"planId"')) return { planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: ['test -f proof.txt'], riskChanges: [] };
  const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: readFileSync(path.join(process.cwd(), 'proof.txt'), 'utf8').trim() };
  return { verdict: 'pass', findingIds: [], summary: 'Proof matches', evidence: { findings: [],
    criteria: ['approved plan', 'checks', 'regressions', 'proof'].map(criterion => ({ criterion, status: 'pass', references: [reference] })) } };
}
