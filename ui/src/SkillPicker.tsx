import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Profile } from '../../src/domain/schema';
import { api } from './api';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Select } from './components/ui/select';

type Ref = Profile['skills'][number];
type Catalog = Ref & { name: string; description: string; source: string };
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
    {refs.map((ref, index) => { const item = catalog.find(skill => skill.path === ref.path), status = statuses.find(value => value.path === ref.path && value.id === ref.id);
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

export function SkillOverride({ refs, onChange }: { refs: Ref[] | undefined; onChange(refs: Ref[] | undefined): void }) {
  return <div className="my-3"><strong className="text-[12px]">Skills của bước</strong>
    {refs === undefined ? <p className="my-2 text-[12px] text-muted-foreground">Kế thừa từ profile.</p> : <SkillPicker refs={refs} onChange={onChange} />}
    <Button className="mt-2" size="sm" onClick={() => onChange(refs === undefined ? [] : undefined)}>{refs === undefined ? 'Chọn riêng' : 'Dùng skill của profile'}</Button>
  </div>;
}
