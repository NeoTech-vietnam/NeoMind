import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { compileFlow, type Diagnostic } from '../src/domain/compiler.js';
import { flowHashes } from '../src/domain/resolve.js';
import { diffFlows } from '../src/domain/flow-diff.js';
import type { Flow } from '../src/domain/schema.js';
import { defaultProject, newFlowFromTemplate, templates } from '../src/domain/templates.js';
import { checkFlow, draftFlow, publishFlow, validateFlow } from '../src/runtime/flow-authoring.js';
import { draftProfile, getProfile, publishProfile } from '../src/runtime/profile-authoring.js';
import { defaultRoles, newProjectPolicy, snapshotProjectFlow } from '../src/runtime/project.js';
import { FlowLibrary } from '../src/storage/flow-library.js';

async function project(roleDefaults: Record<string, unknown> = defaultRoles) {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-fv-'));
  await mkdir(path.join(root, 'neomind'));
  await writeFile(path.join(root, 'neomind', 'project.json'), JSON.stringify({ ...defaultProject, policy: newProjectPolicy, roleDefaults }));
  return root;
}
const codes = (items: Diagnostic[], severity: 'error' | 'warning' = 'error') => items.filter(item => (item.severity ?? 'error') === severity).map(item => item.code);
const pinned = (value: string) => ({ mode: 'pinned' as const, value });
function dev(): Flow { return { ...structuredClone(templates.dev), flowId: 'mine' }; }
function agent(flow: Flow, id: string) { const node = flow.definition.nodes.find(item => item.id === id); assert.ok(node?.type === 'agent_task'); return node; }
function review(flow: Flow, id: string) { const node = flow.definition.nodes.find(item => item.id === id); assert.ok(node?.type === 'review_group'); return node; }

test('built-in flows validate without errors or warnings, by the compiler and by the runtime check', async () => {
  const root = await project();
  for (const [id, flow] of Object.entries(templates)) {
    // Parallel exceeds the AI time ceiling (an older rule), so built-ins are checked as a person authors them.
    const compiled = compileFlow(flow, newProjectPolicy, { authoring: true });
    assert.ok(compiled.ok, id); assert.equal(compiled.warnings, undefined, id);
    assert.deepEqual(await checkFlow(root, flow), { valid: true, diagnostics: [], order: compiled.order }, id);
    assert.deepEqual((await checkFlow(root, newFlowFromTemplate(id as keyof typeof templates))).diagnostics, [], id);
  }
});

test('web access is explicit, visible in the diff, and restricted to OpenCode including fallbacks', async () => {
  const root = await project(), original = dev(), flow = structuredClone(original);
  flow.definition.webAccess = true;
  assert.deepEqual(diffFlows(original, flow).webAccess, { before: false, after: true });
  assert.notEqual(flowHashes(original).semanticHash, flowHashes(flow).semanticHash);
  assert.ok(codes((await checkFlow(root, flow)).diagnostics).includes('web_access_unsupported'));
  for (const binding of Object.values(flow.definition.bindings)) {
    binding.runner = pinned('opencode'); binding.provider = pinned('opencode'); binding.model = pinned('free-model'); binding.reasoning = pinned('high');
  }
  assert.equal(codes((await checkFlow(root, flow)).diagnostics).includes('web_access_unsupported'), false);
  flow.definition.bindings.implementer!.fallback = [{ runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'high' }];
  assert.ok(codes((await checkFlow(root, flow)).diagnostics).includes('web_access_unsupported'));
});

/** Research whose reviewed step returns a plan: a plan is recorded without a baseline, so its review blocks the run. */
function reviewedPlan(flowId = 'mine'): Flow { const flow = { ...structuredClone(templates.research), flowId }; agent(flow, 'research').outputContract = 'plan'; return flow; }

