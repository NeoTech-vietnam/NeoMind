import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject, templates } from '../src/domain/templates.js';
import { parseRules } from '../src/domain/rules.js';
import { reviewRequirements } from '../src/domain/review-requirements.js';
import { assessReviewEvidence } from '../src/core/review-evidence.js';
import { flowBlocks } from '../src/runtime/flow-authoring.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];
const rulesFile = '# Rules\n\n- [R1] Do not edit files outside the approved scope.\n- [R2] Keep proof.txt to one line.\nfree text\n- [R1] Duplicate code\n';

test('rules parse one coded line each, skip malformed and duplicate lines with warnings', () => {
  const parsed = parseRules(rulesFile);
  assert.deepEqual(parsed.rules, [{ id: 'R1', text: 'Do not edit files outside the approved scope.' }, { id: 'R2', text: 'Keep proof.txt to one line.' }]);
  assert.equal(parsed.warnings.length, 2); assert.match(parsed.warnings[0]!, /Dòng 5/); assert.match(parsed.warnings[1]!, /R1 bị trùng/);
});

test('a review that leaves out a rule does not cover its criteria, branch reviews included', async () => {
  const { rules } = parseRules(rulesFile), review = templates.dev.definition.nodes.find(node => node.type === 'review_group');
  assert.ok(review?.type === 'review_group');
  const criteria = reviewRequirements(templates.dev, review, undefined, rules).criteria;
  assert.deepEqual(criteria.slice(-2), ['Rule R1: Do not edit files outside the approved scope.', 'Rule R2: Keep proof.txt to one line.']);
  const branch = templates.parallel.definition.nodes.find(node => node.type === 'review_group' && node.targetNodeId === 'implement-a');
  if (branch?.type === 'review_group') assert.ok(reviewRequirements(templates.parallel, branch, undefined, rules).criteria.includes('Rule R2: Keep proof.txt to one line.'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'nm-rule-')); await writeFile(path.join(workspace, 'proof.txt'), 'ok\n');
  const reference = { kind: 'source' as const, path: 'proof.txt', line: 1, quote: 'ok' };
  const evidence = { findings: [], criteria: criteria.filter(item => !item.startsWith('Rule R2')).map(criterion => ({ criterion, status: 'pass' as const, references: [reference] })) };
  const assessment = await assessReviewEvidence({ workspace, criteria, evidence, findingIds: [], baselineHash: 'b', checks: [] });
  assert.equal(assessment.criteriaCovered, false); assert.equal(assessment.evidenceValidated, false);
});

async function project(rules?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } }));
  if (rules) await writeFile(path.join(repo, 'neomind/rules.md'), rules);
  git('add', '.'); git('commit', '-qm', 'baseline');
  const prompts: Record<'plan' | 'write' | 'review', string[]> = { plan: [], write: [], review: [] };
  const ruleCriteria = rules ? parseRules(rules).rules.map(rule => `Rule ${rule.id}: ${rule.text}`) : [];
  const agents = new FakeRunnerFactory('codex', { respond: async (session, request) => {
    const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties?.planId) { prompts.plan.push(request.prompt); return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] }); }
    if (schema?.properties?.evidence) {
      prompts.review.push(request.prompt);
      const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: (await readFile(path.join(session.workspace, 'proof.txt'), 'utf8')).trim() };
      return JSON.stringify({ verdict: 'pass', findingIds: [], summary: 'Proof matches', evidence: { findings: [],
        criteria: ['approved plan', 'checks', 'regressions', 'proof', ...ruleCriteria].map(criterion => ({ criterion, status: 'pass', references: [reference] })) } });
    }
    prompts.write.push(request.prompt); await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
  } }, codexModels);
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([agents]));
  const runs = async () => manager;
  return { repo, manager, prompts, tools: sessionToolHandlers(runs, createEditorApi(repo, runs)) };
}

test('pinned rules reach planner, writer and reviewer, become review criteria and are listed by preview and flow_blocks', async () => {
  const f = await project(rulesFile);
  try {
    const preview = await f.tools.preview!({ flowId: 'dev' }) as { rules: string[]; ruleWarnings: string[] };
    assert.deepEqual(preview.rules, ['[R1] Do not edit files outside the approved scope.', '[R2] Keep proof.txt to one line.']); assert.equal(preview.ruleWarnings.length, 2);
    assert.equal(((await flowBlocks(f.repo)).rules.rules).length, 2);
    const { runId } = await f.tools.start!({ flowId: 'dev', task: 'Add proof' }) as { runId: string };
    await f.manager.settle(runId);
    // Editing rules.md after creation does not change the run: it pinned the text it started with.
    await writeFile(path.join(f.repo, 'neomind/rules.md'), '- [R9] Something else\n');
    await f.manager.action(runId, 'approve', 'cli'); const run = await f.manager.settle(runId);
    assert.equal(run.runtimeState?.phase, 'completed', run.runtimeState?.reason);
    assert.deepEqual(run.runtimeContext?.rules?.rules.map(rule => rule.id), ['R1', 'R2']);
    for (const prompt of [f.prompts.plan[0]!, f.prompts.write[0]!, f.prompts.review[0]!]) {
      assert.match(prompt, /Rules của project \(bắt buộc[^\n]*\n- \[R1\] Do not edit files outside the approved scope\.\n- \[R2\] Keep proof\.txt to one line\./);
      assert.ok(prompt.indexOf('Rules của project') < prompt.indexOf('Approved project memory'));
    }
    assert.match(f.prompts.review[0]!, /Rule R2: Keep proof\.txt to one line\./);
    assert.ok(run.nodeData.every(item => item.sources.some(source => source.kind === 'rules' && source.hash === run.runtimeContext?.rules?.hash)));
  } finally { await f.manager.close(); }
});

test('a project without rules.md runs as before', async () => {
  const f = await project();
  try {
    const preview = await f.tools.preview!({ flowId: 'dev' }) as { rules: string[]; ruleWarnings?: string[] };
    assert.deepEqual(preview.rules, []); assert.equal(preview.ruleWarnings, undefined);
    const { runId } = await f.tools.start!({ flowId: 'dev', task: 'Add proof' }) as { runId: string };
    await f.manager.settle(runId); await f.manager.action(runId, 'approve', 'cli'); const run = await f.manager.settle(runId);
    assert.equal(run.runtimeState?.phase, 'completed', run.runtimeState?.reason);
    assert.equal(run.runtimeContext?.rules, undefined);
    assert.ok([...f.prompts.plan, ...f.prompts.write, ...f.prompts.review].every(prompt => !prompt.includes('Rules của project')));
  } finally { await f.manager.close(); }
});
