import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ClaudeTurn, resolveClaudeExecutable, type ClaudeExecutable, type ClaudePolicy } from '../adapters/claude-cli.js';
import { claudeConfigDir, claudeEffort, claudeModel, claudeRunnerModels, claudeSettings, claudeTools, CLAUDE_FORBIDDEN_TOOLS, CLAUDE_PROVIDER } from '../adapters/claude-policy.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { claudeTranscriptEvents, type TranscriptEvent } from '../core/transcript.js';
import { allocateProcessScope, type ProcessScope } from '../adapters/worker-scope.js';
import { verifyClaudeCapabilities } from '../runtime/claude-capabilities.js';
import type { AgentRunner, AgentRunnerFactory, AvailableRunnerModel, RunnerAccess, RunnerScope, RunnerSessionRequest, RunnerTurnRequest, VerifiedRunnerSession } from './agent-runner.js';

/** Isolation and tool flags for a turn; model, effort and settings are passed by the transport. */
export function claudeTurnPolicy(workspace: string, access: RunnerAccess, configDir = claudeConfigDir()): ClaudePolicy {
  const tools = claudeTools(access);
  if (tools.some(tool => CLAUDE_FORBIDDEN_TOOLS.includes(tool))) throw new Error('Claude policy grants a forbidden tool');
  return { args: ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--tools', tools.join(',')],
    settings: claudeSettings(workspace, access, configDir), tools, permissionMode: 'dontAsk' };
}

/** Claude Code stores a session under its cwd; a session that never reached disk (or lives under another cwd) cannot be resumed. */
export function claudeSessionStored(workspace: string, sessionId: string, configDir = claudeConfigDir()): boolean {
  return existsSync(path.join(configDir, 'projects', path.resolve(workspace).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`));
}

/**
 * The runner's scope before and during its single turn. Nothing runs until `startTurn`, so the scope counts as active
 * until it is stopped or its process has ended; the identity is fixed at allocation so it can be journaled first.
 */
class ClaudeRunnerScope implements RunnerScope {
  private stopped = false;
  started = false;
  constructor(readonly process: ProcessScope) {}
  get identity() { return this.process.identity; }
  async isActive(): Promise<boolean> { return !this.stopped && (!this.started || await this.process.isActive()); }
  async stop(): Promise<boolean> { this.stopped = true; return this.process.stop(); }
}

/**
 * Claude Code behind the runner contract: one `claude -p` process per dispatch, inside a process scope allocated
 * before the turn. The effective model, cwd, permission mode and tool inventory are verified from `system/init`
 * before the turn is accepted; access is limited by tools and permission rules proved by the capability probe.
 */
export class ClaudeRunner implements AgentRunner {
  readonly runner = 'claude-code' as const;
  readonly scope: ClaudeRunnerScope;
  private readonly sessions = new Map<string, { session: VerifiedRunnerSession; resume: boolean }>();
  private turn?: ClaudeTurn;
  private listener?: (event: TranscriptEvent) => void;
  constructor(process: ProcessScope, private readonly executable?: ClaudeExecutable, private readonly env?: NodeJS.ProcessEnv,
    private readonly configDir = claudeConfigDir()) { this.scope = new ClaudeRunnerScope(process); }

  async openSession(request: RunnerSessionRequest): Promise<VerifiedRunnerSession> {
    const { binding, access, resumeSessionId } = request, workspace = path.resolve(request.workspace);
    if (binding.runner !== 'claude-code') throw new Error(`Binding uses runner ${binding.runner}, not claude-code`);
    if (binding.provider !== CLAUDE_PROVIDER) throw new Error(`Claude Code uses provider ${CLAUDE_PROVIDER}, not ${binding.provider}`);
    claudeModel(binding.model); claudeTurnPolicy(workspace, access, this.configDir);
    // A session id handed out earlier is reused even if its first turn never ran, so the session group keeps one id.
    const sessionId = resumeSessionId ?? randomUUID(), resume = !!resumeSessionId && claudeSessionStored(workspace, sessionId, this.configDir);
    const session: VerifiedRunnerSession = Object.freeze({ runner: 'claude-code', sessionId, workspace, model: binding.model, provider: binding.provider,
      access: access.kind === 'read' ? { kind: 'read' as const } : { kind: 'write' as const, writableRoots: [...access.writableRoots] } });
    this.sessions.set(sessionId, { session, resume });
    return session;
  }
  private owned(session: VerifiedRunnerSession) {
    const entry = this.sessions.get(session.sessionId);
    if (entry?.session !== session) throw new Error('Thread has not been verified against the run binding');
    return entry;
  }
  async startTurn(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string> {
    const { resume } = this.owned(session);
    if (this.turn || this.scope.started) throw new Error('Claude runner runs one turn per dispatch');
    if (!await this.scope.isActive()) throw new Error('Claude worker scope was stopped');
    this.scope.started = true;
    this.turn = await ClaudeTurn.start({ scope: this.scope.process, workspace: session.workspace, model: claudeModel(session.model), effort: claudeEffort(request.effort),
      sessionId: session.sessionId, resume, prompt: request.prompt, ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      policy: claudeTurnPolicy(session.workspace, session.access, this.configDir), executable: this.executable ?? resolveClaudeExecutable(), ...(this.env ? { env: this.env } : {}),
      ...(this.listener ? { observe: (event: unknown) => { for (const item of claudeTranscriptEvents(event)) this.listener!(item); } } : {}) });
    return this.turn.turnId;
  }
  async waitForTurn(session: VerifiedRunnerSession, turnId: string, stopped: () => boolean): Promise<TurnResult> {
    this.owned(session);
    if (!this.turn || this.turn.turnId !== turnId) throw new Error('Turn does not belong to this runner');
    return this.turn.wait(stopped);
  }
  /** Tools are fixed per turn by `--tools`; `system/init` is verified again when the turn starts. */
  async verifyNoDelegation(session: VerifiedRunnerSession): Promise<void> {
    this.owned(session);
    if (claudeTurnPolicy(session.workspace, session.access, this.configDir).tools.some(tool => tool === 'Task' || tool === 'Agent' || tool.startsWith('mcp__'))) throw new Error('Claude session exposes delegation');
  }
  /** Transcript events of the turn, mapped from its `stream-json` events; must be called before `startTurn`. */
  observe(listener: (event: TranscriptEvent) => void): void { this.listener = listener; }
  close(): Promise<boolean> { return this.scope.stop(); }
}

export class ClaudeRunnerFactory implements AgentRunnerFactory {
  readonly runner = 'claude-code' as const;
  /** `configDir` must be the Claude config directory of `env` (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
  constructor(private readonly options: { executable?: ClaudeExecutable; env?: NodeJS.ProcessEnv; configDir?: string; scopes?: () => Promise<ProcessScope>;
    capabilities?: () => Promise<{ sandboxVerified: true; stopVerified: true }> } = {}) {}
  async start(): Promise<ClaudeRunner> {
    const executable = this.options.executable ?? resolveClaudeExecutable();
    return new ClaudeRunner(await (this.options.scopes ?? allocateProcessScope)(), executable, this.options.env, this.options.configDir);
  }
  async models(): Promise<AvailableRunnerModel[]> {
    if (!this.options.executable) resolveClaudeExecutable();
    return claudeRunnerModels();
  }
  verifyCapabilities() { return (this.options.capabilities ?? verifyClaudeCapabilities)(); }
}