test('a review of a plan step is refused while authoring, and a published one still compiles for its runs', () => {
  const flow = reviewedPlan();
  const authored = compileFlow(flow, newProjectPolicy, { authoring: true });
  assert.ok(!authored.ok); assert.deepEqual(authored.diagnostics.map(item => [item.code, item.nodeId, item.severity]), [['review_target_plan', 'review', undefined]]);
  assert.ok(compileFlow(flow, newProjectPolicy).ok);
  // A read-only report step records a baseline and can be reviewed (Research).
  assert.ok(compileFlow(templates.research, newProjectPolicy, { authoring: true }).ok);
});

test('an automatic approval needs a plan step directly before it', () => {
  const noPlan = structuredClone(templates.fast);
  noPlan.definition.nodes = noPlan.definition.nodes.filter(node => node.id !== 'plan');
  noPlan.definition.edges = [{ from: 'start', to: 'approval', outcome: 'completed' }, ...noPlan.definition.edges.filter(edge => edge.from !== 'start' && edge.from !== 'plan')];
  const authored = compileFlow(noPlan, newProjectPolicy, { authoring: true });
  assert.ok(!authored.ok); assert.deepEqual(codes(authored.diagnostics), ['auto_approval_without_plan']);
  assert.equal(authored.diagnostics[0]?.nodeId, 'approval');
  assert.ok(compileFlow(noPlan, newProjectPolicy).ok);
  // Plan reports joined before the approval (the failing lc-review shape) are not a plan either.
  const joined = structuredClone(templates.fast), plan = agent(joined, 'plan'); plan.outputContract = 'research-report';
  assert.deepEqual(codes((compileFlow(joined, newProjectPolicy, { authoring: true }) as { diagnostics: Diagnostic[] }).diagnostics), ['auto_approval_without_plan']);
});

test('text warnings: BOM instructions and file requests in a flow that cannot write; neither blocks', () => {
  const bom = dev(); agent(bom, 'implement').goal = 'Implement the plan. Write files as UTF-8 without BOM.';
  const compiled = compileFlow(bom, newProjectPolicy, { authoring: true });
  assert.ok(compiled.ok); assert.deepEqual(compiled.warnings?.map(item => [item.code, item.nodeId, item.severity]), [['bom_instruction', 'implement', 'warning']]);
  const readOnly = structuredClone(templates.research); agent(readOnly, 'research').goal = 'Research the bug and save the findings to report.md';
  const report = compileFlow(readOnly, newProjectPolicy, { authoring: true });
  assert.ok(report.ok); assert.deepEqual(report.warnings?.map(item => [item.code, item.nodeId]), [['read_only_output_file', 'research']]);
  readOnly.description = 'Ghi kết quả ra file báo cáo'; agent(readOnly, 'research').goal = 'Research and cite sources';
  assert.deepEqual((compileFlow(readOnly, newProjectPolicy, { authoring: true }) as { warnings?: Diagnostic[] }).warnings?.map(item => item.code), ['read_only_output_file']);
  // A flow that writes may name its output file.
  const writes = dev(); agent(writes, 'implement').goal = 'Write the summary to notes.md';
  assert.equal((compileFlow(writes, newProjectPolicy, { authoring: true }) as { warnings?: Diagnostic[] }).warnings, undefined);
  // Without authoring (a run start) there are no warnings.
  assert.equal((compileFlow(bom, newProjectPolicy) as { warnings?: Diagnostic[] }).warnings, undefined);
});

