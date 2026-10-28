import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { pluginRegistration, type PluginRegistration } from './plugin-control.js';
import { readInvocation, assertRouting } from './routing.js';
import { readAutomationPolicy } from './manager.js';
import { getRecord, hash, safePath } from './storage.js';
import { connectRea, callReaTool } from './rea.js';
import { adapterNodeCommand } from './adapters.js';
import { toolCatalog, type ProviderId } from './tools.js';
import { ControlledToolError, controlledPublicReferencePath, type ControlledBinding } from './controlled-tools.js';
import { prepareWorkForceCodeGraphProjection, workForceCodeGraphProjectionCurrent, closeWorkForceCodeGraphProjection,
  codeGraphProjectionServer, mapWorkForceCodeGraphResult, type WorkForceCodeGraphProjection } from './workforce-codegraph-projection.js';

const roleProviders: Record<string, readonly ProviderId[]> = {
  manager: ['rea', 'codegraph', 'context7'], requirements: ['rea', 'codegraph', 'context7'],
  architect: ['rea', 'codegraph', 'context7'], reviewer: ['rea', 'codegraph', 'context7'],
  developer: ['rea', 'codegraph', 'context7', 'playwright'], verifier: ['rea', 'codegraph', 'context7', 'playwright'],
};
export interface WorkForceCapabilityInput { provider: ProviderId; tool?: string; arguments?: Record<string, unknown> }
interface Connection { tools: Tool[]; call(name: string, args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }
/** Dependency injection is a host-side test seam, never a tool argument. */
export interface WorkForcePluginDependencies {
  registration: typeof pluginRegistration; invocation: typeof readInvocation; routing: typeof assertRouting;
  automation: typeof readAutomationPolicy; record: typeof getRecord;
  connect(root: string, id: ProviderId, registration: PluginRegistration): Promise<Connection>;
}
const denied = (message: string): never => { throw new ControlledToolError('PLUGIN_SCOPE_DENIED', message); };
const invalid = (message: string): never => { throw new ControlledToolError('PLUGIN_ARGUMENTS_INVALID', message); };
function publicPath(root: string, value: string): string {
  const path = isAbsolute(value) ? relative(root, value).split(sep).join('/') : value.replaceAll('\\', '/');
  if (path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..') || !controlledPublicReferencePath(path))
    denied('Plug-in file arguments must name ordinary public project paths.');
  let absolute: string;
  try { absolute = safePath(root, path); } catch { return denied('Plug-in file arguments must remain inside the bound public project.'); }
  for (let current = absolute; current !== resolve(root); current = resolve(current, '..')) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) denied('Plug-in file arguments cannot follow links.');
  }
  return path;
}
function scoped(path: string, scopes: string[]): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const target = normalize(path);
  return scopes.some(value => value === '.' || target === normalize(value) || target.startsWith(normalize(value).replace(/\/$/, '') + '/'));
}
async function connect(root: string, id: ProviderId, registration: PluginRegistration): Promise<Connection> {
  if (id === 'rea') {
    const rea = await connectRea(root);
    return { tools: [...rea.tools.values()], call: (name, args) => callReaTool(root, rea, name, args), close: () => rea.client.close() };
  }
  if (registration.status !== 'ready' || !registration.server) denied('The enabled plug-in must have a verified local registration.');
  const launch = registration.server!, client = new Client({ name: 'workforce-bound-plugin', version: '1' });
  const transport = new StdioClientTransport({ ...launch, command: launch.command === 'node' ? adapterNodeCommand(root) : launch.command,
    cwd: root, env: { ...getDefaultEnvironment(), ...launch.env }, stderr: 'pipe', maxBufferSize: 2 * 1024 * 1024 });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 20000 });
    const tools: Tool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20000 });
      if (result.tools.some(tool => tools.some(prior => prior.name === tool.name))) throw new Error('Duplicate tools.');
      tools.push(...result.tools); cursor = result.nextCursor;
      if (tools.length > 2048 || Buffer.byteLength(JSON.stringify(tools)) > 1024 * 1024) throw new Error('Catalog bounds.');
      if (!cursor) break;
    }
    if (cursor) throw new Error('Catalog bounds.');
    return { tools, call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 60000 }), close: () => client.close() };
  } catch { await client.close().catch(() => {}); throw new ControlledToolError('PLUGIN_UNAVAILABLE', 'The verified plug-in connection is unavailable. Continue with another permitted project tool.'); }
}

