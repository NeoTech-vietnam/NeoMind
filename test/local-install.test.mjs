import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initialize, readConfig, hash } from '../dist/storage.js';
import { installProject, updateProject, doctor } from '../dist/installer.js';
import { adapterOutputs } from '../dist/adapters.js';
import { setRoleModel } from '../dist/model-control.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind local install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, path, body) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), body);
}
function read(root, path) { return readFileSync(join(root, path), 'utf8'); }
function run(root, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('CLI local init and repeated/model updates preserve shared files and bind MCP to the installed project', t => {
  const root = fixture(t);
  const sentinels = {
    '.gitignore': '# Repository-owned ignore rules\n',
    'AGENTS.md': '# Existing Codex rules\r\n',
    'CLAUDE.md': '# Existing Claude rules\r\n',
    '.github/copilot-instructions.md': '# Repository Copilot rules\r\n',
    '.vscode/mcp.json': '{"servers":{"existing":{"command":"existing-server"}}}\n',
    '.mcp.json': '{"mcpServers":{"existing":{"command":"another-existing-server"}}}\n',
    '.codex/config.toml': '# Existing Codex configuration\n',
    '.codex/hooks.json': '{"hooks":{}}\n',
  };
  for (const [path, body] of Object.entries(sentinels)) write(root, path, body);
  let git = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  git = spawnSync('git', ['-C', root, 'add', '--', ...Object.keys(sentinels)], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const initialized = run(root, ['init', '--local', '--platforms', 'copilot', '--project-id', 'LOCAL']);
  assert.equal(initialized.config.copilot_integration, 'local');
  assert.deepEqual(initialized.installation.conflicts, []);
  const instruction = read(root, '.github/instructions/neomind.instructions.md');
  assert.match(instruction, /^---\ndescription: .+\napplyTo: "\*\*"\n---/);
  const example = JSON.parse(read(root, '.neomind/mcp-server.json'));
  assert.match(example.registration, /example-only/);
  assert.equal(example.servers.neomind.command, process.execPath);
  assert.deepEqual(example.servers.neomind.args, [cli, 'mcp', '--project', root]);
  const observation = doctor(root);
  assert.ok(observation.warnings.some(warning => warning.includes('example metadata only')));
  assert.equal(observation.platforms[0].capabilities.find(capability => capability.capability === 'user-profile-mcp').status, 'unverified');
  const again = run(root, ['update']);
  assert.deepEqual(again.updated, []);
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(JSON.parse(read(root, '.neomind/mcp-server.json')), example);
  // This is the same core policy + updater sequence used by the monitor.
  setRoleModel(root, { role: 'developer', model: 'local-selected-model' });
  const generated = updateProject(root);
  assert.deepEqual(generated.conflicts, []);
  assert.match(read(root, '.github/agents/neomind-implementer.agent.md'), /model: "local-selected-model"/);
  assert.deepEqual(JSON.parse(read(root, '.neomind/mcp-server.json')), example);
  assert.equal(readConfig(root).copilot_integration, 'local');
  for (const [path, body] of Object.entries(sentinels)) assert.equal(read(root, path), body, path);
  git = spawnSync('git', ['-C', root, 'diff', '--exit-code', '--', ...Object.keys(sentinels)], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stdout || git.stderr);
  for (const path of ['package.json', 'package-lock.json', 'node_modules']) assert.equal(existsSync(join(root, path)), false);
});

test('default Copilot mode retains its standard integration and does not create local metadata', t => {
  const root = fixture(t);
  initialize(root, { platforms: ['copilot'] });
  installProject(root);
  assert.match(read(root, '.github/copilot-instructions.md'), /BEGIN NEOMIND instructions/);
  assert.ok(JSON.parse(read(root, '.vscode/mcp.json')).servers.neomind);
  assert.equal(existsSync(join(root, '.github/instructions/neomind.instructions.md')), false);
  assert.equal(existsSync(join(root, '.neomind/mcp-server.json')), false);
  assert.equal(existsSync(join(root, '.mcp.json')), false);
});

test('update --local persists mode and never retires an older hash-owned shared MCP entry', t => {
  const root = fixture(t);
  initialize(root, { platforms: ['copilot'] });
  installProject(root);
  const config = JSON.parse(read(root, '.vscode/mcp.json'));
  config.servers.verythinker = config.servers.neomind;
  delete config.servers.neomind;
  write(root, '.vscode/mcp.json', JSON.stringify(config) + '\n');
  const manifest = JSON.parse(read(root, '.neomind/install-manifest.json'));
  const old = manifest.files['.vscode/mcp.json#servers.neomind'];
  delete manifest.files['.vscode/mcp.json#servers.neomind'];
  manifest.files['.vscode/mcp.json#servers.verythinker'] = { ...old, key: 'servers.verythinker', hash: hash(JSON.stringify(config.servers.verythinker)) };
  write(root, '.neomind/install-manifest.json', JSON.stringify(manifest));
  const before = read(root, '.vscode/mcp.json'), instructions = read(root, '.github/copilot-instructions.md');
  const result = run(root, ['update', '--local']);
  assert.ok(result.warnings.some(warning => warning.includes('preserves existing shared')));
  assert.equal(read(root, '.vscode/mcp.json'), before);
  assert.equal(read(root, '.github/copilot-instructions.md'), instructions);
  updateProject(root);
  assert.equal(read(root, '.vscode/mcp.json'), before);
  assert.equal(readConfig(root).copilot_integration, 'local');
});

test('local mode emits no workspace MCP entry even with Claude configured', t => {
  const root = fixture(t);
  initialize(root, { platforms: ['copilot', 'claude'], copilot_integration: 'local' });
  const outputs = adapterOutputs(root, readConfig(root));
  assert.equal(outputs.some(output => ['.mcp.json', '.vscode/mcp.json'].includes(output.path)), false);
  assert.equal(outputs.filter(output => output.path === '.neomind/mcp-server.json').length, 1);
});

test('unsupported local mode values fail configuration validation', t => {
  const root = fixture(t);
  assert.throws(() => initialize(root, { copilot_integration: 'invalid' }), /invalid project configuration/);
  assert.equal(existsSync(join(root, '.neomind/config.json')), false);
});
