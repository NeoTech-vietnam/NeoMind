import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TurnResult } from './codex-turn-events.js';
import { ClaudeStream, type ClaudeInit, type ClaudePermissionDenial } from './claude-stream.js';
import { workerEnvironment } from './worker-environment.js';
import type { ProcessScope } from './worker-scope.js';

/** A Claude Code executable that can be launched without a shell. */
export interface ClaudeExecutable { command: string; args: string[] }

/** Tool and permission policy for one turn, built by the policy layer; the transport only verifies its effect. */
export interface ClaudePolicy {
  /** Isolation, tool and permission arguments (`--tools`, `--permission-mode`, `--setting-sources`, ...). */
  args: string[];
  /** Settings document passed as `--settings`. */
  settings: unknown;
  /** Exact tool inventory `init` must report, excluding `StructuredOutput` (expected whenever a schema is set). */
  tools: string[];
  permissionMode: string;
}

export interface ClaudeTurnRequest {
  /** Allocated by the caller, whose identity is journaled before the turn starts. Used once. */
  scope: ProcessScope;
  workspace: string;
  model: string;
  effort: string;
  /** Session UUID: created with `--session-id` on the first turn, continued with `--resume` afterwards. */
  sessionId: string;
  resume: boolean;
  prompt: string;
  outputSchema?: unknown;
  policy: ClaudePolicy;
  executable?: ClaudeExecutable;
  env?: NodeJS.ProcessEnv;
  /** Every stream event after it was accepted (transcripts). Observation only: errors it throws are ignored. */
  observe?: (event: unknown) => void;
}

export interface ClaudeTurnResult extends TurnResult {
  model: string;
  structuredOutput?: unknown;
  costUsd?: number;
  permissionDenials: ClaudePermissionDenial[];
  toolErrors: string[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const delegationTools = new Set(['Task', 'Agent']);
/** Flags the transport owns; a policy that sets them could change the protocol, the session or the permission model. */
const reservedFlags = new Set(['-p', '--print', '--output-format', '--input-format', '--verbose', '--model', '--effort', '--session-id', '--resume', '-r',
  '--continue', '-c', '--fork-session', '--json-schema', '--settings', '--fallback-model', '--include-partial-messages', '--replay-user-messages',
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
/** Claude Code variables that are not credentials or provider selection; inheriting them would tie the worker to a parent session. */
const keptClaudeVariables = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH']);

/** Resolve the native Claude Code binary. A `.cmd`/npm shim is never used: it needs a shell and expands `%VAR%` in arguments. */
export function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): ClaudeExecutable {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [path.join(os.homedir(), '.local', 'bin', name), ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))];
  const found = candidates.find(candidate => path.isAbsolute(candidate) && existsSync(candidate));
  if (!found) throw new Error(`Claude Code (${name}) was not found in ~/.local/bin or on PATH`);
  return { command: found, args: [] };
}

/** Worker environment without the parent's Claude Code session linkage (session ids, IDE sockets, effort overrides). */
export function claudeEnvironment(base: NodeJS.ProcessEnv = workerEnvironment()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!/^CLAUDE/i.test(key) || keptClaudeVariables.has(key.toUpperCase())) env[key] = value;
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

/**
 * Claude Code validates `--json-schema` without the 2020-12 meta-schema and exits before `init` when `$schema` names it
 * (zod's default); the dialect marker is dropped, the schema itself is unchanged.
 */
export function claudeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !('$schema' in schema)) return schema;
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
}

/** Command-line arguments for one turn. The prompt is written to stdin, which keeps it out of the command line and its length limit. */
export function claudeArgs(request: Omit<ClaudeTurnRequest, 'scope' | 'prompt' | 'executable' | 'env'>): string[] {
  if (!uuidPattern.test(request.sessionId)) throw new Error('Claude session id must be a lowercase UUID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/.test(request.model)) throw new Error('Claude model name is invalid');
  if (!/^[a-z]+$/.test(request.effort)) throw new Error('Claude effort level is invalid');
  for (const arg of request.policy.args) if (reservedFlags.has(arg.split('=')[0]!)) throw new Error(`Claude policy cannot set ${arg.split('=')[0]}`);
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', request.model, '--effort', request.effort,
    request.resume ? '--resume' : '--session-id', request.sessionId,
    ...(request.outputSchema === undefined ? [] : ['--json-schema', JSON.stringify(claudeSchema(request.outputSchema))]),
    '--settings', JSON.stringify(request.policy.settings ?? {}), ...request.policy.args];
}