// Goals of the lc-new-problem flow whose runs stopped after a clean validation: v1 copied the placeholder check, v1 and
// v2 planned scope "." for a writer limited to `c`; v4 runs.
const lcPlanV1 = 'Plan only (no edits): resolve the task to ONE LeetCode problem per skill lc-new-problem section 1 (topic only -> first README starter for that topic not yet in c/ or cpp/). State id, title, slug, topic and the target directory c/<topic>/<id4>_<slug>/, and confirm it does not exist. Scope: only that new directory. Checks: list ONLY `gcc -std=c11 -fsyntax-only -I tools c/<topic>/<id4>_<slug>/test.c` and `git diff --check`. Never list tools/build_test.py: the empty stub reports TODO by design.';
const lcPlanV2 = "Plan only (no edits). First DO the resolution now: read README section 3 and list the directories under c/ and cpp/, then pick ONE concrete LeetCode problem per skill lc-new-problem section 1 (topic only -> first README starter for that topic not yet in the repo). The plan must name the concrete id, title, slug, topic and directory (e.g. c/two-pointers/0125_valid-palindrome/) and confirm it does not exist. Scope: only that directory. Checks: list ONLY these two literal commands with the concrete directory filled in, no placeholders and no angle-bracket characters anywhere: the gcc syntax check of that directory's test.c, e.g. `gcc -std=c11 -fsyntax-only -I tools c/two-pointers/0125_valid-palindrome/test.c`, and `git diff --check`. Never list tools/build_test.py: the empty stub reports TODO by design.";
const lcPlanV4 = lcPlanV2.replace('Scope: only that directory.', "Scope: exactly one entry, the literal string `c` (plan scope must be a directory that already exists; the new problem directory does not exist yet), never '.' and never the new directory itself.");
/** lc-new-problem: plan → automatic approval → a scaffolder that may write only `c`. */
function lcNewProblem(goal: string): Flow {
  const flow = { ...structuredClone(templates.fast), flowId: 'lc-new-problem' };
  agent(flow, 'plan').goal = goal;
  flow.definition.nodes = flow.definition.nodes.map(node => node.type === 'approval' ? { ...node, purpose: 'Approved automatically: the scaffolder may create only the new c/<topic>/<id4>_<slug>/ directory' } : node);
  Object.assign(agent(flow, 'implement'), { writeScopes: ['c'], goal: 'Create the planned problem directory with `python tools/new_problem.py <topic> <id> <slug> --fetch`, then run the two planned checks.' });
  return flow;
}
const warned = (flow: Flow) => { const compiled = compileFlow(flow, newProjectPolicy, { authoring: true }); assert.ok(compiled.ok); return (compiled.warnings ?? []).map(item => [item.code, item.nodeId]); };

