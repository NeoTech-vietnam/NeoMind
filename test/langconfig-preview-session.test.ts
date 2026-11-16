import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEditorApi } from '../src/ui-server/server.js';
import { SESSION_TOOLS, sessionToolHandlers } from '../src/runtime/session-tools.js';

test('session LangConfig preview uses the read-only API without exposing input or starting a run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-lc-session-'));
  let calls = 0;
  const runs = async () => { calls++; throw new Error('runtime must not start'); };
  const handlers = sessionToolHandlers(runs, createEditorApi(root, runs));
  assert.ok(SESSION_TOOLS.some(item => item.name === 'langconfig_preview' && !item.panelOnly));
  const before = await readdir(root);
  const input = JSON.stringify({ name: 'SECRET', nodes: [], edges: [] });
  const result = await handlers.langconfig_preview!({ json: input }) as { executable: boolean };
  assert.equal(result.executable, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  await assert.rejects(handlers.langconfig_preview!({ json: '{"SECRET":1,"SECRET":2}' }), /HTTP 400/);
  await assert.rejects(handlers.langconfig_preview!({ json: 'x'.repeat(1_048_577) }), /Input exceeds 1 MiB/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), before);
});
