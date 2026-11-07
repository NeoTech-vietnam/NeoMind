import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initialize } from '../dist/storage.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distribution = join(repository, 'agent-plugin');
const body = result => result.structuredContent ?? JSON.parse(result.content.find(part => part.type === 'text').text);

test('Git plugin contains portable entrypoints and the required profiles, skills and dependency notices', () => {
  const manifest = JSON.parse(readFileSync(join(distribution, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(readFileSync(join(distribution, 'mcp.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'workforce');
  assert.equal(manifest.repository, 'https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(mcp.mcpServers), ['workforce']);
  assert.deepEqual(mcp.mcpServers.workforce, { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/workforce-plugin.mjs'] });
  assert.doesNotMatch(JSON.stringify(mcp.mcpServers), /[A-Za-z]:[\\/]|workspaceFolder|apiKey|authorization|claim_token/);
  assert.equal(readdirSync(join(distribution, 'com.github.copilot/agents')).filter(name => name.endsWith('.agent.md')).length, 6);
  assert.deepEqual(readdirSync(join(distribution, 'skills')).sort(), ['workforce-plugin-connection', 'workforce-plugin-status', 'workforce-request']);
  const notices = readFileSync(join(distribution, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /@modelcontextprotocol\/sdk@/);
  assert.match(notices, /jsonc-parser@/);
  assert.match(readFileSync(join(distribution, 'LICENSE'), 'utf8'), /MIT License/);
  const bundle = readFileSync(join(distribution, 'bin/workforce-plugin.mjs'), 'utf8');
  assert.equal(bundle.includes(repository), false, 'Bundle must not embed the build machine path.');
  assert.equal(bundle.includes(repository.replaceAll('\\', '/')), false);
});

test('copied Git plugin starts without npm installation and connects after User runtime setup', { timeout: 45_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'workforce standalone plugin '));
  const plugin = join(temporary, 'clone with spaces');
  const user = join(temporary, 'VS Code User');
  const project = join(temporary, 'project with spaces');
  let client, transport, diagnostic = '';
  try {
    cpSync(distribution, plugin, { recursive: true });
    mkdirSync(user); mkdirSync(project);
    initialize(project, { platforms: ['copilot'] });
    assert.equal(existsSync(join(plugin, 'node_modules')), false);
    assert.equal(existsSync(join(temporary, 'node_modules')), false);
    const { mcpServers: { workforce: entry } } = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8'));
    transport = new StdioClientTransport({ command: entry.command,
      args: entry.args.map(value => value.replaceAll('${PLUGIN_ROOT}', plugin)), cwd: plugin, stderr: 'pipe',
      env: { ...getDefaultEnvironment(), WORKFORCE_VSCODE_USER_DIR: user },
    });
    transport.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    client = new Client({ name: 'workforce-standalone-distribution-test', version: '1' }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(project).href, name: 'trial project' }] }));
    await client.connect(transport, { timeout: 10_000 });
    assert.deepEqual((await client.listTools({}, { timeout: 5000 })).tools.map(tool => tool.name), ['workforce_connection']);
    const beforeSetup = await client.callTool({ name: 'workforce_connection', arguments: {} }, undefined, { timeout: 5000 });
    assert.equal(body(beforeSetup).code, 'RUNTIME_NOT_CONFIGURED', diagnostic);
    assert.equal(existsSync(join(plugin, 'node_modules')), false, 'Bootstrap must not install dependencies.');
    // Simulate the user selecting the existing runtime in this private fixture.
    writeFileSync(join(user, 'settings.json'), `// Existing User configuration\n{\n  "workforce.bridge.runtimePath": ${JSON.stringify(repository)},\n  "unrelated.secret": "USER_SETTING_MUST_STAY_PRIVATE",\n}\n`);
    const connected = await client.callTool({ name: 'workforce_connection', arguments: {} }, undefined, { timeout: 25_000 });
    assert.equal(body(connected).state, 'ready', diagnostic);
    assert.equal(realpathSync.native(body(connected).workspace), realpathSync.native(project));
    assert.doesNotMatch(JSON.stringify(connected), /USER_SETTING_MUST_STAY_PRIVATE/);
    const names = (await client.listTools({}, { timeout: 5000 })).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['request_control', 'request_status', 'request_submit', 'workforce_connection'].sort());
    const status = await client.callTool({ name: 'request_status', arguments: {} }, undefined, { timeout: 5000 });
    assert.notEqual(status.isError, true, diagnostic);
    assert.deepEqual(body(status), { requests: [] });
    assert.equal(existsSync(join(project, '.vscode')), false, 'The plugin must not write workspace registration or settings.');
    assert.equal(existsSync(join(plugin, 'node_modules')), false);
  } catch (error) {
    throw new Error(`Standalone bundled MCP test failed: ${diagnostic || '(no stderr)'}\n${error.message}`, { cause: error });
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    rmSync(temporary, { recursive: true, force: true });
  }
});
