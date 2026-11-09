import { createHash } from 'node:crypto';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
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
    /(?:\berror\b|\bfailed?\b|\bfailure\b|\bassert(?:ion)?\b|\bfatal\b|\bsanitizer\b|\bundefined reference\b|\bsegmentation fault\b|\bexception\b|\bnot ok\b)/i.test(line)))];
  const missing = protectedLines.filter(line => !compressed.includes(line));
  return { raw_sha256: sha(raw), compressed_sha256: sha(compressed), raw_bytes: Buffer.byteLength(raw), compressed_bytes: Buffer.byteLength(compressed),
    bytes_saved: Buffer.byteLength(raw) - Buffer.byteLength(compressed), protected_lines: protectedLines.length,
    missing_protected_line_hashes: missing.map(sha), diagnostics_preserved: missing.length === 0,
    scope: 'selected-diagnostic-lines-only', raw_evidence_required: true, token_savings: 'not-measured' };
}
