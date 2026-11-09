import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, safePath } from '../dist/storage.js';
import { resolveNativeMcpCapabilities } from '../dist/native-mcp-capabilities.js';
import { controlNativeMcpBinding, readNativeMcpBindingControl, applyNativeMcpBindingControl } from '../dist/native-mcp-control.js';
import { acquireNativeCapabilityLease, releaseNativeCapabilityLease, drainNativeCapabilityControls } from '../dist/native-capability-leases.js';
import { listWorkspaceSkillComponents, controlWorkspaceSkillComponent, installWorkspaceSkillComponents } from '../dist/workspace-skill-components.js';
import { resolveNativeSkills } from '../dist/native-skill-context.js';
const require = createRequire(import.meta.url);
const { createNativeControlObserver } = require('./vscode-client-driver/native-local/native-pilot.cjs');
const { manageNativeCapabilityControls } = require('../extensions/vscode-model-bridge/native-capability-controls.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-control-observer-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-OBSERVER' });
  const records = [], callbacks = new Map();
  const vscode = { commands: { registerCommand(name, callback, thisArg) { callbacks.set(name, (...args) => callback.apply(thisArg, args)); return { dispose() {} }; } } };
  const runtime = { safePath, resolveNativeMcpCapabilities, controlNativeMcpBinding, readNativeMcpBindingControl, applyNativeMcpBindingControl,
    listWorkspaceSkillComponents, controlWorkspaceSkillComponent };
  const observed = createNativeControlObserver(vscode, runtime, root, { runtime: 'owned-test-build' }, (name, record) => records.push({ name, record }));
  return { root, records, callbacks, runtime, observed };
}

test('observer records actual deferred picker and automatic drain separately, without assigning concurrent calls to an open UI promise', async t => {
  const f = fixture(t), owner = { request_ref: 'WF-R0001', assignment_ref: 'assignment-1', generation: 1 };
  const lease = acquireNativeCapabilityLease(f.root, { owner, resources: [{ key: 'mcp:fixture', fingerprint: hash('toolset') }] });
  const approved = [{ id: 'fixture', label: 'Fixture', roles: ['WF.FnD'], tools: [{ name: 'mcp_echo', reference: 'fixture/echo' }] }];
  let dismiss;
  const shown = new Promise(resolve => { dismiss = resolve; });
  const vscode = { lm: { tools: [{ name: 'mcp_echo', fullReferenceName: 'fixture/echo', inputSchema: { type: 'object' } }] }, window: {
    async showQuickPick(rows) { return typeof rows[0] === 'string' ? 'Disable' : rows[0]; }, showInformationMessage() { return shown; } } };
  f.observed.commands.registerCommand('workforce.capabilities.manage', () => manageNativeCapabilityControls(vscode, f.observed.runtime, f.root, () => approved));
  const pendingUi = f.callbacks.get('workforce.capabilities.manage')();
  await new Promise(resolve => setImmediate(resolve));
  let controls = f.records.filter(item => item.name.startsWith('capability-control')).map(item => item.record);
  assert.equal(controls.length, 1); assert.equal(controls[0].control.state, 'deferred'); assert.equal(controls[0].control.active_count, 1);
  assert.equal(controls[0].ui_command_context, true); assert.equal(controls[0].ui_sync_stack_contains_manage, true);
  assert.equal(controls[0].binding_status.new_admissions, false);
  f.observed.runtime.controlNativeMcpBinding(f.root, 'unrelated', 'enable');
  controls = f.records.filter(item => item.name.startsWith('capability-control')).map(item => item.record);
  assert.equal(controls[1].ui_command_context, false); assert.equal(controls[1].ui_sync_stack_contains_manage, false);
  dismiss(); await pendingUi;
  releaseNativeCapabilityLease(f.root, lease, owner, { outcome_sha256: hash('actual settled fixture holder') });
  const drained = drainNativeCapabilityControls(f.root, input => f.observed.runtime.applyNativeMcpBindingControl(f.root, input));
  assert.equal(drained[0].state, 'applied');
  const drain = f.records.filter(item => item.record.api_method === 'applyNativeMcpBindingControl').at(-1).record;
  assert.equal(drain.ui_command_context, false); assert.equal(drain.automatic_drain_stack, true);
  assert.equal(drain.binding_status.state, 'disabled'); assert.equal(drain.control.state, 'apply-now');
});

test('read-only observer records current actual owned skill and receipt hashes after a deferred control', async t => {
  const f = fixture(t), text = '---\nname: observed-guide\ndescription: Owned fixture guidance\n---\nPreserve files.\n';
  const files = new Map([['LICENSE', 'MIT\n'], ['skills/observed-guide/SKILL.md', text]]);
  const installed = await installWorkspaceSkillComponents(f.root, { approved: true, repository: 'https://github.com/example/observer', commit: 'a'.repeat(40),
    license_path: 'LICENSE', skills: [{ source_path: 'skills/observed-guide', target_name: 'observed-guide', files: ['skills/observed-guide/SKILL.md'] }] },
  async input => ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
  const id = installed.components[0].id, candidate = listWorkspaceSkillComponents(f.root).components[0];
  const owner = { request_ref: 'WF-R0002', assignment_ref: 'assignment-2', generation: 1 };
  const skill = resolveNativeSkills(f.root, ['observed-guide'])[0];
  acquireNativeCapabilityLease(f.root, { owner, resources: [{ key: `skill:${id}`, fingerprint: skill.approval_sha256, skill }] });
  const result = f.observed.runtime.controlWorkspaceSkillComponent(f.root, id, 'remove');
  assert.equal(result.control.state, 'deferred');
  const proof = f.records.find(item => item.name.startsWith('capability-control')).record;
  assert.equal(proof.skill_status.receipt.sha256, hash(readFileSync(safePath(f.root, candidate.receipt.path))));
  assert.equal(proof.skill_status.files[0].sha256, hash(text));
  assert.equal(proof.skill_status.files[0].present, true);
  assert.equal(JSON.stringify(proof).includes('Preserve files'), false);
});

test('logging failure preserves exact returned value, thrown error and non-control functions', t => {
  const f = fixture(t), returned = { control: { state: 'deferred', active_count: 1, new_admissions: false }, secret: 'SECRET' };
  const original = Error('SECRET failure'), modelFunction = () => 'untouched';
  const runtime = { controlNativeMcpBinding() { return returned; }, readNativeMcpBindingControl() { throw Error('observer read failed'); },
    controlWorkspaceSkillComponent() { throw original; }, modelFunction };
  const observed = createNativeControlObserver({ commands: { registerCommand() {} } }, runtime, f.root, {}, () => { throw Error('observer write failed'); });
  assert.equal(observed.runtime.controlNativeMcpBinding(f.root, 'fixture', 'disable'), returned);
  assert.throws(() => observed.runtime.controlWorkspaceSkillComponent(f.root, 'fixture', 'remove'), error => error === original);
  assert.equal(observed.runtime.modelFunction, modelFunction);
  const records = [], safe = createNativeControlObserver({ commands: { registerCommand() {} } },
    { ...runtime, readNativeMcpBindingControl: () => ({ state: 'enabled', active_count: 1, new_admissions: false, token: 'SECRET' }) },
    f.root, {}, (_name, record) => records.push(record));
  assert.equal(safe.runtime.controlNativeMcpBinding(f.root, 'fixture', 'disable'), returned);
  assert.equal(JSON.stringify(records).includes('SECRET'), false);
});
