import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { initialize, createRecord, getRecord, loadRecords, safePath, atomicWrite, now } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow, nativeAutomationPolicy } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment } from '../dist/assignment-runtime.js';
import { planNativeSoftware, readNativeSoftwareContract } from '../dist/native-software.js';
import { reportAgentActivity, readAgentActivity } from '../dist/agent-activity.js';
import { readAgentMap } from '../dist/agent-map.js';

function fixture(t) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(parent, 'neomind-record-view-')));
  t.after(() => { assert.equal(dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'FRESH-VIEW', profile: 'software', platforms: ['copilot'] }); ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify(nativeAutomationPolicy()));
  const workflow = beginWorkflow(root, { requirement: 'Deliver one independently checked dependency-free scalar.', execution_mode: 'copilot-native' });
  const packet = prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager', assignment_id: 'fresh-view-plan', objective: 'Define bounded software ownership and independent verification.' });
  const manager = openAssignment(root, packet.open_input).handle;
  const planned = planNativeSoftware(root, manager, { process: 'software-tools', title: 'Deliver integer one', objective: 'Export one from a dependency-free Node module.', rationale: 'A pure software scalar requires no hardware assumptions.',
    acceptance_criteria: ['source/value.mjs exports integer one.'], allowed_paths: ['source/value.mjs'], verification_paths: ['checks/check.mjs'], outputs: ['source/value.mjs'], documentation_paths: [],
    checks: [{ title: 'Independent scalar assertion', command: [process.execPath, 'checks/check.mjs'], baseline_paths: ['source/value.mjs', 'checks/check.mjs'] }] });
  const activity = reportAgentActivity(root, { workflow_id: workflow.meta.id, task_id: planned.task_id, assignment_id: 'inspect-0', profile_id: 'explorer', state: 'running', summary: 'Inspecting the saved scalar contract.' });
  for (let index = 1; index < 18; index++) {
    const event = { ...activity, id: randomUUID(), assignment_id: `inspect-${index}` };
    atomicWrite(safePath(root, `.neomind/runs/agent-activity/${event.id}.json`), JSON.stringify(event));
  }
  // Scale actual ordinary record bytes without spending fixture setup time in
  // createRecord's intentionally authoritative writer paths for each padding row.
  for (let index = 0; index < 96; index++) {
    const meta = { schema_version: 1, id: `FRESH-VIEW-KNW-${9000 + index}`, type: 'knowledge', title: `Unrelated history ${index}`, owner: 'manager', status: 'draft', revision: 1, created_at: now(), updated_at: now(), links: [], data: {} };
    atomicWrite(safePath(root, `.neomind/records/${meta.id}.md`), `---\n${JSON.stringify(meta)}\n---\n# Unrelated saved history\n`);
  }
  return { root, workflow, planned, activity, recordCount: loadRecords(root).length,
    activityCount: fs.readdirSync(safePath(root, '.neomind/runs/agent-activity')).filter(name => name.endsWith('.json')).length };
}
function recordReads(root, operation) {
  const original = fs.readFileSync, counts = new Map(), base = resolve(root, '.neomind/records').replaceAll('\\', '/').toLowerCase() + '/';
  fs.readFileSync = function (path, ...args) {
    if (typeof path === 'string' && resolve(path).replaceAll('\\', '/').toLowerCase().startsWith(base)) counts.set(String(path), (counts.get(String(path)) ?? 0) + 1);
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return { value: operation(), total: [...counts.values()].reduce((a, b) => a + b, 0), maximum: Math.max(0, ...counts.values()) }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}
function rewrite(record, root, change) {
  const value = structuredClone(record); change(value);
  atomicWrite(safePath(root, value.path), `---\n${JSON.stringify(value.meta)}\n---\n${value.body}`);
}

test('scaled native contract reads every record exactly once per fresh authority check', t => {
  const a = fixture(t), read = recordReads(a.root, () => readNativeSoftwareContract(a.root, a.workflow.meta.id));
  assert.equal(read.value.task_id, a.planned.task_id);
  assert.equal(read.total, a.recordCount, 'Checks and requirements share one fresh inventory, not one full-store scan per ID.');
  assert.equal(read.maximum, 1);
});

test('read-only activity and Universe projections share one fresh record view while preserving real reported state', t => {
  const a = fixture(t), activity = recordReads(a.root, () => readAgentActivity(a.root)), map = recordReads(a.root, () => readAgentMap(a.root));
  assert.equal(activity.total, a.recordCount); assert.equal(activity.maximum, 1);
  assert.equal(activity.value.events.length, a.activityCount); assert.equal(activity.value.invalid, 0);
  assert.equal(activity.value.events.filter(event => event.task_id === a.planned.task_id).length, 18);
  assert.equal(map.total, a.recordCount); assert.equal(map.maximum, 1);
  const observed = map.value.nodes.filter(node => node.source === 'native-activity' && node.task_id === a.planned.task_id);
  assert.equal(observed.length, 18); assert.ok(observed.every(node => node.state === 'running' && node.workflow_id === a.workflow.meta.id && node.task_id === a.planned.task_id));
});

test('contract snapshots never survive a call: edits, deletion and duplicate IDs are detected next time', t => {
  const a = fixture(t), requirement = getRecord(a.root, a.workflow.meta.data.requirement_id), path = safePath(a.root, requirement.path), original = fs.readFileSync(path);
  assert.equal(readNativeSoftwareContract(a.root, a.workflow.meta.id).task_id, a.planned.task_id);
  rewrite(requirement, a.root, record => { record.body += '\nUser changed the original acceptance intent.\n'; });
  assert.throws(() => readNativeSoftwareContract(a.root, a.workflow.meta.id), /requirement intent|baseline changed/);
  fs.writeFileSync(path, original); fs.unlinkSync(path);
  assert.throws(() => readNativeSoftwareContract(a.root, a.workflow.meta.id), /Record not found/);
  fs.writeFileSync(path, original);
  const duplicate = safePath(a.root, '.neomind/records/duplicate.md'); fs.writeFileSync(duplicate, original);
  assert.throws(() => readNativeSoftwareContract(a.root, a.workflow.meta.id), /Duplicate record ID/);
  assert.throws(() => readAgentActivity(a.root), /Duplicate record ID/);
  assert.throws(() => readAgentMap(a.root), /Duplicate record ID/);
});

test('a previous read-only projection cannot authorize a later activity mutation or hide changed strict ownership', t => {
  const a = fixture(t), task = getRecord(a.root, a.planned.task_id);
  assert.equal(readAgentActivity(a.root).events.length, a.activityCount);
  rewrite(task, a.root, record => { record.meta.data.routing_required = true; });
  const changed = readAgentActivity(a.root);
  // Strict ancestry wins for the whole increment, including its Coordinator.
  assert.equal(changed.events.length, 0); assert.equal(changed.invalid, a.activityCount);
  assert.equal(readAgentMap(a.root).nodes.some(node => node.source === 'native-activity' && node.workflow_id === a.workflow.meta.id), false);
  assert.throws(() => reportAgentActivity(a.root, { workflow_id: a.workflow.meta.id, task_id: a.planned.task_id, assignment_id: 'new-write', profile_id: 'explorer', state: 'running', summary: 'Must not reuse stale read authority.' }), /Unsigned activity requires a saved native or lightweight workflow/);
});
