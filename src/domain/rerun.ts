/** Phases from which a run can be started again as a new run: it is not doing anything any more. */
export const RERUNNABLE_PHASES = ['blocked', 'cancelled', 'completed', 'paused'];

/** Inputs for a new run; the old run and its configuration are left untouched. */
export function rerunDraft(run: { runtimeState?: { phase: string }; runtimeContext?: { task: string }; snapshot?: { configuration: { flow: { flowId: string } } } }): { flowId: string; task: string } | null {
  const flowId = run.snapshot?.configuration.flow.flowId, task = run.runtimeContext?.task;
  return RERUNNABLE_PHASES.includes(run.runtimeState?.phase ?? '') && flowId && task?.trim() ? { flowId, task } : null;
}
