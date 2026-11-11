import test from 'node:test';
import assert from 'node:assert/strict';
import { fitDraft, rerunDraft } from '../src/domain/rerun.js';
import { bindingKeys, pinBindings } from '../src/domain/pin-bindings.js';
import { templates } from '../src/domain/templates.js';

const sonnet = { runner: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium' };
const opus = { ...sonnet, model: 'claude-opus-5-5', reasoning: 'high' };
const sol = { runner: 'codex', provider: 'openai', model: 'gpt-6.1-sol', reasoning: 'high' };

function runOf(phase: string) {
  const flow = structuredClone(templates.dev);
  flow.flowId = 'custom'; flow.definition.limits = { ...flow.definition.limits, activeTimeSeconds: 900, maxTokens: 200_000 };
  return { runtimeState: { phase }, runtimeContext: { task: '  Fix the issue\nwith context  ', workspaceMode: 'current' as const },
    snapshot: { configuration: { flow, bindings: { plan: { values: opus }, implement: { values: sonnet }, 'verify/required-reviewer': { values: sol } } } },
    bindingSelections: [{ key: 'implement', values: { ...sonnet, model: 'claude-haiku-5-5' } }] };
}

test('duplicating a run copies task, flow, the runners it used, limits and workspace without changing the run', () => {
  const run = runOf('blocked'), before = structuredClone(run);
  const draft = rerunDraft(run);
  assert.deepEqual(draft, { flowId: 'custom', task: run.runtimeContext.task, workspaceMode: 'current',
    // The fallback selection recorded during the run wins over the snapshot.
    overrides: { plan: opus, implement: { ...sonnet, model: 'claude-haiku-5-5' }, 'verify/required-reviewer': sol },
    limits: { ...templates.dev.definition.limits, activeTimeSeconds: 900, maxTokens: 200_000 } });
  assert.deepEqual(run, before);
  draft!.overrides.plan!.model = 'changed';
  assert.equal(run.snapshot.configuration.bindings.plan.values.model, 'claude-opus-5-5');
  // Reading only: a run that is still running or waiting can be duplicated too.
  for (const phase of ['running', 'waiting_approval', 'completed', 'cancelled', 'paused']) assert.equal(rerunDraft(runOf(phase))?.flowId, 'custom');
  assert.equal(rerunDraft({ ...run, runtimeContext: { task: ' ' } }), null);
  assert.equal(rerunDraft({ runtimeContext: { task: 'x' } }), null);
  // Older runs without a workspace mode in their context use the flow's policy.
  assert.equal(rerunDraft({ ...run, runtimeContext: { task: 'x' } })?.workspaceMode, 'isolated');
});

test('a duplicated draft keeps only differences from the latest flow and drops steps it no longer has', () => {
  const draft = rerunDraft(runOf('completed'))!, latest = structuredClone(templates.dev);
  latest.definition.limits = { ...latest.definition.limits, maxConcurrency: 1, maxRepairRounds: 1, activeTimeSeconds: 900 };
  latest.definition.workspacePolicy = 'current';
  const resolved = { plan: opus, implement: sonnet, 'verify/required-reviewer': { ...sol, reasoning: 'medium' } };
  const fitted = fitDraft({ ...draft, overrides: { ...draft.overrides, removed: sonnet }, limits: { ...draft.limits, maxConcurrency: 4, maxRepairRounds: 3 } }, latest, resolved);
  assert.deepEqual(fitted, { overrides: { implement: { model: 'claude-haiku-5-5' }, 'verify/required-reviewer': { reasoning: 'high' } },
    // Concurrency and repair rounds cannot exceed the saved flow; equal values are no override at all.
    limits: { maxTokens: 200_000 }, dropped: ['removed'] });
  const other = fitDraft({ overrides: {}, limits: { maxRepairRounds: 0 }, workspaceMode: 'shared' }, latest, resolved);
  assert.deepEqual(other, { overrides: {}, limits: { maxRepairRounds: 0 }, workspaceMode: 'shared', dropped: [] });
});

test('pinning step choices writes the shared flow binding and refuses steps that disagree', () => {
  const flow = structuredClone(templates.dev);
  assert.deepEqual(bindingKeys(flow), [{ key: 'plan', bindingId: 'implementer' }, { key: 'implement', bindingId: 'implementer' }, { key: 'verify/required-reviewer', bindingId: 'verifier' }]);
  const { flow: pinned, pinned: summary } = pinBindings(flow, { implement: opus, 'verify/required-reviewer': { model: 'gpt-6.1-terra', reasoning: undefined } });
  assert.deepEqual(pinned.definition.bindings.implementer!.model, { mode: 'pinned', value: 'claude-opus-5-5' });
  assert.deepEqual(pinned.definition.bindings.verifier!.model, { mode: 'pinned', value: 'gpt-6.1-terra' });
  assert.deepEqual(pinned.definition.bindings.verifier!.runner, { mode: 'inherit' });
  assert.deepEqual(summary, [{ bindingId: 'implementer', steps: ['plan', 'implement'], values: opus }, { bindingId: 'verifier', steps: ['verify/required-reviewer'], values: { model: 'gpt-6.1-terra' } }]);
  assert.deepEqual(flow.definition.bindings.implementer!.model, { mode: 'inherit' });
  assert.equal(pinBindings(flow, { plan: opus, implement: opus }).pinned.length, 1);
  assert.throws(() => pinBindings(flow, { plan: opus, implement: sonnet }), /share binding implementer.*model/);
  assert.throws(() => pinBindings(flow, { nowhere: opus }), /no step nowhere/);
  assert.throws(() => pinBindings(flow, { plan: { model: ' ' } }), /Empty model/);
});
