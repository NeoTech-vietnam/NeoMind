import { CodexTurnEvents, type TurnResult } from '../adapters/codex-turn-events.js';
import { SystemdScope, type WorkerScope } from '../adapters/systemd-scope.js';
import { z } from 'zod';

export interface RuntimeWorker { scope: WorkerScope; events: CodexTurnEvents; fault(): Error | undefined }
export type WorkerFactory = (workspace?: string) => Promise<RuntimeWorker>;

/** Disable external tools and delegation for this bounded local executor. */
export async function localToolConfiguration(_worker: RuntimeWorker): Promise<Record<string, unknown>> {
  // Capability restrictions are applied before app-server starts, so plugins
  // cannot retain connections established by the parent desktop context.
  return {};
}

export async function verifyLocalTools(worker: RuntimeWorker, threadId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const response = z.object({ data: z.array(z.object({ tools: z.record(z.string(), z.unknown()), resources: z.array(z.unknown()), resourceTemplates: z.array(z.unknown()) })), nextCursor: z.string().nullish() }).parse(
      await worker.scope.transport.request('mcpServerStatus/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }));
    if (response.data.some(server => Object.keys(server.tools).length || server.resources.length || server.resourceTemplates.length)) throw new Error('External MCP capabilities remain enabled for this session');
    cursor = response.nextCursor ?? undefined;
  } while (cursor);
}

export const startRuntimeWorker: WorkerFactory = async (workspace) => {
  const events = new CodexTurnEvents();
  let fault: Error | undefined;
  const bootstrap = await SystemdScope.start(() => {}, () => {});
  let names: string[];
  try {
    const response = z.object({ config: z.record(z.string(), z.unknown()) }).parse(await bootstrap.transport.request('config/read', { includeLayers: false, ...(workspace ? { cwd: workspace } : {}) }));
    names = Object.keys(z.record(z.string(), z.unknown()).parse(response.config.mcp_servers ?? {}));
  } finally { if (!await bootstrap.stop()) throw new Error('Configuration worker stop unconfirmed'); }
  if (names.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error('MCP server name cannot be safely disabled by this CLI');
  const disabled = ['apps', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'hooks', 'skill_mcp_dependency_install'];
  const overrides = [...disabled.flatMap(feature => ['--disable', feature]), '-c', 'web_search="disabled"', ...names.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`])];
  const scope = await SystemdScope.start((method, params) => {
    try { events.accept(method, params); } catch (error) { fault = error instanceof Error ? error : new Error(String(error)); }
  }, (_id, method) => { fault = new Error(`Runner đang chờ tương tác: ${method}`); }, overrides);
  return { scope, events, fault: () => fault };
};

export async function waitForTurn(worker: RuntimeWorker, threadId: string, turnId: string, stopped: () => boolean): Promise<TurnResult> {
  while (true) {
    if (stopped()) throw new Error('Run was interrupted');
    const fault = worker.fault(); if (fault) throw fault;
    const result = worker.events.result(threadId, turnId);
    if (result) {
      if (result.status !== 'completed') throw new Error(`Runner turn ${result.status}${result.error ? `: ${result.error}` : ''}`);
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