test('plan warnings: placeholder checks and a plan scope outside the writer scopes, from the failed lc-new-problem runs', async () => {
  assert.deepEqual(warned(lcNewProblem(lcPlanV1)), [['plan_check_placeholder', 'plan'], ['plan_scope_outside_write_scope', 'plan']]);
  const v1 = compileFlow(lcNewProblem(lcPlanV1), newProjectPolicy, { authoring: true }) as { warnings: Diagnostic[] };
  assert.match(v1.warnings[0]!.message, /"c\/<topic>\/<id4>_<slug>\/".*argv without a shell/);
  assert.match(v1.warnings[1]!.message, /writer implement's writeScopes \(c\).*"Writer implement lacks a valid declared scope".*Scope: exactly `c`/);
  assert.deepEqual(warned(lcNewProblem(lcPlanV2)), [['plan_scope_outside_write_scope', 'plan']]);
  // The goal that ran: concrete example paths, scope pinned to the existing `c`. Steps other than the plan may keep placeholders.
  assert.deepEqual(warned(lcNewProblem(lcPlanV4)), []);
  // Warnings never block: the draft publishes, and a run start compiles without them.
  const root = await project(), created = await draftFlow(root, { flowId: 'lc-new-problem', draft: { ...lcNewProblem(lcPlanV1), name: 'LC new problem' } });
  assert.deepEqual(created.diagnostics.map(item => [item.code, item.severity]), [['plan_check_placeholder', 'warning'], ['plan_scope_outside_write_scope', 'warning']]);
  assert.equal((await validateFlow(root, 'lc-new-problem')).valid, true);
  assert.equal((await publishFlow(root, 'lc-new-problem', { author: { kind: 'human' }, expectedRevision: created.revision })).version, 1);
  assert.equal((compileFlow(lcNewProblem(lcPlanV1), newProjectPolicy) as { warnings?: Diagnostic[] }).warnings, undefined);
});

test('plan check placeholder heuristic: paths and commands only, not tags, types or prose', () => {
  const plan = (goal: string, instructionsOverride?: string) => { const flow = structuredClone(templates.fast); Object.assign(agent(flow, 'plan'), { goal, ...(instructionsOverride ? { instructionsOverride } : {}) }); return warned(flow).map(([code]) => code); };
  for (const goal of ['Checks: `npm test && npm run lint`.', 'Checks: `npm test | tee log.txt`.', 'Checks: npm test && npm run lint.', 'Kiểm tra: `pytest "tests/a b.py"`.',
    'Name the file src/<module>.ts and test it.', 'Run `python tools/new_problem.py <topic> <id>` first.', 'Write tests/<name>_test.py.'])
    assert.deepEqual(plan(goal), ['plan_check_placeholder'], goal);
  assert.deepEqual(plan('Propose a plan.', 'Checks: list `make test-<target>`.'), ['plan_check_placeholder']);
  for (const goal of ['Propose a plan. Use <details> and <br> in the summary.', 'Pick a problem <id> from the list, then plan it.', 'Change the return type to `Array<string>`.',
    "Checks: list the directory's own test, e.g. `npm test -- test/parser.test.js`, and `git diff --check`; nothing else.", 'Keep the plan short -> work starts right after.'])
    assert.deepEqual(plan(goal), [], goal);
});

test('plan scope heuristic: a writer narrower than "." needs a scope inside its writeScopes named where the plan talks about scope', () => {
  const plan = (goal: string, writeScopes = ['src']) => { const flow = structuredClone(templates.fast); agent(flow, 'plan').goal = goal; agent(flow, 'implement').writeScopes = writeScopes; return warned(flow).map(([code]) => code); };
  for (const goal of ['Propose a plan.', 'Scope: only the files you change.', "Scope: `.` (the repo root).", 'Scope: the new module directory. Keep changes inside src/.', 'Phạm vi: thư mục mới.'])
    assert.deepEqual(plan(goal), ['plan_scope_outside_write_scope'], goal);
  for (const goal of ['Scope: exactly `src`.', 'Scope: src/api, which already exists.', 'Keep every change inside src/.', 'Phạm vi: `src`.'])
    assert.deepEqual(plan(goal), [], goal);
  assert.deepEqual(plan('Scope: `srcx`.'), ['plan_scope_outside_write_scope']);
  assert.deepEqual(plan('Scope: `docs`.', ['src', 'docs']), []);
  assert.deepEqual(plan('Propose a plan.', ['.']), []);
});

test('a plan profile whose instructions list a placeholder check warns at the plan step unless the step overrides them', async () => {
  const root = await project({ ...defaultRoles, scaffolder: defaultRoles.implementer! });
  const base = (await getProfile(root, 'implementer')).draft as object;
  await draftProfile(root, { profileId: 'scaffolder', name: 'Scaffolder', draft: { ...base, instructions: 'Plan step: name the directory and list exactly `gcc -fsyntax-only c/<topic>/<id4>_<slug>/test.c` as a check.' } });
  await publishProfile(root, 'scaffolder', { author: { kind: 'human' } });
  const flow = dev(); agent(flow, 'plan').profileId = 'scaffolder';
  const result = await checkFlow(root, flow);
  assert.equal(result.valid, true); assert.deepEqual(result.diagnostics.map(item => [item.code, item.nodeId, item.severity]), [['plan_check_placeholder', 'plan', 'warning']]);
  assert.match(result.diagnostics[0]!.message, /Profile "scaffolder" gives plan step plan the placeholder/);
  // A writer using the same profile is not a plan; an override replaces the profile text.
  agent(flow, 'plan').profileId = 'implementer'; agent(flow, 'implement').profileId = 'scaffolder';
  assert.deepEqual((await checkFlow(root, flow)).diagnostics, []);
  agent(flow, 'plan').profileId = 'scaffolder'; agent(flow, 'plan').instructionsOverride = 'Plan with concrete paths.';
  assert.deepEqual((await checkFlow(root, flow)).diagnostics, []);
});

test('a custom profile with inherited bindings reports each step that cannot resolve, and pinning fixes it', async () => {
  const root = await project({}), created = await draftProfile(root, { profileId: 'coach', from: { profileId: 'implementer' } });
  await publishProfile(root, 'coach', { author: { kind: 'human' }, expectedRevision: created.revision });
  const flow = dev(); agent(flow, 'implement').profileId = 'coach';
  const result = await checkFlow(root, flow);
  assert.equal(result.valid, false);
  const unresolved = result.diagnostics.filter(item => item.code === 'binding_unresolved');
  assert.deepEqual(unresolved.map(item => item.nodeId), ['plan', 'implement', 'verify']);
  assert.match(unresolved[1]!.message, /Step implement has no runner, provider, model, reasoning: binding "implementer" inherits, and profile "coach"/);
  assert.match(unresolved[1]!.message, /"runner": \{"mode": "pinned", "value": "codex"\}/);
  for (const binding of Object.values(flow.definition.bindings)) Object.assign(binding, { runner: pinned('codex'), provider: pinned('openai'), model: pinned('gpt-6-luna'), reasoning: pinned('medium') });
  assert.deepEqual(await checkFlow(root, flow), { valid: true, diagnostics: [], order: (compileFlow(flow, newProjectPolicy) as { order: string[] }).order });
  // A flow-level binding default resolves too.
  const defaults = dev(); defaults.definition.bindingDefaults = { implementer: { runner: pinned('claude-code'), provider: pinned('anthropic'), model: pinned('claude-sonnet-5-5'), reasoning: pinned('high'), fallback: [] },
    verifier: { runner: pinned('codex'), provider: pinned('openai'), model: pinned('gpt-6.1-sol'), reasoning: pinned('high'), fallback: [] } };
  assert.deepEqual((await checkFlow(root, defaults)).diagnostics, []);
});

test('runner, provider, model and reasoning are checked against the registry and runner allowlists', async () => {
  const root = await project(), flow = dev();
  flow.definition.bindings.implementer = { ...flow.definition.bindings.implementer!, runner: pinned('claude'), provider: pinned('anthropic') };
  flow.definition.bindings.verifier = { ...flow.definition.bindings.verifier!, runner: pinned('claude-code'), provider: pinned('openai'), model: pinned('claude-sonet-5-5'), reasoning: pinned('xhigh'),
    fallback: [{ runner: 'codex', provider: 'anthropic', model: 'gpt-6-luna', reasoning: 'low' }, { runner: 'opencode', provider: 'local', model: 'any', reasoning: 'low' }] };
  const result = await checkFlow(root, flow);
  assert.equal(result.valid, false);
  const runner = result.diagnostics.find(item => item.code === 'unknown_runner' && item.nodeId === 'implement');
  assert.match(runner!.message, /runner "claude".*Did you mean "claude-code"\?/);
  assert.deepEqual(codes(result.diagnostics.filter(item => item.nodeId === 'verify')), ['provider_mismatch', 'model_not_allowed', 'reasoning_not_supported']);
  assert.match(result.diagnostics.find(item => item.code === 'model_not_allowed')!.message, /Did you mean "claude-sonnet-5-5"\?/);
  // A fallback that does not fit is never selected: a warning, not an error. OpenCode providers are host-specific.
  assert.deepEqual(codes(result.diagnostics, 'warning'), ['provider_mismatch']);
  assert.match(result.diagnostics.find(item => item.severity === 'warning')!.message, /Reviewer required-reviewer \(fallback\)/);
});

test('profiles must exist at the referenced version and fit the step permissions', async () => {
  const root = await project({ ...defaultRoles, auditor: defaultRoles.implementer! });
  const created = await draftProfile(root, { profileId: 'auditor', from: { profileId: 'verifier' } });
  await publishProfile(root, 'auditor', { author: { kind: 'human' }, expectedRevision: created.revision });
  const flow = dev(); agent(flow, 'plan').profileVersion = 3; agent(flow, 'implement').profileId = 'ghost';
  review(flow, 'verify').reviewers[0]!.profileId = 'auditor'; review(flow, 'verify').reviewers[0]!.profileVersion = 2;
  const result = await checkFlow(root, flow);
  assert.deepEqual(result.diagnostics.map(item => [item.code, item.nodeId]), [['missing_profile_version', 'plan'], ['binding_unresolved', 'implement'], ['missing_profile_version', 'implement'], ['missing_profile_version', 'verify']]);
  assert.match(result.diagnostics[3]!.message, /version 2, which is not published \(published: 1\)/);
  // A writer cannot use a read-only profile; a reviewer cannot use a writer profile.
  const swapped = dev(); agent(swapped, 'implement').profileId = 'auditor'; review(swapped, 'verify').reviewers[0]!.profileId = 'implementer';
  assert.deepEqual(codes((await checkFlow(root, swapped)).diagnostics), ['profile_permission', 'reviewer_overprivileged']);
  // Preview-only refusals of the executor are reported with their step.
  const unread = dev(); agent(unread, 'plan').permissions.read = false;
  const runtime = (await checkFlow(root, unread)).diagnostics.find(item => item.code === 'runtime_unsupported');
  assert.equal(runtime?.nodeId, 'plan');
});

test('pinned skills: a changed skill warns, a missing one is an error', async () => {
  const root = await project(), file = path.join(root, 'neomind', 'skills', 'style', 'SKILL.md');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '---\nname: Style\n---\nKeep it short.\n');
  const sha256 = createHash('sha256').update('---\nname: Style\n---\nKeep it short.\n').digest('hex');
  const flow = dev(); agent(flow, 'implement').skillsOverride = [{ id: 'style', path: 'neomind/skills/style/SKILL.md', sha256 }];
  assert.deepEqual((await checkFlow(root, flow)).diagnostics, []);
  await writeFile(file, 'changed');
  const changed = await checkFlow(root, flow);
  assert.equal(changed.valid, true); assert.deepEqual(changed.diagnostics.map(item => [item.code, item.nodeId, item.severity]), [['skill_changed', 'implement', 'warning']]);
  agent(flow, 'implement').skillsOverride = [{ id: 'gone', path: 'neomind/skills/gone/SKILL.md', sha256 }];
  assert.deepEqual(codes((await checkFlow(root, flow)).diagnostics), ['skill_missing']);
});

