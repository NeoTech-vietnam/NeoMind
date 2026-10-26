import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { serveHost, hostPrivateDirectory } from '../dist/vscode-wire.js';
import { ModelCallProgress } from '../dist/vscode-model-progress.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-progress-unit-'));
  const host = await serveHost(root, async () => ({ ok: true }));
  const directory = hostPrivateDirectory(root);
  t.after(async () => { await host.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const id = randomUUID(), path = join(directory, 'progress', `${id}.json`);
  return { root, host, directory, id, path, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

test('private progress coalesces chunks to five seconds but flushes phase changes and aggregate counts', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const p = new ModelCallProgress(f.root, f.id, 'top-models', 'customendpoint');
  p.beginRound(1); p.request(); p.handleReceived(); p.part('tool-call');
  const first = readFileSync(f.path, 'utf8');
  p.part('text', 6); p.part('data', 7);
  assert.equal(readFileSync(f.path, 'utf8'), first, 'Ordinary fragments do not cause per-chunk writes.');
  t.mock.timers.tick(4999);
  assert.equal(readFileSync(f.path, 'utf8'), first);
  t.mock.timers.tick(1);
  let value = f.read();
  assert.equal(value.round_counts.parts, 3);
  assert.equal(value.round_counts.text_bytes, 6);
  assert.equal(value.round_counts.data_bytes, 7);
  assert.equal(value.tool_calls_pending, 1);
  p.executingTools(); p.toolResult(); p.endRound();
  value = f.read();
  assert.equal(value.phase, 'round-completed');
  assert.equal(value.tool_calls_pending, 0);
  assert.equal(value.totals.tool_results, 1);
  p.beginRound(2); p.request();
  assert.equal(f.read().round_counts.parts, 0);
  assert.equal(f.read().totals.parts, 3);
  p.finish('error', 'model-or-host-error');
  value = f.read();
  assert.equal(value.failure_phase, 'awaiting-sdk-handle');
  assert.equal(value.phase, 'error');
  p.handleReceived(); p.part('text', 900); p.finish('completed'); t.mock.timers.tick(5000);
  assert.deepEqual(f.read(), value, 'Late SDK activity cannot overwrite a terminal snapshot.');
  t.mock.timers.reset();
});

test('private diagnostic files stay bounded, redact URL-shaped model labels, and survive host shutdown', async t => {
  const f = await fixture(t);
  const first = new ModelCallProgress(f.root, f.id, 'https://SECRET_HOST/key', 'SECRET@VENDOR');
  first.beginRound(1); first.request(); first.finish('cancelled', 'host-close');
  const value = f.read();
  assert.equal(value.model_id, null); assert.equal(value.vendor, null);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|https/);
  const directory = join(f.directory, 'progress');
  for (let i = 0; i < 260; i++) writeFileSync(join(directory, `${randomUUID()}.json`), '{}', { mode: 0o600 });
  for (let i = 0; i < 260; i++) writeFileSync(join(directory, `${randomUUID()}.json.${randomUUID()}.tmp`), '{}', { mode: 0o600 });
  const unrelated = ['user-data.tmp', `${randomUUID()}.json.unrelated.tmp`];
  for (const name of unrelated) writeFileSync(join(directory, name), 'unrelated authored file', { mode: 0o600 });
  const next = randomUUID();
  new ModelCallProgress(f.root, next, 'top-models', 'customendpoint');
  const files = readdirSync(directory).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 256);
  assert.ok(files.includes(`${next}.json`));
  assert.ok(files.every(name => statSync(join(directory, name)).size < 8192));
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp')).sort(), unrelated.sort(),
    'Only exact writer-owned orphan temporary files may be pruned.');
  await f.host.close();
  assert.ok(existsSync(join(directory, `${next}.json`)), 'Host shutdown does not discard diagnostic history.');
  if (process.platform !== 'win32') assert.equal(statSync(join(directory, `${next}.json`)).mode & 0o077, 0);
});

test('Windows diagnostic child rejects explicit foreign ACL grants through the descriptor private-directory policy', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), directory = join(f.directory, 'progress');
  mkdirSync(directory);
  execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:R'], { stdio: 'ignore', windowsHide: true });
  const p = new ModelCallProgress(f.root, f.id, 'top-models', 'customendpoint');
  p.beginRound(1); p.request();
  assert.equal(existsSync(f.path), false, 'Do not expose even diagnostic metadata through an explicitly shared child directory.');
});
