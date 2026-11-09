import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNativeMcpCapabilities, nativeMcpCapabilitiesMatchInventory,
  nativeMcpConnectorJsonSchema } from '../dist/native-mcp-capabilities.js';

const row = (extra = {}) => ({ id: 'research-local', label: 'Local research connector',
  tools: [{ name: 'mcp_fixture_lookup', reference: 'research-fixture/lookup' }], roles: ['WF.P-RES', 'WF.FnD'], ...extra });
const tool = (extra = {}) => ({ name: 'mcp_fixture_lookup', fullReferenceName: 'research-fixture/lookup',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, ...extra });
const resolve = (policy = [row()], inventory = [tool()], extra = {}) =>
  resolveNativeMcpCapabilities(policy, inventory, { role: 'WF.FnD', selectIds: ['research-local'], ...extra });

test('generic exact-approved tools resolve without fixed provider names and remain immutable', () => {
  const policy = [row()], inventory = [tool()], result = resolve(policy, inventory);
  assert.equal(result.state, 'ready'); assert.equal(result.snapshots.length, 1);
  const snapshot = result.snapshots[0];
  assert.equal(snapshot.connector_id, 'research-local');
  assert.equal(snapshot.provenance, 'user-approved/exact-observed');
  assert.equal(snapshot.ownership, 'not-observed');
  assert.equal(snapshot.tools[0].reference, 'research-fixture/lookup');
  assert.match(snapshot.tools[0].schema_sha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.snapshots));
  assert.ok(Object.isFrozen(snapshot.tools[0].input_schema.properties));
  inventory[0].inputSchema.properties.query.type = 'number'; policy[0].label = 'changed';
  assert.equal(snapshot.label, 'Local research connector');
  assert.equal(snapshot.tools[0].input_schema.properties.query.type, 'string');
});

test('exact schema and reference snapshots detect actual inventory changes', () => {
  const result = resolve();
  assert.equal(nativeMcpCapabilitiesMatchInventory(result.snapshots, [tool()]), true);
  assert.equal(nativeMcpCapabilitiesMatchInventory(result.snapshots, []), false);
  assert.equal(nativeMcpCapabilitiesMatchInventory(result.snapshots, [tool({ fullReferenceName: 'other/lookup' })]), false);
  assert.equal(nativeMcpCapabilitiesMatchInventory(result.snapshots, [tool({ inputSchema: { type: 'object' } })]), false);
  assert.equal(nativeMcpCapabilitiesMatchInventory([{ ...result.snapshots[0], label: 'forged' }], [tool()]), false);
});

test('missing or unobserved native reference never grants guessed mcp permissions', () => {
  for (const inventory of [[], [tool({ fullReferenceName: undefined })], [tool({ fullReferenceName: 'research-fixture/other' })]]) {
    const result = resolve(undefined, inventory);
    assert.equal(result.state, 'unavailable'); assert.deepEqual(result.snapshots, []);
    assert.equal(result.fallback, 'ordinary-work');
  }
});

test('approval requires a known connector and its exact allowed role', () => {
  assert.equal(resolve([], [tool()]).unavailable[0].reason, 'connector-not-approved');
  assert.equal(resolve(undefined, undefined, { role: 'WF.Tester' }).unavailable[0].reason, 'role-not-approved');
  assert.equal(resolve([row({ enabled: true })]).reason, 'invalid-approved-connectors');
  assert.equal(resolve([row({ roles: ['unknown-role'] })]).reason, 'invalid-approved-connectors');
  assert.equal(resolve(undefined, undefined, { workflow_id: 'forged' }).reason, 'invalid-selection');
  assert.equal(nativeMcpConnectorJsonSchema.additionalProperties, false);
});

test('every admission selects only requested exact tools; partial optional failure preserves ordinary work', () => {
  const policy = [row(), row({ id: 'other', tools: [{ name: 'mcp_other_lookup', reference: 'other/lookup' }] })];
  const result = resolve(policy, [tool()], { selectIds: ['research-local', 'other'] });
  assert.equal(result.state, 'partial'); assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.unavailable, [{ connector_id: 'other', reason: 'native-tool-unavailable' }]);
  assert.equal(resolve(policy, [tool()], { selectIds: [] }).state, 'not-selected');
  assert.equal(resolve(policy, [tool()], { selectIds: [] }).snapshots.length, 0);
});

