import { z } from 'zod';
import { AppServerTransport } from './app-server-transport.js';
import { admitIsolatedWorkspaceWrite } from '../workspace/write-admission.js';
import path from 'node:path';

const threadResponse = z.object({ thread: z.object({ id: z.string().min(1) }) });
const turnResponse = z.object({ turn: z.object({ id: z.string().min(1) }) });
type Admission = Parameters<typeof admitIsolatedWorkspaceWrite>[0];

/** Isolated-worktree writer for approved directory scopes only; callers must journal intent and serialize run transitions. */
export class CodexWorkspaceWriteAdapter {
  private readonly verified = new Map<string, { model: string; provider: string; workspace: string }>();
  constructor(private readonly transport: Pick<AppServerTransport, 'request'>) {}
  usesTransport(transport: Pick<AppServerTransport, 'request'>): boolean { return this.transport === transport; }
  async startVerifiedThread(model: string, provider: string, input: Admission, config?: Record<string, unknown>): Promise<string> {
    const grant = await admitIsolatedWorkspaceWrite(input);
    const result = z.object({ thread: z.object({ id: z.string().min(1) }), model: z.string(), modelProvider: z.string(),
      cwd: z.string(), approvalPolicy: z.literal('never'), sandbox: z.object({ type: z.literal('workspaceWrite') }) }).parse(
      await this.transport.request('thread/start', { cwd: grant.workspace, model, modelProvider: provider, sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: false, ...(config ? { config } : {}) }));
    if (result.model !== model || result.modelProvider !== provider || path.resolve(result.cwd) !== path.resolve(grant.workspace)) throw new Error('Effective writer configuration does not match the run binding');
    this.verified.set(result.thread.id, { model, provider, workspace: grant.workspace });
    return result.thread.id;
  }
  async resumeThread(threadId: string, model: string, input: Admission): Promise<void> {
    this.verified.delete(threadId);
    const grant = await admitIsolatedWorkspaceWrite(input);
    const response = await this.transport.request('thread/resume', { threadId, cwd: grant.workspace, model,
      sandbox: 'workspace-write', approvalPolicy: 'never' });
    if (threadResponse.parse(response).thread.id !== threadId) throw new Error('Resumed thread identity mismatch');
  }
  async resumeVerifiedThread(threadId: string, model: string, provider: string, input: Admission, config?: Record<string, unknown>): Promise<void> {
    this.verified.delete(threadId);
    const grant = await admitIsolatedWorkspaceWrite(input);
    const result = z.object({ thread: z.object({ id: z.string().min(1) }), model: z.string(), modelProvider: z.string(),
      cwd: z.string(), approvalPolicy: z.literal('never'), sandbox: z.object({ type: z.literal('workspaceWrite') }) }).parse(
      await this.transport.request('thread/resume', { threadId, cwd: grant.workspace, model, modelProvider: provider, sandbox: 'workspace-write', approvalPolicy: 'never', ...(config ? { config } : {}) }));
    if (result.thread.id !== threadId || result.model !== model || result.modelProvider !== provider || path.resolve(result.cwd) !== path.resolve(grant.workspace)) throw new Error('Effective writer configuration does not match the run binding');
    this.verified.set(threadId, { model, provider, workspace: grant.workspace });
  }
  assertBound(threadId: string, binding: { runner: string; provider: string; model: string; reasoning: string }, workspace: string): void {
    const verified = this.verified.get(threadId);
    if (binding.runner !== 'codex' || !verified || verified.model !== binding.model || verified.provider !== binding.provider || verified.workspace !== workspace) throw new Error('Writer thread has not been verified against the run binding');
  }
  async startTurn(threadId: string, prompt: string, effort: string, input: Admission, model?: string): Promise<string> {
    const grant = await admitIsolatedWorkspaceWrite(input);
    if (!input.coordinator.isCurrent(input.lease)) throw new Error('Workspace writer lease is stale');
    const response = await this.transport.request('turn/start', { threadId, cwd: grant.workspace, effort, ...(model ? { model } : {}),
      input: [{ type: 'text', text: prompt }],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: grant.writableRoots, networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
    return turnResponse.parse(response).turn.id;
  }
}
