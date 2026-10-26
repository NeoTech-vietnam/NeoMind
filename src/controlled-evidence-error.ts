/** A trusted runtime scheduling/storage deadline, never model-supplied content. */
export class ControlledEvidenceScanTimeout extends Error {
  readonly code = 'EVIDENCE_SCAN_TIMEOUT';
  constructor(readonly max_ms: number) {
    super(`Runtime preservation capture exceeded its bounded scan time (${max_ms} ms). Keep the saved requirement and preservation scope unchanged; the backend must reconcile its existing environment allowance.`);
    this.name = 'ControlledEvidenceScanTimeout';
  }
}
