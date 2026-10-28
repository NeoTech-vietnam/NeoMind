// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRecord, getRecord, saveWorkflowClosure } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { lightweightRun } from '../dist/lightweight.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { reportAgentActivity, readAgentActivity, agentActivityTtlMs, agentActivityLimits } from '../dist/agent-activity.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-activity-'));
  initialize(root, { project_id: 'ACTIVITY', name: 'Activity test', platforms: ['copilot'] });
  ensureRoutingPolicy(root);
  const native = beginWorkflow(root, { requirement: 'Inspect unsigned native activity without changing engineering state.', execution_mode: 'copilot-native' });
  const light = lightweightRun(root, { requirement: 'Inspect lightweight progress without accepting engineering work.', request_id: 'activity-light' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, native, light: getRecord(root, light.workflow.workflow_id) };
}
const input = (workflow, patch = {}) => ({ workflow_id: workflow.meta.id, assignment_id: 'inspect-source',
  profile_id: 'explorer', state: 'running', summary: 'Reading the assigned source boundary.', ...patch });
function protectedSnapshot(root, directory = '.neomind') {
  return readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (path === '.neomind/runs/agent-activity') return [];
    return entry.isDirectory() ? protectedSnapshot(root, path) : [[path, readFileSync(join(root, path)).toString('base64')]];
  });
}
function saved(root, value, patch = {}, time) {
  const event = { ...value, id: randomUUID(), ...patch }, path = join(root, `.neomind/runs/agent-activity/${event.id}.json`);
  writeFileSync(path, JSON.stringify(event));
  if (time) utimesSync(path, time, time);
  return event;
}

test('activity reports are append-only unsigned observations for all nine profiles and preserve protected state', t => {
  const { root, native, light } = setup(t), before = protectedSnapshot(root);
  const roles = { coordinator: 'manager', explorer: 'codebase-analyst', researcher: 'researcher', planner: 'requirements',
    architect: 'architect', implementer: 'developer', debugger: 'developer', verifier: 'verifier', reviewer: 'reviewer' };
  for (const [profile_id, role] of Object.entries(roles)) {
    const event = reportAgentActivity(root, input(native, { profile_id, assignment_id: profile_id, invocation_id: `reported-${profile_id}` }));
    assert.equal(event.role, role);
    assert.equal(event.source, 'native-activity');
    assert.equal(event.execution_mode, 'unsigned-native-progress');
    assert.equal(event.project_id, 'ACTIVITY');
    assert.equal(new Date(event.observed_at).toISOString(), event.observed_at);
    assert.equal(event.confirmed_model, undefined);
  }
  assert.equal(light.meta.data.routing_required, true, 'Legitimate lightweight storage keeps its legacy routing stamp');
  reportAgentActivity(root, input(light));
  assert.deepEqual(protectedSnapshot(root), before);
  const snapshot = readAgentActivity(root);
  assert.equal(snapshot.events.length, 10);
  assert.equal(snapshot.latest.length, 10);
  assert.equal(snapshot.invalid, 0);
  assert.equal(snapshot.omitted, 0);
});

test('strict, foreign, missing, nonworkflow and cross-workflow task input cannot write activity', t => {
  const { root, native, light } = setup(t);
  const strict = beginWorkflow(root, { requirement: 'Preserve signed engineering state.', execution_mode: 'strict' });
  const other = beginWorkflow(root, { requirement: 'Keep a different unsigned workflow isolated.', execution_mode: 'copilot-native' });
  const task = createRecord(root, { type: 'task', title: 'Developer task', owner: 'developer', data: { workflow_id: native.meta.id } });
  const outside = createRecord(root, { type: 'task', title: 'Other task', owner: 'developer', data: { workflow_id: other.meta.id } });
  const strictTask = createRecord(root, { type: 'task', title: 'Strict target', owner: 'developer', data: { workflow_id: strict.meta.id } });
  const before = protectedSnapshot(root);
  for (const patch of [
    { workflow_id: strict.meta.id }, { workflow_id: 'FOREIGN-KNW-0001' }, { workflow_id: task.meta.id },
    { task_id: outside.meta.id }, { task_id: strictTask.meta.id }, { task_id: native.meta.id },
    { workflow_id: light.meta.id, task_id: task.meta.id },
  ]) assert.throws(() => reportAgentActivity(root, input(native, patch)));
  assert.deepEqual(protectedSnapshot(root), before);
  assert.equal(readAgentActivity(root).events.length, 0);
  // Association is not ownership: an independent reviewer can inspect a developer task.
  assert.equal(reportAgentActivity(root, input(native, { profile_id: 'reviewer', task_id: task.meta.id })).task_id, task.meta.id);
});