function comparablePath(value: string): string {
  let resolved = path.resolve(value);
  try { resolved = realpathSync.native(resolved); } catch { /* compare the lexical path */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function modelMatches(actual: string, requested: string): boolean { return actual === requested || actual.startsWith(`${requested}-`); }

export interface ClaudeInitExpectation { sessionId: string; model: string; workspace: string; permissionMode: string; tools: string[] }
/** Throws unless the session Claude Code actually started is the one requested: never accept output from a different configuration. */
export function verifyClaudeInit(init: ClaudeInit, expected: ClaudeInitExpectation): void {
  if (init.sessionId !== expected.sessionId) throw new Error('Claude started a different session than requested');
  if (!modelMatches(init.model, expected.model)) throw new Error(`Claude model ${init.model} does not match ${expected.model}`);
  if (comparablePath(init.cwd) !== comparablePath(expected.workspace)) throw new Error('Claude working directory does not match the workspace');
  if (init.permissionMode !== expected.permissionMode) throw new Error(`Claude permission mode ${init.permissionMode} does not match ${expected.permissionMode}`);
  if (init.mcpServers.length) throw new Error('Claude session exposes MCP servers');
  if (init.tools.some(tool => delegationTools.has(tool) || tool.startsWith('mcp__'))) throw new Error('Claude session exposes delegation or external tools');
  const actual = [...new Set(init.tools)].sort(), wanted = [...new Set(expected.tools)].sort();
  if (actual.length !== init.tools.length || actual.join('\n') !== wanted.join('\n')) throw new Error(`Claude tools [${actual.join(', ')}] do not match [${wanted.join(', ')}]`);
}

/**
 * One Claude Code turn: a single `claude -p` process inside a process scope. `start` resolves only after the
 * `init` event matched the request; any mismatch, protocol fault or unconfirmed stop fails the turn. When the
 * process ends, the scope must be confirmed empty before the result is returned.
 */
export class ClaudeTurn {
  readonly turnId = randomUUID();
  private readonly stream = new ClaudeStream();
  private fault?: Error;
  private exitCode: number | null = null;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private initSeen?: () => void;
  private stderrHead = '';

  private constructor(private readonly request: ClaudeTurnRequest, private readonly child: ChildProcessWithoutNullStreams) {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.fault) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { this.line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (buffer.length > 16 * 1024 * 1024) this.fail(new Error('Claude stream event too large'));
    });
    // Runtime stderr is never logged; only its first `Error:` line is kept to explain an exit before `init`.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (this.stderrHead.length < 4096) this.stderrHead += chunk.slice(0, 4096 - this.stderrHead.length); });
    child.stdin.on('error', () => { /* an early exit is reported through the exit code */ });
    this.closedPromise = new Promise(resolve => child.once('close', (code: number | null) => {
      if (!this.fault && buffer) this.line(buffer);
      this.exitCode = code; this.closed = true; resolve();
    }));
    child.stdin.end(request.prompt, 'utf8');
  }

  private line(text: string): void {
    if (this.fault) return;
    try {
      const hadInit = !!this.stream.init;
      this.stream.accept(text.replace(/\r$/, ''));
      if (!hadInit && this.stream.init) {
        verifyClaudeInit(this.stream.init, { sessionId: this.request.sessionId, model: this.request.model, workspace: this.request.workspace,
          permissionMode: this.request.policy.permissionMode, tools: [...this.request.policy.tools, ...(this.request.outputSchema === undefined ? [] : ['StructuredOutput'])] });
        this.initSeen?.();
      }
      for (const model of this.stream.models) if (!modelMatches(model, this.request.model)) throw new Error(`Claude answered with model ${model} instead of ${this.request.model}`);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
    if (this.request.observe && text.trim()) { try { this.request.observe(JSON.parse(text)); } catch { /* observation only */ } }
  }
  private fail(error: Error): void { this.fault ??= error; this.initSeen?.(); }

  /** Launch the turn in `request.scope` and wait for a verified `init`. */
  static async start(request: ClaudeTurnRequest): Promise<ClaudeTurn> {
    const executable = request.executable ?? resolveClaudeExecutable();
    const args = [...executable.args, ...claudeArgs(request)];
    const child = await request.scope.start({ command: executable.command, args, cwd: request.workspace, env: request.env ?? claudeEnvironment() });
    const turn = new ClaudeTurn(request, child);
    await Promise.race([turn.closedPromise, new Promise<void>(resolve => { turn.initSeen = resolve; if (turn.stream.init || turn.fault) resolve(); })]);
    if (turn.fault || !turn.stream.init) {
      const reason = /^Error: (.{1,300})/m.exec(turn.stderrHead)?.[1];
      const error = turn.fault ?? new Error(`Claude exited with code ${turn.exitCode} before reporting its configuration${reason ? `: ${reason}` : ''}`);
      throw await turn.halted(error);
    }
    return turn;
  }

  get init(): ClaudeInit { return this.stream.init!; }

  /** Stop every process of the turn; true only with proof that none is still running. */
  async interrupt(): Promise<boolean> { return this.request.scope.stop(); }

  private async halted(error: Error): Promise<Error> {
    return await this.interrupt() ? error : new Error(`${error.message}; Claude worker stop unconfirmed`);
  }

  /** Resolve with the terminal result; reject with `Run was interrupted` once `stopped()` is true, after stopping the scope. */
  async wait(stopped: () => boolean): Promise<ClaudeTurnResult> {
    while (true) {
      if (stopped()) {
        if (!await this.interrupt()) throw new Error('Run was interrupted; Claude worker stop unconfirmed');
        throw new Error('Run was interrupted');
      }
      if (this.fault) throw await this.halted(this.fault);
      if (this.closed) break;
      await Promise.race([this.closedPromise, new Promise(resolve => setTimeout(resolve, 50))]);
    }
    if (!await this.request.scope.stop()) throw new Error('Claude worker stop unconfirmed');
    const final = this.stream.final, init = this.stream.init!;
    if (!final) throw new Error(`Claude exited with code ${this.exitCode} before reporting a result`);
    if (final.sessionId !== this.request.sessionId) throw new Error('Claude result belongs to another session');
    const messages = [...this.stream.messages];
    let error: string | undefined;
    if (final.isError || final.subtype !== 'success') error = (final.result || final.subtype).slice(0, 2000);
    else if (this.exitCode !== 0) error = `Claude exited with code ${this.exitCode} after reporting success`;
    else if (this.request.outputSchema !== undefined) {
      if (final.structuredOutput === undefined) error = 'Claude returned no structured output';
      else messages.push(JSON.stringify(final.structuredOutput));
    } else if (final.result && messages.at(-1) !== final.result) messages.push(final.result);
    return { threadId: final.sessionId, turnId: this.turnId, status: error ? 'failed' : 'completed', messages, ...(error ? { error } : {}),
      ...(final.usage ? { usage: final.usage } : {}), model: init.model, ...(final.structuredOutput !== undefined ? { structuredOutput: final.structuredOutput } : {}),
      ...(final.costUsd !== undefined ? { costUsd: final.costUsd } : {}), permissionDenials: final.permissionDenials, toolErrors: [...this.stream.toolErrors] };
  }
}

/** Run one turn to completion: start, verify `init`, wait, and confirm the scope is empty. */
export async function runClaudeTurn(request: ClaudeTurnRequest, stopped: () => boolean = () => false): Promise<ClaudeTurnResult> {
  return (await ClaudeTurn.start(request)).wait(stopped);
}
