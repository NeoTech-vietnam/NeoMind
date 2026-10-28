import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { legacyAgentProfiles as agentProfiles, type AgentProfileId } from './agent-profiles.js';
import { isNativeExecutionMode } from './execution-mode.js';
import { nativeWorkflowRecord, strictRecord } from './engineering.js';
import { atomicWrite, getRecord, loadRecords, now, readConfig, safePath, withLock, withOperationLock } from './storage.js';
import type { NativeRole } from './routing.js';
import type { ProjectRecord } from './types.js';

export const agentActivityTtlMs = 300_000;
export const agentActivityLimits = { events: 256, bytes: 16_384 } as const;
export type AgentActivityState = 'dispatched' | 'running' | 'waiting' | 'completed' | 'blocked' | 'failed';
export interface AgentActivityInput {
  workflow_id: string;
  assignment_id: string;
  profile_id: AgentProfileId;
  state: AgentActivityState;
  summary: string;
  invocation_id?: string;
  task_id?: string;
}
export interface AgentActivityEvent extends AgentActivityInput {
  schema_version: 1;
  id: string;
  project_id: string;
  observed_at: string;
  source: 'native-activity';
  execution_mode: 'unsigned-native-progress';
  role: NativeRole;
}
export interface AgentActivityProjection extends Omit<AgentActivityEvent, 'state'> {
  state: AgentActivityState | 'unknown';
  reported_state: AgentActivityState;
  expired: boolean;
  age_ms: number;
  expires_at: string | null;
}
export interface AgentActivitySnapshot {
  events: AgentActivityEvent[];
  latest: AgentActivityProjection[];
  invalid: number;
  omitted: number;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const states = new Set(['dispatched', 'running', 'waiting', 'completed', 'blocked', 'failed']);
const active = new Set(['dispatched', 'running', 'waiting']);
const closedPhases = new Set(['completed', 'completed-with-blockers', 'awaiting-native-completion']);
const inputKeys = new Set(['workflow_id', 'assignment_id', 'profile_id', 'state', 'summary', 'invocation_id', 'task_id']);
const eventKeys = new Set([...inputKeys, 'schema_version', 'id', 'project_id', 'observed_at', 'source', 'execution_mode', 'role']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Activity must be an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be bounded nonempty text without control characters.`);
  return value.trim();
}
function entry(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
interface ProjectionRecords { records: readonly ProjectRecord[]; byId: ReadonlyMap<string, ProjectRecord> }
function recordAt(root: string, id: string, projection?: ProjectionRecords): ProjectRecord {
  if (!projection) return getRecord(root, id);
  const record = projection.byId.get(id);
  if (!record) throw new Error(`Record not found: ${id}`);
  return structuredClone(record);
}
function workflow(root: string, id: string, projection?: ProjectionRecords): ProjectRecord {
  const record = recordAt(root, id, projection), data = record.meta.data;
  const native = record.meta.type === 'knowledge' && data.kind === 'manager-workflow' &&
    isNativeExecutionMode(data.execution_mode) && data.routing_required === false && nativeWorkflowRecord(root, record, new Set<string>(), projection?.records);
  // createRecord currently stamps lightweight records routing_required when a routing
  // policy exists; the exact saved kind/mode/backend/assurance establish this branch.
  const lightweight = record.meta.type === 'knowledge' && data.kind === 'lightweight-workflow' &&
    data.execution_mode === 'lightweight' && isNativeExecutionMode(data.backend) && data.assurance === 'unsigned-native-report' &&
    data.workflow_id === undefined && data.intake_workflow_id === undefined &&
    record.meta.links.every(link => !strictRecord(root, recordAt(root, link.target, projection), new Set<string>(), projection?.records));
  if (!native && !lightweight) throw new Error('Unsigned activity requires a saved native or lightweight workflow.');
  return record;
}
function normalizedInput(root: string, value: unknown, persisted = false, parents = new Map<string, ProjectRecord>(), projection?: ProjectionRecords): { input: AgentActivityInput; workflow: ProjectRecord; role: NativeRole } {
  const data = object(value);
  if (Object.keys(data).some(key => !(persisted ? eventKeys : inputKeys).has(key)))
    throw new Error('Unknown activity fields are not permitted.');
  const profile = agentProfiles.find(profile => profile.id === data.profile_id);
  if (!profile) throw new Error('Activity profile must identify a configured NeoMind profile.');
  if (typeof data.state !== 'string' || !states.has(data.state)) throw new Error('Invalid reported activity state.');
  const input: AgentActivityInput = {
    workflow_id: text(data.workflow_id, 'Workflow ID', 256),
    assignment_id: text(data.assignment_id, 'Assignment ID', 256),
    profile_id: profile.id, state: data.state as AgentActivityState,
    summary: text(data.summary, 'Activity summary', 240),
    ...(data.invocation_id === undefined ? {} : { invocation_id: text(data.invocation_id, 'Invocation ID', 256) }),
    ...(data.task_id === undefined ? {} : { task_id: text(data.task_id, 'Task ID', 256) }),
  };
  if ((profile.id === 'coordinator') !== (input.assignment_id === 'coordinator'))
    throw new Error('Only the Coordinator uses assignment_id coordinator.');
  const parent = parents.get(input.workflow_id) ?? workflow(root, input.workflow_id, projection);
  parents.set(input.workflow_id, parent);
  if (!persisted && closedPhases.has(String(parent.meta.data.phase)))
    throw new Error('Completed workflows cannot receive new activity.');
  if (input.task_id) {
    const task = recordAt(root, input.task_id, projection);
    if (task.meta.type !== 'task' || task.meta.data.workflow_id !== parent.meta.id ||
        (parent.meta.data.kind === 'manager-workflow' && !nativeWorkflowRecord(root, task, new Set<string>(), projection?.records)) ||
        (parent.meta.data.kind === 'lightweight-workflow' && task.meta.data.intake_workflow_id !== undefined))
      throw new Error('Activity task must belong to the same unsigned workflow.');
  }
  return { input, workflow: parent, role: profile.modelRole };
}
/** Append a self-reported observation; this never mutates engineering records or receipts. */
export function reportAgentActivity(root: string, value: AgentActivityInput): AgentActivityEvent {
  return withOperationLock(root, 'agent-activity', () => withLock(root, () => {
    const { input, role } = normalizedInput(root, value);
    // Identity consistency is limited to the reader's bounded recent window.
    const prior = readAgentActivity(root).latest.find(event =>
      event.workflow_id === input.workflow_id && event.assignment_id === input.assignment_id);
    if (prior && (prior.profile_id !== input.profile_id || (prior.task_id ?? null) !== (input.task_id ?? null)))
      throw new Error('Activity assignment profile and task binding cannot change within the recent window.');
    const directory = safePath(root, '.neomind/runs/agent-activity');
    const info = entry(directory);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error('Activity storage must be an ordinary directory.');
    const event: AgentActivityEvent = {
      schema_version: 1, id: randomUUID(), project_id: readConfig(root).project_id, observed_at: now(),
      source: 'native-activity', execution_mode: 'unsigned-native-progress', role, ...input,
    };
    atomicWrite(safePath(root, `.neomind/runs/agent-activity/${event.id}.json`), JSON.stringify(event) + '\n');
    return event;
  }), 10_000);
}
/** Inspect only the newest bounded disk window; omitted events may contain older heads. */
export function readAgentActivity(root: string, options: { now?: string } = {}, projectionRecords?: readonly ProjectRecord[]): AgentActivitySnapshot {
  const current = options.now === undefined ? Date.now() : Date.parse(options.now);
  if (!Number.isFinite(current)) throw new Error('Activity projection time must be a valid timestamp.');
  const result: AgentActivitySnapshot = { events: [], latest: [], invalid: 0, omitted: 0 };
  const project = readConfig(root).project_id;
  let directory: string;
  try {
    directory = safePath(root, '.neomind/runs/agent-activity');
    const info = entry(directory);
    if (!info) return result;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe activity directory.');
  } catch { result.invalid++; return result; }
  const candidates: { name: string; time: number }[] = [];
  for (const name of readdirSync(directory)) {
    // An atomic append may be visible briefly before its final rename.
    if (/\.json\.[a-f0-9-]+\.tmp$/.test(name)) continue;
    if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) { result.invalid++; continue; }
    try {
      const info = lstatSync(safePath(root, `.neomind/runs/agent-activity/${name}`));
      if (!info.isFile() || info.isSymbolicLink() || info.size > agentActivityLimits.bytes) throw new Error('Unsafe activity file.');
      candidates.push({ name, time: info.mtimeMs });
    } catch { result.invalid++; }
  }
  candidates.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  result.omitted = Math.max(0, candidates.length - agentActivityLimits.events);
  // The optional input belongs only to a synchronous read-only projection such
  // as readAgentMap. Mutation callers never receive or reuse this snapshot.
  const records = projectionRecords ?? loadRecords(root);
  const projection: ProjectionRecords = { records, byId: new Map(records.map(record => [record.meta.id, record])) };
  const observed: { event: AgentActivityEvent; workflow: ProjectRecord; time: number }[] = [];
  const parents = new Map<string, ProjectRecord>();
  for (const candidate of candidates.slice(0, agentActivityLimits.events)) {
    let fd: number | undefined;
    try {
      const path = safePath(root, `.neomind/runs/agent-activity/${candidate.name}`);
      if (lstatSync(path).isSymbolicLink()) throw new Error('Linked activity file.');
      fd = openSync(path, 'r');
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > agentActivityLimits.bytes) throw new Error('Oversized activity file.');
      const bytes = Buffer.alloc(agentActivityLimits.bytes + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
      if (length > agentActivityLimits.bytes) throw new Error('Oversized activity file.');
      const data = object(JSON.parse(bytes.subarray(0, length).toString('utf8')));
      const parsed = normalizedInput(root, data, true, parents, projection);
      if (Object.entries(parsed.input).some(([key, value]) => data[key] !== value) ||
          data.schema_version !== 1 || data.id !== candidate.name.slice(0, -5) || data.project_id !== project ||
          data.source !== 'native-activity' || data.execution_mode !== 'unsigned-native-progress' || data.role !== parsed.role ||
          typeof data.observed_at !== 'string' || !Number.isFinite(Date.parse(data.observed_at)) ||
          new Date(data.observed_at).toISOString() !== data.observed_at)
        throw new Error('Invalid saved activity provenance.');
      observed.push({ event: data as unknown as AgentActivityEvent, workflow: parsed.workflow, time: candidate.time });
    } catch { result.invalid++; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  observed.sort((a, b) => b.event.observed_at.localeCompare(a.event.observed_at) || b.time - a.time ||
    Number(active.has(a.event.state)) - Number(active.has(b.event.state)) || b.event.id.localeCompare(a.event.id));
  result.events = observed.map(item => item.event);
  const latest = new Map<string, AgentActivityProjection>();
  for (const { event, workflow: parent } of observed) {
    const key = JSON.stringify([event.workflow_id, event.assignment_id]);
    if (latest.has(key)) continue;
    const delta = current - Date.parse(event.observed_at), running = active.has(event.state);
    const expired = running && (delta >= agentActivityTtlMs || delta < -60_000 || closedPhases.has(String(parent.meta.data.phase)));
    latest.set(key, { ...event, reported_state: event.state, state: expired ? 'unknown' : event.state, expired,
      age_ms: Math.max(0, delta), expires_at: running ? new Date(Date.parse(event.observed_at) + agentActivityTtlMs).toISOString() : null });
  }
  result.latest = [...latest.values()].sort((a, b) => Number(active.has(b.state)) - Number(active.has(a.state)) ||
    b.observed_at.localeCompare(a.observed_at) || b.id.localeCompare(a.id));
  return result;
}
