import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RunManager } from '../runtime/run-manager.js';
import { SESSION_TOOLS, sessionToolHandlers } from '../runtime/session-tools.js';
import { createEditorApi } from '../ui-server/server.js';
import { installShutdown } from './shutdown.js';

/** Drain active calls before closing resources, including when the client disconnects. */
export function toolCallLifecycle() {
  let stopping = false;
  const active = new Set<Promise<unknown>>();
  return {
    async call<T>(handler: () => Promise<T>): Promise<T> {
      if (stopping) throw new Error('MCP server is shutting down');
      const pending = Promise.resolve().then(handler);
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
    async drain(): Promise<void> {
      stopping = true;
      await Promise.allSettled(active);
    },
  };
}

export async function serveMcp(project: string): Promise<void> {
  let manager: Promise<RunManager> | undefined;
  const runs = () => manager ??= RunManager.open(project).catch(error => { manager = undefined; throw error; });
  // Approvals made through this server are journaled as coming from the MCP session, not from Nimbalyst.
  const handlers = sessionToolHandlers(runs, createEditorApi(project, runs), { approvalActor: 'local-user (MCP session)' });
  const tools = SESSION_TOOLS.filter(tool => !tool.panelOnly);
  const lifecycle = toolCallLifecycle();
  const server = new Server({ name: 'neomind', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({ name: `neomind_${tool.name}`, description: tool.description, inputSchema: tool.inputSchema as { type: 'object' } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name.replace(/^neomind_/, '');
    if (!tools.some(tool => `neomind_${tool.name}` === request.params.name)) throw new Error('Unknown tool');
    try {
      const result = await lifecycle.call(() => handlers[name]!(request.params.arguments ?? {}, { caller: 'agent' }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const draining = lifecycle.drain();
    try { await server.close(); } finally {
      await draining;
      if (manager) await (await manager).close();
    }
  })();
  const removeSignals = installShutdown(async () => close());
  try {
    await server.connect(transport);
    await new Promise<void>(resolve => process.stdin.once('end', resolve));
  } finally {
    removeSignals();
    await close();
  }
}
