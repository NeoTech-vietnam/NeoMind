import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initialize } from '../dist/storage.js';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-plugin-cli-'));
  initialize(root, { project_id: 'PLUGIN-CLI', platforms: ['copilot'], copilot_integration: 'local' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'plugins', ...args, '--project', root],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return { root, invoke };
}
test('CLI plug-in controls report readiness and toggle policy without installing packages', t => {
  const { root, invoke } = fixture(t);
  let result = invoke('status'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plugins.length, 4);
  result = invoke('enable', 'rea'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status.plugins.find(item => item.id === 'rea').enabled, true);
  assert.equal(existsSync(join(root, '.neomind/tools/rea')), false);
  result = invoke('disable', 'rea'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status.plugins.find(item => item.id === 'rea').enabled, false);
  assert.equal(existsSync(join(root, '.gitignore')), false);
});
test('CLI connection controls refuse unselected profiles and unready providers without modifying targets', t => {
  const { root, invoke } = fixture(t), target = join(root, 'profile/mcp.json');
  mkdirSync(dirname(target), { recursive: true });
  const original = '// Keep my settings\n{"servers":{"other":{"command":"mine"}}}\n';
  writeFileSync(target, original);
  let result = invoke('connect', 'rea', '--client', 'copilot-vscode');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /--mcp-file/);
  result = invoke('connect', 'rea', '--client', 'copilot-vscode', '--mcp-file', target);
  assert.notEqual(result.status, 0); assert.equal(readFileSync(target, 'utf8'), original);
  result = invoke('connections'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).find(item => item.client === 'copilot-vscode').status, 'unselected');
  result = invoke('enable', 'unknown-provider'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown plug-in/);
});
