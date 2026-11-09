import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { callReaTool, connectRea, reaPin, reaToolAllowlist } from './rea.js';
import { atomicWrite, safePath } from './storage.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';

/** Keep engine identity and giant inline-evidence schemas outside the model
 * interface. These are a documented subset of the original unchanged tools;
 * the existing adapter still validates every resulting upstream request. */
export function reaNativeToolDefinition(tool: Tool): Tool {
  const object = (properties: Record<string, object>, required: string[] = []) =>
    ({ type: 'object' as const, additionalProperties: false, properties, ...(required.length ? { required } : {}) });
  let inputSchema: Tool['inputSchema'];
  if (tool.name === 'binary_session') inputSchema = object({ expected_package_version: { type: 'string', enum: [reaPin.version] } });
  else if (tool.name === 'analyze_javascript_application') inputSchema = object({
    input_path: { type: 'string', minLength: 1, maxLength: 4096 }, format: { type: 'string', enum: ['directory'] },
    detail: { type: 'string', enum: ['summary'] },
    source_paths: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 800 } },
    analysis_timeout_ms: { type: 'integer', minimum: 1, maximum: 45000 },
    max_heap_mb: { type: 'integer', enum: [256, 512] }, max_semantic_nodes: { type: 'integer', minimum: 1, maximum: 100000 },
  }, ['input_path']);
  else if (tool.name === 'inspect_analysis_view') inputSchema = object({
    source: object({ kind: { type: 'string', const: 'retained-evidence' }, evidence_id: { type: 'string', pattern: '^ev_[a-f0-9]{64}$' } }, ['kind', 'evidence_id']),
    view: { oneOf: [object({ kind: { type: 'string', const: 'summary' } }, ['kind']), object({
      kind: { type: 'string', const: 'page' }, collection: { type: 'string', const: 'modules' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, ['kind', 'collection'])] },
  }, ['source', 'view']);
  else if (tool.name === 'get_evidence_bundle') inputSchema = object({ detail: { type: 'string', enum: ['summary'] },
    filters: object({ evidence_id: { type: 'string', pattern: '^ev_[a-f0-9]{64}$' } }) });
  else throw Error('REA_NATIVE_TOOL_UNSUPPORTED');
  return { ...tool, inputSchema, description: `${tool.description ?? tool.name} WorkForce exposes public-directory summary analysis and same-session retained summaries/module pages only. Engine identity is supplied by the backend; do not construct server paths, digests or identity placeholders.` };
}
const validator = new AjvJsonSchemaValidator();
export function reaNativeArguments(name: string, input: Record<string, unknown>) {
  const definition = reaNativeToolDefinition({ name, inputSchema: { type: 'object' } });
  if (!validator.getValidator(definition.inputSchema as JsonSchemaType)(input).valid) throw Error('REA_NATIVE_INPUT_INVALID');
  return { ...input, ...(name === 'binary_session' ? { expected_package_version: reaPin.version } : {}) };
}

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
    return { tools: reaToolAllowlist.map(name => reaNativeToolDefinition(current.tools.get(name)!)) }; });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = reaNativeArguments(request.params.name, request.params.arguments ?? {});
      const value = await callReaTool(root, await original(), request.params.name, args, { signal: extra.signal });
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
