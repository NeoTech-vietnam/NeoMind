import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { callReaTool, connectRea, reaToolAllowlist } from './rea.js';
import { atomicWrite, safePath } from './storage.js';

/** Native MCP facade over the existing reviewed static adapter. The original
 * REA process and retained analysis session stay together; target/resource
 * limits are identical for native and strict clients. */
export async function startReaNativeMcp(root: string) {
  root = realpathSync.native(root);
  let connection: Awaited<ReturnType<typeof connectRea>> | undefined;
  let connecting: Promise<Awaited<ReturnType<typeof connectRea>>> | undefined;
  const original = () => connection ? Promise.resolve(connection) : connecting ??= connectRea(root).then(value => connection = value)
    .finally(() => { connecting = undefined; });
  const server = new Server({ name: 'workforce-rea', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => { const current = await original();
    return { tools: reaToolAllowlist.map(name => current.tools.get(name)!) }; });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const value = await callReaTool(root, await original(), request.params.name, request.params.arguments ?? {}, { signal: extra.signal });
      // These four reviewed operations accept public artifacts or same-session
      // evidence IDs, never provider credentials. Retain actual results for
      // the engineering report without changing the original tool response.
      try {
        atomicWrite(safePath(root, `.neomind/native/rea/evidence/${randomUUID()}.json`), JSON.stringify({
          observed_at: new Date().toISOString(), tool: request.params.name,
          arguments: request.params.arguments ?? {}, result_sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), result: value,
        }, null, 2) + '\n');
      } catch { /* Optional audit storage cannot turn successful analysis into a retry. */ }
      return value;
    } catch {
      return { isError: true, content: [{ type: 'text' as const,
        text: 'REA analysis did not satisfy its observed schema, current installation, public target or resource bounds. Use the discovered schema and a smaller public artifact directory; retained successful results remain available.' }] };
    }
  });
  const transport = new StdioServerTransport();
  try { await server.connect(transport); }
  catch (error) { await connection?.client.close(); throw error; }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; try { await server.close(); }
    finally { await connecting?.catch(() => {}); await connection?.client.close(); } };
  const previousClose = transport.onclose;
  transport.onclose = () => { previousClose?.(); void close(); };
  return { close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--project') throw Error('Usage: rea-native-mcp --project ABSOLUTE_PROJECT');
  const host = await startReaNativeMcp(args[1]!);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void host.close().finally(() => { process.exitCode = 0; }); });
}
