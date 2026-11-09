import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { initialize, loadRecords } from '../dist/storage.js';
import { installWorkspaceSkillComponents, controlWorkspaceSkillComponent } from '../dist/workspace-skill-components.js';
import { resolveNativeSkills, assertNativeSkillsCurrent } from '../dist/native-skill-context.js';
import * as requests from '../dist/native-request.js';
import * as roles from '../dist/native-role-job.js';
import { nativeLocalRequestSchema } from '../dist/native-local-contract.js';
const require = createRequire(import.meta.url);
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-skills-'));
  initialize(root, { project_id: 'WF-NATIVE-SKILLS' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function install(root) {
  const names = ['writing-guide', 'review-guide'];
  const files = new Map([['LICENSE', 'MIT License\n']]);
  const skills = names.map(name => {
    const source_path = `skills/${name}`;
    files.set(`${source_path}/SKILL.md`, `---\nname: ${name}\ndescription: Scoped professional guidance\n---\nRead references/checklist.md.\n`);
    files.set(`${source_path}/references/checklist.md`, `# ${name}\nCheck concrete outcomes.\n`);
    return { source_path, target_name: name, files: [`${source_path}/SKILL.md`, `${source_path}/references/checklist.md`] };
  });
  return installWorkspaceSkillComponents(root, { approved: true, repository: 'https://github.com/example/approved-guidance',
    commit: 'a'.repeat(40), license_path: 'LICENSE', skills }, async input =>
    ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
}
const isSkillError = code => error => error.code === code && !/AUTH|claim|token|assignment/.test(error.message);
const pass = { summary: 'Observed bounded professional work.', verdict: 'pass', findings: [] };
function outcome(state, assignment) { return { request_ref: state.request_ref, assignment_ref: assignment.assignment_ref,
  invocation: { transport: 'vscode-native', tool: 'runSubagent', invoked: true, host_call_id: randomUUID(), agentName: assignment.agentName, status: 'returned' },
  raw_result: JSON.stringify(pass) }; }

test('explicit native skill selection pins the exact receipt and every ordinary approved asset without claiming loading', async t => {
  const root = project(t); await install(root);
  const before = loadRecords(root), selected = resolveNativeSkills(root, ['writing-guide']);
  assert.equal(selected.length, 1); assert.equal(selected[0].name, 'writing-guide');
  assert.equal(selected[0].files.length, 2);
  assert.match(selected[0].receipt_path, /\.workforce\/capabilities\/workspace-skill-/);
  assert.match(selected[0].receipt_sha256, /^[a-f0-9]{64}$/);
  assert.ok(selected[0].files.some(file => file.path.endsWith('/references/checklist.md')));
  assert.doesNotThrow(() => assertNativeSkillsCurrent(root, selected));
  assert.deepEqual(resolveNativeSkills(root, []), []);
  assert.deepEqual(loadRecords(root), before);
  assert.equal('loaded' in selected[0], false); assert.equal('used' in selected[0], false);
});

test('missing, duplicate, disabled or changed explicit skill selections never silently choose another capability', async t => {
  const root = project(t), installed = await install(root);
  assert.throws(() => resolveNativeSkills(root, ['missing-guide']), isSkillError('SELECTED_SKILL_UNAVAILABLE'));
  assert.throws(() => resolveNativeSkills(root, ['writing-guide', 'writing-guide']), isSkillError('SELECTED_SKILL_UNAVAILABLE'));
  const selected = resolveNativeSkills(root, ['writing-guide']);
  const asset = join(root, '.github/skills/writing-guide/references/checklist.md');
  const bytes = readFileSync(asset); writeFileSync(asset, 'User changed the selected reference.\n');
  assert.throws(() => assertNativeSkillsCurrent(root, selected), isSkillError('SELECTED_SKILL_CHANGED'));
  assert.equal(readFileSync(asset, 'utf8'), 'User changed the selected reference.\n');
  writeFileSync(asset, bytes);
  controlWorkspaceSkillComponent(root, installed.components.find(item => item.target_name === 'writing-guide').id, 'disable');
  assert.throws(() => resolveNativeSkills(root, ['writing-guide']), isSkillError('SELECTED_SKILL_UNAVAILABLE'));
  assert.throws(() => assertNativeSkillsCurrent(root, selected), isSkillError('SELECTED_SKILL_CHANGED'));
});

test('full request skill names bind only their selected roles and current receipt/file hashes remain acceptance inputs', async t => {
  const root = project(t); await install(root);
  const opened = requests.openNativeRequest(root, { requirement: 'Write a checked text product.' });
  const state = requests.planNativeRequest(root, opened.request_ref, { summary: 'One checked file', requirements: ['hello'], design: 'Plain UTF-8 text',
    role_skills: { 'WF.FnD': ['writing-guide'], 'WF.Reviewer': ['review-guide'] }, outputs: ['product.txt'],
    checks: [{ title: 'Exact text', level: 'acceptance', command: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'hello')"] }] });
  assert.equal(Object.keys(state.preservation_baseline).some(path => path.includes('/capabilities/workspace-skill-')), false,
    'Lifecycle receipt metadata is provenance; selected assets remain protected product inputs');
  assert.ok(Object.keys(state.preservation_baseline).some(path => path.endsWith('/references/checklist.md')));
  const fnd = requests.nextNativeAssignment(root, state.request_ref);
  assert.match(fnd.prompt, /\.github\/skills\/writing-guide\/SKILL\.md/);
  assert.doesNotMatch(fnd.prompt, /\.github\/skills\/review-guide\/SKILL\.md/);
  writeFileSync(join(root, 'product.txt'), 'hello');
  requests.recordNativeResult(root, outcome(state, fnd));
  const review = requests.nextNativeAssignment(root, state.request_ref);
  assert.match(review.prompt, /\.github\/skills\/review-guide\/SKILL\.md/);
  assert.doesNotMatch(review.prompt, /\.github\/skills\/writing-guide\/SKILL\.md/);
  requests.recordNativeResult(root, outcome(state, review));
  const tester = requests.nextNativeAssignment(root, state.request_ref);
  assert.doesNotMatch(tester.prompt, /Selected workspace skill context/);
  requests.recordNativeResult(root, outcome(state, tester));
  await requests.runNativeChecks(root, state.request_ref);
  const closed = requests.finishNativeRequest(root, state.request_ref);
  assert.equal(closed.accepted, true);
  const retainedPlan = loadRecords(root).find(record => record.meta.id === closed.final_report_id).meta.data.native_capability_plan;
  assert.deepEqual(retainedPlan.role_skills, { 'WF.FnD': ['writing-guide'], 'WF.Reviewer': ['review-guide'] });
  assert.equal(retainedPlan.roles['WF.FnD'][0].receipt_sha256, state.skill_contexts['WF.FnD'][0].receipt_sha256);
  assert.equal(retainedPlan.loaded, 'not-observed'); assert.equal(retainedPlan.used, 'not-observed');
  assert.equal(retainedPlan.verified, 'not-observed');
  writeFileSync(join(root, '.github/skills/writing-guide/references/checklist.md'), 'Changed after acceptance.');
  assert.equal(requests.getNativeRequest(root, state.request_ref).accepted, false);
});

test('direct-role selected skills are protected context and concurrent disable prevents report publication', async t => {
  const root = project(t), installed = await install(root);
  const before = loadRecords(root).length;
  assert.throws(() => roles.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review only.', skills: ['missing-guide'] }), isSkillError('SELECTED_SKILL_UNAVAILABLE'));
  assert.equal(loadRecords(root).length, before, 'An invalid explicit selection creates no job');
  const opened = roles.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review only.', skills: ['review-guide'], outputs: ['review.md'] });
  assert.match(opened.prompt, /\.github\/skills\/review-guide\/SKILL\.md/);
  assert.ok(Object.keys(opened.baseline).some(path => path.endsWith('/references/checklist.md')));
  const software = requests.openNativeRequest(root, { requirement: 'Write a checked product.' });
  requests.planNativeRequest(root, software.request_ref, { summary: 'Checked text', requirements: ['hello'], design: 'Text',
    outputs: ['product.txt'], role_skills: { 'WF.FnD': ['review-guide'] },
    checks: [{ title: 'Existing check', level: 'acceptance', command: [process.execPath, '--version'] }] });
  controlWorkspaceSkillComponent(root, installed.components.find(item => item.target_name === 'review-guide').id, 'disable');
  assert.throws(() => requests.nextNativeAssignment(root, software.request_ref), isSkillError('SELECTED_SKILL_CHANGED'));
  assert.equal(requests.getNativeRequest(root, software.request_ref).assignments.length, 0);
  const saved = roles.recordNativeRoleResult(root, { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', agentName: 'WF.Reviewer', invoked: true, status: 'returned' },
    raw_result: JSON.stringify({ ...pass, report_artifacts: [{ path: 'review.md', content: '# Reviewed\n' }] }) });
  assert.equal(saved.completion, 'incomplete'); assert.equal(saved.accepted, false);
  assert.equal(existsSync(join(root, 'review.md')), false);
});

test('full adapter rejects unavailable explicit skills before creating any request or model call', async t => {
  const root = project(t), before = loadRecords(root);
  const vscode = { CancellationTokenSource: class { constructor() {
    this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
    lm: { tools: [], invokeTool() { assert.fail('Unavailable selected guidance must not invoke a model'); } } };
  const runner = createLocalRequestRunner(vscode, { ...requests, nativeLocalRequestSchema }, root);
  t.after(() => runner.dispose());
  const result = await runner.run({ requirement: 'A normal checked text product.', plan: {
    summary: 'Use installed guidance', requirements: ['hello'], design: 'A text product', outputs: ['product.txt'],
    role_skills: { 'WF.FnD': ['not-installed'] },
    checks: [{ title: 'Existing check', command: [process.execPath, '-e', 'process.exit(0)'], level: 'acceptance' }] } }, {});
  assert.equal(result.error.code, 'SELECTED_SKILL_UNAVAILABLE');
  assert.equal(result.error.category, 'capability');
  assert.deepEqual(loadRecords(root), before, 'Preflight cannot leave an orphan intake request');
});

test('hash-identical linked selected references are unavailable and cannot publish a direct-role report', async t => {
  const root = project(t); await install(root);
  const shared = join(root, 'same-guidance'); mkdirSync(shared);
  const original = join(root, '.github/skills/review-guide/references/checklist.md');
  writeFileSync(join(shared, 'checklist.md'), readFileSync(original));
  const opened = roles.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review only.', skills: ['review-guide'], outputs: ['review.md'] });
  const references = join(root, '.github/skills/review-guide/references');
  rmSync(references, { recursive: true }); symlinkSync(shared, references, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveNativeSkills(root, ['review-guide']), isSkillError('SELECTED_SKILL_UNAVAILABLE'));
  const saved = roles.recordNativeRoleResult(root, { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', agentName: 'WF.Reviewer', invoked: true, status: 'returned' },
    raw_result: JSON.stringify({ ...pass, report_artifacts: [{ path: 'review.md', content: '# Independent review\n' }] }) });
  assert.equal(saved.completion, 'incomplete'); assert.equal(saved.status, 'uncertain');
  assert.equal(existsSync(join(root, 'review.md')), false);
  assert.match(saved.report.summary, /Observed/);
});

test('explicit pinned skill lookup follows existing legacy managed roots without creating a competing metadata folder', async t => {
  const root = project(t); await install(root);
  renameSync(join(root, '.workforce'), join(root, '.neomind'));
  const selected = resolveNativeSkills(root, ['writing-guide']);
  assert.doesNotThrow(() => assertNativeSkillsCurrent(root, selected));
  assert.equal(existsSync(join(root, '.workforce')), false);
  assert.match(selected[0].receipt_path, /\/capabilities\/workspace-skill-/);
  assert.match(selected[0].skill_path, /writing-guide\/SKILL\.md/);
});
