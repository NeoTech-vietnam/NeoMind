import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { LANGCONFIG_PREVIEW_LIMITS } from '../src/domain/langconfig-preview.js';
import { createEditorApi, startEditorServer } from '../src/ui-server/server.js';

const route = '/api/langconfig/preview';
const graph = JSON.stringify({ name: 'SECRET_NAME', nodes: [
  { node_id: 'SECRET_ID', display_name: 'SECRET_LABEL', node_type: 'start', handler_function: 'SECRET_HANDLER' },
  { node_id: 'end', display_name: 'End', node_type: 'end', handler_function: 'end' },
], edges: [{ source_id: 'SECRET_ID', target_id: 'end' }], entry_point_id: 'SECRET_ID' });

test('editor API preview never obtains runtime and accepts only bounded raw JSON text', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'neomind-lc-preview-api-'));
  let calls = 0;
  const api = createEditorApi(project, async () => { calls++; throw new Error('runtime must not start'); });
  const before = await readdir(project);
  const result = await api({ method: 'POST', path: route, body: graph });
  assert.equal(result.status, 200);
  assert.equal((result.body as { executable: boolean }).executable, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal((await api({ method: 'POST', path: route, body: { text: graph } })).status, 400);
  assert.equal((await api({ method: 'GET', path: route })).status, 405);
  assert.equal((await api({ method: 'POST', path: route, body: '{"SECRET":1,"SECRET":2}' })).status, 400);
  assert.equal((await api({ method: 'POST', path: route, body: 'x'.repeat(LANGCONFIG_PREVIEW_LIMITS.bytes + 1) })).status, 413);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(project), before);
});

test('HTTP preview enforces origin and token, bounds bytes, and does not write or execute', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'neomind-lc-preview-http-'));
  const sentinel = path.join(project, 'sentinel.txt');
  await writeFile(sentinel, 'unchanged');
  const editor = await startEditorServer(project);
  const headers = { 'Content-Type': 'application/json', Origin: editor.url, 'X-NeoMind-Token': editor.token };
  const send = (body: string | Uint8Array, extra: Record<string, string> = {}) => fetch(`${editor.url}${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: body as BodyInit });
  try {
    assert.equal((await fetch(`${editor.url}${route}`, { method: 'POST', body: graph })).status, 403);
    assert.equal((await send(graph, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await send(graph, { 'X-NeoMind-Token': 'incorrect' })).status, 403);
    assert.equal((await fetch(`${editor.url}${route}`)).status, 405);
    const ok = await send(graph);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const output = await ok.text();
    assert.doesNotMatch(output, /SECRET/);
    const preview = JSON.parse(output) as { executable: boolean; nodes: unknown[] };
    assert.equal(preview.executable, false);
    assert.equal(preview.nodes.length, 2);
    const bad = await send('{"SECRET":1,"SECRET":2}');
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /SECRET/);
    const invalidUtf8 = await send(new Uint8Array([0x7b, 0xff, 0x7d]));
    assert.equal(invalidUtf8.status, 400);
    assert.doesNotMatch(await invalidUtf8.text(), /SECRET/);
    const large = await send('x'.repeat(LANGCONFIG_PREVIEW_LIMITS.bytes + 1));
    assert.equal(large.status, 413);
    assert.doesNotMatch(await large.text(), /SECRET/);
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${editor.url}${route}`, { method: 'POST', headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject);
      req.write('x'.repeat(LANGCONFIG_PREVIEW_LIMITS.bytes));
      req.end('SECRET');
    });
    assert.equal(chunked, 413);
    assert.deepEqual(await readdir(project), ['sentinel.txt']);
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
  } finally { await editor.close(); }
});
