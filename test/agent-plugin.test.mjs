import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initialize, readConfig, safePath } from '../dist/storage.js';
import { packageAgentPlugin } from '../scripts/package-agent-plugin.mjs';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { nativeLocalProfile, nativeLocalWorkerProfile, nativeRoles, nativeSpecialists } from '../dist/native-local-contract.js';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t, nativeLocal = false) {
  const root = mkdtempSync(join(tmpdir(), 'workforce plugin '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project with spaces'); mkdirSync(project);
  initialize(project, { platforms: ['copilot'], ...(nativeLocal ? { copilot_integration: 'local' } : {}) });
  return { root, project, out: join(root, 'plugin with spaces') };
}

test('a native Local plugin carries the same six selectors, hidden workers and entry contract as the installer', async t => {
  const { project, out } = fixture(t, true);
  const before = readFileSync(safePath(project, '.workforce/config.json'));
  await packageAgentPlugin({ runtime, project, out });
  for (const role of nativeRoles) {
    const text = readFileSync(join(out, `com.github.copilot/agents/workforce-${role.slice(3).toLowerCase()}.agent.md`), 'utf8');
    assert.equal(text, nativeLocalProfile(role));
    assert.doesNotMatch(text, /workforce\/request_submit|OpenCode workers|top-models|worker-models/);
    assert.equal(parseYaml(text.split('---')[1])['user-invocable'], true);
  }
  for (const role of nativeSpecialists) {
    const text = readFileSync(join(out, `com.github.copilot/agents/workforce-worker-${role.slice(3).toLowerCase()}.agent.md`), 'utf8');
    assert.equal(text, nativeLocalWorkerProfile(role));
    const worker = parseYaml(text.split('---')[1]);
    assert.equal(worker['user-invocable'], false);
    assert.deepEqual(worker.agents, []);
  }
  assert.equal(readdirSync(join(out, 'com.github.copilot/agents')).length, 11);
  const skill = readFileSync(join(out, 'skills/workforce-request/SKILL.md'), 'utf8');
  assert.match(skill, /vscode-native\/v1/); assert.doesNotMatch(skill, /request_submit|claim_token/);
  const binding = JSON.parse(readFileSync(join(out, 'binding.json')));
  assert.match(binding.profile_source, /native-local-contract/);
  assert.deepEqual(readFileSync(safePath(project, '.workforce/config.json')), before);
});
function files(root, path = '') {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(root, join(path, entry.name)) : [join(path, entry.name)]);
}

test('plugin packages the real runtime profiles and exact-project MCP without copying project secrets or history', async t => {
  const { project, out } = fixture(t);
  writeFileSync(join(project, 'private-product.txt'), 'USER_PRODUCT_SENTINEL');
  writeFileSync(safePath(project, '.workforce/private-catalog.json'), '{"apiKey":"SECRET_DO_NOT_PACKAGE"}');
  const configBefore = readFileSync(safePath(project, '.workforce/config.json'));
  const result = await packageAgentPlugin({ runtime, project, out });
  assert.deepEqual(result.agents, ['WF.PM', 'WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']);
  const manifest = JSON.parse(readFileSync(join(out, 'plugin.json')));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  const mcp = JSON.parse(readFileSync(join(out, 'mcp.json')));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['workforce']);
  assert.deepEqual(mcp.mcpServers.workforce, { type: 'stdio', command: 'node',
    args: [join(realpathSync.native(runtime), 'dist/cli.js'), 'mcp', '--project', realpathSync.native(project)] });
  assert.doesNotMatch(JSON.stringify(mcp), /\$\{workspaceFolder\}/);
  const agents = files(join(out, 'com.github.copilot/agents'));
  assert.equal(agents.length, 6);
  const pm = readFileSync(join(out, 'com.github.copilot/agents/workforce-pm.agent.md'), 'utf8');
  const frontmatter = parseYaml(pm.split('---')[1]);
  assert.equal(frontmatter.name, 'WF.PM'); assert.equal(frontmatter['user-invocable'], true);
  assert.equal(frontmatter.model, undefined, 'Local user model selection stays independent.');
  assert.deepEqual(frontmatter.tools, ['workforce/request_submit', 'workforce/request_status', 'workforce/request_control']);
  assert.ok(!frontmatter.tools.some(tool => /edit|write|terminal|execute|runInTerminal/i.test(tool)));
  assert.match(pm, /new_request: true/);
  for (const path of files(out)) {
    const content = readFileSync(join(out, path), 'utf8');
    assert.doesNotMatch(content, /SECRET_DO_NOT_PACKAGE|USER_PRODUCT_SENTINEL/);
    assert.ok(!path.startsWith('.workforce'));
  }
  assert.deepEqual(readFileSync(safePath(project, '.workforce/config.json')), configBefore);
  assert.equal(result.project_id, readConfig(project).project_id);
  rmSync(out, { recursive: true });
  assert.equal(readFileSync(join(project, 'private-product.txt'), 'utf8'), 'USER_PRODUCT_SENTINEL');
  assert.deepEqual(readFileSync(safePath(project, '.workforce/config.json')), configBefore);
});

test('packaging preserves nonempty output and rejects runtime/project overlap', async t => {
  const { project, out } = fixture(t);
  mkdirSync(out); writeFileSync(join(out, 'authored.txt'), 'PRESERVE');
  await assert.rejects(packageAgentPlugin({ runtime, project, out }), /existing files are preserved/);
  assert.equal(readFileSync(join(out, 'authored.txt'), 'utf8'), 'PRESERVE');
  await assert.rejects(packageAgentPlugin({ runtime, project, out: join(project, 'plugin') }), /separate/);
  await assert.rejects(packageAgentPlugin({ runtime, project, out: join(runtime, 'plugin') }), /separate/);
  await assert.rejects(packageAgentPlugin({ runtime, project, out: 'relative' }), /absolute/);
});

test('packaged stdio server initializes, advertises exactly the intake tools and returns real empty-project status', { timeout: 30_000 }, async t => {
  const { project, out } = fixture(t);
  await packageAgentPlugin({ runtime, project, out });
  const { mcpServers: { workforce: entry } } = JSON.parse(readFileSync(join(out, 'mcp.json')));
  const transport = new StdioClientTransport({ ...entry, cwd: out, stderr: 'pipe' });
  const client = new Client({ name: 'workforce-agent-plugin-package-test', version: '1' });
  let diagnostic = '';
  transport.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  try {
    await client.connect(transport, { timeout: 20_000 });
    const { tools } = await client.listTools({}, { timeout: 5000 });
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['request_control', 'request_status', 'request_submit']);
    const status = await client.callTool({ name: 'request_status', arguments: {} }, undefined, { timeout: 5000 });
    assert.notEqual(status.isError, true, diagnostic);
    const text = status.content.find(item => item.type === 'text')?.text;
    assert.deepEqual(JSON.parse(text), { requests: [] });
    assert.doesNotMatch(JSON.stringify(status), /SECRET_DO_NOT_PACKAGE|apiKey|claim_token/);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
