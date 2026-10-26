/** A transport loss cannot establish that a submitted intake had no effects. */
export class ControlledIntakeDeliveryError extends Error {
  readonly code = 'INTAKE_OUTCOME_UNCERTAIN';
  readonly owner = 'runtime';
  readonly retryable = false;
  readonly next_action = 'Call manager_status without workflow_id and match the saved request_id. Use only a returned workflow_id for subsequent status or control. Do not submit the requirement again, invent an ID or assume that the original operation failed.';
  constructor(readonly request_id: string) {
    super('The runtime could not confirm delivery of this intake receipt within its bounded read-only reconciliation. The original request identity is retained; no start operation was replayed and existing effects remain intact.');
    this.name = 'ControlledIntakeDeliveryError';
  }
}
