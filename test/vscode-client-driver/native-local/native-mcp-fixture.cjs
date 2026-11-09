'use strict';

// Deterministic owned test server, not a product MCP gateway. stdout contains
// MCP JSON-RPC only. Retained proof records never contain incoming arguments,
// environment variables, model context or credentials.
const { createHash } = require('node:crypto');
const { appendFileSync, existsSync, realpathSync, statSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) argumentsByName.set(process.argv[index], process.argv[index + 1]);
const nonce = argumentsByName.get('--nonce'), evidence = argumentsByName.get('--evidence'), selectedGate = argumentsByName.get('--gate-file');
if (typeof nonce !== 'string' || !/^[a-f0-9]{16,128}$/.test(nonce) || !isAbsolute(evidence ?? '') || !statSync(evidence).isDirectory()) process.exit(2);
const root = realpathSync.native(evidence), events = join(root, 'events.ndjson');
let gate;
if (selectedGate !== undefined) {
  try {
    if (!isAbsolute(selectedGate)) process.exit(2);
    const selected = resolve(selectedGate), parent = realpathSync.native(dirname(selected));
    // The gate does not exist yet. Resolve its actual existing parent so a
    // Windows TEMP 8.3 alias cannot be mistaken for another evidence root.
    const same = process.platform === 'win32' ? parent.toLowerCase() === root.toLowerCase() : parent === root;
    if (!same) process.exit(2);
    gate = join(root, basename(selected));
  } catch { process.exit(2); }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const record = (event, fields = {}) => appendFileSync(events, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const problem = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
const tool = { name: 'echo_nonce', title: 'Echo owned fixture nonce',
  description: 'Return the supplied owned acceptance fixture nonce unchanged. No project files or external services are accessed.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const active = new Map();
const gateMilliseconds = 300000;
async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return;
  const hasId = Object.hasOwn(request, 'id');
  if (request.method === 'notifications/cancelled') {
    active.get(request.params?.requestId)?.abort(); record('cancel-notification'); return;
  }
  if (!hasId) { if (request.method === 'notifications/initialized') record('initialized'); return; }
  if (request.method === 'initialize') {
    record('initialize');
    return reply(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'owned-native-fixture', version: '1.0.0' } });
  }
  if (request.method === 'ping') return reply(request.id, {});
  if (request.method === 'tools/list') { record('tools-list'); return reply(request.id, { tools: [tool] }); }
  if (request.method !== 'tools/call') return problem(request.id, -32601, 'Unsupported owned fixture method.');
  const input = request.params?.arguments;
  const valid = request.params?.name === tool.name && input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === 1 && input.nonce === nonce;
  record('tool-start', { tool: tool.name, nonce_valid: !!valid, expected_nonce_sha256: hash(nonce) });
  if (!valid) return reply(request.id, { content: [{ type: 'text', text: 'Supply the exact nonce from the fixture tool schema.' }], isError: true });
  const controller = new AbortController(); active.set(request.id, controller);
  try {
    if (gate && !existsSync(gate)) {
      record('tool-waiting-for-owned-gate', { tool: tool.name, gate_ms: gateMilliseconds });
      const deadline = Date.now() + gateMilliseconds;
      while (!existsSync(gate) && !controller.signal.aborted && Date.now() < deadline) await delay(25);
      if (controller.signal.aborted) { record('tool-cancelled', { tool: tool.name }); return problem(request.id, -32800, 'Owned fixture call cancelled.'); }
      if (!existsSync(gate)) { record('tool-gate-timeout', { tool: tool.name }); return reply(request.id, {
        content: [{ type: 'text', text: 'Owned fixture gate was not released.' }], isError: true }); }
    }
    const result = { nonce, marker: 'WF_M6_NATIVE_MCP_ECHO' };
    record('tool-completed', { tool: tool.name, nonce_valid: true, output_sha256: hash(JSON.stringify(result)) });
    return reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } finally { active.delete(request.id); }
}
record('server-started', { expected_nonce_sha256: hash(nonce), gated: !!gate, gate_ms: gateMilliseconds });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return problem(null, -32700, 'Invalid JSON.'); }
  void handle(request).catch(() => { record('fixture-error'); if (Object.hasOwn(request ?? {}, 'id')) problem(request.id, -32603, 'Owned fixture failure.'); });
}).on('close', () => { for (const controller of active.values()) controller.abort(); });
