import { realpathSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { discoverRuntime } from './runtime-discovery.mjs';
import { pluginVersion } from './version.mjs';

const intakeNames = new Set(['request_submit', 'request_status', 'request_control']);
const connectionTool = {
  name: 'workforce_connection',
  description: 'Check WorkForce MCP setup without model inference. Uses the workspace folders exposed by this client. Select workspace_uri only when several folders are open.',
  inputSchema: { type: 'object', properties: { workspace_uri: { type: 'string', description: 'Exact file URI returned in roots when workspace selection is required.' } }, additionalProperties: false },
};
const problem = (code, summary, extra = {}) => ({ state: 'needs-setup', code, summary, ...extra });
const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
class ConnectionIssue extends Error {
  constructor(value) { super(value.summary); this.value = value; }
}

/** The installed runtime remains the sole implementation of intake tools. */
async function connectRuntime({ runtime, root, timeout }) {
  const client = new Client({ name: 'WorkForce Agent Plugin', version: pluginVersion });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(runtime, 'dist/cli.js'), 'mcp', '--project', root], cwd: root, stderr: 'pipe' });
  // Never send subprocess diagnostics, endpoint data or environment to chat.
  transport.stderr?.resume();
  try {
    await client.connect(transport, { timeout });
    if (client.getServerVersion()?.name !== 'workforce') throw new Error('BACKEND_IDENTITY');
  }
  catch { await client.close().catch(() => {}); await transport.close().catch(() => {}); throw new Error('BACKEND_CONNECT'); }
  return {
    info: client.getServerVersion(),
    listTools: () => client.listTools(undefined, { timeout }),
    callTool: (input, options = {}) => client.callTool(input, undefined, { timeout, ...options }),
    close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); },
  };
}

/** One client connection owns one root selection and isolated runtime transport.
 * Roots are scope observations; the installed runtime still enforces policy. */
