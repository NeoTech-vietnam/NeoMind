/** Catalog and bindings endpoints (phase 2b) plus the small helpers the page, the picker and the step panels share. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, enc } from '../api';
import {
  DEFAULT_ROLE_ORDER, ROLE_ORDER,
  type BindingModes, type BindingOverride, type BindingPut, type BindingValue, type Catalog, type NativeFallback, type RecordedBinding, type RetryMode, type RoleDetail, type RoleEntry,
  type RoleMode, type RoleSourceName, type SkillDetail, type SkillMode, type SkillUse, type StepAgent, type StepBindingRow, type WorkflowBindings,
} from './types';

export const fetchCatalog = () => api<Catalog>('/api/catalog');
export const fetchSkill = (id: string) => api<SkillDetail>(`/api/catalog/skill/${enc(id)}`);
export const fetchRole = (id: string) => api<RoleDetail>(`/api/catalog/role/${enc(id)}`);
export const fetchBindings = (workflow: string) => api<WorkflowBindings>(`/api/workflows/${enc(workflow)}/bindings`);
export const putBinding = (workflow: string, step: string, body: BindingPut) => api<unknown>(`/api/workflows/${enc(workflow)}/bindings/${enc(step)}`, 'PUT', body);
export const deleteBinding = (workflow: string, step: string) => api<unknown>(`/api/workflows/${enc(workflow)}/bindings/${enc(step)}`, 'DELETE');

// ---------------------------------------------------------------- shared catalog store

/** One catalog for the whole page: the catalog tab, graph badges and step panels read the same copy. */
type Store = { catalog: Catalog | null; error: string; loading: boolean; version: number };
let store: Store = { catalog: null, error: '', loading: false, version: 0 };
const listeners = new Set<() => void>();
const emit = (next: Partial<Store>) => { store = { ...store, ...next }; listeners.forEach(listener => listener()); };
let pending: Promise<void> | null = null;

/** Re-reads the catalog (after a binding is saved, `used_by` changes). */
export function reloadCatalog(): Promise<void> {
  if (pending) return pending;
  emit({ loading: true });
  pending = fetchCatalog().then(catalog => emit({ catalog, error: '', loading: false, version: store.version + 1 }))
    .catch(e => emit({ error: e instanceof Error ? e.message : String(e), loading: false }))
    .finally(() => { pending = null; });
  return pending;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The shared catalog; loads it on first use. */
export function useCatalog(): Store & { reload: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, () => store);
  useEffect(() => { if (!store.catalog && !store.loading && !store.error) void reloadCatalog(); }, []);
  return { ...current, reload: reloadCatalog };
}

// Bindings change in two places (the picker, "Về mặc định"); every view of the same workflow re-reads after a save.
const bindingListeners = new Map<string, Set<() => void>>();
export function notifyBindingsChanged(workflow: string): void {
  bindingListeners.get(workflow)?.forEach(listener => listener());
  void reloadCatalog();
}

