import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize } from '../dist/storage.js';
import { resolveNativeMcpCapabilities } from '../dist/native-mcp-capabilities.js';
import { readNativeMcpBindingControl, controlNativeMcpBinding, applyNativeMcpBindingControl } from '../dist/native-mcp-control.js';
import { acquireNativeCapabilityLease, releaseNativeCapabilityLease, drainNativeCapabilityControls } from '../dist/native-capability-leases.js';
import { listWorkspaceSkillComponents, installWorkspaceSkillComponents, controlWorkspaceSkillComponent } from '../dist/workspace-skill-components.js';
const { manageNativeCapabilityControls } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/native-capability-controls.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const connector = () => ({ id: 'fixture', label: 'Native fixture connector', roles: ['WF.FnD'],
  tools: [{ name: 'mcp_fixture_echo', reference: 'fixture/echo' }] });
const inventory = () => [{ name: 'mcp_fixture_echo', fullReferenceName: 'fixture/echo', inputSchema: { type: 'object' } }];
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-control-picker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-CONTROL-PICKER' });
  const calls = [], notices = [], choices = [], approved = options.approved ?? [connector()];
  const api = { resolveNativeMcpCapabilities, readNativeMcpBindingControl, listWorkspaceSkillComponents,
    controlNativeMcpBinding: (...args) => { calls.push(['mcp', ...args]); return controlNativeMcpBinding(...args); },
    controlWorkspaceSkillComponent: (...args) => { calls.push(['skill', ...args]); return controlWorkspaceSkillComponent(...args); } };
  const vscode = { lm: { tools: options.inventory ?? inventory() }, window: {
    async showQuickPick(rows, metadata) {
      choices.push({ rows, metadata });
      return typeof rows[0] === 'string' ? options.action ?? 'Disable' : options.cancel ? undefined : rows[0];
    },
    async showInformationMessage(message) { notices.push(message); },
  } };
  return { root, calls, notices, choices, approved, api, vscode,
    run: () => manageNativeCapabilityControls(vscode, api, root, () => approved) };
}

test('valid connector IDs matching Object prototype names retain ordinary enable and disable semantics', t => {
  const f = fixture(t);
  assert.equal(readNativeMcpBindingControl(f.root, 'constructor').state, 'enabled');
  controlNativeMcpBinding(f.root, 'constructor', 'disable');
  assert.equal(readNativeMcpBindingControl(f.root, 'constructor').new_admissions, false);
  controlNativeMcpBinding(f.root, 'constructor', 'enable');
  assert.equal(readNativeMcpBindingControl(f.root, 'constructor').state, 'enabled');
  assert.equal(readNativeMcpBindingControl(f.root, 'constructor').new_admissions, true);
});

test('empty approved inventory does not offer a native binding or grant policy, connection or tools', async t => {
  const f = fixture(t, { approved: [] });
  await f.run();
  assert.equal(f.choices.length, 0); assert.deepEqual(f.calls, []);
  assert.match(f.notices[0], /No approved native MCP bindings/);
  assert.equal(existsSync(join(f.root, '.neomind/native/mcp-bindings.json')), false);
  assert.equal(existsSync(join(f.root, '.vscode/mcp.json')), false);
});

test('a missing native tool is reported unavailable and does not trigger installation or change User approval', async t => {
  const f = fixture(t, { inventory: [], action: 'Disable' }), before = JSON.stringify(f.approved);
  await f.run();
  assert.match(f.choices[0].rows[0].detail, /^unavailable/);
  assert.equal(readNativeMcpBindingControl(f.root, 'fixture').state, 'disabled');
  assert.equal(JSON.stringify(f.approved), before);
  assert.equal(existsSync(join(f.root, '.vscode/mcp.json')), false);
  assert.equal(existsSync(join(f.root, '.github/agents')), false);
  assert.match(f.notices[0], /Native MCP server processes and User configuration remain managed by VS Code/);
});

for (const [action, state] of [['Disable', 'disabled'], ['Enable', 'enabled'], ['Remove WorkForce binding', 'removed']]) {
  test(`native picker ${action} applies the actual local runtime control without editing native server configuration`, async t => {
    const f = fixture(t, { action }), before = JSON.stringify(f.approved);
    if (action === 'Enable') controlNativeMcpBinding(f.root, 'fixture', 'disable');
    await f.run();
    assert.equal(readNativeMcpBindingControl(f.root, 'fixture').state, state);
    assert.deepEqual(f.calls.map(call => [call[0], call[2], call[3]]), [['mcp', 'fixture', action.startsWith('Remove') ? 'remove' : action.toLowerCase()]]);
    assert.equal(JSON.stringify(f.approved), before);
    assert.equal(existsSync(join(f.root, '.vscode/mcp.json')), false);
    assert.equal(existsSync(join(f.root, '.mcp.json')), false);
  });
}

