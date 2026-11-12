import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Flow, Profile } from '../../src/domain/schema';
import { api } from './api';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Select } from './components/ui/select';

type Ref = Profile['skills'][number];
type Catalog = Ref & { name: string; description: string; source: string; shadowed?: { path: string }[] };
type Status = Ref & { status: 'ok' | 'changed' | 'missing'; currentSha256?: string };

/** Edit pinned references using only the current project catalog. */
export function SkillPicker({ refs, onChange, readOnly = false }: { refs: Ref[]; onChange(refs: Ref[]): void; readOnly?: boolean }) {
  const [catalog, setCatalog] = useState<Catalog[]>([]), [statuses, setStatuses] = useState<Status[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState('');
  const key = JSON.stringify(refs);
  useEffect(() => { let live = true; void api<{ skills: Catalog[] }>('/api/skills').then(data => { if (live) setCatalog(data.skills); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, []);
  useEffect(() => { let live = true; if (!refs.length) { setStatuses([]); return; }
    void api<{ skills: Status[] }>('/api/skills/status', 'POST', { refs: JSON.parse(key) }).then(data => { if (live) setStatuses(data.skills); }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [key]);
  const choices = catalog.filter(item => !refs.some(ref => ref.id === item.id));
  return <div className="flex flex-col gap-3">
    {error && <p role="alert" className="text-danger">{error}</p>}
    {!refs.length && <p className="text-[12px] text-muted-foreground">Chưa chọn skill.</p>}
    {refs.map((ref, index) => { const item = catalog.find(skill => skill.path === ref.path || skill.shadowed?.some(copy => copy.path === ref.path)), status = statuses.find(value => value.path === ref.path && value.id === ref.id);
      return <div key={`${ref.path}-${index}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
        <div className="min-w-0 flex-1"><strong className="block truncate">{item?.name ?? ref.id}</strong><code className="block truncate text-[11px] text-muted-foreground">{ref.path} · {ref.sha256.slice(0, 12)}</code></div>
        {status && <Badge status={status.status === 'ok' ? 'success' : status.status === 'changed' ? 'attention' : 'danger'}>{status.status === 'ok' ? 'Khớp' : status.status === 'changed' ? 'Đã đổi' : 'Thiếu'}</Badge>}
        {!readOnly && status?.status === 'changed' && status.currentSha256 && <Button variant="ghost" size="sm" onClick={() => onChange(refs.map((value, i) => i === index ? { ...value, sha256: status.currentSha256! } : value))}><RefreshCw />Ghim lại</Button>}
        {!readOnly && <Button variant="ghost" size="icon-sm" aria-label={`Xóa skill ${ref.id}`} onClick={() => onChange(refs.filter((_, i) => i !== index))}><Trash2 /></Button>}
      </div>;
    })}
    {!readOnly && <div className="flex items-center gap-2"><div className="min-w-0 flex-1"><Select label="Chọn skill" value={selected} placeholder="Chọn skill từ danh mục" onValueChange={setSelected} options={choices.map(item => ({ value: item.path, label: `${item.name} · ${item.source}` }))} /></div><Button disabled={!selected} onClick={() => { const item = choices.find(value => value.path === selected); if (item) onChange([...refs, { id: item.id, path: item.path, sha256: item.sha256 }]); setSelected(''); }}><Plus />Thêm</Button></div>}
  </div>;
}

// Published profile versions never change, so their skill lists are fetched once per page.
const versionSkills = new Map<string, Promise<Ref[] | null>>();
function profileVersionSkills(profileId: string, version: number): Promise<Ref[] | null> {
  const key = `${profileId}@${version}`;
  let pending = versionSkills.get(key);
  if (!pending) {
    pending = api<{ version: Profile }>(`/api/profiles/${encodeURIComponent(profileId)}/versions/${version}`).then(data => data.version.skills, () => null);
    versionSkills.set(key, pending);
  }
  return pending;
}
/** Skills each agent version pins, keyed `profileId@version`; null when the version cannot be read. */
export function useProfileSkills(keys: string[]): Record<string, Ref[] | null> {
  const [skills, setSkills] = useState<Record<string, Ref[] | null>>({}), joined = [...new Set(keys)].sort().join('|');
  useEffect(() => {
    let live = true;
    void Promise.all(joined.split('|').filter(Boolean).map(async key => { const at = key.lastIndexOf('@'); return [key, await profileVersionSkills(key.slice(0, at), Number(key.slice(at + 1)))] as const; }))
      .then(entries => { if (live) setSkills(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [joined]);
  return skills;
}
type SkillHolder = { profileId?: string | undefined; profileVersion?: number | undefined; skillsOverride?: Ref[] | undefined };
/** Every agent (profile version) a flow's steps use, for useProfileSkills. */
export function flowProfileKeys(flow: Flow | null): string[] {
  return (flow?.definition.nodes ?? []).flatMap(node => node.type === 'review_group' ? node.reviewers.map(item => `${item.profileId}@${item.profileVersion}`)
    : (node.type === 'agent_task' || node.type === 'integration') && node.profileId && node.profileVersion ? [`${node.profileId}@${node.profileVersion}`] : []);
}
/** Skills a step will receive: its own list when set, otherwise its agent's. Undefined while the agent is loading. */
export function stepSkills(holder: SkillHolder, profiles: Record<string, Ref[] | null>): Ref[] | undefined {
  if (holder.skillsOverride) return holder.skillsOverride;
  if (!holder.profileId || !holder.profileVersion) return [];
  return profiles[`${holder.profileId}@${holder.profileVersion}`] ?? undefined;
}
/** Skill count of a canvas card: every reviewer of a review group counts. */
export function nodeSkillCount(node: Flow['definition']['nodes'][number], profiles: Record<string, Ref[] | null>): number {
  if (node.type === 'review_group') return new Set(node.reviewers.flatMap(reviewer => (stepSkills(reviewer, profiles) ?? []).map(ref => ref.path))).size;
  if (node.type === 'agent_task' || node.type === 'integration') return stepSkills(node, profiles)?.length ?? 0;
  return 0;
}

/**
 * The step's skills, shown in the inspector's main section. "Theo agent" lists the agent version's skills (read-only);
 * "Riêng cho bước này" writes `skillsOverride`, which replaces the agent's list for this step only.
 */
export function StepSkills({ holder, label = 'Skills', onChange, onOpenSkills }: { holder: SkillHolder; label?: string; onChange(refs: Ref[] | undefined): void; onOpenSkills?: (() => void) | undefined }) {
  const keys = useMemo(() => holder.profileId && holder.profileVersion ? [`${holder.profileId}@${holder.profileVersion}`] : [], [holder.profileId, holder.profileVersion]);
  const inherited = useProfileSkills(keys)[keys[0] ?? ''], own = holder.skillsOverride !== undefined;
  const mode = (value: boolean, text: string) => <button type="button" role="radio" aria-checked={own === value} onClick={() => { if (own !== value) onChange(value ? structuredClone(inherited ?? []) : undefined); }}
    className={`h-6 flex-auto cursor-pointer whitespace-nowrap rounded border-0 px-2 font-sans text-[11.5px] ${own === value ? 'bg-background font-semibold text-foreground shadow-sm' : 'bg-transparent text-muted-foreground hover:text-foreground'}`}>{text}</button>;
  return <div className="step-skills my-2">
    <div className="mb-1.5 flex items-center gap-2"><strong className="text-[12px]">{label}</strong>{onOpenSkills && <button type="button" className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[11.5px] text-muted-foreground underline hover:text-foreground" onClick={onOpenSkills}>Sửa nội dung skill</button>}</div>
    <div role="radiogroup" aria-label={`${label}: nguồn`} className="mb-2 flex gap-0.5 rounded-md bg-muted p-0.5">{mode(false, 'Theo agent')}{mode(true, 'Riêng cho bước này')}</div>
    {!own ? <div className="flex flex-wrap gap-1.5">
      {inherited === undefined ? <span className="text-[12px] text-muted-foreground">Đang tải skill của agent…</span>
        : inherited === null ? <span className="text-[12px] text-muted-foreground">Không đọc được agent {holder.profileId} v{holder.profileVersion}.</span>
        : inherited.length ? inherited.map(ref => <span key={ref.path} className="rounded-full border border-dashed px-2 py-0.5 text-[11.5px] text-muted-foreground" title={ref.path}>{ref.id}</span>)
        : <span className="text-[12px] text-muted-foreground">Agent {holder.profileId} v{holder.profileVersion} không ghim skill nào.</span>}
    </div> : <><p className="mb-2 mt-0 text-[11.5px] text-muted-foreground">Danh sách này thay cho skill của agent ở bước này.</p><SkillPicker refs={holder.skillsOverride!} onChange={onChange} /></>}
  </div>;
}
