import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRuntimeInfo } from './runtime-info.js';
import { requestListForMonitor } from './workforce-requests.js';
import { nativeWorkPrepareSchema, prepareNativeWork } from './native-work.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function nativeLocalSetupStatus(root: string) { return {
  ready: false, configured: true, engine_ready: false, transport: 'vscode-native',
  version: createRuntimeInfo(root).package_version, checks: [{ label: 'Local harness', state: 'not-observed',
    summary: 'Open WF.PM in VS Code Local. The editor owns models, tool permissions and subagents. Setup makes no model call.' }],
  summary: 'Use Local WF.PM; live model readiness belongs to the actual native chat, without a background engine connection.',
}; }

/** MCP can query the same durable engineering state. Native agent dispatch
 * needs the editor-owned invocation token and remains in its LM tools. Expose
 * no legacy submit/auth/claim endpoints to a new Local project. */
export function createNativeLocalMcpServer(root: string) {
  const server = new McpServer({ name: 'workforce', version: createRuntimeInfo(root).package_version });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('request_status', {
    description: 'Read saved WorkForce requests and current evidence. This does not start workers or resume historical execution engines.',
    inputSchema: { request_id: z.string().optional() },
  }, input => {
    const value = requestListForMonitor(root);
    return result(input.request_id ? { ...value, requests: value.requests.filter(row =>
      ('request_id' in row && row.request_id === input.request_id) || row.workflow_id === input.request_id || row.request_key === input.request_id) } : value);
  });
  server.registerTool('work_prepare', {
    description: 'Find compatible prior WorkForce experience and qualified tools before planning. Advisory only; execute through native Local WorkForce tools.',
    inputSchema: nativeWorkPrepareSchema.shape,
  }, async input => result(await prepareNativeWork(root, input)));
  return server;
}
export async function startNativeLocalMcp(root: string) {
  await createNativeLocalMcpServer(root).connect(new StdioServerTransport());
}