test('only exact bounded activity fields and canonical profile identities are accepted', t => {
  const { root, native } = setup(t);
  for (const patch of [
    { profile_id: 'NeoMind Explorer Agent' }, { profile_id: 'manager' }, { state: 'accepted' }, { state: ['running'] },
    { summary: '' }, { summary: 'x'.repeat(241) }, { summary: 'raw\nlog' }, { assignment_id: '' },
    { assignment_id: 'x'.repeat(257) }, { invocation_id: 'x\0y' },
    { profile_id: 'coordinator', assignment_id: 'other' }, { assignment_id: 'coordinator' },
    { observed_at: new Date().toISOString() }, { role: 'manager' }, { confirmed_model: 'forged' },
    { requested_model: 'forged' }, { assurance: 'signed-native-routing' }, { data: { phase: 'completed' } },
  ]) assert.throws(() => reportAgentActivity(root, input(native, patch)));
  assert.equal(readAgentActivity(root).events.length, 0);
});

test('known assignment profile and task identity remain stable without granting task ownership', t => {
  const { root, native } = setup(t);
  const task = createRecord(root, { type: 'task', title: 'Associated task', owner: 'developer', data: { workflow_id: native.meta.id } });
  const first = reportAgentActivity(root, input(native, { task_id: task.meta.id }));
  assert.throws(() => reportAgentActivity(root, input(native, { task_id: task.meta.id, profile_id: 'researcher' })), /binding cannot change/);
  assert.throws(() => reportAgentActivity(root, input(native)), /binding cannot change/);
  const second = reportAgentActivity(root, input(native, { task_id: task.meta.id, state: 'waiting', invocation_id: 'actual-reported-worker' }));
  assert.notEqual(first.id, second.id);
  assert.equal(readAgentActivity(root).events.length, 2);
});

test('active reports expire to unknown using server observation time while terminal heads remain historical', t => {
  const { root, native } = setup(t);
  const first = reportAgentActivity(root, input(native));
  const expired = readAgentActivity(root, { now: new Date(Date.parse(first.observed_at) + agentActivityTtlMs).toISOString() }).latest[0];
  assert.equal(expired.state, 'unknown');
  assert.equal(expired.reported_state, 'running');
  assert.equal(expired.expired, true);
  assert.equal(expired.age_ms, agentActivityTtlMs);
  const terminal = reportAgentActivity(root, input(native, { state: 'completed', summary: 'The bounded source inspection has returned.' }));
  const snapshot = readAgentActivity(root, { now: new Date(Date.parse(terminal.observed_at) + agentActivityTtlMs * 2).toISOString() });
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.latest[0].state, 'completed');
  assert.equal(snapshot.latest[0].expired, false);
  assert.equal(snapshot.latest[0].expires_at, null);
  assert.equal(snapshot.latest[0].id, terminal.id);
});

test('workflow closure refuses further writes and neutralizes earlier active reports without rewriting them', t => {
  const { root, native } = setup(t);
  reportAgentActivity(root, input(native));
  saveWorkflowClosure(root, native.meta.id, { data: { phase: 'completed' } }, () => {});
  const before = protectedSnapshot(root), eventBytes = readdirSync(join(root, '.neomind/runs/agent-activity')).map(name => readFileSync(join(root, '.neomind/runs/agent-activity', name), 'utf8'));
  assert.throws(() => reportAgentActivity(root, input(native, { state: 'completed' })), /Completed workflows/);
  const latest = readAgentActivity(root).latest[0];
  assert.equal(latest.state, 'unknown');
  assert.equal(latest.expired, true);
  assert.deepEqual(protectedSnapshot(root), before);
  assert.deepEqual(readdirSync(join(root, '.neomind/runs/agent-activity')).map(name => readFileSync(join(root, '.neomind/runs/agent-activity', name), 'utf8')), eventBytes);
});