test('ambiguous native names or profile references never broaden permissions', () => {
  assert.equal(resolve(undefined, [tool(), tool()]).state, 'unavailable');
  assert.equal(resolve(undefined, [tool(), tool({ name: 'another_tool' })]).state, 'unavailable');
  assert.equal(resolve([row(), row()]).reason, 'invalid-approved-connectors');
  assert.equal(resolve([row({ tools: [...row().tools, ...row().tools] })]).reason, 'invalid-approved-connectors');
});

test('recursive orchestrator/subagent grants, wildcards and invalid identifiers are rejected', () => {
  for (const name of ['runSubagent', 'vscode/runSubagent', 'workforce_native_role', 'mcp_neomind_manager_run', 'mcp_*', 'tool\nname']) {
    assert.equal(resolve([row({ tools: [{ name, reference: 'fixture/lookup' }] })]).reason, 'invalid-approved-connectors', name);
    assert.equal(resolve([row({ tools: [{ name: 'mcp_fixture_lookup', reference: name }] })]).reason, 'invalid-approved-connectors', name);
  }
  assert.equal(resolve([row({ tools: [] })]).reason, 'invalid-approved-connectors');
});

test('canonical schemas produce stable hashes independent of key and selection ordering', () => {
  const first = resolve(), reordered = resolve(undefined, [tool({ inputSchema: { required: ['query'],
    properties: { query: { type: 'string' } }, type: 'object' } })]);
  assert.equal(first.fingerprint, reordered.fingerprint);
  assert.equal(first.snapshots[0].fingerprint, reordered.snapshots[0].fingerprint);
  const policy = [row(), row({ id: 'second', tools: [{ name: 'second_tool', reference: 'second/tool' }] })];
  const inventory = [tool(), tool({ name: 'second_tool', fullReferenceName: 'second/tool' })];
  assert.equal(resolve(policy, inventory, { selectIds: ['second', 'research-local'] }).fingerprint,
    resolve(policy, inventory, { selectIds: ['research-local', 'second'] }).fingerprint);
});

test('malformed or cyclic schemas fall back without executing accessors or serializing provider objects', () => {
  let accessed = false;
  const schema = {}; Object.defineProperty(schema, 'properties', { enumerable: true, get() { accessed = true; throw Error('secret'); } });
  const cyclic = {}; cyclic.self = cyclic;
  const enumeration = [];
  Object.defineProperty(enumeration, '0', { enumerable: true, get() { accessed = true; throw Error('secret'); } });
  for (const inputSchema of [schema, cyclic, { enum: enumeration }, { unsupported: Infinity }, { unsupported: () => {} }, { prototype: new Date() }]) {
    const result = resolve(undefined, [tool({ inputSchema })]);
    assert.equal(result.state, 'unavailable');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  assert.equal(accessed, false);
});

test('policy accessors and duplicate role selections do not establish approval', () => {
  let accessed = false;
  const policy = row(); Object.defineProperty(policy, 'tools', { enumerable: true, get() { accessed = true; throw Error('secret'); } });
  assert.equal(resolve([policy]).reason, 'invalid-approved-connectors');
  assert.equal(accessed, false);
  assert.equal(resolve([row({ roles: ['WF.FnD', 'WF.FnD'] })]).reason, 'invalid-approved-connectors');
  assert.equal(resolve(undefined, undefined, { selectIds: ['research-local', 'research-local'] }).reason, 'invalid-selection');
});

test('profile selectors use locale-independent canonical ordering', () => {
  const selectors = [{ name: 'mcp_fixture_a', reference: 'fixture/a' }, { name: 'mcp_fixture_Z', reference: 'fixture/Z' }];
  const result = resolve([row({ tools: selectors })], selectors.map(({ name, reference }) => tool({ name, fullReferenceName: reference })));
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.snapshots[0].tools.map(tool => tool.name), ['mcp_fixture_Z', 'mcp_fixture_a']);
});

test('missing schemas are captured as null and inventory descriptions/source objects are not persisted', () => {
  const result = resolve(undefined, [tool({ inputSchema: undefined, description: 'sensitive unrelated text', source: { token: 'secret' } })]);
  assert.equal(result.state, 'ready'); assert.equal(result.snapshots[0].tools[0].input_schema, null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});
