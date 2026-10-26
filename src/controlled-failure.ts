import { hash } from './storage.js';
import { ControlledEvidenceScanTimeout } from './controlled-evidence-error.js';
import { ControlledPayloadError } from './controlled-payload.js';

/** Diagnostics for backend exceptions. Never persist raw provider text, paths or credentials. */
export function controlledFailure(error: unknown) {
  const cause = error instanceof Error ? error : new Error('Unknown runtime failure');
  const rawCode = (cause as Error & { code?: unknown }).code;
  const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ETIMEDOUT', 'ECONNREFUSED',
    'STATE_UNCERTAIN', 'INPUT_CHANGED', 'ACTOR_INACTIVE', 'ACCEPTANCE_INCOMPLETE',
    'NATIVE_SIGNING_TRUST_INVALID', 'NATIVE_SIGNING_HISTORY_REQUIRES_TRUST',
    'NATIVE_SIGNING_KEY_INVALID', 'NATIVE_SIGNING_KEY_UNTRUSTED']);
  const code = cause instanceof ControlledEvidenceScanTimeout ? cause.code
    : cause instanceof ControlledPayloadError && cause.code === 'STALE_READ' ? 'INPUT_CHANGED'
    : typeof rawCode === 'string' && codes.has(rawCode) ? rawCode : 'UNEXPECTED_RUNTIME_FAILURE';
  const names = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'NativeSigningError', 'ControlledToolError', 'ControlledPayloadError', 'ControlledEvidenceScanTimeout', 'ZodError']);
  const frames = [...(cause.stack ?? '').matchAll(/(?:[\\/](?:src|dist)[\\/])([a-z0-9-]+\.(?:js|ts)):(\d+):(\d+)/gi)]
    .slice(0, 8).map(match => ({ module: match[1], line: Number(match[2]), column: Number(match[3]) }));
  const signing = code.startsWith('NATIVE_SIGNING_');
  const reconciliation: Record<string, { message: string; next_action: string }> = {
    EVIDENCE_SCAN_TIMEOUT: { message: 'The runtime could not capture the complete saved preservation scope within its existing scan deadline. The validated plan and original scope are retained.',
      next_action: 'Reconcile storage or runtime load before resuming this same workflow. Do not resubmit the plan, narrow the user preservation scope or increase limits. The existing environment allowance is not reset.' },
    STATE_UNCERTAIN: { message: 'A durable operation or its current artifact provenance needs reconciliation. Existing work is preserved.',
      next_action: 'Reconcile the exact saved operation and current artifacts before another mutation; do not guess identities, replace external edits or replay uncertain side effects.' },
    INPUT_CHANGED: { message: 'A required input or artifact changed from its saved baseline. Existing edits are preserved.',
      next_action: 'Inspect the current inputs and obtain fresh owned evidence before continuing this same workflow.' },
    ACTOR_INACTIVE: { message: 'The backend operation no longer belongs to an active owned session.',
      next_action: 'Reconcile the current Bridge owner and durable checkpoint before resuming; workers must not repair credentials.' },
    ACCEPTANCE_INCOMPLETE: { message: 'Final acceptance did not validate the current artifacts and evidence. The workflow was not closed.',
      next_action: 'Inspect the saved acceptance findings and current artifact provenance; obtain fresh required verification and review.' },
  };
  return {
    code,
    name: names.has(cause.name) ? cause.name : 'Error',
    message_sha256: hash(cause.message), frames,
    owner: 'runtime' as const,
    kind: ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ETIMEDOUT', 'ECONNREFUSED', 'EVIDENCE_SCAN_TIMEOUT'].includes(code) ? 'environment' as const : 'protocol' as const,
    message: reconciliation[code]?.message ?? (signing ? 'Native session signing identity could not be reconciled with its saved trust data.'
      : 'The runtime could not complete its backend operation. The saved diagnostic identifies the failing boundary.'),
    next_action: reconciliation[code]?.next_action ?? (signing ? 'Restore the matching trusted signing data if historical receipts exist. An unused orphaned identity can be rotated by the runtime; workers must not supply or repair credentials.'
      : 'Inspect the credential-free runtime diagnostic and repair the backend or environment before resuming this same workflow.'),
  };
}
