import { existsSync, readdirSync, statSync } from 'node:fs';
import { readConfig, loadRecords, safePath, now } from './storage.js';
import { readInvocation, ownerIsAlive, strongRoles, workerRoles, type NativeReceipt } from './routing.js';
import { readAgentActivity, type AgentActivityState } from './agent-activity.js';
import { agentProfiles } from './agent-profiles.js';
import { readNativeHooks, hookTtlMs } from './agent-hooks.js';
import type { ProjectRecord } from './types.js';
import { controlledStatus, type ControlledSnapshot } from './controlled-workflow.js';

export type AgentMapState = 'running' | 'waiting' | 'blocked' | 'idle' | 'completed' | 'failed' | 'unknown' | 'queued' | 'interrupted' | 'uncertain';
export type AgentMapSource = 'signed-receipt' | 'project-record' | 'native-activity' | 'native-hook' | 'controlled-runtime';
export interface AgentMapNode {
  id: string;
  kind: 'agent' | 'workflow' | 'task';
  label: string;
  role: string | null;
  state: AgentMapState;
  source: AgentMapSource;
  source_id: string;
  invocation_id: string | null;
  workflow_id: string | null;
  task_id: string | null;
  requested_model: string | null;
  confirmed_model: string | null;
  provider: string | null;
  execution_mode: string | null;
  updated_at: string;
  profile_id?: string;
  assignment_id?: string;
  reported_at?: string;
  expires_at?: string | null;
  expired?: boolean;
  reported_state?: AgentActivityState;
  activity_summary?: string;
}
export interface AgentMapEdge {
  id: string;
  from: string;
  to: string;
  kind: 'coordinates' | 'participates' | 'assignment' | 'works-on' | 'handoff' | 'report' | 'contribution' | 'depends-on';
  source: AgentMapSource;
  evidence_id: string;
  at: string;
  animated: boolean;
}
export interface AgentMapSnapshot {
  schema_version: 1;
  project: { id: string; name: string };
  observed_at: string;
  nodes: AgentMapNode[];
  edges: AgentMapEdge[];
  diagnostics: { invalid_receipts: number; omitted_receipts: number; omitted_records: number; omitted_edges: number;
    invalid_activity: number; omitted_activity: number; invalid_hooks?: number; omitted_hooks?: number };
}
export const agentMapLimits = { receipts: 128, records: 128, edges: 512 } as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (value: unknown, limit = 160): string | null => typeof value === 'string' && value.trim()
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : null;
function recordState(record: ProjectRecord): AgentMapState {
  if (record.meta.status === 'blocked') return 'blocked';
  if (record.meta.status === 'failed') return 'failed';
  if (['accepted', 'verified', 'approved', 'reviewed', 'superseded'].includes(record.meta.status)) return 'completed';
  if (record.meta.status === 'submitted') return 'waiting';
  if (record.meta.status === 'in-progress') return 'running';
  return 'idle';
}
function receiptState(receipt: NativeReceipt): AgentMapState {
  if (['starting', 'running', 'waiting-native-permission'].includes(receipt.state) && !ownerIsAlive(receipt.owner_pid))
    return 'blocked';
  if (receipt.state === 'waiting-native-permission') return 'waiting';
  if (['starting', 'running'].includes(receipt.state)) return 'running';
  if (['blocked', 'interrupted', 'orphaned'].includes(receipt.state)) return 'blocked';
  if (receipt.state === 'completed') return 'completed';
  if (receipt.state === 'failed') return 'failed';
  return 'unknown';
}

