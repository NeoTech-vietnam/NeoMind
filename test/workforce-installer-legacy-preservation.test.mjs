import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { initializeLegacy } from './helpers/legacy-project.mjs';
import { readConfig, safePath } from '../dist/storage.js';
import { installProject, updateProject } from '../dist/installer.js';
import { configureRouter } from '../dist/model-control.js';

const temporary = resolve('artifacts/test-temp');
function fixture(t, routing = false) {
  mkdirSync(temporary, { recursive: true }); const root = mkdtempSync(join(temporary, 'wf-legacy-installer-'));
  t.after(() => { assert.equal(dirname(resolve(root)), temporary); rmSync(root, { recursive: true, force: true }); });
  initializeLegacy(root, { project_id: 'LEGACY-INSTALL', platforms: ['codex'], ...(routing ? { codex_routing: '9router' } : {}) });
  if (routing) configureRouter(root, { base_url: 'http://localhost:20128', api_key_env: 'LEGACY_ROUTER_KEY' });
  return root;
}
function put(root, path, bytes) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
const config = root => join(root, '.codex/config.toml');

for (const [style, declaration] of [
  ['table', '[mcp_servers.neomind]\ncommand = "authored-command"\nargs = []\n'],
  ['quoted table', '["mcp_servers"."neomind"]\ncommand = "authored-command"\nargs = []\n'],
  ['dotted keys', 'mcp_servers.neomind.command = "authored-command"\nmcp_servers.neomind.args = []\n'],
  ['parent inline table', '[mcp_servers]\nneomind = { command = "authored-command", args = [] }\n'],
  ['root inline table', 'mcp_servers = { neomind = { command = "authored-command", args = [] } }\n'],
]) test(`legacy ${style} MCP registration is preserved using the actual emitted server namespace`, t => {
  const root = fixture(t), authored = `# User-owned historical registration\n${declaration}`;
  put(root, '.codex/config.toml', authored);
  const report = installProject(root), candidate = report.conflicts.find(item => item.path === '.codex/config.toml#mcp');
  assert.ok(candidate); assert.match(candidate.reason, /user-owned neomind MCP/i);
  assert.equal(readFileSync(config(root), 'utf8'), authored);
  assert.equal(parseToml(authored).mcp_servers.neomind.command, 'authored-command');
  assert.equal(existsSync(join(root, candidate.candidate)), true);
  assert.match(readFileSync(join(root, candidate.candidate), 'utf8'), /\[mcp_servers\.neomind\]/);
});

for (const [style, declaration] of [
  ['table', '[model_providers.neomind_9router]\nname = "Authored"\nbase_url = "http://localhost:6000/v1"\n'],
  ['quoted table', '["model_providers"."neomind_9router"]\nname = "Authored"\nbase_url = "http://localhost:6000/v1"\n'],
  ['parent inline table', '[model_providers]\nneomind_9router = { name = "Authored", base_url = "http://localhost:6000/v1" }\n'],
  ['dotted keys', 'model_providers.neomind_9router.name = "Authored"\nmodel_providers.neomind_9router.base_url = "http://localhost:6000/v1"\n'],
]) test(`legacy authored ${style} 9router provider is not replaced or duplicated`, t => {
  const root = fixture(t, true), authored = `model_provider = "personal"\n# User provider\n${declaration}`;
  put(root, '.codex/config.toml', authored);
  const report = installProject(root), conflict = report.conflicts.find(item => item.path === '.codex/config.toml#codex-routing-provider');
  assert.ok(conflict); assert.match(conflict.reason, /neomind_9router provider table/);
  assert.ok(report.conflicts.some(item => item.path === '.codex/config.toml#codex-routing-root'));
  const actual = readFileSync(config(root), 'utf8'); assert.ok(actual.startsWith(authored.trimEnd()));
  const parsed = parseToml(actual); assert.equal(parsed.model_provider, 'personal');
  assert.equal(parsed.model_providers.neomind_9router.base_url, 'http://localhost:6000/v1');
  assert.deepEqual(Object.keys(parsed.model_providers), ['neomind_9router']);
});

test('opting out retires unchanged owned old provider blocks and preserves unrelated parent settings', t => {
  const root = fixture(t, true); put(root, '.codex/config.toml', '# Keep my settings\nmodel = "personal-model"\n');
  assert.equal(installProject(root).conflicts.length, 0);
  const before = parseToml(readFileSync(config(root), 'utf8')); assert.equal(before.model_provider, 'neomind_9router');
  put(root, '.neomind/config.json', JSON.stringify({ ...readConfig(root), codex_routing: 'inherit' }));
  updateProject(root);
  const after = parseToml(readFileSync(config(root), 'utf8'));
  assert.equal(after.model_provider, undefined); assert.equal(after.model_providers?.neomind_9router, undefined);
  assert.equal(after.model, 'personal-model'); assert.ok(after.mcp_servers.neomind);
});

test('opting out preserves an owned old provider while an edited root still selects it', t => {
  const root = fixture(t, true); assert.equal(installProject(root).conflicts.length, 0);
  const source = readFileSync(config(root), 'utf8').replace('model_provider = "neomind_9router"', 'model_provider = "neomind_9router" # Keep this selection');
  writeFileSync(config(root), source);
  put(root, '.neomind/config.json', JSON.stringify({ ...readConfig(root), codex_routing: 'inherit' }));
  const result = updateProject(root), actual = readFileSync(config(root), 'utf8'), parsed = parseToml(actual);
  assert.equal(parsed.model_provider, 'neomind_9router'); assert.ok(parsed.model_providers.neomind_9router);
  assert.match(actual, /Keep this selection/); assert.ok(result.warnings.some(warning => /neomind_9router provider is still referenced/.test(warning)));
  const manifest = JSON.parse(readFileSync(safePath(root, '.neomind/install-manifest.json')));
  assert.ok(manifest.files['.codex/config.toml#codex-routing-provider']);
});
