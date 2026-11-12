import { useCallback, useEffect, useState } from 'react';
import { Eye, FilePlus2, Lock, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api } from './api';
import { askText, confirmAction } from './dialog';
import { Button } from './components/ui/button';
import { Badge, Tag } from './components/ui/badge';
import { Field, Input, Textarea } from './components/ui/input';
import { Select } from './components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogActions, DialogContent, SheetContent } from './components/ui/dialog';
import { Callout, EmptyState } from './components/ui/misc';
import { cn } from './lib/utils';

export type SkillSource = 'neomind' | 'agents' | 'claude';
// Same-ID copies in lower-priority folders (neomind > .agents > .claude); the catalog offers only the listed one.
type Shadowed = { path: string; source: SkillSource; sha256: string };
type LibraryItem = { id: string; path: string; sha256: string; name: string; description: string; source: SkillSource; editable: boolean; used: number; stale: number; shadowed?: Shadowed[] };
type Skill = { id: string; path: string; source: SkillSource; editable: boolean; sha256: string; content: string; name: string; description: string; body: string; files: string[]; prompt: string };
type Pin = { sha256: string; stale: boolean };
export type SkillUsage = { sha256: string | null;
  profiles: { profileId: string; name: string; draft: Pin | null; latest: (Pin & { version: number }) | null }[];
  flows: { flowId: string; name: string; draft: { nodeId: string; label: string; stale: boolean }[]; published: { nodeId: string; label: string; stale: boolean }[]; publishedVersion: number | null }[] };
type Repinned = { profiles: { profileId: string; error?: string }[]; flows: { flowId: string; changed: number; error?: string }[] };
type CompanionFile = { path: string; content: string; sha256: string | null; original: string };

