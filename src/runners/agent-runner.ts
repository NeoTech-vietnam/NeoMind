import type { TurnResult } from '../adapters/codex-turn-events.js';
import type { ScopeIdentity } from '../adapters/worker-scope.js';
import type { TranscriptEvent } from '../core/transcript.js';
import type { BindingValues } from '../domain/resolve.js';

/**
 * Runner-neutral contract between the NeoMind core and an agent runtime (Codex, Claude Code). Implementations must keep
 * the guarantees the core relies on; a runner that cannot prove one must fail instead of degrading silently.
 *
 * - The effective model, workspace, access and tool inventory are verified from the runtime, not from request parameters.
 * - Every runtime process belonging to a turn runs inside the worker scope whose identity was journaled before launch.
 * - No delegation (sub-agents, sessions) and no external tools (MCP, web) are available to the agent.
 */
export type RunnerId = 'codex' | 'claude-code';

/** What an agent may touch. Write access is limited to these existing directories inside the workspace. */
export type RunnerAccess = { kind: 'read' } | { kind: 'write'; writableRoots: string[] };

export interface RunnerSessionRequest {
  workspace: string;
  binding: BindingValues;
  access: RunnerAccess;
  /** Continue an existing runner session (Codex thread, Claude session) instead of starting one. */
  resumeSessionId?: string;
}

/** A session whose effective configuration the runner has verified (or will verify before accepting any turn output). */
export interface VerifiedRunnerSession {
  runner: RunnerId;
  sessionId: string;
  workspace: string;
  model: string;
  provider: string;
  access: RunnerAccess;
}

export interface RunnerTurnRequest {
  prompt: string;
  /** Reasoning effort from the binding (low/medium/high/...); runners map it to their own flag. */
  effort: string;
  /** JSON schema for structured output; the final message is the JSON document. */
  outputSchema?: unknown;
}

/**
 * The OS container for a runner's processes. Its identity can be allocated (and journaled) before any process starts;
 * `stop` must return true only with proof that no process of the scope is still running.
 */
export interface RunnerScope {
  identity: ScopeIdentity;
  isActive(): Promise<boolean>;
  stop(): Promise<boolean>;
}

export interface AgentRunner {
  readonly runner: RunnerId;
  /** The scope the next turn runs in; the core journals `scope.identity` before calling `startTurn`. */
  readonly scope: RunnerScope;
  openSession(request: RunnerSessionRequest): Promise<VerifiedRunnerSession>;
  /** Start a turn and return its runner turn id. Throws on any configuration mismatch detected at start. */
  startTurn(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string>;
  /** Resolve with the terminal result of the turn; reject with `Run was interrupted` once `stopped()` is true. */
  waitForTurn(session: VerifiedRunnerSession, turnId: string, stopped: () => boolean): Promise<TurnResult>;
  /** Fail if the session exposes delegation or external tools. Called after open and before every dispatch. */
  verifyNoDelegation(session: VerifiedRunnerSession): Promise<void>;
  /**
   * Receive transcript events (messages, reads, edits, commands) of this runner's turns as they happen. Observation only:
   * the listener must not throw and nothing it sees is trusted by the core.
   */
  observe?(listener: (event: TranscriptEvent) => void): void;
  /** Stop the scope and release the runner; same contract as `RunnerScope.stop`. */
  close(): Promise<boolean>;
}

export interface AvailableRunnerModel { runner: RunnerId; provider: string; model: string; reasoning: string[] }

export interface AgentRunnerFactory {
  readonly runner: RunnerId;
  /** Start a runner for one dispatch in `workspace`. */
  start(workspace: string): Promise<AgentRunner>;
  /** Models this runner may use on this host, already filtered by NeoMind's allowlist. */
  models(): Promise<AvailableRunnerModel[]>;
  /** Host capability probe; must prove the access limits and stop behaviour before any write is granted. */
  verifyCapabilities(): Promise<{ sandboxVerified: true; stopVerified: true }>;
}