/** Bindings of one workflow's ai steps; `null` workflow loads nothing. */
export function useWorkflowBindings(workflow: string | null | undefined) {
  const [data, setData] = useState<{ workflow: string; rows: StepBindingRow[]; defaults: WorkflowBindings['defaults'] } | null>(null), [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => {
    if (!workflow) return;
    const set = bindingListeners.get(workflow) ?? new Set();
    set.add(reload); bindingListeners.set(workflow, set);
    return () => { set.delete(reload); };
  }, [workflow, reload]);
  useEffect(() => {
    if (!workflow) { setData(null); setError(''); return; }
    let current = true;
    fetchBindings(workflow).then(value => { if (current) { setData({ workflow, rows: value.steps ?? [], defaults: value.defaults }); setError(''); } })
      .catch(e => { if (current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [workflow, tick]);
  const rows = data && data.workflow === workflow ? data.rows : null, defaults = data && data.workflow === workflow ? data.defaults : undefined;
  return { rows, defaults, error, reload, row: (step: string) => rows?.find(item => item.step === step || item.step === baseStep(step)) ?? null };
}

/** Detail of one skill or role, loaded on demand. */
export function useCatalogDetail(kind: 'skill' | 'role', id: string | null, version?: unknown) {
  const [loaded, setLoaded] = useState<{ key: string; value: SkillDetail | RoleDetail } | null>(null), [error, setError] = useState('');
  const key = id ? `${kind}:${id}` : '';
  useEffect(() => {
    if (!id) { setLoaded(null); setError(''); return; }
    let current = true; setError('');
    (kind === 'skill' ? fetchSkill(id) : fetchRole(id)).then(value => { if (current) setLoaded({ key, value }); })
      .catch(e => { if (current) { setLoaded(null); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { current = false; };
  }, [kind, id, key, version]);
  return { detail: loaded && loaded.key === key ? loaded.value : null, error };
}

// ---------------------------------------------------------------- helpers

/** Fan-out workers run as "name[i]"; bindings and the graph use the fan-out name. Graph worker nodes are "<fanout>_worker". */
export const baseStep = (step: string) => step.replace(/\[\d+\]$/, '').replace(/_worker$/, '');

export const shortHash = (sha: string | null | undefined, length = 8) => (sha ?? '').slice(0, length);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** The role file a CLI would read (catalog.py pick_source), or null when the role has none. */
export function pickSource(role: RoleEntry | undefined, agent: StepAgent | null | undefined): RoleSourceName | null {
  if (!role?.sources) return null;
  for (const source of ROLE_ORDER[agent ?? ''] ?? DEFAULT_ROLE_ORDER) if (role.sources[source]) return source;
  return null;
}
/** The step's CLI loads this role file itself (Claude: `--agent`, Codex: its toml) rather than as prompt text. */
export const isNative = (role: RoleEntry | undefined, agent: StepAgent | null | undefined) => !!agent && pickSource(role, agent) === agent;

/** A picker choice: role and skills, plus the mode keys where null = keep the code value (no override). */
export type BindingChoice = BindingValue & { role_mode?: RoleMode | null; contract?: boolean | null; skill_mode?: SkillMode | null;
  native_fallback?: NativeFallback | null; retry_mode?: RetryMode | null };

/**
 * What to write to bindings.toml for a choice in the picker: only the keys that differ from the code value, or null
 * when the choice equals the code (then the override is deleted instead). Mode keys (role_mode, contract, skill_mode,
 * native_fallback, retry_mode): written when chosen (not null) and different from the code's `ai(...)` value.
 */
export function overrideFor(code: BindingValue & BindingModes, chosen: BindingChoice): BindingOverride | null {
  const out: BindingOverride = {};
  if ((chosen.role ?? null) !== (code.role ?? null)) out.role = chosen.role ?? '';
  if (!sameList(chosen.skills, code.skills)) out.skills = chosen.skills;
  if (chosen.role_mode != null && chosen.role_mode !== code.role_mode) out.role_mode = chosen.role_mode;
  if (chosen.contract != null && chosen.contract !== code.contract) out.contract = chosen.contract;
  if (chosen.skill_mode != null && chosen.skill_mode !== code.skill_mode) out.skill_mode = chosen.skill_mode;
  if (chosen.native_fallback != null && chosen.native_fallback !== code.native_fallback) out.native_fallback = chosen.native_fallback;
  if (chosen.retry_mode != null && chosen.retry_mode !== code.retry_mode) out.retry_mode = chosen.retry_mode;
  return Object.keys(out).length ? out : null;
}

/** Save a picker choice: PUT the difference, or DELETE when it matches the code. Tells every listener. */
export async function saveBinding(workflow: string, row: StepBindingRow, chosen: BindingChoice): Promise<void> {
  const body = overrideFor(row.code, chosen);
  if (body) await putBinding(workflow, row.step, body);
  else if (row.override) await deleteBinding(workflow, row.step);
  notifyBindingsChanged(workflow);
}
export async function resetBinding(workflow: string, step: string): Promise<void> {
  await deleteBinding(workflow, step);
  notifyBindingsChanged(workflow);
}

/** "đã đổi từ lúc chạy": how the files a run used differ from the catalog now. */
export type BindingChange = { kind: 'role' | 'skill'; id: string; state: 'changed' | 'missing' | 'moved'; path: string; now?: string };
export function bindingChanges(recorded: RecordedBinding | null | undefined, catalog: Catalog | null): BindingChange[] | null {
  if (!recorded || !catalog) return null;
  const out: BindingChange[] = [];
  if (recorded.role) {
    const role = catalog.roles.find(item => item.id === recorded.role!.id && !item.missing), file = role?.sources?.[recorded.role.source];
    if (!file) out.push({ kind: 'role', id: recorded.role.id, state: 'missing', path: recorded.role.path });
    else if (file.sha256 && file.sha256 !== recorded.role.sha256) out.push({ kind: 'role', id: recorded.role.id, state: 'changed', path: recorded.role.path });
  }
  for (const skill of recorded.skills ?? []) {
    const entry = catalog.skills.find(item => item.id === skill.id && !item.missing);
    if (!entry?.path) out.push({ kind: 'skill', id: skill.id, state: 'missing', path: skill.path });
    else if (entry.path !== skill.path) out.push({ kind: 'skill', id: skill.id, state: 'moved', path: skill.path, now: entry.path });
    else if (entry.sha256 && entry.sha256 !== skill.sha256) out.push({ kind: 'skill', id: skill.id, state: 'changed', path: skill.path });
  }
  return out;
}

/** Reads `binding` from a step's info or start event without trusting its shape. */
export function asRecorded(value: unknown): RecordedBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { role?: unknown; skills?: unknown };
  const role = raw.role && typeof raw.role === 'object' && typeof (raw.role as { id?: unknown }).id === 'string' ? raw.role as RecordedBinding['role'] : null;
  const skills = Array.isArray(raw.skills) ? raw.skills.filter((item): item is RecordedBinding['skills'][number] => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') : [];
  return role || skills.length ? { role, skills } : null;
}

export const ORIGIN_LABEL: Record<string, string> = { code: 'code', bindings: 'bindings.toml', run: 'tham số run' };

/** The warnings (catalog.skill_notes) about one skill: lines that start with "<id>: ". */
export const skillWarnings = (warnings: string[] | null | undefined, id: string) => (warnings ?? []).filter(line => line.startsWith(`${id}: `));

/** The CLI loads another text than the file langflow sends (or a personal copy, or a shadow with other text). */
export function cliDiffers(skill: Pick<SkillUse, 'path' | 'sha256' | 'cli'>): boolean {
  const cli = skill.cli;
  if (!cli) return false;
  return cli.source === 'personal' || cli.sha256 !== skill.sha256 || (cli.shadow ?? []).some(item => item.sha256 !== cli.sha256);
}
