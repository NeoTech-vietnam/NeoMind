import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Ellipsis, Lock, Plus, Search, Trash2 } from 'lucide-react';
import type { Flow, Profile } from '../../src/domain/schema';
import { api } from './api';
import { askText, confirmAction } from './dialog';
import { Button } from './components/ui/button';
import { Tag } from './components/ui/badge';
import { Field, Input, Textarea } from './components/ui/input';
import { Select } from './components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogActions, DialogContent } from './components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Callout, EmptyState } from './components/ui/misc';

type Metadata = { profileId: string; name: string; archived: boolean };
type Use = { flowId: string; flowName: string; nodeId: string; nodeName: string; profileId: string; version: number };
type Template = 'implementer' | 'verifier';
const permissions: { key: keyof Profile['requestedPermissions']; label: string; description: string }[] = [
  { key: 'read', label: 'Đọc file', description: 'Cho phép agent đọc file trong workspace.' },
  { key: 'write', label: 'Sửa file', description: 'Cho phép agent sửa file trong phạm vi được duyệt.' },
  { key: 'checks', label: 'Chạy checks', description: 'Cho phép agent đề xuất các lệnh kiểm tra.' },
  { key: 'gitCommit', label: 'Commit local', description: 'Cho phép agent đề xuất commit trong workspace.' },
];
const listClass = 'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[12.5px] text-fg-2 hover:bg-accent';

