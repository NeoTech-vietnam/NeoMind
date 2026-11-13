import { randomUUID } from 'node:crypto';
import type { TurnResult } from '../../src/adapters/codex-turn-events.js';
import type { AgentRunner, AgentRunnerFactory, AvailableRunnerModel, RunnerAccess, RunnerId, RunnerScope, RunnerSessionRequest, RunnerTurnRequest, VerifiedRunnerSession } from '../../src/runners/agent-runner.js';
import type { BindingValues } from '../../src/domain/resolve.js';

export const fakeBinding: BindingValues = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };

/** An in-memory scope with a journal-valid identity; `stop` decides whether the stop is confirmed. */
export function fakeScope(stop: () => Promise<boolean> = async () => true): RunnerScope {
  let active = true;
  const id = randomUUID();
  return { identity: { unit: `neomind-run-${id}.scope`, controlGroup: `/user.slice/fake-${id}.scope` },
    isActive: async () => active, stop: async () => { active = false; return stop(); } };
}

export interface FakeRunnerBehaviour {
  /** Start a turn and return its id; throw to simulate an uncertain dispatch. Defaults to a fresh id. */
  startTurn?(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string>;
  /** The turn's final agent message. Defaults to "done". */
  respond?(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string> | string;
  /** Return a terminal failure without pretending that partial output was completed. */
  failure?(session: VerifiedRunnerSession, request: RunnerTurnRequest): string | undefined;
  /** Tokens each turn adds to its session's cumulative usage (a quarter of them output); omitted reports no usage. */
  tokensPerTurn?: number;
}

/** Turns per session of every runner sharing one behaviour (one factory), like a runtime's own session history. */
const sessionTurns = new WeakMap<FakeRunnerBehaviour, Map<string, number>>();

/** A runner with no runtime behind it: sessions are "verified" as requested and turns complete with `respond`. */
export class FakeRunner implements AgentRunner {
  readonly opened: VerifiedRunnerSession[] = [];
  readonly turns: { session: VerifiedRunnerSession; request: RunnerTurnRequest; turnId: string }[] = [];
  private readonly sessions = new Map<string, VerifiedRunnerSession>();
  private readonly results = new Map<string, Promise<TurnResult>>();
  constructor(readonly runner: RunnerId = 'codex', readonly scope: RunnerScope = fakeScope(), private readonly behaviour: FakeRunnerBehaviour = {}) {}
  async openSession(request: RunnerSessionRequest): Promise<VerifiedRunnerSession> {
    if (request.binding.runner !== this.runner) throw new Error(`Binding uses runner ${request.binding.runner}, not ${this.runner}`);
    const session: VerifiedRunnerSession = Object.freeze({ runner: this.runner, sessionId: request.resumeSessionId ?? randomUUID(), workspace: request.workspace,
      model: request.binding.model, provider: request.binding.provider, access: structuredClone(request.access) });
    this.sessions.set(session.sessionId, session); this.opened.push(session);
    return session;
  }
  private owned(session: VerifiedRunnerSession) { if (this.sessions.get(session.sessionId) !== session) throw new Error('Thread has not been verified against the run binding'); }
  async startTurn(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string> {
    this.owned(session);
    const turnId = this.behaviour.startTurn ? await this.behaviour.startTurn(session, request) : randomUUID();
    this.turns.push({ session, request, turnId });
    const respond = this.behaviour.respond ?? (() => 'done');
    const result = Promise.resolve().then(async () => {
      const error = this.behaviour.failure?.(session, request);
      return error ? { threadId: session.sessionId, turnId, status: 'failed' as const, messages: [], error, ...this.usage(session) }
        : { threadId: session.sessionId, turnId, status: 'completed' as const, messages: [await respond(session, request)], ...this.usage(session) };
    });
    result.catch(() => {}); this.results.set(turnId, result);
    return turnId;
  }
  async waitForTurn(session: VerifiedRunnerSession, turnId: string, stopped: () => boolean): Promise<TurnResult> {
    this.owned(session);
    if (stopped()) throw new Error('Run was interrupted');
    const result = this.results.get(turnId);
    if (!result) throw new Error('Unknown turn');
    return result;
  }
  /** Runners report cumulative usage per session, so a session resumed by a later runner keeps counting up. */
  private usage(session: VerifiedRunnerSession) {
    const step = this.behaviour.tokensPerTurn;
    if (!step) return {};
    const counts = sessionTurns.get(this.behaviour) ?? new Map<string, number>(); sessionTurns.set(this.behaviour, counts);
    const turns = (counts.get(session.sessionId) ?? 0) + 1, output = Math.floor(step / 4) * turns, total = step * turns;
    counts.set(session.sessionId, turns);
    return { usage: { inputTokens: total - output, outputTokens: output, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total } };
  }
  async verifyNoDelegation(session: VerifiedRunnerSession): Promise<void> { this.owned(session); }
  close(): Promise<boolean> { return this.scope.stop(); }
}

export class FakeRunnerFactory implements AgentRunnerFactory {
  readonly started: FakeRunner[] = [];
  constructor(readonly runner: RunnerId, private readonly behaviour: FakeRunnerBehaviour = {}, private readonly available: AvailableRunnerModel[] = []) {}
  async start(): Promise<FakeRunner> { const runner = new FakeRunner(this.runner, fakeScope(), this.behaviour); this.started.push(runner); return runner; }
  async models(): Promise<AvailableRunnerModel[]> { return this.available; }
  async verifyCapabilities() { return { sandboxVerified: true as const, stopVerified: true as const }; }
}

/** A fake runner with one session already open under `sessionId`, for dispatch fixtures. */
export async function fakeRunnerSession(sessionId: string, options: { startTurn?: FakeRunnerBehaviour['startTurn']; workspace?: string; access?: RunnerAccess; scope?: RunnerScope } = {}) {
  const runner = new FakeRunner('codex', options.scope ?? fakeScope(), options.startTurn ? { startTurn: options.startTurn } : {});
  const session = await runner.openSession({ workspace: options.workspace ?? process.cwd(), binding: fakeBinding, access: options.access ?? { kind: 'read' }, resumeSessionId: sessionId });
  return { runner, session };
}