const listClass = 'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[12.5px] text-fg-2 hover:bg-accent';
const templateOptions = [{ value: 'empty', label: 'Trống' }, { value: 'review-checklist', label: 'Checklist review' }];
const skillUrl = (id: string, source: SkillSource = 'neomind', suffix = '') => `/api/skills/${encodeURIComponent(id)}${suffix}${source === 'neomind' ? '' : `?source=${source}`}`;
const fileUrl = (id: string, file: string) => `/api/skills/${encodeURIComponent(id)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
const staleUses = (usage: SkillUsage | null) => !usage ? 0 : usage.profiles.filter(item => item.draft?.stale).length + usage.flows.reduce((sum, item) => sum + item.draft.filter(ref => ref.stale).length, 0);

/** Where a skill is pinned, for the usage tab and the delete confirmation. */
export function SkillUsageList({ usage }: { usage: SkillUsage }) {
  if (!usage.profiles.length && !usage.flows.length) return <p className="m-0 text-[12.5px] text-muted-foreground">Chưa agent hay bước nào ghim skill này.</p>;
  return <div className="flex flex-col gap-1 text-[12.5px]">
    {usage.profiles.map(item => <div key={item.profileId} className="flex flex-wrap items-center gap-2 border-b py-2"><span className="text-muted-foreground">Agent</span><strong>{item.name}</strong>
      {item.draft && <Badge status={item.draft.stale ? 'attention' : 'success'}>{item.draft.stale ? 'Nháp ghim bản cũ' : 'Nháp khớp'}</Badge>}
      {item.latest && <Tag>v{item.latest.version}{item.latest.stale ? ' · bản cũ' : ''}</Tag>}</div>)}
    {usage.flows.flatMap(flow => [...new Set([...flow.draft, ...flow.published].map(ref => ref.nodeId))].map(nodeId => {
      const draft = flow.draft.find(ref => ref.nodeId === nodeId), published = flow.published.find(ref => ref.nodeId === nodeId);
      return <div key={`${flow.flowId}-${nodeId}`} className="flex flex-wrap items-center gap-2 border-b py-2"><span className="text-muted-foreground">Flow</span><strong>{flow.name}</strong> › {(draft ?? published)!.label}
        {draft && <Badge status={draft.stale ? 'attention' : 'success'}>{draft.stale ? 'Nháp ghim bản cũ' : 'Nháp khớp'}</Badge>}
        {published && flow.publishedVersion !== null && <Tag>v{flow.publishedVersion}{published.stale ? ' · bản cũ' : ''}</Tag>}</div>;
    }))}
  </div>;
}

/** Skills screen: project skills in neomind/skills are edited here; .agents/skills and .claude/skills are shown read-only. */
export function SkillsPanel({ focus }: { focus?: { id: string; source: SkillSource; nonce: number } | undefined }) {
  const [items, setItems] = useState<LibraryItem[]>([]), [query, setQuery] = useState('');
  const [skill, setSkill] = useState<Skill | null>(null), [usage, setUsage] = useState<SkillUsage | null>(null);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [body, setBody] = useState('');
  const [files, setFiles] = useState<CompanionFile | null>(null), [tab, setTab] = useState('content');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [savedStale, setSavedStale] = useState(false);
  const [createOpen, setCreateOpen] = useState(false), [draft, setDraft] = useState({ id: '', name: '', description: '', template: 'empty' });
  const [promptOpen, setPromptOpen] = useState(false), [deleteOpen, setDeleteOpen] = useState(false);
  const dirty = !!skill && skill.editable && (name !== skill.name || description !== skill.description || body !== skill.body);
  const fileDirty = !!files && files.content !== files.original;
  const refresh = useCallback(async () => { const data = await api<{ skills: LibraryItem[] }>('/api/skill-library'); setItems(data.skills); return data.skills; }, []);
  async function open(id: string, source: SkillSource) {
    const [data, used] = await Promise.all([api<Skill>(skillUrl(id, source)), api<SkillUsage>(skillUrl(id, source, '/usage'))]);
    setSkill(data); setUsage(used); setName(data.name); setDescription(data.description); setBody(data.body); setFiles(null); setSavedStale(false);
  }
  useEffect(() => {
    void refresh().then(async list => {
      const wanted = focus && list.find(item => item.id === focus.id && item.source === focus.source), first = wanted ?? list.find(item => item.editable) ?? list[0];
      if (first) { await open(first.id, first.source); if (wanted) setTab('content'); }
    }).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh, focus?.nonce]);
  async function canLeave() { return (!dirty && !fileDirty) || confirmAction({ title: 'Bỏ thay đổi chưa lưu?', description: 'Các thay đổi chưa lưu của skill sẽ bị bỏ.', confirmLabel: 'Bỏ thay đổi', danger: true }); }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function save() {
    if (!skill) return;
    await action(async () => {
      const result = await api<{ skill: Skill; usage: SkillUsage }>(skillUrl(skill.id), 'PUT', { expectedSha256: skill.sha256, name, description, body });
      setSkill(result.skill); setUsage(result.usage); setName(result.skill.name); setDescription(result.skill.description); setBody(result.skill.body);
      setSavedStale(staleUses(result.usage) > 0); setMessage('Đã lưu skill.');
    });
  }
  async function repin() {
    if (!skill) return;
    await action(async () => {
      const result = await api<Repinned>(skillUrl(skill.id, skill.source, '/repin'), 'POST', {});
      const failed = [...result.profiles, ...result.flows].filter(item => item.error);
      setUsage(await api<SkillUsage>(skillUrl(skill.id, skill.source, '/usage'))); setSavedStale(false);
      if (failed.length) setError(`Không ghim lại được: ${failed.map(item => ('profileId' in item ? item.profileId : item.flowId) + ` (${item.error})`).join('; ')}`);
      setMessage(`Đã ghim lại trong ${result.profiles.filter(item => !item.error).length} agent và ${result.flows.filter(item => !item.error).length} flow (bản nháp). Lưu agent/flow để dùng bản mới khi chạy.`);
    });
  }
  async function remove(force: boolean) {
    if (!skill) return;
    await action(async () => {
      await api(skillUrl(skill.id, 'neomind', '/delete'), 'POST', { force });
      setDeleteOpen(false); setSkill(null); setUsage(null); setMessage(`Đã xóa skill ${skill.name}.`);
      const list = await refresh(), next = list.find(item => item.editable) ?? list[0];
      if (next) await open(next.id, next.source);
    });
  }
  async function openFile(file: string) {
    if (!skill || (fileDirty && !await confirmAction({ title: 'Bỏ thay đổi file?', confirmLabel: 'Bỏ thay đổi', danger: true }))) return;
    await action(async () => { const data = await api<{ content: string; sha256: string }>(fileUrl(skill.id, file)); setFiles({ path: file, content: data.content, sha256: data.sha256, original: data.content }); });
  }
  async function addFile() {
    if (!skill) return;
    const file = (await askText({ title: 'Thêm file phụ', label: 'Đường dẫn trong thư mục skill (vd. reference.md)', confirmLabel: 'Tạo file' }))?.trim().replaceAll('\\', '/');
    if (!file) return;
    await action(async () => { await api(fileUrl(skill.id, file), 'PUT', { content: '', expectedSha256: null }); await open(skill.id, skill.source); setTab('files'); setFiles({ path: file, content: '', sha256: null, original: '' }); });
  }
  async function saveFile() {
    if (!skill || !files) return;
    await action(async () => { const result = await api<{ sha256: string }>(fileUrl(skill.id, files.path), 'PUT', { content: files.content, expectedSha256: files.sha256 ?? (await api<{ sha256: string }>(fileUrl(skill.id, files.path))).sha256 }); setFiles({ ...files, sha256: result.sha256, original: files.content }); setMessage(`Đã lưu ${files.path}.`); });
  }
  async function deleteFile(file: string) {
    if (!skill || !await confirmAction({ title: `Xóa file ${file}?`, description: 'File bị xóa khỏi thư mục skill. Các run đã tạo không bị ảnh hưởng.', confirmLabel: 'Xóa file', danger: true })) return;
    await action(async () => { await api(fileUrl(skill.id, file), 'DELETE', {}); if (files?.path === file) setFiles(null); await open(skill.id, skill.source); setTab('files'); });
  }
  const shadowed = skill ? items.find(item => item.id === skill.id && item.source === skill.source)?.shadowed ?? [] : [];
  const needle = query.toLocaleLowerCase(), visible = items.filter(item => `${item.name} ${item.id} ${item.description}`.toLocaleLowerCase().includes(needle));
  const stale = staleUses(usage), used = usage ? usage.profiles.length + usage.flows.reduce((sum, flow) => sum + new Set([...flow.draft, ...flow.published].map(ref => ref.nodeId)).size, 0) : 0;
  const listItem = (item: LibraryItem) => <button key={`${item.source}-${item.id}`} className={cn(listClass, skill?.id === item.id && skill.source === item.source && 'bg-accent')} onClick={() => void canLeave().then(ok => { if (ok) void action(() => open(item.id, item.source)); })}>
    {!item.editable && <Lock className="size-4 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1"><strong className="block truncate">{item.name}</strong>
      <small className="block truncate text-muted-foreground">{item.id} · {item.used ? `${item.used} nơi dùng` : 'chưa dùng'}</small></span>
    {item.stale > 0 && <Badge status="attention">{item.stale} cũ</Badge>}</button>;
  return <section className="library-page"><div className="library-heading"><div><h1>Skills</h1><p>Hướng dẫn dùng lại cho agent và từng bước. Agent và bước ghim skill bằng SHA-256; sửa skill không đổi run đã tạo.</p></div>
    <Button variant="primary" onClick={() => void canLeave().then(ok => { if (ok) { setDraft({ id: '', name: '', description: '', template: 'empty' }); setCreateOpen(true); } })}><Plus />Skill mới</Button></div>
    {error && <Callout tone="danger" className="mb-3">{error}</Callout>}{message && <Callout tone="success" className="mb-3">{message}</Callout>}
    <div className="profiles-layout"><aside className="profiles-list"><div className="relative"><Search className="absolute left-2 top-2 size-4 text-muted-foreground" /><Input aria-label="Tìm skill" className="pl-8" placeholder="Tìm theo tên, ID hoặc mô tả" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <p className="profiles-caption">CỦA PROJECT · neomind/skills</p>
      {visible.filter(item => item.source === 'neomind').map(listItem)}
      {!items.some(item => item.source === 'neomind') && <p className="m-0 px-2.5 text-[12px] text-muted-foreground">Chưa có skill. Tạo skill đầu tiên bằng nút Skill mới.</p>}
      {items.some(item => item.source === 'agents') && <><p className="profiles-caption">AGENT SKILLS · chỉ đọc · sửa trong .agents/skills</p>{visible.filter(item => item.source === 'agents').map(listItem)}</>}
      {items.some(item => item.source === 'claude') && <><p className="profiles-caption">CLAUDE CODE · chỉ đọc · sửa trong .claude/skills</p>{visible.filter(item => item.source === 'claude').map(listItem)}</>}
    </aside><div className="profiles-detail">{!skill ? <EmptyState title="Chọn hoặc tạo skill">Skill là một file SKILL.md (tên, mô tả, hướng dẫn Markdown) cùng các file phụ.</EmptyState> : <>
      <div className="profiles-detail-header"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="m-0 truncate text-[16px] font-semibold">{skill.name}</h2>{!skill.editable && <Tag>chỉ đọc</Tag>}</div>
        <p className="m-0 mt-1 truncate text-[11px] text-muted-foreground"><code>{skill.path}</code> · {skill.sha256.slice(0, 12)}{dirty ? ' · Đã sửa, chưa lưu' : ''}</p></div>
        <Button disabled={busy} onClick={() => setPromptOpen(true)}><Eye />Xem đoạn chèn vào prompt</Button>
        {skill.editable && <Button variant="ghost" size="icon" aria-label="Xóa skill" disabled={busy} onClick={() => setDeleteOpen(true)}><Trash2 /></Button>}
        {skill.editable && <Button variant="primary" disabled={busy || !dirty || !name.trim()} onClick={() => void save()}>Lưu</Button>}</div>
      {!skill.editable && <Callout tone="hint" className="mx-5 mt-4">{skill.source === 'agents' ? 'Skill dùng chung theo chuẩn Agent Skills (Codex, OpenCode đọc thư mục này).' : 'Skill của Claude Code.'} Sửa trực tiếp trong <code>{skill.path}</code>; agent đang ghim sẽ báo “Đã đổi” để bạn ghim lại.</Callout>}
      {shadowed.length > 0 && <Callout tone="attention" className="mx-5 mt-4">Cùng ID còn có ở {shadowed.map(item => <span key={item.path}><code>{item.path}</code> ({item.sha256 === skill.sha256 ? 'cùng nội dung' : 'khác nội dung'}) </span>)}. Danh mục chọn skill chỉ đưa ra bản này; agent/bước đã ghim bản kia vẫn dùng bản đó.</Callout>}
      {stale > 0 && <Callout tone="attention" className="mx-5 mt-4"><div className="flex flex-wrap items-center gap-3"><span className="flex-1">{savedStale ? 'Đã lưu. ' : ''}{stale} agent/bước đang ghim bản cũ của skill này; run mới vẫn dùng bản cũ cho tới khi ghim lại và lưu agent/flow.</span>
        <Button size="sm" disabled={busy} onClick={() => void repin()}><RefreshCw />Ghim lại tất cả</Button></div></Callout>}
      <Tabs value={tab} onValueChange={setTab}><TabsList className="px-5 pt-2"><TabsTrigger value="content">Nội dung</TabsTrigger><TabsTrigger value="files" count={skill.files.length}>File phụ</TabsTrigger><TabsTrigger value="usage" count={used}>Nơi dùng</TabsTrigger></TabsList>
        <TabsContent value="content" className="profiles-tab flex flex-col gap-4">
          <Field label="Tên"><Input aria-label="Tên skill" value={name} disabled={!skill.editable} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Mô tả" help="Khi nào nên dùng skill này; hiện trong danh mục khi chọn skill."><Input aria-label="Mô tả skill" value={description} disabled={!skill.editable} onChange={e => setDescription(e.target.value)} /></Field>
          <Field label="Hướng dẫn (Markdown)"><Textarea aria-label="Nội dung skill" rows={16} className="font-mono text-[12px]" value={body} readOnly={!skill.editable} onChange={e => setBody(e.target.value)} /></Field>
        </TabsContent>
        <TabsContent value="files" className="profiles-tab"><p className="mb-3 mt-0 text-[12.5px] text-muted-foreground">Run chỉ đưa tên file vào prompt; agent tự đọc khi cần. File phụ không đổi SHA-256 của skill.</p>
          <div className="flex flex-col gap-1">{skill.files.map(file => <div key={file} className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5', files?.path === file && 'bg-accent')}>
            <button className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-[12px] text-fg-2" onClick={() => void openFile(file)}>{file}</button>
            {skill.editable && <Button variant="ghost" size="icon-sm" aria-label={`Xóa file ${file}`} onClick={() => void deleteFile(file)}><Trash2 /></Button>}</div>)}
            {!skill.files.length && <p className="m-0 text-[12.5px] text-muted-foreground">Chưa có file phụ.</p>}</div>
          {skill.editable && <Button className="mt-3" size="sm" onClick={() => void addFile()}><FilePlus2 />Thêm file</Button>}
          {files && <div className="mt-4 flex flex-col gap-2"><Field label={files.path}><Textarea aria-label={`Nội dung ${files.path}`} rows={10} className="font-mono text-[12px]" value={files.content} readOnly={!skill.editable} onChange={e => setFiles({ ...files, content: e.target.value })} /></Field>
            {skill.editable && <div><Button size="sm" variant="primary" disabled={busy || !fileDirty} onClick={() => void saveFile()}>Lưu file</Button></div>}</div>}
        </TabsContent>
        <TabsContent value="usage" className="profiles-tab">{usage && <SkillUsageList usage={usage} />}</TabsContent>
      </Tabs></>}</div></div>
    <Dialog open={promptOpen} onOpenChange={setPromptOpen}><SheetContent title="Đoạn chèn vào prompt" description={skill ? `Mỗi bước ghim ${skill.name} nhận đúng đoạn này sau hướng dẫn của agent.` : undefined}>
      {skill && <div className="p-4">{dirty && <Callout tone="attention" className="mb-3">Đang hiện bản đã lưu; lưu để xem thay đổi.</Callout>}<pre className="m-0 whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-[12px]">{skill.prompt}</pre></div>}</SheetContent></Dialog>
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent title={skill ? `Xóa skill ${skill.name}?` : 'Xóa skill'} description={used ? 'Skill đang được ghim ở những nơi dưới đây. Xóa thì run mới của các agent/bước này bị chặn cho tới khi bỏ ghim.' : 'Thư mục skill và các file phụ bị xóa khỏi project.'}>
      {usage && used > 0 && <div className="mt-3 max-h-64 overflow-auto"><SkillUsageList usage={usage} /></div>}
      <DialogActions><Button variant="ghost" onClick={() => setDeleteOpen(false)}>Hủy</Button><Button variant="danger-solid" disabled={busy} onClick={() => void remove(used > 0)}>{used ? 'Vẫn xóa' : 'Xóa skill'}</Button></DialogActions></DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent title="Skill mới" description="Tạo neomind/skills/<id>/SKILL.md theo chuẩn skill của Claude.">
      <form className="mt-4 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void action(async () => { const result = await api<{ skill: Skill }>('/api/skills', 'POST', { id: draft.id.trim(), name: draft.name.trim(), ...(draft.description.trim() ? { description: draft.description.trim() } : {}), template: draft.template }); setCreateOpen(false); await refresh(); await open(result.skill.id, 'neomind'); setTab('content'); setMessage('Đã tạo skill. Ghim nó trong agent hoặc từng bước của flow.'); }); }}>
        <Field label="ID" help="Tên thư mục; chữ, số, dấu chấm, gạch."><Input required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} /></Field>
        <Field label="Tên"><Input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
        <Field label="Mô tả"><Input value={draft.description} placeholder="Khi nào dùng skill này" onChange={e => setDraft({ ...draft, description: e.target.value })} /></Field>
        <Field label="Mẫu"><Select label="Mẫu skill" value={draft.template} onValueChange={value => setDraft({ ...draft, template: value })} options={templateOptions} /></Field>
        <DialogActions><Button variant="ghost" onClick={() => setCreateOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy}>Tạo skill</Button></DialogActions></form></DialogContent></Dialog>
  </section>;
}