export function ProfilePanel() {
  const revision = useRef<string | undefined>(undefined);
  const [profiles, setProfiles] = useState<Metadata[]>([]), [builtins, setBuiltins] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null), [original, setOriginal] = useState(''), [builtin, setBuiltin] = useState(false);
  const [versions, setVersions] = useState<number[]>([]), [usage, setUsage] = useState<Use[]>([]), [usageError, setUsageError] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false), [id, setId] = useState(''), [name, setName] = useState(''), [template, setTemplate] = useState<Template>('implementer');
  const [archivedOpen, setArchivedOpen] = useState(false), [outputOpen, setOutputOpen] = useState(false), [output, setOutput] = useState('{}');
  const metadata = profiles.find(item => item.profileId === profile?.profileId);
  const dirty = !!profile && !builtin && (JSON.stringify(profile) !== original || output !== JSON.stringify(profile.outputDefaults, null, 2));
  const refresh = useCallback(async () => { const data = await api<{ profiles: Metadata[]; builtins: Profile[] }>('/api/profiles'); setProfiles(data.profiles); setBuiltins(data.builtins); return data; }, []);
  const loadUsage = useCallback(async () => {
    try {
      const bootstrap = await api<{ flows: { flowId: string; name: string }[] }>('/api/bootstrap');
      const drafts = await Promise.all(bootstrap.flows.map(async item => ({ meta: item, flow: (await api<{ draft: Flow }>(`/api/flows/${encodeURIComponent(item.flowId)}/draft`)).draft })));
      const complete = drafts.flatMap(({ meta, flow }) => flow.definition.nodes.flatMap(node => {
        const common = { flowId: meta.flowId, flowName: meta.name, nodeId: node.id, nodeName: node.label };
        if ((node.type === 'agent_task' || node.type === 'integration') && node.profileId && node.profileVersion) return [{ ...common, profileId: node.profileId, version: node.profileVersion }];
        if (node.type === 'review_group') return node.reviewers.map(reviewer => ({ ...common, nodeName: `${node.label} · ${reviewer.id}`, profileId: reviewer.profileId, version: reviewer.profileVersion }));
        return [];
      }));
      setUsage(complete); setUsageError('');
    } catch (e) { setUsageError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void refresh().then(async data => { const first = data.profiles.find(item => !item.archived); if (first) await openProject(first.profileId); else if (data.builtins[0]) openBuiltin(data.builtins[0]); }).catch(e => setError(String(e))); void loadUsage(); }, [refresh, loadUsage]);
  function applyProfile(next: Profile, isBuiltin: boolean) { setProfile(next); setOriginal(JSON.stringify(next)); setOutput(JSON.stringify(next.outputDefaults, null, 2)); setBuiltin(isBuiltin); setOutputOpen(false); }
  async function canLeave() { return !dirty || confirmAction({ title: 'Bỏ thay đổi chưa lưu?', description: 'Các thay đổi chưa lưu của profile sẽ bị bỏ.', confirmLabel: 'Bỏ thay đổi', danger: true }); }
  async function openProject(profileId: string) {
    const data = await api<{ draft: Profile; revision: string }>(`/api/profiles/${encodeURIComponent(profileId)}/draft`);
    const saved = await api<{ versions: number[] }>(`/api/profiles/${encodeURIComponent(profileId)}/versions`);
    revision.current = data.revision; applyProfile(data.draft, false); setVersions(saved.versions);
  }
  function openBuiltin(item: Profile) { revision.current = undefined; applyProfile(structuredClone(item), true); setVersions([item.version]); }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function save() {
    if (!profile || builtin) return undefined;
    const defaults = JSON.parse(output) as Profile['outputDefaults'];
    if (!defaults || Array.isArray(defaults) || typeof defaults !== 'object') throw new Error('Output mặc định phải là một JSON object.');
    const draft = { ...profile, outputDefaults: defaults };
    const result = await api<{ revision: string }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/draft`, 'PUT', { draft, ...(revision.current ? { expectedRevision: revision.current } : {}) });
    revision.current = result.revision; applyProfile(draft, false); return result.revision;
  }
  async function clone() {
    if (!profile) return;
    const targetId = await askText({ title: 'Nhân bản profile', label: 'ID profile mới', confirmLabel: 'Nhân bản' });
    if (!targetId?.trim()) return;
    await action(async () => {
      if (builtin) await api('/api/profiles', 'POST', { id: targetId.trim(), name: `${profile.name} copy`, template: profile.profileId });
      else { if (dirty) await save(); await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/clone`, 'POST', { targetId: targetId.trim(), name: `${metadata?.name ?? profile.name} copy` }); }
      await openProject(targetId.trim()); setMessage('Đã tạo bản nháp profile.');
    });
  }
  const uses = usage.filter(item => item.profileId === profile?.profileId);
  const visible = profiles.filter(item => `${item.name} ${item.profileId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const edit = (change: (value: Profile) => void) => setProfile(current => { if (!current || builtin) return current; const next = structuredClone(current); change(next); return next; });
  return <section className="p4-page"><div className="p4-heading"><div><h1>Agent profiles</h1><p>Tái sử dụng hướng dẫn, quyền và skills giữa các flow.</p></div><Button onClick={() => void canLeave().then(ok => { if (ok) { setId(''); setName(''); setCreateOpen(true); } })}><Plus />Tạo profile</Button></div>
    {error && <Callout tone="danger">{error}</Callout>}{message && <Callout tone="success">{message}</Callout>}
    <div className="p4-profile-layout"><aside className="p4-profile-list"><div className="relative"><Search className="absolute left-2 top-2 size-4 text-muted-foreground" /><Input aria-label="Tìm profile" className="pl-8" placeholder="Tìm theo tên hoặc ID" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <p className="p4-caption">CÓ SẴN</p>{builtins.filter(item => `${item.name} ${item.profileId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <button key={item.profileId} className={listClass} onClick={() => void canLeave().then(ok => { if (ok) openBuiltin(item); })}><Lock className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1"><strong className="block truncate">{item.name}</strong><small className="text-muted-foreground">Nhân bản để có bản riêng</small></span></button>)}
      <p className="p4-caption">CỦA PROJECT</p>{visible.filter(item => !item.archived).map(item => <button key={item.profileId} className={`${listClass} ${!builtin && profile?.profileId === item.profileId ? 'bg-accent' : ''}`} onClick={() => void canLeave().then(ok => { if (ok) void action(() => openProject(item.profileId)); })}><span className="min-w-0 flex-1"><strong className="block truncate">{item.name}</strong><small className="text-muted-foreground">{item.profileId}</small></span></button>)}
      {visible.some(item => item.archived) && <><Button variant="ghost" className="mt-3 w-full justify-start" onClick={() => setArchivedOpen(!archivedOpen)}><ChevronDown />Đã lưu trữ</Button>{archivedOpen && visible.filter(item => item.archived).map(item => <button key={item.profileId} className={listClass} onClick={() => void canLeave().then(ok => { if (ok) void action(() => openProject(item.profileId)); })}>{item.name}</button>)}</>}
    </aside><div className="p4-profile-detail">{!profile ? <EmptyState title="Chọn profile">Chọn profile có sẵn hoặc tạo profile cho project.</EmptyState> : <>
      <div className="p4-detail-header"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="m-0 truncate text-[16px] font-semibold">{metadata?.name ?? profile.name}</h2><DropdownMenu><DropdownMenuTrigger asChild><Button size="sm">{builtin ? 'Có sẵn' : versions.length ? `v${versions.at(-1)}` : 'Bản nháp'}<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent>{versions.length ? versions.map(v => <DropdownMenuItem key={v} disabled>v{v}</DropdownMenuItem>) : <DropdownMenuItem disabled>Chưa lưu phiên bản</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div><p className="m-0 mt-1 text-[11px] text-muted-foreground">{profile.profileId} · {builtin ? 'profile có sẵn' : 'profile của project'}{dirty ? ' · Đã sửa, chưa lưu' : ''}</p></div>
        <Button disabled={busy} onClick={() => void clone()}><Copy />Nhân bản</Button>{!builtin && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Quản lý profile"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent>
          <DropdownMenuItem onSelect={() => void askText({ title: 'Đổi tên profile', label: 'Tên mới', initial: metadata?.name ?? profile.name, confirmLabel: 'Đổi tên' }).then(value => { if (value?.trim()) void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/rename`, 'POST', { name: value.trim() }); }); })}>Đổi tên</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/${metadata?.archived ? 'restore' : 'archive'}`, 'POST'); })}>{metadata?.archived ? 'Khôi phục' : 'Lưu trữ'}</DropdownMenuItem><DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => void askText({ title: `Xóa vĩnh viễn profile ${metadata?.name ?? profile.name}?`, description: 'Nhập chính xác tên profile để xác nhận.', label: 'Tên profile', confirmLabel: 'Xóa vĩnh viễn', danger: true }).then(confirmedName => { if (confirmedName) void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/delete`, 'POST', { confirmedName }); setProfile(null); }); })}>Xóa vĩnh viễn</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>}{!builtin && (dirty || !versions.length) && <Button variant="primary" disabled={busy || metadata?.archived} onClick={() => void action(async () => { const expectedRevision = await save(); const result = await api<{ version: { version: number } }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/publish`, 'POST', { expectedRevision }); await openProject(profile.profileId); setMessage(`Đã lưu phiên bản ${result.version.version}.`); })}>Lưu phiên bản mới</Button>}
      </div><Tabs defaultValue="instructions"><TabsList className="px-5 pt-2"><TabsTrigger value="instructions">Hướng dẫn</TabsTrigger><TabsTrigger value="permissions">Quyền</TabsTrigger><TabsTrigger value="skills">Skills</TabsTrigger>{!usageError && <TabsTrigger value="usage">Được dùng ở</TabsTrigger>}</TabsList>
        <TabsContent value="instructions" className="p4-tab"><Field label="Gửi kèm mỗi bước dùng profile này"><Textarea aria-label="Hướng dẫn" rows={14} disabled={builtin} value={profile.instructions} onChange={e => edit(next => { next.instructions = e.target.value; })} /></Field><Button variant="ghost" className="mt-4" onClick={() => setOutputOpen(!outputOpen)}><ChevronDown />Output mặc định</Button>{outputOpen && <Textarea aria-label="Output mặc định" rows={5} disabled={builtin} value={output} onChange={e => setOutput(e.target.value)} />}</TabsContent>
        <TabsContent value="permissions" className="p4-tab">{permissions.map(item => <label key={item.key} className="p4-permission"><span className="flex-1"><strong>{item.label}</strong><small>{item.description}</small></span><input type="checkbox" disabled={builtin} checked={profile.requestedPermissions[item.key]} onChange={e => edit(next => { next.requestedPermissions[item.key] = e.target.checked; })} /></label>)}</TabsContent>
        <TabsContent value="skills" className="p4-tab"><p className="text-muted-foreground">Skills được ghim bằng SHA-256; nội dung được xác minh khi chạy.</p>{profile.skills.map((skill, index) => <div className="p4-skill" key={index}><Field label="ID"><Input disabled={builtin} value={skill.id} onChange={e => edit(next => { next.skills[index]!.id = e.target.value; })} /></Field><Field label="Đường dẫn"><Input disabled={builtin} value={skill.path} onChange={e => edit(next => { next.skills[index]!.path = e.target.value; })} /></Field><Field label="SHA-256"><Input disabled={builtin} value={skill.sha256} onChange={e => edit(next => { next.skills[index]!.sha256 = e.target.value; })} /></Field>{!builtin && <Button variant="ghost" size="icon" aria-label="Xóa skill" onClick={() => edit(next => { next.skills.splice(index, 1); })}><Trash2 /></Button>}</div>)}{!builtin && <Button onClick={() => edit(next => { next.skills.push({ id: '', path: '', sha256: '' }); })}><Plus />Thêm skill</Button>}</TabsContent>
        {!usageError && <TabsContent value="usage" className="p4-tab">{uses.length ? uses.map((item, index) => <div className="border-b py-3" key={`${item.flowId}-${item.nodeId}-${index}`}><strong>{item.flowName}</strong> › {item.nodeName} <Tag>v{item.version}</Tag></div>) : <p className="text-muted-foreground">Chưa có bước nào dùng profile này.</p>}</TabsContent>}
      </Tabs>{!builtin && dirty && <div className="border-t p-4"><Button disabled={busy} onClick={() => void action(async () => { await save(); setMessage('Đã lưu bản nháp.'); })}>Lưu nháp</Button></div>}</>}</div></div>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent title="Tạo profile" description="Bắt đầu từ một mẫu có sẵn."><form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/api/profiles', 'POST', { id, name, template }); await openProject(id); setCreateOpen(false); }); }} className="mt-4 flex flex-col gap-3"><Field label="ID"><Input required value={id} onChange={e => setId(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></Field><Field label="Tên"><Input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="Mẫu"><Select label="Mẫu profile" value={template} onValueChange={value => setTemplate(value as Template)} options={[{ value: 'implementer', label: 'Implementer' }, { value: 'verifier', label: 'Verifier · chỉ đọc' }]} /></Field><DialogActions><Button variant="ghost" onClick={() => setCreateOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy}>Tạo bản nháp</Button></DialogActions></form></DialogContent></Dialog>
  </section>;
}
