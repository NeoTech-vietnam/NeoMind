import { canonicalJson } from './routing.js';
import { hash } from './storage.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
export interface OpenCodeToolObservation {
  source: 'sse' | 'message-reconciliation'; event_id?: string; call_id: string; tool: string; status: 'running' | 'completed' | 'error';
  input_sha256: string; error_sha256?: string; repeated_failures?: number; repeated_observations?: number;
  halt?: boolean; halt_reason?: 'repeated-error' | 'repeated-observation';
}
interface ToolCall { tool: string; input: unknown }
const mutatingTools = new Set(['workflow_plan', 'assignment_report', 'task_file_write', 'task_run', 'procedure_run',
  'cornell_research_compile', 'check_run', 'request_input']);
const readOnlyTools = new Set(['project_read', 'project_list', 'project_search', 'runtime_context', 'check_evidence']);
function decoded(output: unknown): unknown {
  if (typeof output === 'string') { try { return decoded(JSON.parse(output)); } catch { return output; } }
  const content = Array.isArray(output) ? output : object(output) && Array.isArray(output.content) ? output.content : undefined;
  if (content?.length === 1 && object(content[0]) && content[0].type === 'text' && typeof content[0].text === 'string') return decoded(content[0].text);
  return output;
}
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['at', 'created_at', 'updated_at', 'observed_at', 'validated_at',
    'date_utc', 'local_date', 'replayed', 'next_action', 'snapshot_notice'].includes(key)).map(([key, entry]) => [key, semantic(entry)]));
}
function semanticInput(name: string, input: unknown): unknown {
  if (name !== 'project_read' || !object(input)) return semantic(input ?? null);
  const line = input.start_line ?? 1, character = input.start_char ?? 0;
  return { path: input.path, max_chars: input.max_chars ?? 64000,
    ...(typeof line === 'number' && line > 1 ? { start_line: line } : {}),
    ...(typeof character === 'number' && character > 0 ? { start_char: character } : {}) };
}
function committedWork(name: string, input: unknown, output: unknown): unknown | undefined {
  const value = decoded(output); if (!object(value) || value.replayed === true) return;
  if (name === 'task_file_write' && value.saved === true && typeof value.path === 'string' && typeof value.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.sha256) && value.previous_sha256 !== value.sha256) return { tool: name, artifacts: { [value.path]: value.sha256 } };
  const artifacts = value.output_hashes ?? value.artifact_hashes;
  if (['task_run', 'procedure_run', 'cornell_research_compile'].includes(name) && (value.saved === true || value.passed === true) &&
      object(artifacts) && Object.keys(artifacts).length && Object.values(artifacts).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
    return { tool: name, artifacts };
}
function protocolFailure(output: unknown): unknown | undefined {
  let value = output;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return; } }
  if (Array.isArray(value)) {
    for (const block of value) if (object(block) && block.type === 'text' && typeof block.text === 'string') {
      const failure = protocolFailure(block.text); if (failure !== undefined) return failure;
    }
    return;
  }
  if (!object(value)) return;
  if (value.isError === true) return value;
  if (typeof value.error === 'string' && typeof value.code === 'string' && object(value.validation)) return value;
}

/** Engine-owned tool validation can fail before MCP dispatch. Observe both
 * pinned event families; a provider/model cannot spend unlimited turns on the
 * same unchanged failure. No raw model payload or error crosses this seam. */
