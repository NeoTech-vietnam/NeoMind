import { createHash } from 'node:crypto';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
export type ManagedGatewayTokenSavingMode = 'off' | 'upstream-rtk';
export function managedGatewayTokenSavingPolicy(messages: readonly any[], mode: ManagedGatewayTokenSavingMode = 'off') {
  if (!['off', 'upstream-rtk'].includes(mode)) throw new Error('GATEWAY_TOKEN_POLICY: choose off or upstream-rtk in User settings.');
  const text: string[] = []; let unknown = false;
  for (const message of messages) if (message?.role === 'tool') {
    if (typeof message.content === 'string') text.push(message.content);
    else if (Array.isArray(message.content) && message.content.every((part: any) => part?.type === 'text' && typeof part.text === 'string'))
      text.push(...message.content.map((part: any) => part.text));
    else unknown = true;
  }
  const raw = JSON.stringify(text), lines = text.flatMap(value => value.split(/\r?\n/).filter(line => line.trim()));
  // This is an admission classifier, never a compressor. Source, acceptance
  // evidence, diagnostics and unfamiliar output must retain the opt-out. The
  // qualified subset contains routine progress lines only; it is not a claim
  // that arbitrary natural-language tool output can be compressed safely.
  const protectedOutput = text.some(value => /\b(?:error|fail(?:ed|ure)?|assert(?:ion)?|fatal|sanitizer|exception|warning|accept(?:ance|ed)?|requirement|expected|actual|verdict|check|tests?|passed|exit|evidence|constraint)\b|undefined reference|segmentation fault|not ok/i.test(value));
  const routine = lines.length > 0 && lines.every(line => /^\s*(?:Compiling|Downloading|Fetching)\s+\S[^\r\n]*$/.test(line));
  const permitted = mode === 'upstream-rtk' && !unknown && !protectedOutput && routine;
  return { mode, header: permitted ? 'on' : 'off',
    reason: mode === 'off' ? 'disabled' : unknown ? 'unfamiliar-tool-shape' : protectedOutput ? 'protected-evidence' : !lines.length ? 'no-tool-results' : !routine ? 'unqualified-tool-output' : 'qualified-routine-progress',
    raw_tool_results_sha256: sha(raw), raw_tool_result_bytes: text.reduce((total, value) => total + Buffer.byteLength(value), 0),
    scope: 'routine-progress-only', outbound_compressed_bytes: null, token_savings: 'not-measured', raw_evidence_required: true };
}
/** Numeric provider quota observations only. Unknown is never replaced with a
 * guessed remaining balance, reset date, subscription or account identity. */
export function sanitizeManagedGatewayQuota(value: unknown) {
  const row = value && typeof value === 'object' ? value as Record<string, any> : {};
  const items = Array.isArray(row.limits) ? row.limits : Array.isArray(row.windows) ? row.windows : Array.isArray(row.quotas) ? row.quotas : [];
  const windows = items.flatMap((item: any) => {
    if (!item || typeof item !== 'object') return [];
    const used = number(item.used ?? item.usage), limit = number(item.limit ?? item.total), remaining = number(item.remaining);
    const reset_at = timestamp(item.resetAt ?? item.reset_at ?? item.resetsAt);
    if ([used, limit, remaining, reset_at].every(value => value === null)) return [];
    return [{ used, limit, remaining, reset_at }];
  });
  const used = number(row.used ?? row.usage), limit = number(row.limit ?? row.total), remaining = number(row.remaining), reset_at = timestamp(row.resetAt ?? row.reset_at);
  return { state: windows.length || [used, limit, remaining, reset_at].some(value => value !== null) ? 'observed' : 'unknown',
    source: 'upstream-provider-usage-api', observed_at: new Date().toISOString(), used, limit, remaining, reset_at, windows };
}
/** Does not implement/fork RTK. Compare bytes actually observed before/after the
 * pinned upstream compressor and explicitly retain the original evidence.
 * Passing this bounded diagnostic check is not a claim of universal semantic
 * equivalence or measured token savings. */
export function assessManagedGatewayCompression(raw: string, compressed: string) {
  const protectedLines = [...new Set(raw.split(/\r?\n/).filter(line =>
    /(?:\berror\b|\bfailed?\b|\bfailure\b|\bassert(?:ion)?\b|\bfatal\b|\bsanitizer\b|\bundefined reference\b|\bsegmentation fault\b|\bexception\b|\bnot ok\b|\bacceptance\b|\bevidence\b|\bverdict\b)/i.test(line)))];
  const missing = protectedLines.filter(line => !compressed.includes(line));
  return { raw_sha256: sha(raw), compressed_sha256: sha(compressed), raw_bytes: Buffer.byteLength(raw), compressed_bytes: Buffer.byteLength(compressed),
    bytes_saved: Buffer.byteLength(raw) - Buffer.byteLength(compressed), protected_lines: protectedLines.length,
    missing_protected_line_hashes: missing.map(sha), diagnostics_preserved: missing.length === 0,
    scope: 'selected-diagnostic-and-acceptance-lines-only', raw_evidence_required: true, token_savings: 'not-measured' };
}