test('bounded readers count malformed, foreign, oversized and provenance-forged events without leaking contents', t => {
  const { root, native } = setup(t), good = reportAgentActivity(root, input(native));
  saved(root, good, { project_id: 'FOREIGN' });
  saved(root, good, { role: 'manager' });
  saved(root, good, { confirmed_model: 'SECRET_CLAIM' });
  saved(root, good, { workflow_id: 'FOREIGN-KNW-0001' });
  saved(root, good, { observed_at: 'invalid' });
  writeFileSync(join(root, `.neomind/runs/agent-activity/${randomUUID()}.json`), '{SECRET_BROKEN');
  writeFileSync(join(root, `.neomind/runs/agent-activity/${randomUUID()}.json`), 'x'.repeat(agentActivityLimits.bytes + 1));
  const snapshot = readAgentActivity(root);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.invalid, 7);
  assert.equal(snapshot.latest[0].id, good.id);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});

test('recent history stays bounded and active latest heads are prioritized within the inspected window', t => {
  const { root, native } = setup(t), good = reportAgentActivity(root, input(native));
  const start = Date.parse(good.observed_at);
  // Direct fixtures exercise the reader window without repeatedly re-reading prior events through the writer.
  for (let index = 0; index < agentActivityLimits.events + 4; index++) {
    const clock = new Date(start + index + 1);
    saved(root, good, { assignment_id: `done-${index}`, state: 'completed', observed_at: clock.toISOString() }, clock);
  }
  const activeClock = new Date(start + agentActivityLimits.events + 20);
  const running = saved(root, good, { assignment_id: 'retained-active', observed_at: activeClock.toISOString() }, activeClock);
  const newer = new Date(activeClock.getTime() + 1);
  saved(root, good, { assignment_id: 'newer-terminal', state: 'completed', observed_at: newer.toISOString() }, newer);
  const snapshot = readAgentActivity(root, { now: newer.toISOString() });
  assert.equal(snapshot.events.length, agentActivityLimits.events);
  assert.ok(snapshot.omitted > 0);
  assert.equal(snapshot.latest[0].id, running.id);
  assert.equal(snapshot.invalid, 0);
});

test('parallel processes append distinct immutable files without overwriting protected project state', async t => {
  const { root, native } = setup(t), before = protectedSnapshot(root);
  const modulePath = fileURLToPath(new URL('../dist/agent-activity.js', import.meta.url));
  const programs = Array.from({ length: 4 }, (_, index) => {
    const payload = input(native, { assignment_id: `parallel-${index}` });
    const script = `import {reportAgentActivity} from ${JSON.stringify(pathToFileURL(modulePath).href)}; reportAgentActivity(${JSON.stringify(root)},${JSON.stringify(payload)});`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Activity child failed: ${errors}`)));
    });
  });
  await Promise.all(programs);
  const snapshot = readAgentActivity(root);
  assert.equal(snapshot.events.length, 4);
  assert.equal(new Set(snapshot.events.map(event => event.id)).size, 4);
  assert.deepEqual(protectedSnapshot(root), before);
});

test('linked activity files are rejected instead of reading unrelated files', t => {
  const { root, native } = setup(t), good = reportAgentActivity(root, input(native));
  const outside = mkdtempSync(join(tmpdir(), 'neomind-activity-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const linked = join(root, `.neomind/runs/agent-activity/${randomUUID()}.json`), target = join(outside, 'private.json');
  writeFileSync(target, JSON.stringify({ ...good, summary: 'SECRET_OUTSIDE' }));
  try { symlinkSync(target, linked, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('File symlinks require host privileges.'); return; } throw error; }
  assert.equal(readAgentActivity(root).invalid, 1);
  assert.doesNotMatch(JSON.stringify(readAgentActivity(root)), /SECRET_OUTSIDE/);
});

test('linked activity directories are rejected without writing outside the project', t => {
  const { root, native } = setup(t);
  reportAgentActivity(root, input(native));
  const outside = mkdtempSync(join(tmpdir(), 'neomind-activity-directory-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(join(root, '.neomind/runs/agent-activity'), { recursive: true, force: true });
  symlinkSync(outside, join(root, '.neomind/runs/agent-activity'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => reportAgentActivity(root, input(native)), /outside|ordinary directory|link/);
  assert.equal(readAgentActivity(root).invalid, 1);
  assert.deepEqual(readdirSync(outside), []);
});
