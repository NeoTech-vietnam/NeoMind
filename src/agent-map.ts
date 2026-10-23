import { existsSync, readdirSync, statSync } from 'node:fs';
import { readConfig, loadRecords, safePath, now } from './storage.js';
import { readInvocation, ownerIsAlive, strongRoles, workerRoles, type NativeReceipt } from './routing.js';
import type { ProjectRecord } from './types.js';

export type AgentMapState = 'running' | 'waiting' | 'blocked' | 'idle' | 'completed' | 'failed' | 'unknown';
export type AgentMapSource = 'signed-receipt' | 'project-record';
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
  diagnostics: { invalid_receipts: number; omitted_receipts: number; omitted_records: number; omitted_edges: number };
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
  const diagnostics = { invalid_receipts: 0, omitted_receipts: 0, omitted_records: 0, omitted_edges: 0 };
  const snapshot: AgentMapSnapshot = {
    schema_version: 1, project: { id: config.project_id, name: text(config.name)! },
    observed_at: now(), nodes: [], edges: [], diagnostics,
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
  const visibleRecords = records.filter(record => record.meta.type === 'task' || record.meta.data.kind === 'manager-workflow')
    .sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at) || a.meta.id.localeCompare(b.meta.id));
  // Keep current receipt bindings ahead of unrelated historical records.
  const bound = new Set([...receipts.values()].flatMap(receipt => [receipt.workflow_id, receipt.task_id]).filter(Boolean));
  visibleRecords.sort((a, b) => Number(bound.has(b.meta.id)) - Number(bound.has(a.meta.id)));
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
  function edge(from: string, to: string, kind: AgentMapEdge['kind'], source: AgentMapSource, evidence: string, at: string): void {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const id = `${kind}:${from}:${to}:${evidence}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    if (snapshot.edges.length >= agentMapLimits.edges) { diagnostics.omitted_edges++; return; }
    snapshot.edges.push({ id, from, to, kind, source, evidence_id: evidence, at,
      animated: kind === 'report' || kind === 'contribution' || kind === 'handoff' });
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
  snapshot.nodes = [...nodes.values()];
  return snapshot;
}
