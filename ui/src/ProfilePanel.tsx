import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Copy, Ellipsis, Lock, Plus, Search } from 'lucide-react';
import type { Flow, Profile } from '../../src/domain/schema';
import { api } from './api';
import { askText, confirmAction } from './dialog';
import { Button } from './components/ui/button';
import { Tag } from './components/ui/badge';
import { Field, Input, Textarea } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogActions, DialogContent, SheetContent } from './components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Callout, EmptyState } from './components/ui/misc';
import { cn } from './lib/utils';
import { SkillPicker } from './SkillPicker';

type Metadata = { profileId: string; name: string; archived: boolean };
type Use = { flowId: string; flowName: string; nodeId: string; nodeName: string; profileId: string; version: number };
type Template = { id: string; label: string; description: string; instructions: string; reviewer: boolean; suggestedSkills: string[]; requestedPermissions: Profile['requestedPermissions'] };
type ProfileFlowUse = { flowId: string; name: string; archived: boolean; revision: string | null; draftValid: boolean; draft: { nodeId: string; label: string; version: number }[]; published: { nodeId: string; label: string; version: number }[]; publishedVersion: number | null; builtin?: boolean };
const permissions: { key: keyof Profile['requestedPermissions']; label: string; description: string }[] = [
  { key: 'read', label: 'Đọc file', description: 'Cho phép agent đọc file trong workspace.' },
  { key: 'write', label: 'Sửa file', description: 'Cho phép agent sửa file trong phạm vi được duyệt.' },
  { key: 'checks', label: 'Chạy checks', description: 'Cho phép agent đề xuất các lệnh kiểm tra.' },
  { key: 'gitCommit', label: 'Commit local', description: 'Cho phép agent đề xuất commit trong workspace.' },
];
const listClass = 'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[12.5px] text-fg-2 hover:bg-accent';

