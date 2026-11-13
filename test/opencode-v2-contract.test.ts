import test from 'node:test';
import assert from 'node:assert/strict';
import { openCodeV2Models, openCodeV2Rules, verifyOpenCodeV2Info, verifyOpenCodeV2ConfigSources } from '../src/runners/opencode-v2-contract.js';

test('OpenCode V2 contract admits exactly 2.2.7', () => {
  verifyOpenCodeV2Info({ version: '2.2.7', pid: 123 });
  for (const version of ['1.19.5', '2.2.6', '2.2.8', '2.2.7-dev']) {
    assert.throws(() => verifyOpenCodeV2Info({ version, pid: 123 }), /Unsupported OpenCode version/);
  }
  assert.throws(() => verifyOpenCodeV2Info({ version: '2.2.7', pid: 0 }));
});

test('OpenCode V2 rules deny by default and allow web and edit only when requested', () => {
  for (const write of [false, true]) for (const web of [false, true]) {
    const rules = openCodeV2Rules(write, web);
    assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
    assert.equal(rules.some(rule => rule.action === 'edit' && rule.effect === 'allow'), write);
    for (const action of ['websearch', 'webfetch']) assert.equal(rules.some(rule => rule.action === action && rule.effect === 'allow'), web);
    assert.ok(rules.some(rule => rule.action === 'external_directory' && rule.effect === 'deny'));
    for (const action of ['shell', 'subagent', 'execute']) assert.ok(!rules.some(rule => rule.action === action && rule.effect === 'allow'));
  }
});

test('OpenCode V2 model snapshot excludes disabled and non-chat models', () => {
  const response = { data: [
    { id: 'model', providerID: 'provider', enabled: true, type: 'chat', variants: [{ id: 'high' }] },
    { id: 'simple', providerID: 'provider', enabled: true, variants: [] },
    { id: 'disabled', providerID: 'provider', enabled: false, variants: [] },
    { id: 'image', providerID: 'provider', enabled: true, type: 'image', variants: [] },
  ] };
  assert.deepEqual(openCodeV2Models(response), [
    { runner: 'opencode', provider: 'provider', model: 'model', reasoning: ['high'] },
    { runner: 'opencode', provider: 'provider', model: 'simple', reasoning: ['medium'] },
  ]);
  assert.throws(() => openCodeV2Models({ all: [], connected: [] }));
});

test('OpenCode V2 rejects external configuration that can change isolation', () => {
  const own = '/private/opencode.json';
  verifyOpenCodeV2ConfigSources([{ type: 'document', path: own, info: { policies: [] } }, { type: 'document', path: '/project/opencode.json', info: { model: 'example/model' } }], own);
  for (const key of ['policies', 'experimental', 'permissions', 'permission', 'plugins', 'plugin', 'mcp', 'agents', 'agent', 'skills', 'instructions', 'references', 'reference']) {
    assert.throws(() => verifyOpenCodeV2ConfigSources([{ type: 'document', path: '/project/opencode.json', info: { [key]: {} } }], own), /external security-sensitive/);
  }
  assert.throws(() => verifyOpenCodeV2ConfigSources([{ type: 'document', info: { policies: [] } }], own), /external security-sensitive/);
});
