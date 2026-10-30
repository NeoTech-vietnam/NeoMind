import path from 'node:path';
import type { BindingValues } from '../domain/resolve.js';
import type { WorkerFactory } from '../runtime/worker.js';
import type { AgentRunner, AgentRunnerFactory, RunnerId, VerifiedRunnerSession } from './agent-runner.js';
import { ClaudeRunnerFactory } from './claude-runner.js';
import { CodexRunnerFactory } from './codex-runner.js';

/** Runner factories by id; the effective binding's `runner` selects the factory for each dispatch. */
export class RunnerRegistry {
  private readonly factories = new Map<string, AgentRunnerFactory>();
  constructor(factories: Iterable<AgentRunnerFactory> = []) { for (const factory of factories) this.register(factory); }
  /** Add a factory, replacing any factory registered for the same runner id. */
  register(factory: AgentRunnerFactory): this { this.factories.set(factory.runner, factory); return this; }
  has(runner: string): boolean { return this.factories.has(runner); }
  get(runner: string): AgentRunnerFactory {
    const factory = this.factories.get(runner);
    if (!factory) throw new Error(`Unknown runner "${runner}"; supported runners: ${this.runners().join(', ') || 'none'}`);
    return factory;
  }
  runners(): RunnerId[] { return [...this.factories.keys()] as RunnerId[]; }
}

/** Codex (through `workerFactory`) and Claude Code. `workspace` is the project whose Codex configuration applies to model discovery. */
export function defaultRunnerRegistry(options: { workerFactory?: WorkerFactory; workspace?: string } = {}): RunnerRegistry {
  return new RunnerRegistry([new CodexRunnerFactory(options.workerFactory, options.workspace), new ClaudeRunnerFactory()]);
}

/** The session the dispatcher was given, if it is the one `sessionId` names and belongs to `runner`. */
export function verifiedSession(runner: AgentRunner | undefined, session: VerifiedRunnerSession | undefined, sessionId: string): { runner: AgentRunner; session: VerifiedRunnerSession } {
  if (!runner || !session || session.sessionId !== sessionId || session.runner !== runner.runner) throw new Error('Thread has not been verified against the run binding');
  return { runner, session };
}

/** A runner session serves a binding only if the runtime verified exactly its runner, provider, model and workspace. */
export function assertSessionBound(session: VerifiedRunnerSession, binding: BindingValues, workspace?: string): void {
  if (session.runner !== binding.runner || session.provider !== binding.provider || session.model !== binding.model ||
    (workspace !== undefined && path.resolve(session.workspace) !== path.resolve(workspace))) throw new Error('Thread has not been verified against the run binding');
}
