import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { nativeLocalToolReferences, nativeRootRoleToolReferences, nativeLocalProfile, nativeLocalRequestJsonSchema, nativeRequestControlJsonSchema } from '../dist/native-local-contract.js';
import { nativeRoleJobJsonSchema, nativeRoleContentJsonSchema } from '../dist/native-role-job.js';
import { nativeWorkPrepareJsonSchema } from '../dist/native-work.js';
import { nativeCapabilityJsonSchema, nativeCapabilitySourceJsonSchema, DEFAULT_NATIVE_CAPABILITY_SOURCES } from '../dist/native-capabilities.js';

const require = createRequire(import.meta.url);
const { nativeToolNames, nativeRoleToolNames } = require('../extensions/vscode-model-bridge/native-entry.cjs');
const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url)));

test('packaged native tool bindings and instructions share their backend schemas without legacy intake', () => {
  const schemas = { request: nativeLocalRequestJsonSchema, role: nativeRoleJobJsonSchema, prepare: nativeWorkPrepareJsonSchema,
    control: nativeRequestControlJsonSchema, capabilities: nativeCapabilityJsonSchema };
  for (const [kind, name] of Object.entries(nativeToolNames)) {
    const tools = manifest.contributes.languageModelTools.filter(tool => tool.name === name);
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.toolReferenceName, nativeLocalToolReferences[kind]);
    const { workspace_folder, ...professional } = tool.inputSchema.properties;
    assert.equal(workspace_folder.type, 'string');
    assert.deepEqual(professional, schemas[kind].properties);
    assert.deepEqual(tool.inputSchema.required, schemas[kind].required);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(manifest.activationEvents.includes(`onLanguageModelTool:${name}`));
    assert.equal(new Set(manifest.contributes.languageModelTools.map(tool => tool.toolReferenceName)).size,
      manifest.contributes.languageModelTools.length, 'native and historical tool references must not collide');
  }
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(nativeLocalProfile('WF.PM'))[1];
  const profile = parse(frontmatter);
  assert.ok(Object.values(nativeLocalToolReferences).every(name => profile.tools.includes(name)));
  assert.equal(profile.tools.includes('workforceRequest'), false, 'The old SDK intake is not a native profile capability');
  assert.ok(manifest.files.includes('native-entry.cjs'));
  const sourcePolicy = manifest.contributes.configuration.properties['workforce.capabilities.sources'];
  assert.equal(sourcePolicy.scope, 'machine');
  assert.deepEqual(sourcePolicy.default, DEFAULT_NATIVE_CAPABILITY_SOURCES);
  assert.deepEqual(sourcePolicy.items, nativeCapabilitySourceJsonSchema);
  for (const [role, name] of Object.entries(nativeRoleToolNames)) {
    const tool = manifest.contributes.languageModelTools.find(tool => tool.name === name);
    assert.equal(tool.toolReferenceName, nativeRootRoleToolReferences[role]);
    const { workspace_folder, ...content } = tool.inputSchema.properties;
    assert.equal(workspace_folder.type, 'string');
    assert.deepEqual(content, nativeRoleContentJsonSchema.properties);
    assert.equal(Object.hasOwn(content, 'role'), false, 'The model cannot select another role on a prebound entry');
    assert.ok(manifest.activationEvents.includes(`onLanguageModelTool:${name}`));
  }
});

test('capability preparation is available to PM only; specialists keep bounded native role tools', () => {
  for (const role of ['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const selector = parse(nativeLocalProfile(role).split('---')[1]);
    assert.equal(selector.tools.includes(nativeLocalToolReferences.capabilities), false);
    assert.equal(selector.tools.includes(nativeRootRoleToolReferences[role]), true);
  }
});

test('the packaged hidden Tester grants actual verification execution without edit or orchestration tools', () => {
  const text = readFileSync(new URL('../agent-plugin/com.github.copilot/agents/workforce-worker-tester.agent.md', import.meta.url), 'utf8');
  const worker = parse(text.split('---')[1]);
  assert.equal(worker.name, 'WF.Tester Worker');
  assert.deepEqual(worker.tools, ['read', 'search', 'execute']);
  assert.deepEqual(worker.agents, []);
  assert.equal(worker['user-invocable'], false);
});
