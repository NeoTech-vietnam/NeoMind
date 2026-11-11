import type { Flow } from './schema.js';

// Same shape as resolve.ts, which the editor UI cannot import (it hashes with node:crypto).
type BindingValues = Record<'runner' | 'provider' | 'model' | 'reasoning', string>;

type WorkspaceMode = Flow['definition']['workspacePolicy'];
export type DraftLimits = Partial<Flow['definition']['limits']>;
/** Inputs for the new-run form copied from an earlier run; nothing here starts or approves a run. */
export type RunDraft = { flowId: string; task: string; overrides: Record<string, Partial<BindingValues>>; limits: DraftLimits; workspaceMode?: WorkspaceMode };

type RunLike = {
  runtimeContext?: { task: string; workspaceMode?: WorkspaceMode | undefined } | undefined;
  snapshot?: { configuration: { flow: { flowId: string; definition?: { limits?: DraftLimits; workspacePolicy?: WorkspaceMode } }; bindings?: Record<string, { values: BindingValues }> } } | undefined;
  bindingSelections?: { key: string; values: BindingValues }[] | undefined;
};

/**
 * Duplicate a run's configuration: flow, task, the runner/model each step really used (the latest recorded fallback
 * selection wins over the snapshot), its limits and workspace mode. It only reads, so a run in any phase can be copied.
 */
export function rerunDraft(run: RunLike): RunDraft | null {
  const configuration = run.snapshot?.configuration, flowId = configuration?.flow.flowId, task = run.runtimeContext?.task;
  if (!configuration || !flowId || !task?.trim()) return null;
  const overrides: RunDraft['overrides'] = Object.fromEntries(Object.entries(configuration.bindings ?? {}).map(([key, binding]) => [key, { ...binding.values }]));
  for (const selection of run.bindingSelections ?? []) if (overrides[selection.key]) overrides[selection.key] = { ...selection.values };
  const limits = { ...configuration.flow.definition?.limits ?? {} };
  const workspaceMode = run.runtimeContext?.workspaceMode ?? configuration.flow.definition?.workspacePolicy;
  return { flowId, task, overrides, limits, ...(workspaceMode ? { workspaceMode } : {}) };
}

/**
 * Fit a duplicated draft to the latest version of its flow: only values that differ from what that version resolves to
 * stay as run overrides, steps it no longer has are dropped (and named), and limits are capped where a run may not
 * exceed the saved flow. A model that is no longer offered is kept; the preview reports it like any other choice.
 */
export function fitDraft(draft: Pick<RunDraft, 'overrides' | 'limits' | 'workspaceMode'>, flow: Pick<Flow, 'definition'>, resolved: Record<string, BindingValues>) {
  const overrides: RunDraft['overrides'] = {}, dropped: string[] = [];
  for (const [key, values] of Object.entries(draft.overrides)) {
    const base = resolved[key];
    if (!base) { dropped.push(key); continue; }
    const changed = Object.fromEntries(Object.entries(values).filter(([field, value]) => value !== undefined && value !== base[field as keyof BindingValues]));
    if (Object.keys(changed).length) overrides[key] = changed;
  }
  const saved = flow.definition.limits, limits: DraftLimits = {};
  const capped: DraftLimits = { ...draft.limits,
    ...draft.limits.maxConcurrency !== undefined ? { maxConcurrency: Math.min(draft.limits.maxConcurrency, saved.maxConcurrency) } : {},
    ...draft.limits.maxRepairRounds !== undefined ? { maxRepairRounds: Math.min(draft.limits.maxRepairRounds, saved.maxRepairRounds) } : {} };
  for (const field of ['activeTimeSeconds', 'maxConcurrency', 'maxRepairRounds', 'maxTokens'] as const) {
    const value = capped[field];
    if (value !== undefined && value !== saved[field]) limits[field] = value;
  }
  const workspaceMode = draft.workspaceMode && draft.workspaceMode !== flow.definition.workspacePolicy ? draft.workspaceMode : undefined;
  return { overrides, limits, ...(workspaceMode ? { workspaceMode } : {}), dropped };
}
