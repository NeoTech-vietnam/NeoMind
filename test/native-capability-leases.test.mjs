import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const base = process.env.WF_NATIVE_LEASE_MODULE_BASE ?? new URL('../dist/', import.meta.url).href;
const load = name => import(new URL(name, base.endsWith('/') ? base : `${base}/`).href);
const lease = await load('native-capability-leases.js');
const { installWorkspaceSkillComponents, controlWorkspaceSkillComponent, listWorkspaceSkillComponents } = await load('workspace-skill-components.js');
const { resolveNativeSkills } = await load('native-skill-context.js');
const { initialize, safePath } = await load('storage.js');
const { setPluginEnabled, readPluginControlStatus, installPlugin, probePlugin } = await load('plugin-control.js');
const { setPluginConnection, removePlugin, applyNativePluginControl } = await load('plugin-connections.js');
const { toolCatalog } = await load('tools.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const owner = (suffix = 'a', generation = 1) => ({ request_ref: `WF-R-${suffix}`, assignment_ref: `assignment-${suffix}`, generation });
const proof = { outcome_sha256: sha('Actual settled role result') };
function fixture(t) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.mkdtempSync(join(parent, 'wf-native-leases-'));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function skillFixture(t) {
  const root = fixture(t), source = 'skills/check-example', content = Buffer.from('---\nname: check-example\ndescription: Verify a bounded example\n---\n# Checks\nPreserve approved guidance.\n');
  const files = new Map([['LICENSE', Buffer.from('MIT\n')], [`${source}/SKILL.md`, content]]);
  const approval = { approved: true, repository: 'https://github.com/example/skills', commit: 'a'.repeat(40), license_path: 'LICENSE',
    skills: [{ source_path: source, target_name: 'check-example', files: [`${source}/SKILL.md`] }] };
  const reader = async input => ({ repository: input.repository, commit: input.commit, path: input.path, kind: 'file', complete: true, content: files.get(input.path) });
  const result = await installWorkspaceSkillComponents(root, approval, reader), id = result.components[0].id;
  const context = resolveNativeSkills(root, ['check-example'])[0];
  const resource = { key: `skill:${id}`, fingerprint: context.approval_sha256, skill: context };
  return { root, id, context, resource, content, approval, reader };
}
test('actual skill removal waits for every pinned holder, rejects new admissions and preserves exact archived guidance', async t => {
  const f = await skillFixture(t), first = lease.acquireNativeCapabilityLease(f.root, { owner: owner('first'), resources: [f.resource] });
  const second = lease.acquireNativeCapabilityLease(f.root, { owner: owner('second'), resources: [f.resource] });
  const receipt = fs.readFileSync(safePath(f.root, f.context.receipt_path));
  const controlled = controlWorkspaceSkillComponent(f.root, f.id, 'remove');
  assert.equal(controlled.control.state, 'deferred');
  assert.deepEqual(fs.readFileSync(safePath(f.root, f.context.receipt_path)), receipt, 'Pending shutdown never rewrites pinned raw receipt bytes.');
  assert.deepEqual(fs.readFileSync(join(f.root, f.context.skill_path)), f.content);
  assert.equal(listWorkspaceSkillComponents(f.root).components[0].available, false, 'A queued removal denies selection for new work.');
  assert.throws(() => lease.acquireNativeCapabilityLease(f.root, { owner: owner('third'), resources: [f.resource] }), /CAPABILITY_DRAINING/);
  assert.throws(() => lease.releaseNativeCapabilityLease(f.root, first, owner('first', 2), proof), /LEASE_OWNER_MISMATCH/);
  assert.equal(lease.releaseNativeCapabilityLease(f.root, first, owner('first'), proof).ready_actions.length, 0);
  assert.equal(lease.drainNativeCapabilityControls(f.root, () => assert.fail('A second actual holder still exists.')).length, 0);
  assert.equal(lease.releaseNativeCapabilityLease(f.root, second, owner('second'), proof).ready_actions.length, 1);
  const drained = lease.drainNativeCapabilityControls(f.root, control => controlWorkspaceSkillComponent(f.root, f.id, control.action));
  assert.equal(drained[0].state, 'applied');
  assert.equal(fs.existsSync(join(f.root, f.context.skill_path)), false);
  const archived = lease.readNativeCapabilityLeaseSkill(f.root, second, owner('second'), f.id);
  assert.deepEqual(Buffer.from(archived.receipt_base64, 'base64'), receipt);
  assert.deepEqual(Buffer.from(archived.files[0].content_base64, 'base64'), f.content);
  assert.equal(archived.approval_sha256, f.context.approval_sha256);
  assert.equal(lease.releaseNativeCapabilityLease(f.root, second, owner('second'), proof).released, false, 'Same settled proof is idempotent.');
  assert.throws(() => lease.releaseNativeCapabilityLease(f.root, second, owner('second'), { outcome_sha256: sha('Different result') }), /LEASE_RELEASE_CONFLICT/);
});
test('queued disable is cancelled by exact approved reinstall without rewriting a running skill', async t => {
  const f = await skillFixture(t), ref = lease.acquireNativeCapabilityLease(f.root, { owner: owner(), resources: [f.resource] });
  controlWorkspaceSkillComponent(f.root, f.id, 'disable');
  const before = fs.readFileSync(join(f.root, f.context.skill_path));
  await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  assert.equal(lease.readNativeCapabilityControl(f.root, f.resource.key).pending_action, undefined);
  assert.deepEqual(fs.readFileSync(join(f.root, f.context.skill_path)), before);
  assert.equal(listWorkspaceSkillComponents(f.root).components[0].available, true);
  lease.releaseNativeCapabilityLease(f.root, ref, owner(), proof);
});
test('durable holders survive module reload, are root and generation bound, and never expire by elapsed time', t => {
  const root = fixture(t), other = fixture(t), resource = { key: 'mcp:approved-fixture', fingerprint: sha('exact MCP tool catalog') };
  const ref = lease.acquireNativeCapabilityLease(root, { owner: owner(), resources: [resource] });
  lease.requestNativeCapabilityControl(root, { key: resource.key, action: 'disable' });
  assert.equal(lease.readNativeCapabilityControl(root, resource.key).active_count, 1);
  assert.throws(() => lease.assertNativeCapabilityLease(root, ref, owner('b')), /LEASE_OWNER_MISMATCH/);
  assert.throws(() => lease.assertNativeCapabilityLease(other, ref, owner()), /LEASE_NOT_FOUND/);
  assert.throws(() => lease.acquireNativeCapabilityLease(root, { owner: owner('b'), resources: [{ ...resource, fingerprint: sha('changed catalog') }] }), /CAPABILITY_DRAINING/);
  assert.equal(lease.drainNativeCapabilityControls(root, () => assert.fail('No known settled proof.')).length, 0);
  const unrelated = lease.acquireNativeCapabilityLease(root, { owner: owner('other'), resources: [{ key: 'mcp:other', fingerprint: sha('other') }] });
  lease.releaseNativeCapabilityLease(root, unrelated, owner('other'), proof);
  assert.equal(lease.readNativeCapabilityControl(root, resource.key).active_count, 1);
});
test('failed deferred application remains denied and can be retried exactly once after success', t => {
  const root = fixture(t), key = 'mcp:fixture';
  const ref = lease.acquireNativeCapabilityLease(root, { owner: owner(), resources: [{ key, fingerprint: sha('catalog') }] });
  lease.requestNativeCapabilityControl(root, { key, action: 'disconnect', client: 'copilot-vscode', target_sha256: sha('selected host profile') });
  lease.releaseNativeCapabilityLease(root, ref, owner(), proof);
  const first = lease.drainNativeCapabilityControls(root, () => { throw new Error('PRIVATE provider detail'); });
  assert.equal(first[0].state, 'pending');
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
  assert.equal(lease.readNativeCapabilityControl(root, key).new_admissions, false);
  let calls = 0;
  assert.equal(lease.drainNativeCapabilityControls(root, control => { calls++; assert.equal(control.target_sha256, sha('selected host profile')); })[0].state, 'applied');
  assert.deepEqual(lease.drainNativeCapabilityControls(root, () => { calls++; }), []);
  assert.equal(calls, 1);
});
test('actual MCP disable and disconnect preserve policy and registrations while a native holder runs', t => {
  const root = fixture(t); initialize(root, { project_id: 'LEASES', platforms: ['copilot'] });
  setPluginEnabled(root, 'context7', true);
  const policy = safePath(root, '.neomind/tools.json'), before = fs.readFileSync(policy);
  const config = join(root, 'private-mcp.json'); fs.writeFileSync(config, '{"servers":{"unrelated":{"command":"preserve"}}}');
  const original = fs.readFileSync(config), key = 'mcp:context7';
  const ref = lease.acquireNativeCapabilityLease(root, { owner: owner(), resources: [{ key, fingerprint: sha('registered catalog') }] });
  const disabled = setPluginEnabled(root, 'context7', false).plugins.find(item => item.id === 'context7');
  assert.equal(disabled.control.state, 'deferred');
  assert.deepEqual(fs.readFileSync(policy), before);
  const disconnected = setPluginConnection(root, { plugin: 'context7', client: 'copilot-vscode', connected: false }, { copilotVscode: config });
  assert.equal(disconnected.control.state, 'deferred');
  assert.deepEqual(fs.readFileSync(config), original);
  assert.equal(readPluginControlStatus(root).plugins.find(item => item.id === 'context7').control.active_count, 1);
  return Promise.all([assert.rejects(installPlugin(root, 'context7'), /CAPABILITY_IN_USE/), assert.rejects(probePlugin(root, 'context7'), /CAPABILITY_IN_USE/)]).then(() => {
    lease.releaseNativeCapabilityLease(root, ref, owner(), proof);
    const drained = lease.drainNativeCapabilityControls(root, control => control.action === 'disconnect'
      ? setPluginConnection(root, { plugin: 'context7', client: control.client, connected: false }, { copilotVscode: config })
      : setPluginEnabled(root, 'context7', false));
    assert.equal(drained.every(item => item.state === 'applied'), true);
    assert.deepEqual(fs.readFileSync(config), original, 'Unrelated registrations survive.');
    assert.equal(readPluginControlStatus(root).plugins.find(item => item.id === 'context7').enabled, false);
  });
});
test('enable cancels an active pending MCP shutdown without changing its pinned policy bytes', t => {
  const root = fixture(t); initialize(root, { project_id: 'LEASE-ENABLE', platforms: ['copilot'] });
  setPluginEnabled(root, 'context7', true);
  const before = fs.readFileSync(safePath(root, '.neomind/tools.json')), key = 'mcp:context7';
  const ref = lease.acquireNativeCapabilityLease(root, { owner: owner('enable', 0), resources: [{ key, fingerprint: sha('catalog') }] });
  setPluginEnabled(root, 'context7', false);
  assert.equal(lease.readNativeCapabilityControl(root, key).pending_action, 'disable');
  setPluginEnabled(root, 'context7', true);
  assert.equal(lease.readNativeCapabilityControl(root, key).pending_action, undefined);
  assert.deepEqual(fs.readFileSync(safePath(root, '.neomind/tools.json')), before);
  const another = lease.acquireNativeCapabilityLease(root, { owner: owner('another'), resources: [{ key, fingerprint: sha('catalog') }] });
  lease.releaseNativeCapabilityLease(root, another, owner('another'), proof);
  lease.releaseNativeCapabilityLease(root, ref, owner('enable', 0), proof);
  assert.deepEqual(lease.drainNativeCapabilityControls(root, () => assert.fail('Shutdown was cancelled.')), []);
});
test('logical MCP uninstall waits, checks original host profile, removes owned registration and retains cache and authored entries', t => {
  const root = fixture(t); initialize(root, { project_id: 'LEASE-REMOVE', platforms: ['copilot'] });
  setPluginEnabled(root, 'context7', true);
  const tool = toolCatalog.find(item => item.id === 'context7'), installed = safePath(root, `.neomind/tools/context7/${tool.version}`);
  const pkg = join(installed, 'node_modules', tool.package), script = join(pkg, 'cli.mjs'), source = '// Private pinned fixture. Not executed.\n';
  fs.mkdirSync(pkg, { recursive: true }); fs.writeFileSync(script, source);
  fs.writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: tool.package, version: tool.version, bin: 'cli.mjs' }));
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${tool.package}`]: { version: tool.version, integrity: tool.integrity } } });
  fs.writeFileSync(join(installed, 'package-lock.json'), lock);
  fs.mkdirSync(safePath(root, '.neomind/tool-locks'), { recursive: true });
  fs.writeFileSync(safePath(root, `.neomind/tool-locks/context7-${tool.version}.json`), lock);
  const server = { command: 'node', args: [script], env: { DO_NOT_TRACK: '1' } };
  fs.mkdirSync(safePath(root, '.neomind/plugins'), { recursive: true });
  fs.writeFileSync(safePath(root, '.neomind/plugins/context7-probe.json'), JSON.stringify({ schema_version: 1, plugin: 'context7', at: new Date().toISOString(), tool_count: tool.tools.length,
    baseline: sha(JSON.stringify({ version: tool.version, integrity: tool.integrity, server, executable: sha(source), dependency_lock: sha(lock) })) }));
  const profile = join(root, 'private-mcp.json'), changed = join(root, 'other-mcp.json');
  fs.writeFileSync(profile, '{"servers":{"authored":{"command":"preserve"}}}'); fs.writeFileSync(changed, '{}');
  const targets = { copilotVscode: profile };
  setPluginConnection(root, { plugin: 'context7', client: 'copilot-vscode', connected: true }, targets);
  const before = fs.readFileSync(profile), key = 'mcp:context7';
  const ref = lease.acquireNativeCapabilityLease(root, { owner: owner('remove'), resources: [{ key, fingerprint: sha('catalog') }] });
  const removed = removePlugin(root, 'context7', targets);
  assert.equal(removed.cache_retained, true); assert.equal(removed.control.state, 'deferred'); assert.equal(removed.owned_registrations_removed, false);
  assert.deepEqual(fs.readFileSync(profile), before);
  lease.releaseNativeCapabilityLease(root, ref, owner('remove'), proof);
  assert.equal(lease.drainNativeCapabilityControls(root, input => applyNativePluginControl(root, input, { copilotVscode: changed }))[0].state, 'pending');
  assert.deepEqual(fs.readFileSync(profile), before);
  assert.equal(lease.drainNativeCapabilityControls(root, input => applyNativePluginControl(root, input, targets))[0].state, 'applied');
  assert.deepEqual(JSON.parse(fs.readFileSync(profile)).servers, { authored: { command: 'preserve' } });
  assert.equal(fs.existsSync(script), true); assert.equal(readPluginControlStatus(root).plugins.find(item => item.id === 'context7').enabled, false);
  assert.deepEqual(lease.drainNativeCapabilityControls(root, () => assert.fail('Already applied.')), []);
});
test('an orphan snapshot or changed immutable asset blob cannot authorize leased guidance', async t => {
  const f = await skillFixture(t), ref = lease.acquireNativeCapabilityLease(f.root, { owner: owner(), resources: [f.resource] });
  const index = safePath(f.root, '.neomind/native/capability-leases/index.json'), original = fs.readFileSync(index);
  fs.unlinkSync(index);
  assert.throws(() => lease.readNativeCapabilityLeaseSkill(f.root, ref, owner(), f.id), /LEASE_NOT_ACTIVE/);
  fs.writeFileSync(index, original);
  const blob = safePath(f.root, `.neomind/native/capability-leases/blobs/${sha(f.content)}.json`);
  fs.writeFileSync(blob, '{}');
  assert.throws(() => lease.readNativeCapabilityLeaseSkill(f.root, ref, owner(), f.id), /CAPABILITY_SNAPSHOT_INVALID/);
});
test('same-ID native binding and owned provider controls keep separate origins and cannot cancel or coalesce one another', t => {
  const root = fixture(t), key = 'mcp:context7';
  const ref = lease.acquireNativeCapabilityLease(root, { owner: owner('origins'), resources: [{ key, fingerprint: sha('same native tool catalog') }] });
  lease.requestNativeCapabilityControl(root, { key, action: 'disable' });
  lease.requestNativeCapabilityControl(root, { key, action: 'remove', origin: 'native-binding' });
  lease.requestNativeCapabilityControl(root, { key, action: 'enable', origin: 'native-binding' });
  assert.equal(lease.readNativeCapabilityControl(root, key).pending_action, 'disable', 'Native binding enable does not cancel provider shutdown.');
  lease.requestNativeCapabilityControl(root, { key, action: 'remove', origin: 'native-binding' });
  lease.requestNativeCapabilityControl(root, { key, action: 'enable' });
  assert.equal(lease.readNativeCapabilityControl(root, key).pending_action, 'remove', 'Provider enable does not cancel native binding removal.');
  lease.requestNativeCapabilityControl(root, { key, action: 'disable' });
  assert.equal(lease.releaseNativeCapabilityLease(root, ref, owner('origins'), proof).ready_actions.length, 2);
  const applied = [];
  const drained = lease.drainNativeCapabilityControls(root, input => { applied.push(input); });
  assert.equal(drained.length, 2);
  assert.deepEqual(applied.map(item => [item.action, item.origin]), [['remove', 'native-binding'], ['disable', undefined]]);
  assert.throws(() => applyNativePluginControl(root, { key, action: 'disable', origin: 'native-binding' }), /does not own/);
});
test('cross-process admission cannot slip between holder check and actual skill mutation', async t => {
  const f = await skillFixture(t), marker = join(f.root, 'host-control-started');
  const coreUrl = new URL('native-capability-leases.js', base.endsWith('/') ? base : `${base}/`).href;
  const skillsUrl = new URL('workspace-skill-components.js', base.endsWith('/') ? base : `${base}/`).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
import {withNativeCapabilityControl} from ${JSON.stringify(coreUrl)};
import {controlWorkspaceSkillComponent} from ${JSON.stringify(skillsUrl)};
import {writeFileSync} from 'node:fs';
withNativeCapabilityControl(${JSON.stringify(f.root)}, {key:${JSON.stringify(f.resource.key)},action:'remove'},()=>{
 writeFileSync(${JSON.stringify(marker)},'locked');
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
 return controlWorkspaceSkillComponent(${JSON.stringify(f.root)},${JSON.stringify(f.id)},'remove');
});`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(marker), true, errors);
  assert.throws(() => lease.acquireNativeCapabilityLease(f.root, { owner: owner('late'), resources: [f.resource] }), /CAPABILITY_INPUT_CHANGED/);
  assert.equal(await finished, 0, errors);
  assert.equal(fs.existsSync(join(f.root, f.context.skill_path)), false);
});
