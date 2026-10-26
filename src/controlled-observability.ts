import { readFileSync, existsSync } from 'node:fs';
import { hash, safePath } from './storage.js';
import { expandControlledSchemaIssues } from './controlled-schema-diagnostics.js';

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
  if (tool === 'task_run') return { input_sha256: digest, title: redactControlledValue(input?.title),
    command: redactControlledValue(input?.command), input_paths: redactControlledValue(input?.input_paths),
    output_paths: redactControlledValue(input?.output_paths),
    structured_input_sha256: input?.input === undefined ? null : hash(JSON.stringify(input.input)) };
  if (tool === 'task_file_write') return { input_sha256: digest,
    path: redactControlledValue(input?.path), bytes: typeof input?.content === 'string' ? Buffer.byteLength(input.content) : null,
    content_sha256: typeof input?.content === 'string' ? hash(input.content) : null };
  return { input_sha256: digest, semantic: redactControlledValue(input) };
}
const contentCodes = new Set(['PLAN_INVALID', 'INVALID_PATH', 'PRIVATE_PATH', 'SCOPE_DENIED', 'READ_REQUIRED', 'INVALID_FILE', 'INVALID_EXECUTION', 'OUTPUT_EXISTS',
  'INVALID_CHECK', 'CHECK_INPUT_MISSING', 'CORNELL_INVALID', 'GENERATED_ARTIFACT', 'VERDICT_REQUIRED', 'SCHEMA_INVALID', 'INVALID_PAYLOAD']);
const runtimeCodes = new Set(['ACTOR_INACTIVE', 'INPUT_CHANGED', 'STALE_READ', 'STATE_UNCERTAIN', 'PROTOCOL_ERROR', 'UNSUPPORTED_STAGE', 'EVIDENCE_SCAN_TIMEOUT',
  'CORNELL_FORMAT_PROFILE_UNSUPPORTED',
  'NO_BOUND_PROCEDURE', 'NO_CORNELL_OUTPUT', 'NO_CHECK_EVIDENCE', 'REUSE_NOT_APPLICABLE', 'CONTROLLED_OPERATION_FAILED',
  'ACCEPTANCE_INCOMPLETE', 'CONTINUATION_PILOT_UNSUPPORTED', 'INTAKE_IDENTITY_MISMATCH', 'INTAKE_PAYLOAD_MISMATCH']);
const schemaMessages = {
  invalid_type: 'Use the declared field type and include required fields.',
  too_big: 'The field exceeds its declared size or length limit.',
  too_small: 'The field has fewer items or characters than the schema requires.',
  invalid_value: 'Use a value allowed by the declared schema.',
  unrecognized_keys: 'Remove extra fields not declared by this tool schema.',
  invalid_format: 'Use the declared string, date or identifier format.',
  not_multiple_of: 'Use a number satisfying the declared numeric constraint.',
  invalid_union: 'Use one of the declared input shapes.',
  custom: 'A declared cross-field or content rule was not satisfied.',
  schema_mismatch: 'The field does not match the declared schema.',
} as const;
const schemaTypes = new Set(['string', 'number', 'boolean', 'array', 'object', 'null', 'undefined', 'int', 'bigint']);
// Schema names, not model-provided dictionary keys. Unknown/sensitive names never enter traces.
const schemaFields = new Set(('schema_version id version title objective rationale acceptance_criteria allowed_paths verification_paths outputs documentation_paths checks purpose command baseline_paths expected_exit_code timeout_ms negative_controls risk reuse procedure_id parameters procedure_candidate script verification_script dependencies effects write_roots read_roots network publication task_family environment input_paths preservation_paths specialists role cornell_output_dir path max_chars start_line query max_matches content outcome summary artifacts findings failure_kind verdict limitations requirement_id expected_requirement_revision workflow_id task_id owner topic date output_dir context constraints abstract learning_objectives text methods explanations heading body results discussion questions prompt objective_ids answer worked_example expected observed evidence_ids practice procedure steps solution_path starter sources uri retrieved_at locator record_id sha256 failure_cases').split(' '));
for (const field of ['input_path', 'cornell_input_path', 'evidence_report_paths', 'after_evidence_reports']) schemaFields.add(field);
for (const field of ['execution_steps', 'output_paths', 'max_output_bytes', 'argv', 'name', 'fixture_description',
  'intent', 'implementation_instructions', 'verification_instructions']) schemaFields.add(field);
