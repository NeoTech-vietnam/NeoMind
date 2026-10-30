import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { CodexReadOnlyAdapter } from '../adapters/codex-readonly.js';
import { CodexWorkspaceWriteAdapter } from '../adapters/codex-workspace-write.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { CodexTranscriptMapper, type TranscriptEvent } from '../core/transcript.js';
import { resolveWindowsCodex } from '../adapters/worker-environment.js';
import { verifyRuntimeCapabilities } from '../runtime/capabilities.js';
import { localToolConfiguration, startRuntimeWorker, verifyLocalTools, waitForTurn, type RuntimeWorker, type WorkerFactory } from '../runtime/worker.js';
import type { AgentRunner, AgentRunnerFactory, AvailableRunnerModel, RunnerScope, RunnerSessionRequest, RunnerTurnRequest, VerifiedRunnerSession } from './agent-runner.js';

/** Codex models NeoMind may bind; anything else reported by `model/list` is ignored. */
export const codexModelAllowlist = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];

/**
 * Codex app-server behind the runner contract. One runner owns one worker scope (app-server process and every
 * descendant); threads are verified from the server's effective settings, never from the request.
 */
export class CodexRunner implements AgentRunner {
  readonly runner = 'codex' as const;
  readonly scope: RunnerScope;
  private readonly reader: CodexReadOnlyAdapter;
  private readonly writer: CodexWorkspaceWriteAdapter;
  /** Sessions this runner verified, by thread id; only the exact object returned by `openSession` is accepted. */
  private readonly sessions = new Map<string, VerifiedRunnerSession>();
  constructor(readonly worker: RuntimeWorker) {
    this.scope = worker.scope;
    this.reader = new CodexReadOnlyAdapter(worker.scope.transport);
    this.writer = new CodexWorkspaceWriteAdapter(worker.scope.transport);
  }
  async openSession(request: RunnerSessionRequest): Promise<VerifiedRunnerSession> {
    const { binding, access, workspace, resumeSessionId } = request;
    if (binding.runner !== 'codex') throw new Error(`Binding uses runner ${binding.runner}, not codex`);
    const config = await localToolConfiguration(this.worker);
    if (resumeSessionId) this.sessions.delete(resumeSessionId);
    let sessionId: string;
    if (access.kind === 'read') {
      sessionId = resumeSessionId ? await this.reader.resumeVerifiedThread(resumeSessionId, workspace, binding.model, binding.provider, config)
        : await this.reader.startVerifiedThread(workspace, binding.model, binding.provider, config);
    } else {
      const grant = { workspace, writableRoots: [...access.writableRoots] };
      if (resumeSessionId) { await this.writer.resumeGrantedThread(resumeSessionId, binding.model, binding.provider, grant, config); sessionId = resumeSessionId; }
      else sessionId = await this.writer.startGrantedThread(binding.model, binding.provider, grant, config);
    }
    const session: VerifiedRunnerSession = Object.freeze({ runner: 'codex', sessionId, workspace: path.resolve(workspace), model: binding.model, provider: binding.provider,
      access: access.kind === 'read' ? { kind: 'read' as const } : { kind: 'write' as const, writableRoots: [...access.writableRoots] } });
    this.sessions.set(sessionId, session);
    return session;
  }
  private owned(session: VerifiedRunnerSession): void {
    if (this.sessions.get(session.sessionId) !== session) throw new Error('Thread has not been verified against the run binding');
  }
  async startTurn(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string> {
    this.owned(session);
    if (session.access.kind === 'read') {
      return this.reader.startBoundTurn(session.sessionId, request.prompt, { runner: 'codex', provider: session.provider, model: session.model, reasoning: request.effort }, request.outputSchema);
    }
    if (request.outputSchema !== undefined) throw new Error('Codex writer turns do not take an output schema');
    return this.writer.startGrantedTurn(session.sessionId, request.prompt, request.effort, { workspace: session.workspace, writableRoots: session.access.writableRoots }, session.model);
  }
  waitForTurn(session: VerifiedRunnerSession, turnId: string, stopped: () => boolean): Promise<TurnResult> {
    this.owned(session);
    return waitForTurn(this.worker, session.sessionId, turnId, stopped);
  }
  async verifyNoDelegation(session: VerifiedRunnerSession): Promise<void> {
    this.owned(session);
    await verifyLocalTools(this.worker, session.sessionId);
  }
  /** Transcript events of the threads this runner verified, mapped from the app-server notifications. */
  observe(listener: (event: TranscriptEvent) => void): void {
    const mapper = new CodexTranscriptMapper();
    this.worker.events.observe((method, payload) => {
      const threadId = payload && typeof payload === 'object' ? (payload as { threadId?: unknown }).threadId : undefined;
      if (typeof threadId !== 'string' || !this.sessions.has(threadId)) return;
      for (const event of mapper.accept(method, payload)) listener(event);
    });
  }
  close(): Promise<boolean> { return this.scope.stop(); }
}

export class CodexRunnerFactory implements AgentRunnerFactory {
  readonly runner = 'codex' as const;
  /** `modelWorkspace` is the directory whose Codex configuration applies to model discovery. */
  constructor(private readonly workers: WorkerFactory = startRuntimeWorker, private readonly modelWorkspace?: string,
    private readonly capabilities: typeof verifyRuntimeCapabilities = verifyRuntimeCapabilities) {}
  async start(workspace: string): Promise<CodexRunner> { return new CodexRunner(await this.workers(workspace)); }
  async models(): Promise<AvailableRunnerModel[]> {
    const worker = await this.workers(this.modelWorkspace);
    try {
      const response = z.object({ data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })) }).parse(await worker.scope.transport.request('model/list', { limit: 100 }));
      return response.data.filter(model => codexModelAllowlist.includes(model.model))
        .map(model => ({ runner: 'codex', provider: 'openai', model: model.model, reasoning: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort) }));
    } finally { if (!await worker.scope.stop()) throw new Error('Model discovery worker stop unconfirmed'); }
  }
  verifyCapabilities() { return this.capabilities(); }
}

/** Cheap presence check for the Codex CLI (checks always run through Codex `command/exec`); returns why it is missing. */
export function codexUnavailableReason(): string | undefined {
  if (process.platform === 'win32') { try { resolveWindowsCodex(); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } }
  return spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 10000 }).status === 0 ? undefined : 'Codex CLI was not found on PATH';
}