test('steps and reviewers asked to run commands on a runner without a shell get a warning', async () => {
  const root = await project(), flow = dev();
  review(flow, 'verify').criteria = ['approved plan', 'Re-run the tests yourself and confirm they pass'];
  // Codex reviewers with checks permission can run commands.
  assert.deepEqual((await checkFlow(root, flow)).diagnostics, []);
  flow.definition.bindings.verifier = { ...flow.definition.bindings.verifier!, runner: pinned('claude-code'), provider: pinned('anthropic'), model: pinned('claude-opus-5-5'), reasoning: pinned('high') };
  const reviewer = await checkFlow(root, flow);
  assert.equal(reviewer.valid, true); assert.deepEqual(reviewer.diagnostics.map(item => [item.code, item.nodeId]), [['review_needs_commands', 'verify']]);
  assert.match(reviewer.diagnostics[0]!.message, /runs on claude-code, which has no shell/);
  const research = structuredClone(templates.research); agent(research, 'research').goal = 'Run the test suite and report which cases fail';
  research.definition.bindings.implementer = { ...research.definition.bindings.implementer!, runner: pinned('claude-code'), provider: pinned('anthropic'), model: pinned('claude-sonnet-5-5'), reasoning: pinned('medium') };
  assert.deepEqual(codes((await checkFlow(root, research)).diagnostics, 'warning'), ['step_cannot_run_commands']);
  agent(research, 'research').goal = 'Chạy lại test và báo cáo'; agent(research, 'research').permissions.checks = false;
  research.definition.bindings.implementer = templates.research.definition.bindings.implementer!;
  assert.match((await checkFlow(root, research)).diagnostics[0]!.message, /has no checks permission/);
});

