import { hash } from './storage.js';

/** Diagnostics for backend exceptions. Never persist raw provider text, paths or credentials. */
export function controlledFailure(error: unknown) {
  const cause = error instanceof Error ? error : new Error('Unknown runtime failure');
  const rawCode = (cause as Error & { code?: unknown }).code;
  const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ETIMEDOUT', 'ECONNREFUSED',
    'NATIVE_SIGNING_TRUST_INVALID', 'NATIVE_SIGNING_HISTORY_REQUIRES_TRUST',
    'NATIVE_SIGNING_KEY_INVALID', 'NATIVE_SIGNING_KEY_UNTRUSTED']);
  const code = typeof rawCode === 'string' && codes.has(rawCode) ? rawCode : 'UNEXPECTED_RUNTIME_FAILURE';
  const names = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'NativeSigningError', 'ControlledToolError', 'ZodError']);
  const frames = [...(cause.stack ?? '').matchAll(/(?:[\\/](?:src|dist)[\\/])([a-z0-9-]+\.(?:js|ts)):(\d+):(\d+)/gi)]
    .slice(0, 8).map(match => ({ module: match[1], line: Number(match[2]), column: Number(match[3]) }));
  const signing = code.startsWith('NATIVE_SIGNING_');
  return {
    code,
    name: names.has(cause.name) ? cause.name : 'Error',
    message_sha256: hash(cause.message), frames,
    owner: 'runtime' as const,
    kind: ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code) ? 'environment' as const : 'protocol' as const,
    message: signing ? 'Native session signing identity could not be reconciled with its saved trust data.'
      : 'The runtime could not complete its backend operation. The saved diagnostic identifies the failing boundary.',
    next_action: signing ? 'Restore the matching trusted signing data if historical receipts exist. An unused orphaned identity can be rotated by the runtime; workers must not supply or repair credentials.'
      : 'Inspect the credential-free runtime diagnostic and repair the backend or environment before resuming this same workflow.',
  };
}