export function createWorkForcePluginGateway(dependencies: WorkForcePluginDependencies) {
  const sessions = new Map<string, { root: string; invocation: string; baseline: string; connection: Connection; projection?: WorkForceCodeGraphProjection }>();
  const connections = new Set<{ root: string; invocation: string; connection: Connection }>();
  const known = new Map<string, { root: string; invocation: string }>(), closed = new Set<string>();
  const authorize = (root: string, binding: ControlledBinding, provider: ProviderId) => {
    if (binding.process_contract !== 'workforce/v1' || !binding.invocation_id || !roleProviders[binding.role]?.includes(provider))
      denied('This WorkForce role cannot use the selected plug-in.');
    if (closed.has(`${resolve(root)}\0${binding.invocation_id}`)) denied('The plug-in assignment has ended.');
    const receipt = dependencies.invocation(root, binding.invocation_id!);
    dependencies.routing(root, binding.role, receipt.id, { workflow_id: binding.workflow_id, task_id: binding.task_id, require_completed: false });
    if (!['starting', 'running'].includes(receipt.state) || receipt.workflow_id !== binding.workflow_id || receipt.role !== binding.role ||
        receipt.task_id !== (binding.task_id ?? null) || receipt.controlled_execution?.process_contract !== 'workforce/v1' ||
        receipt.controlled_execution.stage !== binding.stage || !receipt.native_tool_scope.includes('capability_invoke'))
      denied('Plug-in invocation does not match the active backend-owned role and task.');
    return dependencies.automation(root);
  };
  const close = async (root?: string, invocation?: string) => {
    for (const [key, value] of known) if ((!root || value.root === resolve(root)) && (!invocation || value.invocation === invocation)) closed.add(key);
    for (const [key, session] of sessions) if ((!root || session.root === resolve(root)) && (!invocation || session.invocation === invocation)) {
      sessions.delete(key);
    }
    for (const connection of connections) if ((!root || connection.root === resolve(root)) && (!invocation || connection.invocation === invocation)) {
      connections.delete(connection); await connection.connection.close().catch(() => {});
    }
  };
  return { close, invoke: async (root: string, binding: ControlledBinding, input: WorkForceCapabilityInput): Promise<unknown> => {
    known.set(`${resolve(root)}\0${binding.invocation_id}`, { root: resolve(root), invocation: binding.invocation_id ?? '' });
    const policy = authorize(root, binding, input.provider);
    const provider = toolCatalog.find(item => item.id === input.provider);
    if (!provider) denied('Unknown approved plug-in.');
    if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) invalid('Plug-in arguments must be one JSON object.');
    if (Buffer.byteLength(JSON.stringify(input.arguments ?? {})) > 256 * 1024) invalid('Plug-in arguments exceed the supported size.');
    if (!input.tool && Object.keys(input.arguments ?? {}).length) invalid('Describe the provider without arguments before invoking an observed tool.');
    const registration = dependencies.registration(root, input.provider);
    if (registration.status !== 'ready') return { available: false, provider: input.provider, status: registration.status,
      next_action: 'Continue the assigned work with another available project tool. Plug-in installation or activation is a separate user-controlled setup action.' };
    if (input.provider === 'context7' && policy.network_policy !== 'remote-enabled')
      return { available: false, provider: input.provider, status: 'network-denied', next_action: 'Use local project documentation. Remote documentation requires the existing project network permission.' };
    if (input.tool && !(provider!.tools as readonly string[]).includes(input.tool)) denied('The selected tool is outside the reviewed provider allowlist.');
    const args = { ...input.arguments };
    if (input.provider === 'codegraph') {
      if (args.projectPath !== undefined && (typeof args.projectPath !== 'string' || resolve(args.projectPath) !== resolve(root)))
        denied('CodeGraph analysis belongs to the bound project only.');
    }
    if (input.provider === 'playwright' && input.tool === 'browser_navigate') {
      const allowed = binding.task_id ? dependencies.record(root, binding.task_id).meta.data.allowed_urls : undefined;
      if (typeof args.url !== 'string' || !Array.isArray(allowed) || !allowed.includes(args.url)) denied('Browser navigation needs an exact URL authorized by the saved task.');
      let url: URL; try { url = new URL(String(args.url)); } catch { return invalid('Use an authorized HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          policy.network_policy !== 'remote-enabled' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        denied('The project network policy does not allow this browser destination.');
    }
    const inspect = (name: string, value: unknown, depth = 0): void => {
      if (depth > 32) invalid('Plug-in arguments exceed the supported nesting depth.');
      if (Array.isArray(value)) { for (const item of value) inspect(name, item, depth + 1); return; }
      if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) inspect(key, item, depth + 1); return; }
      if (typeof value !== 'string') return;
      if (name === 'projectPath') { if (resolve(value) !== resolve(root)) denied('Every CodeGraph project identity must match the bound project.'); return; }
      if (!/(?:path|filename|directory|^file$|fileuri)/i.test(name)) return;
      let target = value;
      if (/^file:/i.test(target)) { try { target = fileURLToPath(target); } catch { invalid('Use a public project file URI.'); } }
      const path = publicPath(root, target);
      const writes = /output|destination/i.test(name) || input.provider === 'playwright' && /filename/i.test(name);
      if (writes) {
        const scopes = binding.role === 'developer' ? binding.implementation_paths : binding.role === 'verifier' ? binding.verification_paths : [];
        if (!scoped(path, scopes) || existsSync(safePath(root, path))) denied('Plug-in file output must be new and inside this role write scope.');
      } else if (!scoped(path, binding.read_paths ?? ['.'])) denied('Plug-in file input exceeds this assignment read scope.');
    };
    for (const [name, value] of Object.entries(args)) inspect(name, value);
    const key = `${resolve(root)}\0${binding.invocation_id}\0${input.provider}`;
    let session = sessions.get(key);
    let projection: WorkForceCodeGraphProjection | undefined, projectedRegistration = registration, connectionRoot = root;
    if (input.provider === 'codegraph') {
      const reusable = session?.baseline === hash(JSON.stringify({ server: registration.server, projection: session?.projection?.baseline })) ? session?.projection : undefined;
      const prepared = prepareWorkForceCodeGraphProjection(root, binding.read_paths ?? ['.'], reusable);
      if (!prepared.available) return { available: false, provider: 'codegraph', status: 'scope-projection-unavailable', reason: prepared.reason, next_action: prepared.next_action };
      projection = prepared.projection;
      const server = registration.server && codeGraphProjectionServer(root, registration.server, projection);
      if (!server) {
        if (projection !== session?.projection) closeWorkForceCodeGraphProjection(projection);
        return { available: false, provider: 'codegraph', status: 'unsupported-scoped-launch',
          next_action: 'Use project_search and project_read. The configured CodeGraph launcher cannot be projected safely; no unscoped server was opened.' };
      }
      projectedRegistration = { ...registration, server }; connectionRoot = projection.root;
      // Validated public input paths must also refer to captured files, rather
      // than forwarding an absolute original-root path around the snapshot.
      const projectArgument = (name: string, value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(item => projectArgument(name, item));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectArgument(key, child)]));
        if (typeof value !== 'string') return value;
        if (name === 'projectPath') return projection!.root;
        if (!/(?:path|filename|directory|^file$|fileuri)/i.test(name)) return value;
        const uri = /^file:/i.test(value), path = publicPath(root, uri ? fileURLToPath(value) : value);
        const captured = join(projection!.root, ...path.split('/'));
        if (!existsSync(captured)) throw new Error('The requested public input is not in the bounded CodeGraph source snapshot.');
        return uri ? pathToFileURL(captured).href : captured;
      };
      try { for (const [name, value] of Object.entries(args)) args[name] = projectArgument(name, value); }
      catch {
        if (projection !== session?.projection) closeWorkForceCodeGraphProjection(projection);
        return { available: false, provider: 'codegraph', status: 'unsupported-scoped-input',
          next_action: 'Use project_read for this input. CodeGraph accepts only files present in the current public source snapshot.' };
      }
      if (input.tool) args.projectPath = projection.root;
    }
    const baseline = hash(JSON.stringify({ server: registration.server, projection: projection?.baseline }));
    if (session && (session.baseline !== baseline || session.projection !== projection)) { sessions.delete(key); connections.delete(session); await session.connection.close(); session = undefined; }
    if (!session) {
      let original: Connection;
      try { original = await dependencies.connect(connectionRoot, input.provider, projectedRegistration); }
      catch (error) { if (projection) closeWorkForceCodeGraphProjection(projection); throw error; }
      const ownedProjection = projection, connection: Connection = { ...original, close: async () => {
        try { await original.close(); } finally { if (ownedProjection) closeWorkForceCodeGraphProjection(ownedProjection); }
      } };
      try { authorize(root, binding, input.provider); }
      catch (error) { await connection.close().catch(() => {}); throw error; }
      session = { root: resolve(root), invocation: binding.invocation_id!, baseline, connection, ...(projection ? { projection } : {}) }; sessions.set(key, session); connections.add(session);
    }
    const tools = session.connection.tools.filter(tool => (provider!.tools as readonly string[]).includes(tool.name));
    if (!input.tool) return { available: true, provider: input.provider, tools: tools.map(tool => {
      const schema = structuredClone(tool.inputSchema);
      // CodeGraph's project identity is backend-owned, not something the model
      // must reconstruct from a hidden runtime path.
      if (input.provider === 'codegraph') {
        if (schema.properties) delete schema.properties.projectPath;
        if (Array.isArray(schema.required)) schema.required = schema.required.filter(name => name !== 'projectPath');
      }
      return { name: tool.name, description: tool.description, input_schema: schema,
        ...(input.provider === 'codegraph' ? { backend_fields: ['projectPath'] } : {}) };
    }), execution_authorized: false };
    const definition = tools.find(tool => tool.name === input.tool);
    if (!definition) denied('The selected tool was not observed in the current approved provider.');
    if (!new AjvJsonSchemaValidator().getValidator(definition!.inputSchema as JsonSchemaType)(args).valid) invalid('Arguments do not match the observed provider schema; describe the provider and use its actual schema.');
    authorize(root, binding, input.provider);
    if (dependencies.registration(root, input.provider).status !== 'ready') denied('Plug-in policy changed before execution.');
    if (session.projection && !workForceCodeGraphProjectionCurrent(session.projection)) return { available: false, provider: 'codegraph', status: 'source-changed',
      next_action: 'Use current project_search/project_read or invoke CodeGraph again to refresh the public source snapshot.' };
    let result: unknown;
    try { result = await session.connection.call(input.tool, args); }
    catch { throw new ControlledToolError('PLUGIN_UNAVAILABLE', 'The plug-in did not return a usable result. Preserve current work and use another permitted tool.'); }
    authorize(root, binding, input.provider);
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) invalid('Plug-in result exceeds the gateway limit; request summary output or a narrower query.');
    if (session.projection && !workForceCodeGraphProjectionCurrent(session.projection)) return { available: false, provider: 'codegraph', status: 'source-changed',
      next_action: 'Public source changed during analysis. Use current project_search/project_read; this stale graph result is not current evidence.' };
    if (session.projection) {
      const mapped = mapWorkForceCodeGraphResult(session.projection, result);
      if (Buffer.byteLength(JSON.stringify(mapped)) > 1024 * 1024) return { available: false, provider: 'codegraph', status: 'result-too-large',
        next_action: 'Use project_search/project_read or request a narrower graph summary. The bounded gateway did not publish an oversized result.' };
      return mapped;
    }
    return result;
  } };
}
const gateway = createWorkForcePluginGateway({ registration: pluginRegistration, invocation: readInvocation, routing: assertRouting,
  automation: readAutomationPolicy, record: getRecord, connect });
export const invokeWorkForceCapability = gateway.invoke;
export const closeWorkForceCapabilities = gateway.close;
