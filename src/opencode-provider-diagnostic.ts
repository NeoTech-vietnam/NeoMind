import type { NativeReceipt } from './routing.js';
import { vscodeProviderDiagnostic, type VSCodeProviderCode } from './vscode-provider-diagnostic.js';

export type OpenCodeProviderCode = VSCodeProviderCode | 'PROVIDER_REQUEST_REJECTED' | 'PROVIDER_ERROR';
/** Fixed, bounded metadata from a canonical SDK assistant, never model prose. */
export interface OpenCodeProviderFailure {
  schema_version: 1; code: OpenCodeProviderCode; status_code?: number; retryable?: boolean;
  session_id: string; user_message_id: string; assistant_message_id: string;
}
const codes: readonly OpenCodeProviderCode[] = ['MODEL_NOT_SUPPORTED', 'MODEL_NOT_FOUND', 'AUTHENTICATION_REQUIRED',
  'AUTHORIZATION_DENIED', 'RATE_LIMITED', 'CONTEXT_LIMIT_EXCEEDED', 'TOOL_CALLING_UNSUPPORTED', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_REQUEST_REJECTED', 'PROVIDER_ERROR'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const statusCode = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
const sessionId = (value: unknown): value is string => typeof value === 'string' && /^ses_[A-Za-z0-9]{1,128}$/.test(value);
const messageId = (value: unknown): value is string => typeof value === 'string' && /^msg_[A-Za-z0-9]{1,128}$/.test(value);

/** Caller has reconciled the canonical SDK session, parent message and route. */
export function canonicalOpenCodeProviderFailure(error: unknown, identity: {
  session_id: string; user_message_id: string; assistant_message_id: string;
}): { observation: OpenCodeProviderFailure; message: string } {
  if (!sessionId(identity.session_id) || !messageId(identity.user_message_id) || !messageId(identity.assistant_message_id) ||
      identity.user_message_id === identity.assistant_message_id) throw new Error('Canonical provider error identity did not validate.');
  let status: number | undefined, retryable: boolean | undefined;
  try {
    const data = record(error) && record(error.data) ? error.data : undefined;
    if (statusCode(data?.statusCode)) status = data.statusCode;
    if (typeof data?.isRetryable === 'boolean') retryable = data.isRetryable;
  } catch { /* Unreadable metadata is omitted, never guessed. */ }
  const diagnostic = vscodeProviderDiagnostic(error);
  const code = diagnostic?.code ?? (status !== undefined && status >= 400 && status < 500 ? 'PROVIDER_REQUEST_REJECTED' : 'PROVIDER_ERROR');
  return { observation: { schema_version: 1, code, ...(status !== undefined ? { status_code: status } : {}),
    ...(retryable !== undefined ? { retryable } : {}), session_id: identity.session_id,
    user_message_id: identity.user_message_id, assistant_message_id: identity.assistant_message_id },
    message: `${code}: ${diagnostic?.message ?? (code === 'PROVIDER_REQUEST_REJECTED'
      ? 'the provider rejected the request; retained canonical metadata requires a configuration or request-contract correction before resuming'
      : 'the provider did not complete inference; retained canonical metadata does not establish a transient outage')}` };
}

/** Call only after readInvocation authenticates the receipt and caller binds its attempt. */
export function boundOpenCodeProviderFailure(receipt: NativeReceipt): OpenCodeProviderFailure | undefined {
  const value = receipt.opencode?.provider_failure;
  if (!record(value) || receipt.issuer !== 'workforce-opencode' || receipt.execution_mode !== 'opencode-local' ||
      !['blocked', 'interrupted'].includes(receipt.state) || receipt.inference_completed !== false ||
      value.schema_version !== 1 || !codes.includes(value.code as OpenCodeProviderCode) ||
      !sessionId(value.session_id) || !messageId(value.user_message_id) || !messageId(value.assistant_message_id) ||
      value.user_message_id === value.assistant_message_id || value.session_id !== receipt.native_thread_id ||
      value.user_message_id !== receipt.native_turn_id || value.assistant_message_id !== receipt.opencode?.response_message_id ||
      value.status_code !== undefined && !statusCode(value.status_code) || value.retryable !== undefined && typeof value.retryable !== 'boolean' ||
      Object.keys(value).some(key => !['schema_version', 'code', 'status_code', 'retryable', 'session_id', 'user_message_id', 'assistant_message_id'].includes(key))) return undefined;
  return value as unknown as OpenCodeProviderFailure;
}

export function transientOpenCodeProviderFailure(failure: OpenCodeProviderFailure): boolean {
  return ['RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(failure.code) && failure.retryable !== false &&
    !(failure.status_code !== undefined && failure.status_code >= 400 && failure.status_code < 500 && failure.status_code !== 429) &&
    (failure.retryable === true || [429, 502, 503, 504].includes(failure.status_code ?? 0));
}