interface SafeSchemaIssue { path: (string | number)[]; code: keyof typeof schemaMessages; message: string }
function safeSchemaIssues(value: unknown): SafeSchemaIssue[] {
  return expandControlledSchemaIssues(value, issue => {
    const code: keyof typeof schemaMessages = typeof issue.code === 'string' && Object.hasOwn(schemaMessages, issue.code)
      ? issue.code as keyof typeof schemaMessages : 'schema_mismatch';
    const path = (Array.isArray(issue.path) ? issue.path : []).slice(0, 8).map((part: unknown) =>
      typeof part === 'string' ? sensitiveKey.test(part) ? '[redacted-field]' : schemaFields.has(part) ? part : '[field]'
        : Number.isSafeInteger(part) && Number(part) >= 0 && Number(part) <= 1000000 ? Number(part) : '[index]');
    return { path, code, message: code === 'invalid_type' && typeof issue.expected === 'string' && schemaTypes.has(issue.expected)
      ? `Expected ${issue.expected}.` : schemaMessages[code] };
  });
}
function sdkSchemaIssues(text: string): unknown[] {
  const start = text.indexOf('[');
  if (start >= 0) try {
    const issues = JSON.parse(text.slice(start));
    if (Array.isArray(issues)) return issues;
  } catch { /* Current SDK formats plain message/path lines instead of a JSON issue array. */ }
  const marker = text.indexOf('Input validation error:');
  if (marker < 0) return [];
  const body = text.slice(marker + 'Input validation error:'.length)
    .replace(/^\s*Invalid arguments for tool [A-Za-z0-9_-]+:\s*/, '');
  return body.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 8).map(line => {
    const at = line.lastIndexOf(' at '), message = at >= 0 ? line.slice(0, at) : line,
      dotted = at >= 0 ? line.slice(at + 4) : '';
    const path = dotted.length <= 512 && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d{1,9}\])*$/.test(dotted)
      ? [...dotted.matchAll(/[A-Za-z_]\w*|\[(\d+)\]/g)].map(part => part[1] === undefined ? part[0] : Number(part[1])) : [];
    const expected = /^Invalid input: expected ([a-z]+), received\b/.exec(message)?.[1]
      ?? /^Expected (string|number|boolean|array|object|null|undefined|int|bigint)\.$/.exec(message)?.[1];
    const code = expected ? 'invalid_type' : /^Too small:/.test(message) ? 'too_small'
      : /^Too big:/.test(message) ? 'too_big' : /^Unrecognized keys?:/.test(message) ? 'unrecognized_keys'
        : /^Invalid (?:option|value):/.test(message) ? 'invalid_value'
          : /^Invalid (?:string|ISO |UUID|url|email|format)/.test(message) ? 'invalid_format'
            : /^Invalid number:.*multiple of/.test(message) ? 'not_multiple_of'
              : message === 'Invalid input' ? 'invalid_union' : 'custom';
    return { path, code, expected }; // Never return raw messages, values, enum choices or unknown key names.
  });
}
export function controlledValidation(code: unknown, rule?: unknown, schemaIssues?: unknown) {
  const known = typeof code === 'string' && (contentCodes.has(code) || runtimeCodes.has(code));
  const safeCode = known ? code : 'CONTROLLED_OPERATION_FAILED';
  const issues = safeCode === 'SCHEMA_INVALID' ? safeSchemaIssues(schemaIssues) : [];
  const schemaRule = issues.length ? `Input schema validation failed: ${JSON.stringify(issues)}. Check the declared tool schema.`
    : 'The supplied arguments do not match this tool\'s declared schema. Check its required fields, field types and forbidden extra fields.';
  const redacted = safeCode === 'SCHEMA_INVALID' ? schemaRule : known && typeof rule === 'string' ? redactControlledValue(rule) : undefined;
  const safeRule = redacted !== undefined ? (typeof redacted === 'string' ? redacted : JSON.stringify(redacted)).slice(0, 2000)
    : 'The bound operation could not complete. The runtime must reconcile the failed boundary; existing work is preserved.';
  return { code: safeCode, rule: safeRule, owner: contentCodes.has(safeCode) ? 'agent-content' : 'runtime',
    rule_id: `controlled.${safeCode.toLowerCase()}`, ...(issues.length ? { issues } : {}) };
}
export function controlledResultFailure(result: any) {
  if (result?.isError !== true) return undefined;
  for (const block of (Array.isArray(result.content) ? result.content : []).slice(0, 8)) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const value = JSON.parse(block.text.slice(0, 16000));
      if (typeof value?.code === 'string') return controlledValidation(value.code, value.validation?.rule ?? value.error,
        value.code === 'SCHEMA_INVALID' ? value.validation?.issues ?? sdkSchemaIssues(String(value.validation?.rule ?? value.error ?? '').slice(0, 16000)) : undefined);
    } catch { /* SDK schema errors are projected below; raw errors never become trace text. */ }
    try {
      const issues = sdkSchemaIssues(block.text.slice(0, 16000));
      if (!issues.length) continue;
      return controlledValidation('SCHEMA_INVALID', undefined, issues);
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
        attempts: run.attempts?.map((attempt: any) => ({ id: attempt.id, state: attempt.state, report_id: attempt.report_id })),
        checks: run.checks?.map((check: any) => ({ id: check.id, attempt_id: check.attempt_id, log_sha256: check.log_sha256,
          passed: check.passed, exit_code: check.exit_code, expected_exit_code: check.expected_exit_code })),
        local_executions: run.local_executions?.map((operation: any) => ({ id: operation.id, attempt_id: operation.attempt_id,
          state: operation.state, passed: operation.passed, intent_sha256: operation.intent_sha256, result_sha256: operation.result_sha256 })) });
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
