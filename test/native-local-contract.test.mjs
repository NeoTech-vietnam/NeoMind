import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../dist/native-local-contract.js';
import { parse } from 'yaml';
import { nativeLocalContractVersion, nativeRoles, nativeLocalProfile, nativeLocalRequestSchema,
  nativeLocalRequestJsonSchema } from '../dist/native-local-contract.js';

test('native profiles and software tool share one content contract without fixed model routing', () => {
  for (const role of nativeRoles) {
    const profile = nativeLocalProfile(role);
    assert.ok(profile.includes(`name: ${JSON.stringify(role)}`));
    assert.ok(profile.includes(nativeLocalContractVersion));
    assert.ok(profile.includes('user-invocable: true'));
    assert.doesNotMatch(profile, /^model:|top-models|worker-models|assignment_claim|assignment_progress|OpenCode/m);
  }
  assert.match(nativeLocalProfile('WF.PM'), /workforceRequest/);
  const manager = parse(nativeLocalProfile('WF.PM').split('---')[1]);
  assert.deepEqual(manager.agents, ['*']);
  assert.equal(manager.tools.some(tool => /^(?:agent|runSubagent)(?:\/|$)/i.test(tool)), false);
  assert.doesNotMatch(nativeLocalProfile('WF.Reviewer'), /tools:.*"edit"/);
  assert.doesNotMatch(nativeLocalProfile('WF.Tester'), /tools:.*"edit"/);
});

test('selector specialists use prebound role entry tools while hidden workers have no recursive or lifecycle capability', () => {
  assert.equal(typeof contract.nativeLocalWorkerProfile, 'function');
  for (const role of contract.nativeSpecialists) {
    const root = parse(nativeLocalProfile(role).split('---')[1]);
    const worker = parse(contract.nativeLocalWorkerProfile(role).split('---')[1]);
    assert.equal(root['user-invocable'], true);
    assert.equal(root['disable-model-invocation'], true);
    assert.ok(root.tools.includes(contract.nativeRootRoleToolReferences[role]));
    assert.deepEqual(root.agents, ['*']);
    assert.equal(root.tools.some(tool => /^(?:agent|runSubagent)(?:\/|$)/i.test(tool)), false);
    assert.equal(root.tools.includes('edit'), false);
    assert.equal(root.tools.includes('execute'), false);
    assert.equal(worker.name, contract.nativeWorkerProfiles[role]);
    assert.equal(worker['user-invocable'], false);
    assert.deepEqual(worker.agents, []);
    assert.ok(worker.tools.every(tool => !/workforce|runSubagent|^agent$|tool_search|assignment/i.test(tool)));
    assert.equal(worker.tools.includes('edit'), role === 'WF.FnD');
    assert.equal(worker.tools.includes('execute'), role === 'WF.FnD' || role === 'WF.Tester');
  }
});

test('the independent Tester worker can execute checks while remaining unable to edit or delegate', () => {
  const worker = parse(contract.nativeLocalWorkerProfile('WF.Tester').split('---')[1]);
  assert.deepEqual(worker.tools, ['read', 'search', 'execute']);
  assert.deepEqual(worker.agents, []);
  assert.equal(worker['user-invocable'], false);
  const reviewer = parse(contract.nativeLocalWorkerProfile('WF.Reviewer').split('---')[1]);
  assert.deepEqual(reviewer.tools, ['read', 'search'], 'Independent review remains read-only');
});

test('native software input accepts professional content and excludes model-authored ownership', () => {
  const input = { requirement: 'Add a sum function with tests', plan: {
    summary: 'Use existing Node tests', requirements: ['Add two integers'], design: 'Pure exported function',
    outputs: ['sum.mjs', 'sum.test.mjs'], checks: [{ title: 'Node tests', command: ['node', '--test', 'sum.test.mjs'], level: 'unit' }],
  } };
  assert.deepEqual(nativeLocalRequestSchema.parse(input).context, []);
  for (const field of ['workflow_id', 'task_id', 'invocation_id', 'actor', 'reported_assignment', 'claim_token'])
    assert.equal(nativeLocalRequestSchema.safeParse({ ...input, [field]: 'invented' }).success, false);
  assert.equal(nativeLocalRequestJsonSchema.type, 'object');
  assert.equal(nativeLocalRequestJsonSchema.additionalProperties, false);
  assert.ok(nativeLocalRequestJsonSchema.required.includes('plan'));
  assert.equal(nativeLocalRequestJsonSchema.required.includes('context'), false,
    'The advertised tool accepts omitted defaulted context just like the backend parser');
});

test('native plans accept only explicit installed skill names for workers actually invoked by the full request', () => {
  const plan = { summary: 'Checked text', requirements: ['hello'], design: 'Text', outputs: ['product.txt'],
    checks: [{ title: 'Check', command: ['node', '--version'], level: 'acceptance' }] };
  assert.equal(contract.nativePlanSchema.safeParse({ ...plan, role_skills: { 'WF.FnD': ['writing-guide'], 'WF.Reviewer': ['review-guide'] } }).success, true);
  assert.equal(nativeLocalRequestJsonSchema.properties.plan.properties.role_skills.properties['WF.FnD'].uniqueItems, true,
    'The native tool advertises the same distinct-name constraint as the backend');
  for (const role_skills of [{ 'WF.PM': ['writing-guide'] }, { 'WF.SWSD': ['writing-guide'] },
    { 'WF.FnD': ['../skills/guide'] }, { 'WF.Tester': ['guide', 'guide'] }, { 'WF.FnD': ['guide'], actor: 'manager' }])
    assert.equal(contract.nativePlanSchema.safeParse({ ...plan, role_skills }).success, false);
});
