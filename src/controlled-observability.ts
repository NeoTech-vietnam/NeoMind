import { readFileSync, existsSync } from 'node:fs';
import { hash, safePath } from './storage.js';

const sensitiveKey = /password|token|secret|authorization|credential|cookie|api.?key|private.?key|connection.?string|headers|^(?:env|environment)$/i;
const fileContent = /^(?:content|file_content|source_content|source_code|stdin|prepared_content)$/i;
const sensitiveFlag = /^--?(?:api[-_]?key|password|token|secret|authorization|credential|cookie|header|h|env|private[-_]?key)$/i;
function redactedText(value: string): string {
  return value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, '[redacted private key]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'\\,;}]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{6,}/g, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted credential]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|authorization|credential|private[-_ ]?key)\s*["']?\s*(?:=|:)\s*)(["'])([\s\S]*?)\2/gi, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|authorization|credential|private[-_ ]?key)\s*(?:=|:)\s*["']?)[^"'\s,;}\\]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => url.replace(/\/\/[^/@\s]+:[^/@\s]+@/, '//[redacted]@').replace(/[?#].*$/, '?[redacted query]'));
}
/** Bounded semantic content, never file bodies or credential-bearing fields. */
export function redactControlledValue(input: unknown): unknown {
  let nodes = 256, remaining = 16000;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number, key = ''): unknown {
    if (sensitiveKey.test(key)) return '[redacted]';
    if (fileContent.test(key)) {
      const content = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return { bytes: Buffer.byteLength(content), content_sha256: hash(content) };
    }
    if (nodes-- <= 0 || depth > 7 || remaining <= 0) return '[bounded]';
    if (typeof value === 'string') {
      let decoded: unknown = value;
      for (let layer = 0; layer < 2 && typeof decoded === 'string' && decoded.length <= 8192 && /^[\[{\"]/.test(decoded.trim()); layer++) {
        try { const next = JSON.parse(decoded); if (next === decoded) break; decoded = next; } catch { break; }
      }
      if (decoded && typeof decoded === 'object') return visit(decoded, depth + 1);
      const text = redactedText(value.slice(0, Math.min(2000, remaining)));
      remaining -= text.length;
      return text + (value.length > 2000 ? ' [truncated]' : '');
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (!value || typeof value !== 'object') return '[unsupported]';
    if (seen.has(value)) return '[cycle]'; seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 64).map((entry, index) =>
      index > 0 && typeof value[index - 1] === 'string' && sensitiveFlag.test(value[index - 1]) ? '[redacted]' : visit(entry, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value).slice(0, 64)) {
      const safeName = redactedText(name).slice(0, 100);
      result[safeName] = visit(child, depth + 1, name);
    }
    return result;
  }
  return visit(input, 0);
}
export function controlledModelInput(tool: string, input: any): Record<string, unknown> {
  const digest = hash(JSON.stringify(input ?? null));
  if (tool === 'task_file_write') return { input_sha256: digest,
    path: redactControlledValue(input?.path), bytes: typeof input?.content === 'string' ? Buffer.byteLength(input.content) : null,
    content_sha256: typeof input?.content === 'string' ? hash(input.content) : null };
  return { input_sha256: digest, semantic: redactControlledValue(input) };
}
const contentCodes = new Set(['PLAN_INVALID', 'INVALID_PATH', 'PRIVATE_PATH', 'SCOPE_DENIED', 'READ_REQUIRED', 'INVALID_FILE',
  'INVALID_CHECK', 'CORNELL_INVALID', 'VERDICT_REQUIRED', 'SCHEMA_INVALID']);
const runtimeCodes = new Set(['ACTOR_INACTIVE', 'INPUT_CHANGED', 'STATE_UNCERTAIN', 'PROTOCOL_ERROR', 'UNSUPPORTED_STAGE',
  'NO_BOUND_PROCEDURE', 'NO_CORNELL_OUTPUT', 'NO_CHECK_EVIDENCE', 'REUSE_NOT_APPLICABLE', 'CONTROLLED_OPERATION_FAILED',
  'ACCEPTANCE_INCOMPLETE', 'CONTINUATION_PILOT_UNSUPPORTED', 'INTAKE_IDENTITY_MISMATCH', 'INTAKE_PAYLOAD_MISMATCH']);
export function controlledValidation(code: unknown, rule?: unknown) {
  const known = typeof code === 'string' && (contentCodes.has(code) || runtimeCodes.has(code));
  const safeCode = known ? code : 'CONTROLLED_OPERATION_FAILED';
  const redacted = known && typeof rule === 'string' ? redactControlledValue(rule) : undefined;
  const safeRule = redacted !== undefined ? (typeof redacted === 'string' ? redacted : JSON.stringify(redacted)).slice(0, 2000)
    : 'The bound operation could not complete. The runtime must reconcile the failed boundary; existing work is preserved.';
  return { code: safeCode, rule: safeRule, owner: contentCodes.has(safeCode) ? 'agent-content' : 'runtime',
    rule_id: `controlled.${safeCode.toLowerCase()}` };
}
export function controlledResultFailure(result: any) {
  if (result?.isError !== true) return undefined;
  for (const block of (Array.isArray(result.content) ? result.content : []).slice(0, 8)) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const value = JSON.parse(block.text.slice(0, 16000));
      if (typeof value?.code === 'string') return controlledValidation(value.code, value.validation?.rule ?? value.error);
    } catch { /* SDK schema errors are projected below; raw errors never become trace text. */ }
    try {
      const text = block.text.slice(0, 16000), start = text.indexOf('[');
      if (start < 0) continue;
      const issues = JSON.parse(text.slice(start));
      const codes = new Set(['invalid_type', 'too_big', 'too_small', 'invalid_value', 'unrecognized_keys',
        'invalid_format', 'not_multiple_of', 'invalid_union', 'custom']);
      if (!Array.isArray(issues) || !issues.length) continue;
      const rules = issues.slice(0, 8).map(issue => ({ rule: codes.has(issue?.code) ? issue.code : 'schema_mismatch',
        path: (Array.isArray(issue?.path) ? issue.path : []).slice(0, 8).map((part: unknown) => typeof part === 'string'
          ? sensitiveKey.test(part) ? '[redacted-field]' : redactedText(part).slice(0, 80) : typeof part === 'number' ? part : '[field]') }));
      return controlledValidation('SCHEMA_INVALID', `Input schema validation failed: ${JSON.stringify(rules)}. Check the declared tool schema.`);
    } catch { /* Unknown SDK errors use a fixed rule without raw provider text. */ }
  }
  return controlledValidation('SCHEMA_INVALID', 'The supplied arguments do not match this tool\'s declared schema. Check its required fields, field types and forbidden extra fields.');
}
/** Ignore trace revision/events so observing a rejection cannot make it new work. */
export function controlledLoopState(root: string, binding: { workflow_id: string; invocation_id?: string }): string {
  const state: unknown[] = [];
  try {
    const path = safePath(root, `.neomind/controlled/workflows/${hash(binding.workflow_id)}.json`);
    if (existsSync(path)) {
      const run = JSON.parse(readFileSync(path, 'utf8'));
      state.push({ epoch: run.epoch_id, phase: run.phase, status: run.status, contract: run.contract_hash,
        attempts: run.attempts?.map((attempt: any) => ({ id: attempt.id, state: attempt.state, report_id: attempt.report_id })) });
    }
    if (binding.invocation_id) {
      const path = safePath(root, `.neomind/controlled-tools/${hash(binding.invocation_id)}/state.json`);
      state.push(existsSync(path) ? hash(readFileSync(path)) : 'no-tool-state');
    }
  } catch { state.push('state-unreadable'); }
  return hash(JSON.stringify(state));
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Third identical failed call is refused before dispatch; corrected work can proceed. */
export class ControlledFailureLoop {
  private prior?: { request: string; state: string; failure: string; count: number };
  private request(tool: string, input: unknown): string { return hash(`${tool}\0${canonical(input)}`); }
  blocked(tool: string, input: unknown, state: string): boolean {
    return !!this.prior && this.prior.count >= 2 && this.prior.request === this.request(tool, input) && this.prior.state === state;
  }
  observe(tool: string, input: unknown, result: unknown, state: string): void {
    const failure = controlledResultFailure(result);
    if (!failure) { this.prior = undefined; return; }
    const request = this.request(tool, input), fingerprint = hash(JSON.stringify(failure));
    const same = this.prior?.request === request && this.prior.state === state && this.prior.failure === fingerprint;
    this.prior = { request, state, failure: fingerprint, count: same ? this.prior!.count + 1 : 1 };
  }
}
