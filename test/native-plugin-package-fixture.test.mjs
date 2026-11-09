import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'yaml';
const root = fileURLToPath(new URL('./fixtures/native-agent-plugin/', import.meta.url));
const nonce = 'WF_NATIVE_PACKAGE_FIXTURE_VALIDATED';
function frontmatter(source) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  assert.ok(header, 'The checked-out fixture has a valid YAML frontmatter boundary.');
  return parse(header[1]);
}
function baseline() {
  return readdirSync(root, { recursive: true }).filter(path => statSync(join(root, path)).isFile()).sort()
    .map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]);
}
async function connection(t) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/package-fixture.mjs')], cwd: root, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'wf-package-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 5000 });
  return client;
}
test('canonical native fixture packages portable skills/MCP and a nonrecursive Copilot agent with no install-time hooks', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'))), mcp = JSON.parse(readFileSync(join(root, 'mcp.json')));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'wf-native-package-fixture'); assert.equal(manifest.license, 'MIT');
  assert.deepEqual(mcp.mcpServers['wf-native-package-fixture'], { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/package-fixture.mjs'] });
  const agent = readFileSync(join(root, 'com.github.copilot/agents/package-researcher.agent.md'), 'utf8');
  const header = frontmatter(agent);
  assert.deepEqual(frontmatter(agent.replace(/\r\n/g, '\n')), header);
  assert.deepEqual(frontmatter(agent.replace(/\r?\n/g, '\r\n')), header);
  assert.deepEqual(header.agents, []); assert.deepEqual(header.tools, ['read', 'search']); assert.equal(header.model, undefined);
  const skill = readFileSync(join(root, 'skills/package-evidence/SKILL.md'), 'utf8');
  assert.equal(frontmatter(skill).name, 'package-evidence');
  assert.match(skill, /WF_NATIVE_PACKAGE_GUIDANCE_V1/);
  assert.match(readFileSync(join(root, 'skills/package-evidence/references/evidence.md'), 'utf8'), /Registered means/);
  assert.equal(baseline().some(([path]) => /(?:^|[\\/])(?:hooks|node_modules|\.git)(?:[\\/]|$)/.test(path)), false);
});
test('full package MCP actually initializes, exposes exact schema and echoes a nonce without changing package bytes', async t => {
  const before = baseline(), client = await connection(t);
  assert.equal(client.getServerVersion().name, 'wf-native-package-fixture');
  const catalog = await client.listTools(); assert.equal(catalog.tools.length, 1); assert.equal(catalog.tools[0].name, 'echo_package_nonce');
  assert.equal(catalog.tools[0].inputSchema.additionalProperties, false);
  const result = await client.callTool({ name: 'echo_package_nonce', arguments: { nonce } });
  assert.notEqual(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text), { nonce, marker: 'WF_NATIVE_PACKAGE_MCP_V1' });
  assert.deepEqual(baseline(), before);
});
test('full package delayed echo provides a bounded actual tool window and rejects invalid arguments without echoing them', async t => {
  const client = await connection(t); let settled = false;
  const pending = client.callTool({ name: 'echo_package_nonce', arguments: { nonce, wait_ms: 120 } }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
  assert.equal(JSON.parse((await pending).content[0].text).nonce, nonce);
  const invalid = await client.callTool({ name: 'echo_package_nonce', arguments: { nonce, extra: 'PRIVATE_TEST_INPUT' } });
  assert.equal(invalid.isError, true); assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_TEST_INPUT/);
});