/** Agents screen (profiles in code and API): instructions, permissions and pinned skills reused by flow steps. */
export function ProfilePanel({ onOpenSkill }: { onOpenSkill?: ((id?: string, source?: 'neomind' | 'claude') => void) | undefined } = {}) {
  const revision = useRef<string | undefined>(undefined);
  const [profiles, setProfiles] = useState<Metadata[]>([]), [builtins, setBuiltins] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null), [original, setOriginal] = useState(''), [builtin, setBuiltin] = useState(false);
  const [versions, setVersions] = useState<number[]>([]), [usage, setUsage] = useState<Use[]>([]), [usageError, setUsageError] = useState('');
  const [listVersions, setListVersions] = useState<Record<string, number | null | undefined>>({});
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false), [id, setId] = useState(''), [name, setName] = useState(''), [template, setTemplate] = useState('implementer'), [templates, setTemplates] = useState<Template[]>([]);
  const [outdated, setOutdated] = useState<{ version: number; flows: ProfileFlowUse[] } | null>(null), [removal, setRemoval] = useState<{ flows: ProfileFlowUse[] } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false), [outputOpen, setOutputOpen] = useState(false), [output, setOutput] = useState('{}');
  const [viewed, setViewed] = useState<Profile | null>(null), [migrationOpen, setMigrationOpen] = useState(false), [migrationVersion, setMigrationVersion] = useState(0), [migrationFlows, setMigrationFlows] = useState<ProfileFlowUse[]>([]), [selectedFlows, setSelectedFlows] = useState<string[]>([]), [migrationError, setMigrationError] = useState('');
  const metadata = builtin ? undefined : profiles.find(item => item.profileId === profile?.profileId);
  const dirty = !!profile && !builtin && (JSON.stringify(profile) !== original || output !== JSON.stringify(profile.outputDefaults, null, 2));
  const refresh = useCallback(async () => { const data = await api<{ profiles: Metadata[]; builtins: Profile[] }>('/api/profiles'); setProfiles(data.profiles); setBuiltins(data.builtins); const pairs = await Promise.all(data.profiles.map(async item => { try { const result = await api<{ versions: number[] }>(`/api/profiles/${encodeURIComponent(item.profileId)}/versions`); return [item.profileId, result.versions.at(-1) ?? null] as const; } catch { return [item.profileId, undefined] as const; } })); setListVersions(Object.fromEntries(pairs)); return data; }, []);
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
  useEffect(() => { void api<{ templates: Template[] }>('/api/profile-templates').then(data => setTemplates(data.templates)).catch(() => {}); }, []);
  useEffect(() => { void refresh().then(async data => { const first = data.profiles.find(item => !item.archived); if (first) await openProject(first.profileId); else if (data.builtins[0]) openBuiltin(data.builtins[0]); }).catch(e => setError(String(e))); void loadUsage(); }, [refresh, loadUsage]);
  function applyProfile(next: Profile, isBuiltin: boolean) { setProfile(next); setOriginal(JSON.stringify(next)); setOutput(JSON.stringify(next.outputDefaults, null, 2)); setBuiltin(isBuiltin); setOutputOpen(false); }
  async function canLeave() { return !dirty || confirmAction({ title: 'Bỏ thay đổi chưa lưu?', description: 'Các thay đổi chưa lưu của agent sẽ bị bỏ.', confirmLabel: 'Bỏ thay đổi', danger: true }); }
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
    const targetId = await askText({ title: 'Nhân bản agent', label: 'ID agent mới', confirmLabel: 'Nhân bản' });
    if (!targetId?.trim()) return;
    await action(async () => {
      if (builtin) await api('/api/profiles', 'POST', { id: targetId.trim(), name: `${profile.name} copy`, template: profile.profileId });
      else { if (dirty) await save(); await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/clone`, 'POST', { targetId: targetId.trim(), name: `${metadata?.name ?? profile.name} copy` }); }
      await openProject(targetId.trim()); setMessage('Đã tạo bản nháp agent.');
    });
  }
  async function showVersion(version: number) {
    if (!profile) return;
    await action(async () => { const data = await api<{ version: Profile }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/versions/${version}`); setViewed(data.version); });
  }
  async function prepareMigration(version: number) {
    if (!profile) return;
    await action(async () => { const data = await api<{ flows: ProfileFlowUse[] }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/usage`); setMigrationFlows(data.flows); setSelectedFlows([]); setMigrationError(''); setMigrationVersion(version); setViewed(null); setMigrationOpen(true); });
  }
  async function migrate() {
    if (!profile) return;
    await action(async () => {
      const flows = migrationFlows.filter(item => selectedFlows.includes(item.flowId) && item.revision !== null).map(item => ({ flowId: item.flowId, expectedRevision: item.revision! }));
      const result = await api<{ results: { flowId: string; error?: string; changed?: number }[] }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/migrate`, 'POST', { version: migrationVersion, flows });
      const errors = result.results.filter(item => item.error); await loadUsage();
      if (errors.length) { const refreshed = await api<{ flows: ProfileFlowUse[] }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/usage`); setMigrationFlows(refreshed.flows); setSelectedFlows([]); setMigrationError(`${errors.map(item => `${item.flowId}: ${item.error}`).join('; ')}. Xem lại draft và chọn lại flow.`); return; }
      setMigrationOpen(false); setViewed(null); setMessage(`Đã cập nhật ${result.results.length} draft flow; chưa publish flow.`);
    });
  }
  /** "Lưu": save the draft and publish it as a new version, then offer to move flows still on an older version. */
  async function saveAndPublish() {
    if (!profile) return;
    await action(async () => {
      const expectedRevision = await save();
      const result = await api<{ version: { version: number } }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/publish`, 'POST', { expectedRevision, author: { kind: 'human' } });
      await openProject(profile.profileId); setMessage(`Đã lưu phiên bản ${result.version.version}.`);
      const usage = await api<{ flows: ProfileFlowUse[] }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/usage`);
      const older = usage.flows.filter(item => !item.builtin && item.draftValid && item.revision && item.draft.some(ref => ref.version < result.version.version));
      setOutdated(older.length ? { version: result.version.version, flows: older } : null);
    });
  }
  async function updateFlows() {
    if (!profile || !outdated) return;
    await action(async () => {
      const result = await api<{ results: { flowId: string; error?: string; changed?: number }[] }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/migrate`, 'POST', { version: outdated.version, flows: outdated.flows.map(item => ({ flowId: item.flowId, expectedRevision: item.revision! })) });
      const errors = result.results.filter(item => item.error); await loadUsage(); setOutdated(null);
      if (errors.length) setError(`${errors.map(item => `${item.flowId}: ${item.error}`).join('; ')}. Mở flow để cập nhật bằng tay.`);
      setMessage(`Đã chuyển ${result.results.length - errors.length} flow sang v${outdated.version} (bản nháp). Lưu flow để run mới dùng bản này.`);
    });
  }
  async function prepareRemoval() {
    if (!profile) return;
    await action(async () => { const data = await api<{ flows: ProfileFlowUse[] }>(`/api/profiles/${encodeURIComponent(profile.profileId)}/usage`); setRemoval({ flows: data.flows.filter(item => !item.builtin && (item.draft.length || item.published.length)) }); });
  }
  async function removeAgent(archive: boolean) {
    if (!profile) return;
    await action(async () => {
      if (archive) { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/set-archived`, 'POST', { archived: true }); setMessage(`Đã lưu trữ ${metadata?.name ?? profile.name}; các flow đang dùng vẫn chạy được.`); }
      else { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/remove`, 'POST', {}); setProfile(null); setMessage('Đã xóa agent.'); }
      setRemoval(null);
    });
  }
  const uses = builtin && profiles.some(item => item.profileId === profile?.profileId) ? [] : usage.filter(item => item.profileId === profile?.profileId);
  const visible = profiles.filter(item => `${item.name} ${item.profileId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const edit = (change: (value: Profile) => void) => setProfile(current => { if (!current || builtin) return current; const next = structuredClone(current); change(next); return next; });
  return <section className="library-page"><div className="library-heading"><div><h1>Agents</h1><p>Agent gồm hướng dẫn, quyền và skill; các bước của flow dùng lại một phiên bản agent.</p></div><Button variant="primary" onClick={() => void canLeave().then(ok => { if (ok) { setId(''); setName(''); setTemplate('implementer'); setCreateOpen(true); } })}><Plus />Agent mới</Button></div>
    {error && <Callout tone="danger">{error}</Callout>}{message && <Callout tone="success">{message}</Callout>}
    <div className="profiles-layout"><aside className="profiles-list"><div className="relative"><Search className="absolute left-2 top-2 size-4 text-muted-foreground" /><Input aria-label="Tìm agent" className="pl-8" placeholder="Tìm theo tên hoặc ID" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <p className="profiles-caption">CÓ SẴN</p>{builtins.filter(item => `${item.name} ${item.profileId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <button key={item.profileId} className={cn(listClass, builtin && profile?.profileId === item.profileId && 'bg-accent')} onClick={() => void canLeave().then(ok => { if (ok) openBuiltin(item); })}><Lock className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1"><strong className="block truncate">{item.profileId === 'verifier' ? 'Verifier' : item.name}</strong><small className="text-muted-foreground">Nhân bản để có bản riêng</small></span></button>)}
      <p className="profiles-caption">CỦA PROJECT</p>{visible.filter(item => !item.archived).map(item => <button key={item.profileId} className={cn(listClass, !builtin && profile?.profileId === item.profileId && 'bg-accent')} onClick={() => void canLeave().then(ok => { if (ok) void action(() => openProject(item.profileId)); })}><span className="min-w-0 flex-1"><strong className="block truncate">{item.name}</strong><small className="text-muted-foreground">{listVersions[item.profileId] === undefined ? 'Chưa tải phiên bản' : listVersions[item.profileId] === null ? 'Bản nháp' : `v${listVersions[item.profileId]}`}{!usageError ? ` · ${new Set(usage.filter(use => use.profileId === item.profileId).map(use => `${use.flowId}/${use.nodeId}`)).size} bước dùng` : ''}</small></span></button>)}
      {visible.some(item => item.archived) && <><Button variant="ghost" className="mt-3 w-full justify-start" onClick={() => setArchivedOpen(!archivedOpen)}><ChevronDown />Đã lưu trữ</Button>{archivedOpen && visible.filter(item => item.archived).map(item => <button key={item.profileId} className={listClass} onClick={() => void canLeave().then(ok => { if (ok) void action(() => openProject(item.profileId)); })}>{item.name}</button>)}</>}
    </aside><div className="profiles-detail">{!profile ? <EmptyState title="Chọn agent">Chọn agent có sẵn hoặc tạo agent cho project.</EmptyState> : <>
      <div className="profiles-detail-header"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="m-0 truncate text-[16px] font-semibold">{metadata?.name ?? profile.name}</h2><DropdownMenu><DropdownMenuTrigger asChild><Button size="sm">{builtin ? 'Có sẵn' : versions.length ? `v${versions.at(-1)}` : 'Bản nháp'}<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent>{versions.length ? versions.map(v => <DropdownMenuItem key={v} onSelect={() => void showVersion(v)}>v{v} · xem chỉ đọc</DropdownMenuItem>) : <DropdownMenuItem disabled>Chưa lưu phiên bản</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div><p className="m-0 mt-1 text-[11px] text-muted-foreground">{profile.profileId} · {builtin ? 'agent có sẵn' : 'agent của project'}{dirty ? ' · Đã sửa, chưa lưu' : ''}</p></div>
        <Button disabled={busy} onClick={() => void clone()}><Copy />Nhân bản</Button>{!!versions.length && <Button disabled={busy} onClick={() => void prepareMigration(versions.at(-1)!)}>Chuyển flow sang bản này</Button>}{!builtin && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Quản lý agent"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent>
          <DropdownMenuItem disabled={!dirty} onSelect={() => void action(async () => { await save(); setMessage('Đã lưu bản nháp (chưa có phiên bản mới).'); })}>Lưu nháp</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void askText({ title: 'Đổi tên agent', label: 'Tên mới', initial: metadata?.name ?? profile.name, confirmLabel: 'Đổi tên' }).then(value => { if (value?.trim()) void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/rename`, 'POST', { name: value.trim() }); }); })}>Đổi tên</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void action(async () => { await api(`/api/profiles/${encodeURIComponent(profile.profileId)}/${metadata?.archived ? 'restore' : 'archive'}`, 'POST'); })}>{metadata?.archived ? 'Khôi phục' : 'Lưu trữ'}</DropdownMenuItem><DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => void prepareRemoval()}>Xóa agent…</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>}{!builtin && <Button variant="primary" disabled={busy || metadata?.archived || !(dirty || !versions.length)} onClick={() => void saveAndPublish()}>Lưu</Button>}
      </div>{outdated && <Callout tone="attention" className="mx-5 mt-4"><div className="flex flex-wrap items-center gap-3"><span className="flex-1">{outdated.flows.length} flow vẫn dùng bản cũ của agent này: {outdated.flows.map(item => item.name).join(', ')}.</span><Button size="sm" disabled={busy} onClick={() => void updateFlows()}>Cập nhật các flow</Button><Button size="sm" variant="ghost" onClick={() => setOutdated(null)}>Để sau</Button></div></Callout>}<Tabs defaultValue="instructions"><TabsList className="px-5 pt-2"><TabsTrigger value="instructions">Hướng dẫn</TabsTrigger><TabsTrigger value="permissions">Quyền</TabsTrigger><TabsTrigger value="skills">Skills</TabsTrigger>{!usageError && <TabsTrigger value="usage">Được dùng ở</TabsTrigger>}</TabsList>
        <TabsContent value="instructions" className="profiles-tab"><Field label="Gửi kèm mỗi bước dùng agent này"><Textarea aria-label="Hướng dẫn" rows={14} disabled={builtin} value={profile.instructions} onChange={e => edit(next => { next.instructions = e.target.value; })} /></Field><Button variant="ghost" className="mt-4" onClick={() => setOutputOpen(!outputOpen)}><ChevronDown />Output mặc định</Button>{outputOpen && <Textarea aria-label="Output mặc định" rows={5} disabled={builtin} value={output} onChange={e => setOutput(e.target.value)} />}</TabsContent>
        <TabsContent value="permissions" className="profiles-tab">{permissions.map(item => <label key={item.key} className="profiles-permission"><span className="flex-1"><strong>{item.label}</strong><small>{item.description}</small></span><input type="checkbox" disabled={builtin} checked={profile.requestedPermissions[item.key]} onChange={e => edit(next => { next.requestedPermissions[item.key] = e.target.checked; })} /></label>)}</TabsContent>
        <TabsContent value="skills" className="profiles-tab"><div className="mb-3 flex items-start gap-3"><p className="m-0 flex-1 text-muted-foreground">Skills được ghim bằng SHA-256; nội dung được xác minh khi chạy. Bước nào chọn skill riêng thì không nhận các skill này.</p>{onOpenSkill && <Button size="sm" variant="ghost" onClick={() => onOpenSkill()}><BookOpen />Mở màn Skills</Button>}</div><SkillPicker refs={profile.skills} readOnly={builtin} onChange={skills => edit(next => { next.skills = skills; })} /></TabsContent>
        {!usageError && <TabsContent value="usage" className="profiles-tab">{uses.length ? uses.map((item, index) => <div className="border-b py-3" key={`${item.flowId}-${item.nodeId}-${index}`}><strong>{item.flowName}</strong> › {item.nodeName} <Tag>v{item.version}</Tag></div>) : <p className="text-muted-foreground">Chưa có bước nào dùng agent này.</p>}</TabsContent>}
      </Tabs></>}</div></div>
    <Dialog open={!!viewed} onOpenChange={open => { if (!open) setViewed(null); }}><SheetContent title={viewed ? `${viewed.name} · v${viewed.version}` : 'Phiên bản profile'} description="Phiên bản đã lưu · chỉ đọc">{viewed && <div className="flex flex-col gap-4 p-4"><Field label="Hướng dẫn"><Textarea readOnly rows={10} value={viewed.instructions} /></Field><div><strong>Quyền</strong>{permissions.map(item => <p key={item.key}>{item.label}: {viewed.requestedPermissions[item.key] ? 'Có' : 'Không'}</p>)}</div><SkillPicker refs={viewed.skills} readOnly onChange={() => {}} /><Button onClick={() => void prepareMigration(viewed.version)}>Chuyển flow sang bản này</Button></div>}</SheetContent></Dialog>
    <Dialog open={migrationOpen} onOpenChange={setMigrationOpen}><DialogContent title="Chuyển flow sang phiên bản profile" description={`Chỉ cập nhật draft sang v${migrationVersion}; phiên bản flow đã lưu không thay đổi.`}>{migrationError && <Callout tone="danger">{migrationError}</Callout>}<div className="mt-3 max-h-72 overflow-auto">{migrationFlows.filter(item => item.draft.length || item.published.length).map(item => <label key={item.flowId} className="flex items-start gap-2 border-b py-2"><input type="checkbox" disabled={!item.draftValid || !item.draft.length} checked={selectedFlows.includes(item.flowId)} onChange={event => setSelectedFlows(current => event.target.checked ? [...current, item.flowId] : current.filter(id => id !== item.flowId))} /><span><strong>{item.name}</strong><small className="block text-muted-foreground">Draft: {item.draft.map(ref => `${ref.label} v${ref.version}`).join(', ') || 'không dùng'} · Đã lưu: {item.published.map(ref => `${ref.label} v${ref.version}`).join(', ') || 'không dùng'}</small></span></label>)}</div><DialogActions><Button variant="ghost" onClick={() => setMigrationOpen(false)}>Hủy</Button><Button variant="primary" disabled={busy || !selectedFlows.length} onClick={() => void migrate()}>Cập nhật draft</Button></DialogActions></DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent title="Agent mới" description="Bắt đầu từ một mẫu; hướng dẫn, quyền và skill gợi ý sửa được sau khi tạo." className="w-[620px] max-w-[calc(100vw-32px)]"><form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/api/profiles/from-template', 'POST', { id, name, template }); await openProject(id); setCreateOpen(false); setMessage('Đã tạo bản nháp agent. Bấm Lưu để có phiên bản dùng trong flow.'); }); }} className="mt-4 flex flex-col gap-3">
      <div role="radiogroup" aria-label="Mẫu agent" className="agent-templates">{templates.map(t => <button type="button" role="radio" aria-checked={template === t.id} key={t.id} className={cn('agent-template', template === t.id && 'agent-template-selected')} onClick={() => { setTemplate(t.id); if (!name.trim() || templates.some(item => item.label === name)) setName(t.label); }}>
        <strong>{t.label}</strong><span>{t.description}</span><small>{[t.requestedPermissions.write ? 'sửa file' : 'chỉ đọc', t.requestedPermissions.checks ? 'checks' : '', t.reviewer ? 'dùng được làm reviewer' : ''].filter(Boolean).join(' · ')}{t.suggestedSkills.length ? ` · gợi ý skill: ${t.suggestedSkills.join(', ')}` : ''}</small></button>)}</div>
      <div className="grid grid-cols-2 gap-3"><Field label="ID"><Input required value={id} onChange={e => setId(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="vd. reviewer-ui" /></Field><Field label="Tên"><Input required value={name} onChange={e => setName(e.target.value)} /></Field></div>
      <p className="m-0 text-[11.5px] text-muted-foreground">Skill gợi ý chỉ được ghim khi project đã có skill cùng ID (màn Skills).</p>
      <DialogActions><Button variant="ghost" onClick={() => setCreateOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy || !templates.length}>Tạo agent</Button></DialogActions></form></DialogContent></Dialog>
    <Dialog open={!!removal} onOpenChange={open => { if (!open) setRemoval(null); }}><DialogContent title={`Xóa agent ${metadata?.name ?? profile?.name ?? ''}?`} description={removal?.flows.length ? 'Agent đang được các flow dưới đây dùng nên không xóa được. Lưu trữ để ẩn khỏi danh sách mà các flow vẫn chạy.' : 'Agent và mọi phiên bản của nó bị xóa khỏi project. Run đã tạo vẫn giữ bản đã ghim.'}>
      {!!removal?.flows.length && <div className="mt-3 max-h-64 overflow-auto">{removal.flows.map(item => <div key={item.flowId} className="border-b py-2 text-[12.5px]"><strong>{item.name}</strong><small className="block text-muted-foreground">{[...new Set([...item.draft, ...item.published].map(ref => `${ref.label} v${ref.version}`))].join(', ')}</small></div>)}</div>}
      <DialogActions><Button variant="ghost" onClick={() => setRemoval(null)}>Hủy</Button>{removal?.flows.length ? <Button variant="primary" disabled={busy || metadata?.archived} onClick={() => void removeAgent(true)}>Lưu trữ</Button> : <Button variant="danger-solid" disabled={busy} onClick={() => void removeAgent(false)}>Xóa vĩnh viễn</Button>}</DialogActions></DialogContent></Dialog>
  </section>;
}