export class OpenCodeToolFailureGuard {
  private calls = new Map<string, ToolCall>();
  private terminals = new Map<string, 'completed' | 'error'>();
  private failures = new Map<string, number>();
  private progress = new Set<string>();
  private reads = new Map<string, number>();
  private halted = false;
  constructor(readonly sessionId: string, readonly allowedTools: readonly string[]) {}
  observe(value: unknown): OpenCodeToolObservation | undefined {
    return this.handle(value, false);
  }
  reconcile(part: unknown): OpenCodeToolObservation | undefined {
    if (!object(part) || part.sessionID !== this.sessionId || typeof part.id !== 'string') return;
    return this.handle({ type: 'message.part.updated', properties: { sessionID: part.sessionID, part } }, true);
  }
  private handle(value: unknown, reconciled: boolean): OpenCodeToolObservation | undefined {
    if (this.halted || !object(value) || !reconciled && typeof value.id !== 'string' || !object(value.properties) ||
        value.properties.sessionID !== this.sessionId) return;
    const properties = value.properties;
    let callId: unknown, tool: unknown, input: unknown, output: unknown, error: unknown;
    let status: 'running' | 'completed' | 'error';
    if (value.type === 'message.part.updated' && object(properties.part) && properties.part.type === 'tool') {
      const part = properties.part;
      if (!object(part.state) || !['running', 'completed', 'error'].includes(String(part.state.status))) return;
      callId = part.callID; tool = part.tool; input = part.state.input; output = part.state.output; error = part.state.error;
      status = part.state.status as 'running' | 'completed' | 'error';
    } else if (value.type === 'session.next.tool.called') {
      callId = properties.callID; tool = properties.tool; input = properties.input; status = 'running';
    } else if (value.type === 'session.next.tool.failed' || value.type === 'session.next.tool.success') {
      callId = properties.callID; status = value.type === 'session.next.tool.failed' ? 'error' : 'completed';
      error = properties.error; output = properties.result ?? properties.content;
    } else return;
    if (typeof callId !== 'string' || !callId) return;
    if (status === 'completed') {
      const failure = protocolFailure(output);
      if (failure !== undefined) { status = 'error'; error = failure; }
    }
    const saved = this.calls.get(callId);
    if (tool === undefined) tool = saved?.tool;
    if (input === undefined) input = saved?.input;
    if (typeof tool !== 'string') return;
    const name = tool.startsWith('wf_') ? tool.slice(3) : tool;
    // OpenCode's invalid pseudo-tool represents argument/schema rejection
    // before any MCP call. Its source tool name may be retained in input.
    if (!this.allowedTools.includes(name) && tool !== 'invalid') return;
    this.calls.set(callId, { tool, input });
    if (this.calls.size > 512) this.calls.delete(this.calls.keys().next().value!);
    const observation: OpenCodeToolObservation = { source: reconciled ? 'message-reconciliation' : 'sse',
      ...(!reconciled ? { event_id: value.id as string } : {}), call_id: callId, tool: name, status,
      input_sha256: hash(canonicalJson(input ?? null)) };
    if (status === 'running') return observation;
    const prior = this.terminals.get(callId);
    if (prior && (prior === 'error' || status === 'completed')) return;
    this.terminals.set(callId, status); if (this.terminals.size > 2048) this.terminals.delete(this.terminals.keys().next().value!);
    if (status === 'completed') {
      if (mutatingTools.has(name)) {
        const committed = committedWork(name, input, output), key = committed === undefined ? undefined : hash(canonicalJson(committed));
        if (key && !this.progress.has(key)) {
          this.progress.add(key);
          this.reads.clear();
          if (this.progress.size > 512) this.progress.delete(this.progress.values().next().value!);
        }
      }
      if (readOnlyTools.has(name)) {
        const key = hash(canonicalJson({ tool: name, input: semanticInput(name, input), content: semantic(decoded(output)) }));
        const count = (this.reads.get(key) ?? 0) + 1; this.reads.set(key, count);
        if (this.reads.size > 512) this.reads.delete(this.reads.keys().next().value!);
        observation.repeated_observations = count;
        if (count >= 3) { this.halted = true; observation.halt = true; observation.halt_reason = 'repeated-observation'; }
      }
      return observation;
    }
    const detail = typeof error === 'string' ? error : object(error) && object(error.data) && typeof error.data.message === 'string'
      ? error.data.message : canonicalJson(error ?? null);
    observation.error_sha256 = hash(detail);
    const key = hash(canonicalJson({ tool: name, input: semanticInput(name, input), error_sha256: observation.error_sha256 }));
    const count = (this.failures.get(key) ?? 0) + 1; this.failures.set(key, count);
    if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
    observation.repeated_failures = count;
    if (count >= 2) { this.halted = true; observation.halt = true; observation.halt_reason = 'repeated-error'; }
    return observation;
  }
}