export function createPluginServer(options = {}) {
  const resolveRuntime = options.discoverRuntime ?? discoverRuntime;
  const connectBackend = options.connectBackend ?? connectRuntime;
  const rootsTimeout = options.rootsTimeoutMs ?? 5000, backendTimeout = options.backendTimeoutMs ?? 30000;
  const server = new Server({ name: 'workforce-agent-plugin', version: pluginVersion }, { capabilities: { tools: { listChanged: true } } });
  let initialized = false, closed = false, scopeVersion = 0, rootsFingerprint, selectedUri, current, connecting;
  const leases = new Set(), pendingConnections = new Set();
  const closeLease = async lease => { if (!lease.closing) lease.closing = Promise.resolve().then(() => lease.backend.close()).catch(() => {}); await lease.closing; leases.delete(lease); };
  const retire = lease => { if (!lease) return; lease.retired = true; if (!lease.active) void closeLease(lease); };
  const invalidate = () => { scopeVersion++; selectedUri = undefined; rootsFingerprint = undefined; retire(current); current = undefined; };

  server.oninitialized = () => { initialized = true; };
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    invalidate();
    if (!closed) await server.sendToolListChanged().catch(() => {});
  });

  async function clientRoots() {
    if (!initialized) throw new ConnectionIssue(problem('INITIALIZING', 'Wait for the MCP client to finish initialization.'));
    if (!server.getClientCapabilities()?.roots) throw new ConnectionIssue(problem('ROOTS_UNSUPPORTED', 'Use a client with MCP Roots, such as VS Code Local, and open the intended folder.'));
    const requestedVersion = scopeVersion;
    let response;
    try { response = await server.listRoots(undefined, { timeout: rootsTimeout }); }
    catch { throw new ConnectionIssue(problem('ROOTS_UNAVAILABLE', 'VS Code did not return its workspace folders. Reconnect this MCP server after opening the intended folder.')); }
    if (requestedVersion !== scopeVersion) throw new ConnectionIssue(problem('WORKSPACE_CHANGED', 'The workspace changed while its folders were being read. Check workforce_connection again.'));
    const unique = new Map();
    for (const item of response.roots ?? []) {
      try {
        const uri = new URL(item.uri);
        if (uri.protocol !== 'file:' || uri.search || uri.hash) continue;
        const root = realpathSync.native(fileURLToPath(uri));
        if (!lstatSync(root).isDirectory()) continue;
        const canonical = pathToFileURL(root).href;
        unique.set(canonical, { uri: canonical, root, name: typeof item.name === 'string' ? item.name.slice(0, 256) : undefined, sourceUri: item.uri });
      } catch { /* Inaccessible roots never fall back to cwd or plugin files. */ }
    }
    const roots = [...unique.values()].sort((a, b) => a.uri.localeCompare(b.uri));
    const fingerprint = JSON.stringify(roots.map(item => item.uri));
    if (rootsFingerprint !== undefined && rootsFingerprint !== fingerprint) invalidate();
    rootsFingerprint = fingerprint;
    return roots;
  }

  async function context(workspaceUri) {
    const roots = await clientRoots();
    const publicRoots = roots.map(({ uri, name }) => ({ uri, ...(name ? { name } : {}) }));
    if (!roots.length) throw new ConnectionIssue(problem('OPEN_WORKSPACE', 'Open the intended local project folder in VS Code, then reconnect WorkForce.', { roots: publicRoots }));
    if (workspaceUri !== undefined) {
      const chosen = roots.find(item => item.uri === workspaceUri || item.sourceUri === workspaceUri);
      if (!chosen) throw new ConnectionIssue(problem('WORKSPACE_NOT_EXPOSED', 'Select an exact workspace URI returned by this MCP client.', { roots: publicRoots }));
      if (selectedUri !== chosen.uri) { retire(current); current = undefined; scopeVersion++; }
      selectedUri = chosen.uri;
    }
    const selected = roots.find(item => item.uri === selectedUri) ?? (roots.length === 1 ? roots[0] : undefined);
    if (!selected) throw new ConnectionIssue(problem('SELECT_WORKSPACE', 'Several workspace folders are open. Choose one returned URI with workforce_connection.', { roots: publicRoots }));
    let project;
    try {
      const path = join(selected.root, '.workforce/config.json');
      const directory = lstatSync(join(selected.root, '.workforce')), file = lstatSync(path);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024) throw new Error();
      project = JSON.parse(readFileSync(path, 'utf8'));
      if (project?.execution_engine !== 'opencode' || !Array.isArray(project.platforms) || !project.platforms.includes('copilot')) throw new Error();
    } catch { throw new ConnectionIssue(problem('INITIALIZE_WORKSPACE', 'Initialize this folder with the installed WorkForce runtime for Copilot before connecting. Existing project files were not changed.', { workspace_uri: selected.uri })); }
    const selectedVersion = scopeVersion;
    const found = await resolveRuntime();
    if (selectedVersion !== scopeVersion) throw new ConnectionIssue(problem('WORKSPACE_CHANGED', 'The workspace changed while the runtime was being located. Check workforce_connection again.'));
    if (found?.state !== 'ready' || typeof found.runtime !== 'string') {
      const codes = { missing: 'RUNTIME_NOT_CONFIGURED', invalid: 'INVALID_RUNTIME', ambiguous: 'AMBIGUOUS_RUNTIME' };
      throw new ConnectionIssue(problem(codes[found?.state] ?? 'RUNTIME_NOT_CONFIGURED',
        found?.summary ?? 'Install the WorkForce runtime and set the User setting workforce.bridge.runtimePath to its package directory.'));
    }
    return { ...selected, runtime: found.runtime, version: selectedVersion };
  }

  async function acquire(selection) {
    if (closed) throw new ConnectionIssue(problem('CONNECTION_CLOSED', 'Reconnect the WorkForce MCP server.'));
    const key = JSON.stringify([selection.root, selection.runtime]);
    if (current?.key === key && !current.retired) return current;
    if (!connecting || connecting.key !== key || connecting.version !== selection.version) {
      retire(current); current = undefined;
      const operation = { key, version: selection.version };
      operation.promise = (async () => {
        let backend, lease;
        try {
          backend = await connectBackend({ runtime: selection.runtime, root: selection.root, timeout: backendTimeout });
          const listed = await backend.listTools();
          const tools = listed.tools?.filter(tool => intakeNames.has(tool.name)) ?? [];
          if (tools.length !== 3 || new Set(tools.map(tool => tool.name)).size !== 3) throw new Error();
          lease = { key, backend, tools, active: 0, retired: false };
          leases.add(lease);
          if (closed || selection.version !== scopeVersion) {
            await closeLease(lease);
            throw new ConnectionIssue(problem('WORKSPACE_CHANGED', 'The workspace changed during connection. Check workforce_connection before submitting work.'));
          }
          current = lease;
          return lease;
        } catch (error) {
          if (lease) await closeLease(lease);
          else await backend?.close().catch(() => {});
          if (error instanceof ConnectionIssue) throw error;
          throw new ConnectionIssue(problem('RUNTIME_CONNECTION_FAILED', 'The selected WorkForce runtime did not complete MCP initialization. Check its installation and Node.js version; no request was submitted.'));
        }
      })();
      pendingConnections.add(operation.promise);
      void operation.promise.finally(() => {
        pendingConnections.delete(operation.promise);
        if (connecting === operation) connecting = undefined;
      }).catch(() => {});
      connecting = operation;
    }
    return connecting.promise;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const lease = await acquire(await context());
      return { tools: [connectionTool, ...lease.tools] };
    } catch { return { tools: [connectionTool] }; }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: input = {} } = request.params;
    if (name !== connectionTool.name && !intakeNames.has(name)) return result(problem('UNKNOWN_TOOL', 'Use the WorkForce connection or intake tools advertised by this server.'), true);
    if (name === connectionTool.name && (typeof input !== 'object' || input === null || Array.isArray(input) ||
        Object.keys(input).some(key => key !== 'workspace_uri') || input.workspace_uri !== undefined && typeof input.workspace_uri !== 'string'))
      return result(problem('INVALID_CONNECTION_INPUT', 'Use an empty object, or the exact workspace_uri returned in the roots list.'), true);
    try {
      const selection = await context(name === connectionTool.name ? input.workspace_uri : undefined);
      const lease = await acquire(selection);
      if (name === connectionTool.name) {
        await server.sendToolListChanged().catch(() => {});
        return result({ state: 'ready', code: 'CONNECTED', workspace_uri: selection.uri, workspace: selection.root,
          runtime: selection.runtime,
          ...(typeof lease.backend.info?.version === 'string' ? { runtime_version: lease.backend.info.version.slice(0, 64) } : {}),
          summary: 'Project-bound MCP connected. Model access and worker execution still require WorkForce: Connect Workspace in VS Code.' });
      }
      if (selection.version !== scopeVersion || lease.retired) throw new ConnectionIssue(problem('WORKSPACE_CHANGED', 'The workspace changed before dispatch. Check workforce_connection; no tool was dispatched.'));
      lease.active++;
      try { return await lease.backend.callTool({ name, arguments: input }, { signal: extra.signal }); }
      catch {
        if (current === lease) current = undefined;
        retire(lease);
        return result(problem('DELIVERY_UNCERTAIN', 'The runtime tool reply was interrupted. Preserve this workspace and check request_status before resubmitting; never repeat a new request automatically.'), true);
      }
      finally { lease.active--; if (lease.retired && !lease.active) await closeLease(lease); }
    } catch (error) {
      return result(error instanceof ConnectionIssue ? error.value : problem('CONNECTION_CHECK_FAILED', 'WorkForce could not complete its connection check. Check the runtime installation and workspace selection.'), true);
    }
  });

  const close = async () => {
    if (closed) return; closed = true; invalidate();
    await Promise.allSettled([...pendingConnections]);
    for (const lease of [...leases]) await closeLease(lease);
    await server.close().catch(() => {});
  };
  return { server, close };
}

export async function runPlugin() {
  if (Number(process.versions.node.split('.')[0]) < 24 || process.versions.electron) throw new Error('WorkForce Agent Plugin requires standalone Node.js 24+ on PATH.');
  const owner = createPluginServer();
  process.once('SIGINT', () => { void owner.close(); });
  process.once('SIGTERM', () => { void owner.close(); });
  process.stdin.once('end', () => { void owner.close(); });
  await owner.server.connect(new StdioServerTransport());
}