for (const action of ['Disable', 'Remove WorkForce binding']) {
  test(`native picker ${action} queues real active holders, then applies only after their exact settled release`, async t => {
    const f = fixture(t, { action }), owner = { request_ref: 'WF-R0001', assignment_ref: 'assignment-1', generation: 1 };
    const resolution = resolveNativeMcpCapabilities(f.approved, f.vscode.lm.tools, { role: 'WF.FnD', selectIds: ['fixture'] });
    const ref = acquireNativeCapabilityLease(f.root, { owner,
      resources: [{ key: 'mcp:fixture', fingerprint: resolution.snapshots[0].fingerprint }] });
    await f.run();
    const pending = readNativeMcpBindingControl(f.root, 'fixture');
    assert.equal(pending.state, 'enabled'); assert.equal(pending.new_admissions, false);
    assert.equal(pending.pending_action, action.startsWith('Remove') ? 'remove' : 'disable');
    assert.equal(pending.active_count, 1);
    assert.equal(existsSync(join(f.root, '.neomind/native/mcp-bindings.json')), false, 'Pending control does not rewrite the frozen binding.');
    assert.match(f.notices[0], /queued: 1 retained holder/); assert.doesNotMatch(f.notices[0], /binding updated/);
    releaseNativeCapabilityLease(f.root, ref, owner, { outcome_sha256: hash('Actual fixture holder settled') });
    const results = drainNativeCapabilityControls(f.root, input => applyNativeMcpBindingControl(f.root, input));
    assert.equal(results[0].state, 'applied');
    assert.equal(readNativeMcpBindingControl(f.root, 'fixture').state, action.startsWith('Remove') ? 'removed' : 'disabled');
  });
}

test('cancelling the native picker cannot mutate an approved connector', async t => {
  const f = fixture(t, { cancel: true });
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 0);
  assert.equal(readNativeMcpBindingControl(f.root, 'fixture').state, 'enabled');
});

test('workspace or policy invalidation across either native picker await stops the mutation', async t => {
  for (const boundary of [1, 2]) {
    const f = fixture(t); let current = true, picks = 0;
    f.vscode.window.showQuickPick = async rows => {
      picks++;
      if (picks === boundary) current = false;
      return typeof rows[0] === 'string' ? 'Disable' : rows[0];
    };
    await manageNativeCapabilityControls(f.vscode, f.api, f.root, () => f.approved, () => current);
    assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 0);
    assert.equal(picks, boundary);
    assert.equal(readNativeMcpBindingControl(f.root, 'fixture').state, 'enabled');
  }
});

test('native picker controls actual owned skill files while preserving unrelated product content', async t => {
  const f = fixture(t, { approved: [], action: 'Remove workspace skill' });
  const content = '---\nname: picker-guide\ndescription: Verify fixture guidance\n---\nPreserve unrelated files.\n';
  const files = new Map([['LICENSE', 'MIT\n'], ['skills/picker-guide/SKILL.md', content]]);
  const installed = await installWorkspaceSkillComponents(f.root, { approved: true, repository: 'https://github.com/example/native-picker',
    commit: 'a'.repeat(40), license_path: 'LICENSE', skills: [{ source_path: 'skills/picker-guide', target_name: 'picker-guide',
      files: ['skills/picker-guide/SKILL.md'] }] }, async input => ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
  writeFileSync(join(f.root, 'product.txt'), 'User-owned product remains\n');
  await f.run();
  assert.equal(f.calls[0][0], 'skill'); assert.equal(f.calls[0][2], installed.components[0].id); assert.equal(f.calls[0][3], 'remove');
  assert.equal(existsSync(join(f.root, '.github/skills/picker-guide/SKILL.md')), false);
  assert.equal(readFileSync(join(f.root, 'product.txt'), 'utf8'), 'User-owned product remains\n');
  assert.equal(listWorkspaceSkillComponents(f.root).components[0].state, 'removed');
});

test('invalid User connector rows cannot crash the native picker or establish permissions', async t => {
  const f = fixture(t, { approved: [null] });
  await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.choices.length, 0);
  assert.match(f.notices[0], /No approved native MCP bindings/);
});
