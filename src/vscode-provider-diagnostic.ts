/** Only these fixed diagnostics may cross the provider/host persistence boundary. */
export type VSCodeProviderCode = 'MODEL_NOT_SUPPORTED' | 'MODEL_NOT_FOUND' |
  'AUTHENTICATION_REQUIRED' | 'AUTHORIZATION_DENIED' | 'RATE_LIMITED' |
  'CONTEXT_LIMIT_EXCEEDED' | 'TOOL_CALLING_UNSUPPORTED' | 'PROVIDER_UNAVAILABLE';

const diagnostics: Record<VSCodeProviderCode, string> = {
  MODEL_NOT_SUPPORTED: 'the provider rejected the configured model; verify this role\'s selected 9router alias and its upstream model target before resuming. No substitute model was selected',
  MODEL_NOT_FOUND: 'the provider could not resolve the configured model; verify this role\'s selected 9router alias and its upstream model target before resuming. No substitute model was selected',
  AUTHENTICATION_REQUIRED: 'the provider rejected authentication; review the existing custom endpoint connection and credentials before resuming',
  AUTHORIZATION_DENIED: 'the provider denied access; review the selected model\'s access and custom endpoint policy before resuming',
  RATE_LIMITED: 'the provider rate limit was reached; wait for the limit to recover before retrying',
  CONTEXT_LIMIT_EXCEEDED: 'the provider rejected the request context size; reduce the bounded task context or configure a model with sufficient context before resuming',
  TOOL_CALLING_UNSUPPORTED: 'the configured provider model does not support the required tool calling; configure a compatible model before resuming. No substitute model was selected',
  PROVIDER_UNAVAILABLE: 'the provider is temporarily unavailable; check the custom endpoint and its upstream service before retrying',
};

/**
 * Providers sometimes wrap a JSON error inside several escaped message strings.
 * Inspect only a bounded set of error fields. Never serialize the object, retain
 * raw messages, interpolate provider values, or persist endpoint credentials.
 */
export function vscodeProviderDiagnostic(error: unknown): { code: VSCodeProviderCode; message: string } | undefined {
  const values: string[] = [], statuses = new Set<number>(), seen = new Set<object>();
  let remaining = 32768, nodes = 32;
  function inspect(value: unknown, depth = 0): void {
    if (value === undefined || value === null) return;
    if (nodes-- <= 0 || depth > 5 || remaining <= 0) return;
    if (typeof value === 'string') {
      const part = value.slice(0, Math.min(8192, remaining)); remaining -= part.length; values.push(part); return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const fields = ['code', 'message', 'error', 'cause', 'body', 'data', 'response'];
    for (const key of fields) {
      try { inspect((value as Record<string, unknown>)[key], depth + 1); } catch { /* An unreadable field is not evidence. */ }
    }
    for (const key of ['status', 'statusCode']) {
      try { const status = (value as Record<string, unknown>)[key];
        if (typeof status === 'number' && Number.isInteger(status)) statuses.add(status);
      } catch { /* Only readable numeric status metadata is classified. */ }
    }
  }
  inspect(error);
  const text = values.join('\n');
  const token = (codes: string[]) => codes.some(code => new RegExp(`(?:^|[^a-z0-9_])${code}(?:$|[^a-z0-9_])`, 'i').test(text));
  let code: VSCodeProviderCode | undefined;
  // Specific model/configuration errors take precedence over a generic HTTP 400.
  if (token(['model_not_supported', 'unsupported_model'])) code = 'MODEL_NOT_SUPPORTED';
  else if (token(['model_not_found', 'model_does_not_exist'])) code = 'MODEL_NOT_FOUND';
  else if (token(['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded', 'prompt_too_long'])) code = 'CONTEXT_LIMIT_EXCEEDED';
  else if (token(['tool_calling_not_supported', 'tool_calling_unsupported', 'tools_not_supported', 'unsupported_tools'])) code = 'TOOL_CALLING_UNSUPPORTED';
  else if (token(['invalid_api_key', 'authentication_error', 'unauthorized', 'authentication_required']) || statuses.has(401) || /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*401\b/i.test(text)) code = 'AUTHENTICATION_REQUIRED';
  else if (token(['permission_denied', 'authorization_error', 'forbidden', 'access_denied']) || statuses.has(403) || /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*403\b/i.test(text)) code = 'AUTHORIZATION_DENIED';
  else if (token(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests']) || statuses.has(429) || /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*429\b/i.test(text)) code = 'RATE_LIMITED';
  else if (token(['service_unavailable', 'overloaded_error', 'server_overloaded', 'upstream connection lost']) || [502, 503, 504].some(status => statuses.has(status)) || /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:502|503|504)\b/i.test(text)) code = 'PROVIDER_UNAVAILABLE';
  return code ? { code, message: diagnostics[code] } : undefined;
}
