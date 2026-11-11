/** Inputs for a new run; the old run and its configuration are left untouched. */
export function rerunDraft(run: { runtimeState?: { phase: string }; runtimeContext?: { task: string }; snapshot?: { configuration: { flow: { flowId: string } } } }): { flowId: string; task: string } | null {
  const flowId = run.snapshot?.configuration.flow.flowId, task = run.runtimeContext?.task;
  return run.runtimeState?.phase === 'blocked' && flowId && task?.trim() ? { flowId, task } : null;
}
