import { z } from 'zod';
import { AppServerTransport } from './app-server-transport.js';
import path from 'node:path';

const threadResponse = z.object({ thread: z.object({ id: z.string().min(1) }) });
const turnResponse = z.object({ turn: z.object({ id: z.string().min(1) }) });
const nonempty = z.string().min(1);
const verifiedThreadResponse = z.object({ thread: z.object({ id: nonempty }), model: nonempty,
  modelProvider: nonempty, cwd: nonempty, approvalPolicy: z.literal('never'), sandbox: z.object({ type: z.literal('readOnly') }) });

/** Initial Codex integration is deliberately read-only until write scopes and stop are verified. */
export class CodexReadOnlyAdapter {
  private readonly verified = new Map<string, { model: string; provider: string; workspace: string }>();
  constructor(private readonly transport: Pick<AppServerTransport, 'request'>) {}
  usesTransport(transport: Pick<AppServerTransport, 'request'>): boolean { return this.transport === transport; }

  /** Verify the server's effective settings, rather than treating request parameters as evidence. */
  async startVerifiedThread(workspace: string, model: string, provider: string, config?: Record<string, unknown>): Promise<string> {
    nonempty.parse(workspace); nonempty.parse(model); nonempty.parse(provider);
    const id = this.verifyThread(await this.transport.request('thread/start', {
      cwd: workspace, model, modelProvider: provider, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, ...(config ? { config } : {}),
    }), workspace, model, provider);
    this.verified.set(id, { model, provider, workspace: path.resolve(workspace) });
    return id;
  }

  async resumeVerifiedThread(threadId: string, workspace: string, model: string, provider: string, config?: Record<string, unknown>): Promise<string> {
    nonempty.parse(threadId); nonempty.parse(workspace); nonempty.parse(model); nonempty.parse(provider);
    this.verified.delete(threadId);
    const resumed = this.verifyThread(await this.transport.request('thread/resume', {
      threadId, cwd: workspace, model, modelProvider: provider, sandbox: 'read-only', approvalPolicy: 'never', ...(config ? { config } : {}),
    }), workspace, model, provider);
    if (resumed !== threadId) throw new Error('Resumed thread identity mismatch');
    this.verified.set(resumed, { model, provider, workspace: path.resolve(workspace) });
    return resumed;
  }

  private verifyThread(raw: unknown, workspace: string, model: string, provider: string): string {
    const response = verifiedThreadResponse.parse(raw);
    if (response.model !== model || response.modelProvider !== provider || path.resolve(response.cwd) !== path.resolve(workspace)) {
      throw new Error('Effective thread configuration does not match the requested binding');
    }
    return response.thread.id;
  }

  async startThread(workspace: string, model: string): Promise<string> {
    nonempty.parse(workspace); nonempty.parse(model);
    const response = await this.transport.request('thread/start', {
      cwd: workspace, model, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false,
    });
    return threadResponse.parse(response).thread.id;
  }

  async resumeThread(threadId: string, workspace: string, model: string): Promise<string> {
    nonempty.parse(threadId); nonempty.parse(workspace); nonempty.parse(model);
    this.verified.delete(threadId);
    const response = await this.transport.request('thread/resume', {
      threadId, cwd: workspace, model, sandbox: 'read-only', approvalPolicy: 'never',
    });
    const resumed = threadResponse.parse(response).thread.id;
    if (resumed !== threadId) throw new Error('Resumed thread identity mismatch');
    return resumed;
  }

  /** Caller must persist a dispatch intent before invoking this method; it never retries. */
  async startTurn(threadId: string, prompt: string, effort: string, outputSchema?: unknown): Promise<string> {
    nonempty.parse(threadId); nonempty.parse(prompt); nonempty.parse(effort);
    const response = await this.transport.request('turn/start', {
      threadId, effort, input: [{ type: 'text', text: prompt }], ...(outputSchema === undefined ? {} : { outputSchema }),
    });
    return turnResponse.parse(response).turn.id;
  }

  assertBound(threadId: string, binding: { runner: string; provider: string; model: string; reasoning: string }, workspace?: string): void {
    const verified = this.verified.get(threadId);
    if (binding.runner !== 'codex' || !verified || verified.model !== binding.model || verified.provider !== binding.provider || (workspace !== undefined && verified.workspace !== path.resolve(workspace))) {
      throw new Error('Thread has not been verified against the run binding');
    }
  }
  async startBoundTurn(threadId: string, prompt: string, binding: { runner: string; provider: string; model: string; reasoning: string }, outputSchema?: unknown): Promise<string> {
    this.assertBound(threadId, binding);
    nonempty.parse(prompt); nonempty.parse(binding.reasoning);
    const response = await this.transport.request('turn/start', { threadId, model: binding.model, effort: binding.reasoning,
      input: [{ type: 'text', text: prompt }], ...(outputSchema === undefined ? {} : { outputSchema }) });
    return turnResponse.parse(response).turn.id;
  }

  /** An accepted interrupt is not a confirmed stopped turn. Await a terminal event. */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    nonempty.parse(threadId); nonempty.parse(turnId);
    await this.transport.request('turn/interrupt', { threadId, turnId });
  }
}
