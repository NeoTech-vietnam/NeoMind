import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initialize, safePath, readConfig, createRecord } from '../dist/storage.js';
import { installProject, updateProject } from '../dist/installer.js';
import { ensureLocalGitExclusions } from '../dist/local-git-excludes.js';

function root(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-local-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['-C', root, 'init', '--quiet'], { encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  return root;
}
const sha = value => createHash('sha256').update(value).digest('hex');
function put(root, path, content) { const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, content); }

test('local exclusions preserve authored BOM/negations and gitignore while hiding WorkForce request data and migration backups', t => {
  const project = root(t);
  const gitignore = '# Team rules\r\n*.object\r\n'; put(project, '.gitignore', gitignore);
  const existing = '\ufeff# Personal exclusions\r\n*.private\r\n!keep.private\r\n!/.github/agents/workforce-personal.agent.md';
  put(project, '.git/info/exclude', existing);
  const first = ensureLocalGitExclusions(project);
  assert.equal(first.changed, true);
  const after = readFileSync(first.path);
  assert.ok(after.subarray(after.length - Buffer.byteLength(existing.slice(1))).equals(Buffer.from(existing.slice(1))));
  for (const path of [
    '.workforce/requests/WF-R0001--exercise/README.md', '.workforce-backups/saved/.neomind/native/key.pem',
    '.workforce-private/private-engine/data/session.sqlite',
    '.workforce-staging-example/records/a.md', '.workforce-migration.json', '.neomind-migration.lock',
    '.github/agents/workforce-pm.agent.md', '.codex/agents/workforce-swsd.toml',
    '.agents/skills/workforce-manager/SKILL.md', 'AGENTS.md.workforce-update-instructions',
  ]) {
    const result = spawnSync('git', ['-C', project, 'check-ignore', '--no-index', '--quiet', '--', path], { windowsHide: true });
    assert.equal(result.status, 0, path);
  }
  const own = spawnSync('git', ['-C', project, 'check-ignore', '--no-index', '--quiet', '--', '.github/agents/workforce-personal.agent.md'], { windowsHide: true });
  assert.equal(own.status, 1);
  assert.equal(ensureLocalGitExclusions(project).changed, false);
  assert.deepEqual(readFileSync(first.path), after);
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), gitignore);
});

test('fresh WorkForce installs controlled Local intake and configured aliases without hardcoded upstream models', t => {
  const project = root(t);
  initialize(project, { platforms: ['copilot', 'codex'] });
  const report = installProject(project);
  assert.equal(readConfig(project).execution_engine, 'opencode');
  assert.equal(readConfig(project).copilot_integration, 'local');
  const policy = JSON.parse(readFileSync(safePath(project, '.workforce/automation.json')));
  assert.equal(policy.execution_mode, 'neomind-controlled');
  assert.equal(policy.automatic_pr, false);
  const routing = JSON.parse(readFileSync(safePath(project, '.workforce/routing.json')));
  assert.equal(routing.strong_model, 'top-models');
  assert.deepEqual(routing.worker_models, ['worker-models']);
  assert.equal(routing.strong_provider, 'customendpoint');
  assert.equal(routing.worker_provider, 'customendpoint');
  const mcp = JSON.parse(readFileSync(join(project, '.vscode/mcp.json')));
  assert.ok(mcp.servers.workforce);
  assert.equal(mcp.servers.neomind, undefined);
  const codex = readFileSync(join(project, '.codex/config.toml'), 'utf8');
  assert.match(codex, /mcp_servers\.workforce/);
  assert.equal(report.conflicts.length, 0, JSON.stringify(report.conflicts));
  const roles = readFileSync(safePath(project, '.workforce/roles/developer.md'), 'utf8');
  assert.doesNotMatch(roles, /NeoMind|\.neomind\//);
});

test('authored routing, siblings and historical pending record bytes survive update', t => {
  const project = root(t);
  initialize(project, { platforms: ['copilot', 'codex'], copilot_integration: 'local' });
  put(project, '.vscode/mcp.json', '{\n// authored sibling\n"servers":{"myServer":{"command":"keep-me"}}\n}\n');
  installProject(project);
  const routePath = safePath(project, '.workforce/routing.json');
  const routing = JSON.parse(readFileSync(routePath)); routing.strong_model = 'my-top-alias';
  const authored = JSON.stringify(routing, null, 4) + '\n'; writeFileSync(routePath, authored);
  const pending = createRecord(project, { type: 'knowledge', title: 'Historical pending', data: { kind: 'manager-workflow', request_id: 'pending', execution_mode: 'copilot-native' } });
  const original = readFileSync(safePath(project, pending.path));
  updateProject(project);
  assert.equal(readFileSync(routePath, 'utf8'), authored);
  assert.deepEqual(readFileSync(safePath(project, pending.path)), original);
  assert.match(readFileSync(join(project, '.vscode/mcp.json'), 'utf8'), /authored sibling/);
  assert.equal(JSON.parse(readFileSync(join(project, '.vscode/mcp.json')) .toString().replace('// authored sibling', '')).servers.myServer.command, 'keep-me');
});

test('an authored legacy connection is preserved and new duplicate owner is only a review candidate', t => {
  const project = root(t);
  initialize(project, { platforms: ['copilot'], copilot_integration: 'local' });
  const original = '{"servers":{"neomind":{"command":"my-authored-runtime"},"other":{"command":"keep"}}}\n';
  put(project, '.vscode/mcp.json', original);
  const report = installProject(project);
  assert.equal(readFileSync(join(project, '.vscode/mcp.json'), 'utf8'), original);
  assert.ok(report.conflicts.some(item => item.path === '.vscode/mcp.json#servers.workforce'));
});

test('a hash-owned legacy connection retires without changing external MCP settings', t => {
  const project = root(t);
  initialize(project, { platforms: ['copilot'], copilot_integration: 'local' });
  const server = { command: 'old-owned-runtime', args: [] };
  put(project, '.vscode/mcp.json', JSON.stringify({ servers: { neomind: server, other: { command: 'keep' } } }));
  put(project, '.workforce/install-manifest.json', JSON.stringify({ schema_version: 1, version: '0.1.0-alpha.14', files: {
    '.vscode/mcp.json#servers.neomind': { path: '.vscode/mcp.json', kind: 'json', key: 'servers.neomind', hash: sha(JSON.stringify(server)), version: '0.1.0-alpha.14' },
  } }));
  const report = installProject(project);
  const after = JSON.parse(readFileSync(join(project, '.vscode/mcp.json')));
  assert.equal(after.servers.neomind, undefined);
  assert.ok(after.servers.workforce);
  assert.equal(after.servers.other.command, 'keep');
  assert.equal(report.conflicts.length, 0, JSON.stringify(report.conflicts));
});
