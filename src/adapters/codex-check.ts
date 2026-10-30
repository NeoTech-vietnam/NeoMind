import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerScope } from './worker-scope.js';
import { AppServerTransport } from './app-server-transport.js';
import { resolveHostCommand } from './worker-environment.js';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';

const responseSchema = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });
const specSchema = z.strictObject({ id: z.string().min(1), command: z.array(z.string().min(1)).min(1), cwd: z.string().min(1), timeoutMs: z.number().int().min(1).max(600000) });
export type CheckSpec = z.infer<typeof specSchema>;
export interface CheckResult { checkId: string; exitCode: number; stdout: string; stderr: string; outputHash: string }

/** Checks execute as argv in the owned worktree; uncertain transport outcomes must not be retried automatically. */
export class CodexCheckExecutor {
  constructor(private readonly transport: Pick<AppServerTransport, 'request'>) {}
  usesTransport(transport: Pick<AppServerTransport, 'request'>): boolean { return this.transport === transport; }
  async run(input: CheckSpec, workspaceInput: string, lease: WorkspaceLease, coordinator: WorkspaceCoordinator, scope: WorkerScope): Promise<CheckResult> {
    const spec = specSchema.parse(input), workspace = await realpath(workspaceInput), cwd = await realpath(spec.cwd);
    const relative = path.relative(workspace, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Check cwd must be inside workspace');
    if (workspace !== lease.workspace || !coordinator.isCurrent(lease)) throw new Error('Workspace lease is stale');
    if (scope.transport !== this.transport || !await scope.isActive()) throw new Error('Verified check scope is required');
    const command = resolveHostCommand(spec.command);
    let response: z.infer<typeof responseSchema>;
    try {
      response = responseSchema.parse(await this.transport.request('command/exec', { command, cwd,
        timeoutMs: spec.timeoutMs, outputBytesCap: 1024 * 1024,
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
      }, spec.timeoutMs + 5000));
    } catch (error) {
      if (!await scope.stop()) coordinator.quarantine(lease);
      throw error;
    }
    if (!await scope.stop()) { coordinator.quarantine(lease); throw new Error('Check worker stop is unconfirmed; workspace quarantined'); }
    if (!coordinator.isCurrent(lease)) throw new Error('Workspace lease changed during check');
    return { checkId: spec.id, ...response,
      outputHash: createHash('sha256').update(JSON.stringify(response)).digest('hex') };
  }
}
