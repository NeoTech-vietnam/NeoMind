import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

type JsonRpcResponse = { jsonrpc: string; id: number; result?: { protocolVersion?: string; capabilities?: { tools?: unknown }; tools?: { name: string }[]; isError?: boolean }; error?: unknown };

// Exercise the actual stdio transport, not just the shared session handlers.
test('standalone MCP serves tools over stdio and exits on EOF', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-mcp-'));
  const repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const child = spawn(process.execPath, [path.resolve('dist/src/cli/main.js'), 'mcp', repo], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id: number, method: string, params: unknown = {}): Promise<JsonRpcResponse> => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const line = await lines.next();
    assert.equal(line.done, false, `MCP exited before response: ${stderr}`);
    const response = JSON.parse(line.value as string) as JsonRpcResponse;
    assert.equal(response.jsonrpc, '2.0'); assert.equal(response.id, id);
    return response;
  };
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
    assert.ok(init.result?.protocolVersion); assert.ok(init.result?.capabilities?.tools);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request(2, 'tools/list');
    const names = listed.result!.tools!.map(tool => tool.name);
    assert.ok(names.includes('neomind_flows')); assert.ok(names.includes('neomind_preview'));
    // Panel-only tools stay inside Nimbalyst.
    assert.ok(!names.includes('neomind_api')); assert.ok(!names.includes('neomind_probe'));
    const flows = await request(3, 'tools/call', { name: 'neomind_flows', arguments: {} });
    assert.ok(!flows.result!.isError, JSON.stringify(flows)); assert.match(JSON.stringify(flows.result), /fast/i);
    const invalid = await request(4, 'tools/call', { name: 'neomind_preview', arguments: {} });
    assert.ok(invalid.error || invalid.result?.isError, JSON.stringify(invalid));
    const unknown = await request(5, 'tools/call', { name: 'neomind_nonexistent', arguments: {} });
    assert.ok(unknown.error || unknown.result?.isError, JSON.stringify(unknown));
    const exited = once(child, 'exit');
    child.stdin.end();
    const [code, signal] = await exited;
    assert.equal(signal, null, stderr); assert.equal(code, 0, stderr);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('MCP shutdown drains in-flight calls and rejects new calls', async () => {
  const { toolCallLifecycle } = await import('../src/cli/mcp.js');
  const lifecycle = toolCallLifecycle();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const call = lifecycle.call(async () => { await blocked; return 'finished'; });
  let drained = false;
  const drain = lifecycle.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(lifecycle.call(async () => 'late'));
  release();
  assert.equal(await call, 'finished');
  await drain;
  assert.equal(drained, true);
});
