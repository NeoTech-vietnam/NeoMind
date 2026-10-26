import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { createAutomationHost, renderAutomationPanelHtml } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/automation-panel.cjs');
function app(t, { aliasedRoot = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'neomind-automation-panel-'));
  const root = aliasedRoot ? `${directory}-alias` : directory;
  if (aliasedRoot) symlinkSync(directory, root, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    if (aliasedRoot) rmSync(root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  let active = true, selected;
  const calls = [], sent = [];
  const manifest = { id: 'existing-procedure', version: '1.0.0', title: '<img src=x onerror=evil()>', status: 'reviewed', script: 'scripts/run.mjs',
    task_family: 'cornell-note', reviews: [{ reviewer: 'independent' }], runs: [{ status: 'succeeded', observation: 'local-process', started_at: '2026-10-24', generator: { stdout: 'PRIVATE OUTPUT' } }], token: 'PRIVATE TOKEN' };
  const runtime = {
    listProcedures: async () => [manifest], discoverProcedureScripts: async () => ({ scripts: [{ path: 'scripts/run.mjs', sha256: 'abc' }], package_commands: [], issues: [] }),
    registerProcedure: async (...args) => calls.push(['register', ...args]),
    suspendProcedure: async (...args) => calls.push(['suspend', ...args]), qualifyProcedure: async (...args) => calls.push(['qualify', ...args]),
    prepareWork: async (...args) => { calls.push(['prepare', ...args]); return { decision: 'adapt', manager_brief: 'Current compatibility needs review.', next_action: 'Review parameters.' }; },
  };
  const vscode = { Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) }, window: { showOpenDialog: async () => selected } };
  const host = createAutomationHost({ vscode, runtime, root, post: async value => sent.push(value), alive: () => active });
  return { root, runtime, calls, sent, host, select: value => { selected = value; }, active: value => { active = value; },
    send: (action, fields = {}) => host.handle({ type: 'automation-action', action, ...fields }) };
}
test('automation snapshots expose procedure metadata without credentials or subprocess output; webview cannot execute code', async t => {
  const a = app(t); await a.send('refresh');
  assert.equal(a.sent.find(item => item.type === 'automation-snapshot').procedures[0].successful_runs, 1);
  assert.equal(JSON.stringify(a.sent).includes('PRIVATE'), false);
  await a.send('run', { command: 'evil', executable: 'evil' });
  await a.send('suspend', { id: 'unregistered', version: '1.0.0' });
  assert.deepEqual(a.calls, []);
  await a.send('suspend', { id: 'existing-procedure', version: '1.0.0', actor: 'evil', root: '/other', reason: 'evil' });
  assert.deepEqual(a.calls[0], ['suspend', a.root, { procedure_id: 'existing-procedure', version: '1.0.0', actor: 'vscode-local-user', reason: 'Automatic reuse disabled from the Automation Library by the local user.' }]);
});
test('candidate registration uses a native project-file picker and ignores supplied webview manifests', async t => {
  const a = app(t), path = join(a.root, 'procedure.json');
  writeFileSync(path, JSON.stringify({ id: 'picked-native-file' }));
  await a.send('register', { manifest: { id: 'evil' }, path });
  assert.equal(a.calls.length, 0);
  a.select([{ scheme: 'file', fsPath: path }]);
  await a.send('register', { manifest: { id: 'evil' } });
  assert.deepEqual(a.calls[0], ['register', a.root, { id: 'picked-native-file' }]);
  a.active(false); await a.send('qualify', { id: 'existing-procedure', version: '1.0.0' });
  assert.equal(a.calls.length, 1);
});
test('picker containment compares physical project identity across root aliases and still refuses outside files', async t => {
  // A junction/symlink produces the same lexical/physical mismatch as Windows
  // RUNNER~1 temp roots while remaining reproducible on case-sensitive hosts.
  const a = app(t, { aliasedRoot: true }), path = join(a.root, 'procedure.json');
  writeFileSync(path, JSON.stringify({ id: 'picked-through-project-alias' }));
  a.select([{ scheme: 'file', fsPath: path }]);
  await a.send('register');
  assert.deepEqual(a.calls[0], ['register', a.root, { id: 'picked-through-project-alias' }]);
  const outside = app(t), outsidePath = join(outside.root, 'outside.json');
  writeFileSync(outsidePath, JSON.stringify({ id: 'outside-project-must-not-register' }));
  a.select([{ scheme: 'file', fsPath: outsidePath }]);
  await a.send('register');
  assert.equal(a.calls.length, 1);
  // An outside file remains forbidden when reached through an in-project link.
  const escape = join(a.root, 'outside-link');
  symlinkSync(outside.root, escape, process.platform === 'win32' ? 'junction' : 'dir');
  a.select([{ scheme: 'file', fsPath: join(escape, 'outside.json') }]);
  await a.send('register');
  assert.equal(a.calls.length, 1);
  assert.ok(a.sent.some(item => item.type === 'automation-notice' && item.error));
});
test('request matching is advisory and refuses malformed JSON without invoking the runtime', async t => {
  const a = app(t);
  await a.send('match', { request: 'Format Cornell notes', parameters: '{', client: 'codex' });
  assert.equal(a.calls.length, 0); assert.ok(a.sent.some(item => item.error));
  await a.send('match', { request: 'Format Cornell notes', parameters: '{"name":"CaseSensitive"}', paths: 'Output\nOther', client: 'codex', network: true });
  assert.equal(a.calls[0][0], 'prepare'); assert.equal(a.calls[0][2].parameters.name, 'CaseSensitive');
  assert.deepEqual(a.calls[0][2].scope, { allowed_paths: ['Output', 'Other'], network: false, publication: false });
  assert.equal(a.sent.find(item => item.type === 'automation-match').decision, 'adapt');
});
test('panel ships isolated CSP/assets and safe text rendering through the extension manifest', () => {
  const html = renderAutomationPanelHtml({ cspSource: 'vscode-resource:', script: 'automation.js', style: 'automation.css', nonce: 'test-nonce' });
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-test-nonce'/); assert.match(html, /form-action 'none'/);
  const source = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/automation.js', import.meta.url), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(item => item.command === 'neomind.automation.open'));
  for (const path of ['automation-panel.cjs', 'resources/monitor/automation.js', 'resources/monitor/automation.css']) assert.ok(manifest.files.includes(path));
});
