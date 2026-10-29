import { createHash } from 'node:crypto';
import type { Binding, Flow, ProjectConfig } from './schema.js';

export type BindingField = 'runner' | 'provider' | 'model' | 'reasoning';
export type BindingValues = Record<BindingField, string>;
export type BindingOverride = Partial<BindingValues>;
export interface ResolvedBinding {
  values: BindingValues;
  sources: Record<BindingField, 'run' | 'step' | 'flow' | 'project'>;
  fallback: Binding['fallback'];
}

/** Every pinned field wins over lower-precedence defaults; missing fields never silently fall back. */
export function resolveBinding(
  step: Binding, flow: Binding | undefined, project: BindingValues | undefined,
  run: BindingOverride = {},
): ResolvedBinding {
  const values = {} as BindingValues;
  const sources = {} as ResolvedBinding['sources'];
  for (const key of ['runner', 'provider', 'model', 'reasoning'] as const) {
    const override = run[key];
    if (override !== undefined) {
      if (!override.trim()) throw new Error(`Empty run override for ${key}`);
      values[key] = override; sources[key] = 'run';
    } else if (step[key].mode === 'pinned') {
      values[key] = step[key].value; sources[key] = 'step';
    } else if (flow?.[key].mode === 'pinned') {
      const field = flow[key];
      if (field.mode !== 'pinned') throw new Error('Unreachable binding state');
      values[key] = field.value; sources[key] = 'flow';
    } else if (project?.[key]) {
      values[key] = project[key]; sources[key] = 'project';
    } else throw new Error(`No value configured for ${key}`);
  }
  return { values, sources, fallback: structuredClone(step.fallback.length ? step.fallback : flow?.fallback ?? []) };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  throw new Error('Only finite JSON values can be canonicalized');
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function flowHashes(flow: Flow): { semanticHash: string; contentHash: string } {
  const semantic = { ...flow.definition, nodes: flow.definition.nodes.map(({ label: _label, ...node }) => node) };
  return { semanticHash: hashJson(semantic), contentHash: hashJson(flow) };
}

export interface RunConfiguration {
  flow: Flow;
  projectId: string;
  policyVersion: number;
  bindings: Record<string, ResolvedBinding>;
  semanticHash: string;
  contentHash: string;
}

/** Detaches the snapshot from editable objects. Runtime state is deliberately not included. */
export function snapshotConfiguration(flow: Flow, project: ProjectConfig, overrides: Record<string, BindingOverride> = {}): RunConfiguration {
  const bindings: Record<string, ResolvedBinding> = {};
  for (const node of flow.definition.nodes) {
    if (node.type === 'agent_task') {
      const binding = flow.definition.bindings[node.bindingId];
      if (!binding) throw new Error(`Unknown binding ${node.bindingId}`);
      bindings[node.id] = resolveBinding(binding, flow.definition.bindingDefaults[node.bindingId], project.roleDefaults[node.profileId], overrides[node.id]);
    } else if (node.type === 'review_group') {
      for (const reviewer of node.reviewers) {
        const group = flow.definition.sessionGroups.find(g => g.id === reviewer.sessionGroup);
        const binding = group && flow.definition.bindings[group.bindingId];
        if (!binding) throw new Error(`Unknown binding for reviewer ${reviewer.id}`);
        const key = `${node.id}/${reviewer.id}`;
        bindings[key] = resolveBinding(binding, flow.definition.bindingDefaults[group.bindingId], project.roleDefaults[reviewer.profileId], overrides[key]);
      }
    }
  }
  const snapshot = structuredClone(flow);
  return { flow: snapshot, projectId: project.projectId, policyVersion: project.policyVersion, bindings,
    ...flowHashes(snapshot) };
}