test('validate reports errors before warnings; publish blocks on errors only; an older published version still starts', async () => {
  const root = await project(), created = await draftFlow(root, { flowId: 'mine', draft: { ...structuredClone(templates.research), flowId: 'mine' } });
  assert.deepEqual(created.diagnostics, []);
  const broken = reviewedPlan(); agent(broken, 'research').goal = 'Survey the code. Keep UTF-8 without BOM.';
  const saved = await draftFlow(root, { flowId: 'mine', draft: broken, expectedRevision: created.revision });
  assert.deepEqual(saved.diagnostics.map(item => item.code), ['review_target_plan', 'bom_instruction']);
  const validation = await validateFlow(root, 'mine');
  assert.equal(validation.valid, false); assert.deepEqual(validation.diagnostics.map(item => item.severity ?? 'error'), ['error', 'warning']);
  await assert.rejects(publishFlow(root, 'mine', { author: { kind: 'human' } }), /Invalid draft: review_target_plan$/);
  await assert.rejects(publishFlow(root, 'mine', { author: { kind: 'ai' }, expectedRevision: saved.revision }), /Invalid draft: review_target_plan$/);
  agent(broken, 'research').outputContract = 'research-report';
  const fixed = await draftFlow(root, { flowId: 'mine', draft: broken, expectedRevision: saved.revision });
  const warned = await validateFlow(root, 'mine');
  assert.equal(warned.valid, true); assert.deepEqual(warned.diagnostics.map(item => item.code), ['bom_instruction']);
  assert.equal((await publishFlow(root, 'mine', { author: { kind: 'ai' }, expectedRevision: fixed.revision })).version, 1);
  // A runtime refusal blocks publishing too.
  const unresolved = dev(); agent(unresolved, 'implement').profileId = 'ghost';
  const third = await draftFlow(root, { flowId: 'mine', draft: unresolved, expectedRevision: fixed.revision });
  await assert.rejects(publishFlow(root, 'mine', { author: { kind: 'human' }, expectedRevision: third.revision }), /Invalid draft: binding_unresolved, missing_profile_version/);

  // A version published before the authoring rules existed keeps starting runs.
  const library = new FlowLibrary(path.join(root, 'neomind', 'flows')), legacy: Flow = { ...reviewedPlan('legacy'), name: 'Legacy' };
  await library.create('legacy', 'Legacy'); await mkdir(path.join(root, 'neomind', 'flows', 'legacy', 'versions'), { recursive: true });
  await writeFile(path.join(root, 'neomind', 'flows', 'legacy', 'versions', '000001.json'), JSON.stringify({ ...legacy, ...flowHashes(legacy), createdAt: new Date().toISOString() }));
  assert.equal((await snapshotProjectFlow(root, 'legacy', 1)).configuration.flow.flowId, 'legacy');
  assert.equal((await validateFlow(root, 'legacy', legacy)).valid, false);
});

test('the editor validate endpoint returns warnings with a valid result and keeps AI limits off human validation', async () => {
  const root = await project(), { createEditorApi } = await import('../src/ui-server/server.js');
  const api = createEditorApi(root, async () => { throw new Error('No run should start'); });
  const flow = dev(); agent(flow, 'implement').goal = 'Implement; write UTF-8 without BOM'; flow.definition.limits.activeTimeSeconds = 7200;
  const body = (await api({ method: 'POST', path: '/api/flows/mine/validate', body: { draft: flow } })).body as { valid: boolean; diagnostics: Diagnostic[] };
  assert.equal(body.valid, true); assert.deepEqual(body.diagnostics.map(item => [item.code, item.severity]), [['bom_instruction', 'warning']]);
  assert.ok(codes((await checkFlow(root, flow, { aiAuthored: true })).diagnostics).includes('ai_limit_exceeded'));
});
