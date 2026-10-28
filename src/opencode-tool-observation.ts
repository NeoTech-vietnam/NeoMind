import { canonicalJson } from './routing.js';
import { hash } from './storage.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
export interface OpenCodeToolObservation {
  event_id: string; call_id: string; tool: string; status: 'running' | 'completed' | 'error';
  input_sha256: string; error_sha256?: string; repeated_failures?: number; halt?: boolean;
}
interface ToolCall { tool: string; input: unknown }
const mutatingTools = new Set(['workflow_plan', 'assignment_report', 'task_file_write', 'task_run', 'procedure_run',
  'cornell_research_compile', 'check_run', 'request_input']);
function protocolFailure(output: unknown): unknown | undefined {
  let value = output;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return; } }
  if (!object(value)) return;
  if (value.isError === true) return value;
  if (typeof value.error === 'string' && typeof value.code === 'string' && object(value.validation)) return value;
}

/** Engine-owned tool validation can fail before MCP dispatch. Observe both
 * pinned event families; a provider/model cannot spend unlimited turns on the
 * same unchanged failure. No raw model payload or error crosses this seam. */
export class OpenCodeToolFailureGuard {
  private calls = new Map<string, ToolCall>();
  private terminals = new Set<string>();
  private failures = new Map<string, number>();
  private progress = new Set<string>();
  private halted = false;
  constructor(readonly sessionId: string, readonly allowedTools: readonly string[]) {}
  observe(value: unknown): OpenCodeToolObservation | undefined {
    if (this.halted || !object(value) || typeof value.id !== 'string' || !object(value.properties) ||
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
    const observation: OpenCodeToolObservation = { event_id: value.id, call_id: callId, tool: name, status,
      input_sha256: hash(canonicalJson(input ?? null)) };
    if (status === 'running') return observation;
    if (this.terminals.has(callId)) return;
    this.terminals.add(callId); if (this.terminals.size > 2048) this.terminals.delete(this.terminals.values().next().value!);
    if (status === 'completed') {
      if (mutatingTools.has(name)) {
        const key = hash(canonicalJson({ tool: name, input: input ?? null, output: output ?? null }));
        if (!this.progress.has(key)) {
          this.progress.add(key); this.failures.clear();
          if (this.progress.size > 512) this.progress.delete(this.progress.values().next().value!);
        }
      }
      return observation;
    }
    const detail = typeof error === 'string' ? error : object(error) && object(error.data) && typeof error.data.message === 'string'
      ? error.data.message : canonicalJson(error ?? null);
    observation.error_sha256 = hash(detail);
    const key = hash(canonicalJson({ tool: name, input_sha256: observation.input_sha256, error_sha256: observation.error_sha256 }));
    const count = (this.failures.get(key) ?? 0) + 1; this.failures.set(key, count);
    if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
    observation.repeated_failures = count;
    if (count >= 2) { this.halted = true; observation.halt = true; }
    return observation;
  }
}