/** A bounded, read-only projection. Receipt signatures establish provenance, not task acceptance. */
export function readAgentMap(root: string): AgentMapSnapshot {
  const config = readConfig(root), records = loadRecords(root);
  const observedAt = now(), activity = readAgentActivity(root, { now: observedAt }, records);
  const diagnostics = { invalid_receipts: 0, omitted_receipts: 0, omitted_records: 0, omitted_edges: 0,
    invalid_activity: activity.invalid, omitted_activity: activity.omitted };
  const snapshot: AgentMapSnapshot = {
    schema_version: 1, project: { id: config.project_id, name: text(config.name)! },
    observed_at: observedAt, nodes: [], edges: [], diagnostics,
  };
  const nodes = new Map<string, AgentMapNode>(), receipts = new Map<string, NativeReceipt>();
  const directory = safePath(root, '.neomind/native/receipts');
  if (existsSync(directory)) {
    // mtime selects a bounded inspection window; signed updated_at remains the displayed timestamp.
    const files = readdirSync(directory).filter(name => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
      .map(name => ({ name, time: statSync(safePath(root, `.neomind/native/receipts/${name}`)).mtimeMs }))
      .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
    diagnostics.omitted_receipts = Math.max(0, files.length - agentMapLimits.receipts);
    for (const { name } of files.slice(0, agentMapLimits.receipts)) {
      const id = name.slice(0, -5);
      try {
        const receipt = readInvocation(root, id);
        receipts.set(id, receipt);
        nodes.set(`agent:${id}`, {
          id: `agent:${id}`, kind: 'agent', label: text(receipt.role) ?? 'Unknown role', role: text(receipt.role),
          state: receiptState(receipt), source: 'signed-receipt', source_id: id, invocation_id: id,
          workflow_id: text(receipt.workflow_id), task_id: text(receipt.task_id),
          requested_model: text(receipt.requested_model), confirmed_model: text(receipt.confirmed_model),
          provider: text(receipt.model_provider), execution_mode: text(receipt.execution_mode), updated_at: text(receipt.updated_at) ?? '',
        });
      } catch { diagnostics.invalid_receipts++; }
    }
  }
  const visibleRecords = records.filter(record => record.meta.type === 'task' ||
    ['manager-workflow', 'lightweight-workflow'].includes(String(record.meta.data.kind)))
    .sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at) || a.meta.id.localeCompare(b.meta.id));
  // Keep fresh activity/receipt bindings ahead of unrelated or completed history.
  const bound = new Map<string, number>();
  const bind = (id: string | null | undefined, priority: number) => { if (id) bound.set(id, Math.max(bound.get(id) ?? 0, priority)); };
  for (const receipt of receipts.values()) {
    const priority = ['starting', 'running', 'waiting-native-permission'].includes(receipt.state) ? 3 : 2;
    bind(receipt.workflow_id, priority); bind(receipt.task_id, priority);
  }
  for (const entry of activity.latest) {
    const priority = ['dispatched', 'running', 'waiting'].includes(entry.state) ? 3 : 1;
    bind(entry.workflow_id, priority); bind(entry.task_id, priority);
  }
  visibleRecords.sort((a, b) => (bound.get(b.meta.id) ?? 0) - (bound.get(a.meta.id) ?? 0));
  diagnostics.omitted_records = Math.max(0, visibleRecords.length - agentMapLimits.records);
  for (const record of visibleRecords.slice(0, agentMapLimits.records)) {
    const kind = record.meta.type === 'task' ? 'task' : 'workflow';
    nodes.set(record.meta.id, {
      id: record.meta.id, kind, label: text(record.meta.title) ?? record.meta.id, role: text(record.meta.owner),
      state: recordState(record), source: 'project-record', source_id: record.meta.id, invocation_id: null,
      workflow_id: kind === 'workflow' ? record.meta.id : text(record.meta.data.workflow_id),
      task_id: kind === 'task' ? record.meta.id : null, requested_model: null, confirmed_model: null,
      provider: null, execution_mode: null, updated_at: record.meta.updated_at,
    });
  }
  const edgeIds = new Set<string>();
  function edge(from: string, to: string, kind: AgentMapEdge['kind'], source: AgentMapSource, evidence: string, at: string,
    animated = kind === 'report' || kind === 'contribution' || kind === 'handoff'): void {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const id = `${kind}:${from}:${to}:${evidence}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    if (snapshot.edges.length >= agentMapLimits.edges) { diagnostics.omitted_edges++; return; }
    snapshot.edges.push({ id, from, to, kind, source, evidence_id: evidence, at, animated });
  }
  // Progress is a separate self-reported observation, never a model receipt or task acceptance.
  const progressId = (workflow: string, assignment: string) => `progress:${workflow}:${assignment}`;
  const coordinators = new Map<string, string>();
  const progress = activity.latest.filter(entry => {
    const profile = agentProfiles.find(profile => profile.id === entry.profile_id);
    if (!profile || nodes.get(entry.workflow_id)?.kind !== 'workflow') {
      diagnostics.omitted_activity++; return false;
    }
    const id = progressId(entry.workflow_id, entry.assignment_id);
    nodes.set(id, { id, kind: 'agent', label: profile.name, role: entry.role,
      state: entry.state === 'dispatched' ? 'waiting' : entry.state,
      source: 'native-activity', source_id: entry.id, invocation_id: text(entry.invocation_id, 256),
      workflow_id: entry.workflow_id, task_id: text(entry.task_id, 256), requested_model: null, confirmed_model: null,
      provider: null, execution_mode: 'unsigned-native-progress', updated_at: entry.observed_at,
      profile_id: entry.profile_id, assignment_id: entry.assignment_id, reported_at: entry.observed_at,
      expires_at: entry.expires_at, expired: entry.expired, reported_state: entry.reported_state,
      activity_summary: text(entry.summary, 240) ?? '' });
    if (entry.profile_id === 'coordinator') coordinators.set(entry.workflow_id, id);
    return true;
  });
  for (const entry of progress) {
    const id = progressId(entry.workflow_id, entry.assignment_id);
    const coordinator = coordinators.get(entry.workflow_id);
    const hub = coordinator && coordinator !== id ? coordinator : entry.workflow_id;
    const events = activity.events.filter(event => event.workflow_id === entry.workflow_id &&
      event.assignment_id === entry.assignment_id && event.profile_id === entry.profile_id);
    // One allocation curve per assignment; repeated progress reports are not new messages.
    const allocation = events.find(event => event.state === 'dispatched') ??
      [...events].reverse().find(event => event.state === 'running');
    if (allocation) edge(hub, id, 'handoff', 'native-activity', allocation.id, allocation.observed_at, !entry.expired && entry.state === 'running');
    const returned = events.find(event => ['completed', 'blocked', 'failed'].includes(event.state));
    if (returned) edge(id, hub, 'report', 'native-activity', returned.id, returned.observed_at, false);
    if (entry.task_id) edge(id, entry.task_id, 'works-on', 'native-activity', entry.id, entry.observed_at, false);
  }
  // Runtime lifecycle links use their actual parent session. They are never
  // attached to a saved workflow merely because a matching role exists there.
  let hooks: ReturnType<typeof readNativeHooks>;
  try { hooks = readNativeHooks(root); } catch { hooks = { observations: [], invalid: 1, omitted: 0 }; }
  if (hooks.invalid) snapshot.diagnostics.invalid_hooks = hooks.invalid;
  if (hooks.omitted) snapshot.diagnostics.omitted_hooks = hooks.omitted;
  for (const observation of hooks.observations) {
    const session = `native-session:${observation.session}`, id = `native-hook:${observation.id}`;
    const active = !observation.expired && observation.state === 'running';
    if (!nodes.has(session)) nodes.set(session, { id: session, kind: 'workflow',
      label: `${observation.client === 'codex' ? 'Codex' : 'Copilot'} parent session`, role: null, state: 'idle',
      source: 'native-hook', source_id: observation.session, invocation_id: null, workflow_id: null, task_id: null,
      requested_model: null, confirmed_model: null, provider: null, execution_mode: 'unsigned-native-hook', updated_at: observation.observed_at });
    if (active) nodes.get(session)!.state = 'running';
    nodes.set(id, { id, kind: 'agent', label: agentProfiles.find(profile => profile.id === observation.profile_id)!.name,
      role: observation.role, state: observation.expired ? 'unknown' : observation.state,
      source: 'native-hook', source_id: observation.id, invocation_id: null, workflow_id: null, task_id: null,
      requested_model: null, confirmed_model: null, provider: null, execution_mode: 'unsigned-native-hook',
      profile_id: observation.profile_id, updated_at: observation.observed_at, reported_at: observation.observed_at,
      expires_at: new Date(Date.parse(observation.observed_at) + hookTtlMs).toISOString(), expired: observation.expired,
      activity_summary: observation.event === 'stop' ? 'Native turn stopped; work acceptance is separate.' : 'Observed through a native lifecycle hook.' });
  }
  for (const observation of hooks.observations) {
    const id = `native-hook:${observation.id}`, parent = observation.parent_agent ? `native-hook:${observation.parent_agent}` : '';
    edge(nodes.has(parent) ? parent : `native-session:${observation.session}`, id, 'coordinates', 'native-hook',
      observation.id, observation.observed_at, !observation.expired && observation.state === 'running');
  }
  for (const receipt of receipts.values()) {
    const agent = `agent:${receipt.id}`;
    if (receipt.workflow_id) edge(agent, receipt.workflow_id, receipt.role === 'manager' ? 'coordinates' : 'participates', 'signed-receipt', receipt.id, receipt.created_at);
    if (receipt.task_id) edge(agent, receipt.task_id, 'works-on', 'signed-receipt', receipt.id, receipt.created_at);
    if (receipt.prior_invocation_id) {
      const prior = receipts.get(receipt.prior_invocation_id);
      if (prior && prior.workflow_id === receipt.workflow_id && prior.task_id === receipt.task_id && prior.role === receipt.role)
        edge(`agent:${prior.id}`, agent, 'handoff', 'signed-receipt', receipt.id, receipt.created_at);
    }
  }
  for (const record of records) {
    if (record.meta.type === 'task') {
      const workflow = text(record.meta.data.workflow_id);
      if (workflow) edge(workflow, record.meta.id, 'assignment', 'project-record', record.meta.id, record.meta.updated_at);
      for (const link of record.meta.links.filter(link => link.type === 'depends-on'))
        edge(record.meta.id, link.target, 'depends-on', 'project-record', record.meta.id, record.meta.updated_at);
    }
    const data = record.meta.data;
    if (!['manager-discussion', 'work-record'].includes(String(data.kind))) continue;
    const workflowId = text(data.workflow_id);
    if (!workflowId || nodes.get(workflowId)?.kind !== 'workflow' ||
      ![...strongRoles, ...workerRoles].some(role => role === record.meta.owner)) continue;
    const invocationIds = [...new Set([data.invocation_id, ...(Array.isArray(data.covered_invocation_ids) ? data.covered_invocation_ids.slice(0, 32) : [])]
      .map(id => text(id)).filter((id): id is string => Boolean(id)))];
    for (const invocationId of invocationIds) {
      const receipt = receipts.get(invocationId);
      // Native mode records are self-reported; retain their useful provenance without
      // converting a contribution into an attested model observation or live heartbeat.
      const signed = receipt && receipt.workflow_id === workflowId && receipt.role === record.meta.owner;
      const agent = signed ? `agent:${receipt.id}` : `reported-agent:${workflowId}:${record.meta.owner}:${invocationId}`;
      if (!signed && !nodes.has(agent)) {
        if ([...nodes.values()].filter(node => node.kind === 'agent').length >= agentMapLimits.receipts) {
          diagnostics.omitted_records++;
          continue;
        }
        nodes.set(agent, { id: agent, kind: 'agent', label: `${record.meta.owner} (reported)`, role: record.meta.owner,
          state: 'completed', source: 'project-record', source_id: record.meta.id, invocation_id: invocationId,
          workflow_id: workflowId, task_id: text(data.task_id), requested_model: null, confirmed_model: null,
          provider: null, execution_mode: 'unsigned-native-report', updated_at: record.meta.updated_at });
      }
      const reported = nodes.get(agent);
      if (!signed && reported && reported.updated_at < record.meta.updated_at) {
        reported.source_id = record.meta.id;
        reported.updated_at = record.meta.updated_at;
        reported.task_id = text(data.task_id);
      }
      if (data.kind === 'manager-discussion')
        edge(agent, workflowId, 'contribution', 'project-record', record.meta.id, record.meta.created_at);
      else for (const link of record.meta.links.filter(link => link.type === 'documents')) {
        const target = nodes.get(link.target);
        if (target && (target.workflow_id === workflowId || target.id === workflowId))
          edge(agent, link.target, 'report', 'project-record', record.meta.id, record.meta.created_at);
      }
    }
  }
  // Owned runtime events are distinct from replayed unsigned progress and configured role planets.
  let controlled: ControlledSnapshot[] = [];
  try { controlled = controlledStatus(root) as ControlledSnapshot[]; } catch { /* Corrupt state cannot establish running activity. */ }
  for (const run of controlled.slice(0, agentMapLimits.records)) {
    const workflow = nodes.get(run.workflow_id);
    if (workflow) {
      workflow.state = run.status === 'paused' ? 'waiting' : run.status === 'cancelled' ? 'interrupted' : run.status;
      workflow.execution_mode = 'neomind-controlled'; workflow.source = 'controlled-runtime';
    }
    let manager: string | undefined;
    for (const attempt of run.attempts) {
      if (!attempt.invocation_id) continue;
      const id = `agent:${attempt.invocation_id}`, node = nodes.get(id);
      if (!node) continue;
      node.execution_mode = 'neomind-controlled'; node.source = 'controlled-runtime';
      const live = run.active_invocations.find(item => item.id === attempt.invocation_id);
      node.state = attempt.state === 'interrupted' ? 'interrupted' : live?.state === 'uncertain' ? 'uncertain' : node.state;
      if (attempt.role === 'manager' && !manager) manager = id;
      const hub = manager && manager !== id ? manager : run.workflow_id;
      const dispatched = run.events.find(event => event.kind === 'dispatch' && event.invocation_id === attempt.invocation_id);
      if (dispatched) edge(hub, id, 'handoff', 'controlled-runtime', dispatched.id, dispatched.at, !!live && node.state === 'running');
      if (attempt.report_id) {
        const report = run.events.find(event => event.kind === 'report-saved' && event.invocation_id === attempt.invocation_id);
        if (report) edge(id, hub, 'report', 'controlled-runtime', report.id, report.at, false);
      }
    }
  }
  // Bound the combined sources after ranking current observations ahead of history.
  const current = (node: AgentMapNode) => node.expired !== true && node.source !== 'project-record' &&
    ['running', 'waiting', 'blocked'].includes(node.state);
  const sortedAgents = [...nodes.values()].filter(node => node.kind === 'agent').sort((a, b) =>
    Number(current(b)) - Number(current(a)) || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  for (const node of sortedAgents.slice(agentMapLimits.receipts)) {
    nodes.delete(node.id);
    if (node.source === 'signed-receipt') diagnostics.omitted_receipts++;
    else if (node.source === 'native-activity') diagnostics.omitted_activity++;
    else if (node.source === 'native-hook') snapshot.diagnostics.omitted_hooks = (snapshot.diagnostics.omitted_hooks ?? 0) + 1;
    else diagnostics.omitted_records++;
  }
  const currentIds = new Set(sortedAgents.slice(0, agentMapLimits.receipts).filter(current).map(node => node.id));
  const related = new Set(snapshot.edges.filter(edge => currentIds.has(edge.from) || currentIds.has(edge.to)).flatMap(edge => [edge.from, edge.to]));
  const otherNodes = [...nodes.values()].filter(node => node.kind !== 'agent').sort((a, b) =>
    Number(related.has(b.id)) - Number(related.has(a.id)) || b.updated_at.localeCompare(a.updated_at));
  for (const node of otherNodes.slice(agentMapLimits.records)) { nodes.delete(node.id); diagnostics.omitted_records++; }
  snapshot.nodes = [...sortedAgents.slice(0, agentMapLimits.receipts), ...otherNodes.slice(0, agentMapLimits.records)];
  snapshot.edges = snapshot.edges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to));
  return snapshot;
}
