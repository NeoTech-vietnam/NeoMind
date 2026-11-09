// Self-contained, target-free MCP fixture. No downloads, file writes, process
// spawning or credentials. Delayed echo provides a bounded active tool window.
import { createInterface } from 'node:readline';
const requests = new Map();
const protocolVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const tools = [{ name: 'echo_package_nonce', description: 'Echo a bounded supplied nonce without side effects.', inputSchema: {
  type: 'object', properties: { nonce: { type: 'string', minLength: 1, maxLength: 160 }, wait_ms: { type: 'integer', minimum: 0, maximum: 120000 } },
  required: ['nonce'], additionalProperties: false } }];
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (Buffer.byteLength(line) > 256 * 1024) { send({ id: null, error: { code: -32600, message: 'Request exceeds fixture bounds.' } }); return; }
  let request; try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return;
  const { id, method, params } = request;
  if (method === 'notifications/cancelled') { const pending = requests.get(params?.requestId); if (pending) { clearTimeout(pending); requests.delete(params.requestId); } return; }
  if (id === undefined) return;
  if (method === 'initialize') { send({ id, result: { protocolVersion: protocolVersions.has(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
    capabilities: { tools: {} }, serverInfo: { name: 'wf-native-package-fixture', version: '1.0.0' } } }); return; }
  if (method === 'ping') { send({ id, result: {} }); return; }
  if (method === 'tools/list') { send({ id, result: { tools } }); return; }
  if (method !== 'tools/call') { send({ id, error: { code: -32601, message: 'Unsupported fixture method.' } }); return; }
  const args = params?.arguments, wait = args?.wait_ms ?? 0;
  if (params?.name !== tools[0].name || !args || typeof args.nonce !== 'string' || !args.nonce.length || args.nonce.length > 160 ||
      Object.keys(args).some(name => !['nonce', 'wait_ms'].includes(name)) || !Number.isInteger(wait) || wait < 0 || wait > 120000) {
    send({ id, result: { isError: true, content: [{ type: 'text', text: 'Fixture arguments do not match the observed schema.' }] } }); return;
  }
  const timer = setTimeout(() => { requests.delete(id); send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ nonce: args.nonce, marker: 'WF_NATIVE_PACKAGE_MCP_V1' }) }] } }); }, wait);
  requests.set(id, timer);
});
input.on('close', () => { for (const timer of requests.values()) clearTimeout(timer); requests.clear(); });
