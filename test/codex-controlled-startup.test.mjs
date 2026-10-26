import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as toml } from 'smol-toml';
import { initialize, readConfig } from '../dist/storage.js';
import { readAutomationPolicy } from '../dist/manager.js';
import { adapterOutputs } from '../dist/adapters.js';
import { installProject, updateProject } from '../dist/installer.js';

const read = (root, path) => readFileSync(join(root, path), 'utf8');
function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function project(t, controlled = true) {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'neomind-codex-startup-'));
  t.after(() => {
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'CODEX-STARTUP', platforms: ['codex'] });
  if (controlled) write(root, '.neomind/automation.json', JSON.stringify({
    ...readAutomationPolicy(root), execution_mode: 'neomind-controlled',
  }));
  return root;
}
function managedMcp(root) {
  return adapterOutputs(root, readConfig(root)).find(output =>
    output.path === '.codex/config.toml' && output.key === 'mcp');
}

test('controlled Codex requires its essential NeoMind MCP without changing native-mode startup policy', t => {
  const root = project(t), output = managedMcp(root);
  const server = toml(output.content).mcp_servers.neomind;
  assert.equal(server.required, true);
  assert.deepEqual(server.enabled_tools, ['manager_run', 'manager_status', 'manager_control']);
  assert.equal(server.startup_timeout_sec, undefined);
  assert.equal(server.tool_timeout_sec, undefined);
  assert.equal(server.args.at(-1), root);
  const nativeRoot = project(t, false);
  const native = toml(managedMcp(nativeRoot).content).mcp_servers.neomind;
  assert.equal(native.required, undefined);
  assert.equal(native.startup_timeout_sec, undefined);
});

test('managed Codex update fixes an older optional entry while preserving authored sibling startup settings', t => {
  const root = project(t);
  const authored = '# Personal configuration\nmodel = "parent-model"\n' +
    '[mcp_servers.personal]\ncommand = "personal-server"\nrequired = false\nstartup_timeout_sec = 7\n' +
    '[mcp_servers.already_required]\ncommand = "other-server"\nrequired = true\nstartup_timeout_sec = 19\n';
  write(root, '.codex/config.toml', authored);
  assert.deepEqual(installProject(root).conflicts, []);
  const current = read(root, '.codex/config.toml');
  const block = /(# BEGIN NEOMIND mcp\n)([\s\S]*?)(\n# END NEOMIND mcp)/.exec(current);
  assert.ok(block);
  const oldContent = block[2].replace(/^required = true\n/m, '');
  write(root, '.codex/config.toml', current.replace(block[0], block[1] + oldContent + block[3]));
  const manifest = JSON.parse(read(root, '.neomind/install-manifest.json'));
  manifest.files['.codex/config.toml#mcp'].hash = createHash('sha256').update(oldContent).digest('hex');
  write(root, '.neomind/install-manifest.json', JSON.stringify(manifest));
  const before = toml(read(root, '.codex/config.toml'));
  assert.equal(before.mcp_servers.neomind.required, undefined);
  const report = updateProject(root);
  assert.deepEqual(report.conflicts, []);
  assert.ok(report.updated.includes('.codex/config.toml#mcp'));
  const updated = read(root, '.codex/config.toml'), parsed = toml(updated);
  assert.ok(updated.startsWith(authored.trimEnd()));
  assert.equal(parsed.model, 'parent-model');
  assert.deepEqual(parsed.mcp_servers.personal, before.mcp_servers.personal);
  assert.deepEqual(parsed.mcp_servers.already_required, before.mcp_servers.already_required);
  assert.equal(parsed.mcp_servers.neomind.required, true);
  assert.equal(parsed.mcp_servers.neomind.startup_timeout_sec, undefined);
  assert.equal(parsed.mcp_servers.neomind.tool_timeout_sec, undefined);
  assert.deepEqual(updateProject(root).updated, []);
  assert.equal(read(root, '.codex/config.toml'), updated);
});

test('controlled update leaves an authored NeoMind entry untouched and offers a required-entry candidate', t => {
  const root = project(t);
  const authored = '# User-owned NeoMind registration\n[mcp_servers.neomind]\n' +
    'command = "personal-neomind"\nrequired = false\nstartup_timeout_sec = 9\n';
  write(root, '.codex/config.toml', authored);
  const report = installProject(root);
  assert.equal(read(root, '.codex/config.toml'), authored);
  const conflict = report.conflicts.find(item => item.path === '.codex/config.toml#mcp');
  assert.ok(conflict);
  const candidateBlock = /# BEGIN NEOMIND mcp\n([\s\S]*?)\n# END NEOMIND mcp/.exec(read(root, conflict.candidate));
  assert.ok(candidateBlock);
  assert.equal(toml(candidateBlock[1]).mcp_servers.neomind.required, true);
  assert.equal(toml(read(root, '.codex/config.toml')).mcp_servers.neomind.required, false);
});
