import { useEffect, useState } from 'react';
import { Database, FolderOpen, Plus, Search } from 'lucide-react';
import { api } from './api';
import { MemorySelection } from './MemorySelection';
import { originLabels, typeLabels } from './RunLessons';
import { confirmAction } from './dialog';
import { Button } from './components/ui/button';
import { Badge, Tag } from './components/ui/badge';
import { Field, Input, Textarea } from './components/ui/input';
import { Select } from './components/ui/select';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogActions, DialogContent, SheetContent } from './components/ui/dialog';
import { Callout, EmptyState } from './components/ui/misc';

type Kind = 'context' | 'decision' | 'lesson';
type MemoryRecord = { revision: string; body: string; header: { id: string; type: Kind; scope: string; sources: string[]; tags: string[]; updatedAt?: string; contentHash?: string; status?: string; expiresAt?: string; supersedes?: string[] } };
type Stats = { uses: number; helpful: number; irrelevant: number; wrong: number; score: number };
type Location = { root: string; configured: boolean; isDefault: boolean; exists: boolean; inRepository: boolean; relativePath?: string };
type MemoryState = { root: string | null; records: MemoryRecord[]; location?: Location; stats?: Record<string, Stats>; inactive?: { id: string; reason: string }[] };
type Proposal = { proposal: { proposalId: string; createdAt: string; origin?: string; reason?: string; record: { id: string; type: Kind; scope: string; tags: string[]; body: string; sources: string[]; supersedes?: string[] } };
  version: number; proposalHash: string; runId: string | null; merged: { runId: string | null; proposalId: string }[]; duplicateOf?: string };
type Proposals = { memoryRoot: string; proposals: Proposal[]; errors: { runId: string; error: string }[] };
type Note = { type: Kind; scope: string; tags: string; body: string; supersedes?: MemoryRecord };

const key = (record: MemoryRecord) => `${record.header.type}/${record.header.id}`;
const inactiveLabels: Record<string, string> = { expired: 'Hết hạn', superseded: 'Đã thay thế', duplicate: 'Trùng' };
const kindOptions = [{ value: 'lesson', label: 'Lesson (bài học)' }, { value: 'decision', label: 'Quyết định' }, { value: 'context', label: 'Context (sự thật về project)' }];
const splitTags = (text: string) => text.split(',').map(value => value.trim()).filter(Boolean);
const scoreText = (stats?: Stats) => !stats || (!stats.helpful && !stats.irrelevant && !stats.wrong) ? '—' : `${stats.score > 0 ? '+' : ''}${stats.score}`;
const rowGrid = 'grid grid-cols-[minmax(0,1fr)_92px_minmax(0,110px)_48px_48px] items-center gap-3 px-4';

/** One pending proposal: approve, edit then approve, or reject. Approving or rejecting also settles the merged duplicates. */
function ProposalRow({ item, memoryRoot, onDone }: { item: Proposal; memoryRoot: string; onDone(message: string): void }) {
  const [editing, setEditing] = useState(false), [body, setBody] = useState(item.proposal.record.body), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const base = { runId: item.runId, proposalId: item.proposal.proposalId, proposalHash: item.proposalHash };
  async function call(action: 'approve' | 'reject', extra: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try { await api(`/api/memory/proposals/${action}`, 'POST', { ...base, ...extra }); onDone(action === 'approve' ? 'Đã duyệt và lưu vào memory.' : 'Đã từ chối đề xuất.'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const record = item.proposal.record;
  return <div className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
    <div className="flex flex-wrap items-center gap-1.5"><Tag>{typeLabels[record.type]}</Tag><Tag>{originLabels[item.proposal.origin ?? 'repair']}</Tag>{record.scope !== 'project' && <Tag>{record.scope}</Tag>}
      {record.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}{item.version > 1 && <span className="text-[11.5px] text-muted-foreground">bản {item.version}</span>}
      {item.merged.length > 0 && <span className="text-[11.5px] text-muted-foreground">· gộp {item.merged.length + 1} đề xuất giống nhau</span>}</div>
    {error && <Callout tone="danger">{error}</Callout>}
    {item.duplicateOf && <Callout tone="attention">Memory đã có bản ghi cùng nội dung: <code className="font-mono">{item.duplicateOf}</code>. Nên từ chối đề xuất này.</Callout>}
    {editing ? <Textarea aria-label="Nội dung đề xuất" rows={5} value={body} onChange={event => setBody(event.target.value)} />
      : <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-2">{record.body}</p>}
    {item.proposal.reason && <p className="m-0 text-[12px] text-muted-foreground">Lý do: {item.proposal.reason}</p>}
    <p className="m-0 text-[11.5px] text-muted-foreground">Nguồn: {record.sources.join(', ')}{record.supersedes?.length ? ` · thay thế ${record.supersedes.join(', ')}` : ''}</p>
    <div className="flex flex-wrap gap-2">{editing ? <>
      <Button variant="primary" disabled={busy || !body.trim()} onClick={() => void call('approve', { body, memoryRoot })}>Duyệt bản đã sửa</Button>
      <Button variant="ghost" onClick={() => { setEditing(false); setBody(record.body); }}>Hủy sửa</Button></> : <>
      <Button variant="primary" disabled={busy} onClick={() => void call('approve', { memoryRoot })}>Duyệt</Button>
      <Button disabled={busy} onClick={() => setEditing(true)}>Sửa rồi duyệt</Button>
      <Button variant="ghost" className="text-danger hover:text-danger" disabled={busy} onClick={() => void call('reject')}>Từ chối</Button></>}</div>
  </div>;
}

export function MemoryPanel() {
  const [memory, setMemory] = useState<MemoryState>({ root: null, records: [] });
  const [proposals, setProposals] = useState<Proposals | null>(null), [proposalError, setProposalError] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [scopeFilter, setScopeFilter] = useState('all'), [typeFilter, setTypeFilter] = useState('all');
  const [rootOpen, setRootOpen] = useState(false), [externalRoot, setExternalRoot] = useState('');
  const [selected, setSelected] = useState<MemoryRecord | null>(null), [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(''), [editTags, setEditTags] = useState(''), [editScope, setEditScope] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  const refresh = async () => setMemory(await api('/api/memory'));
  const refreshProposals = async () => { try { setProposals(await api('/api/memory/proposals')); setProposalError(''); } catch (e) { setProposalError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { void refresh().catch(e => setError(String(e))); void refreshProposals(); }, []);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  function open(record: MemoryRecord) { setSelected(record); setEditing(false); setEditBody(record.body); setEditTags(record.header.tags.join(', ')); setEditScope(record.header.scope); }
  const location = memory.location, inactive = new Map((memory.inactive ?? []).map(item => [item.id, item.reason]));
  const scopes = [...new Set(memory.records.map(record => record.header.scope))].sort();
  const filtered = memory.records.filter(record => (typeFilter === 'all' || record.header.type === typeFilter) && (scopeFilter === 'all' || record.header.scope === scopeFilter.slice(6)) && `${record.header.id} ${record.body} ${record.header.tags.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const count = (kind: string) => kind === 'all' ? memory.records.length : memory.records.filter(record => record.header.type === kind).length;
  const pending = proposals?.proposals ?? [], stats = (record: MemoryRecord) => memory.stats?.[key(record)];
  /** Write the selected record back with the revision the user saw; a concurrent edit is refused, not overwritten. */
  const save = (record: MemoryRecord, changes: Partial<{ body: string; tags: string[]; scope: string }>) => action(async () => {
    const result = await api<{ record: MemoryRecord }>('/api/memory', 'POST', { record: { id: record.header.id, type: record.header.type, scope: changes.scope ?? record.header.scope, sources: record.header.sources, tags: changes.tags ?? record.header.tags, body: changes.body ?? record.body,
      ...(record.header.expiresAt ? { expiresAt: record.header.expiresAt } : {}), ...(record.header.supersedes ? { supersedes: record.header.supersedes } : {}) }, expectedRevision: record.revision });
    open(result.record); setMessage('Đã lưu revision mới của bản ghi.');
  });
  const expire = async (record: MemoryRecord) => {
    if (!await confirmAction({ title: 'Đánh dấu hết hạn?', description: 'Bản ghi vẫn nằm trong memory nhưng các run sau không dùng nó nữa.', confirmLabel: 'Hết hạn ngay' })) return;
    await action(async () => { const result = await api<{ record: MemoryRecord }>('/api/memory/expire', 'POST', { type: record.header.type, id: record.header.id, expectedRevision: record.revision }); open(result.record); setMessage('Bản ghi đã hết hạn.'); });
  };
  const remove = async (record: MemoryRecord) => {
    if (!await confirmAction({ title: `Xóa ${record.header.id}?`, description: 'File bản ghi bị xóa khỏi thư mục memory (vẫn còn trong lịch sử Git nếu đã commit). Không hoàn tác được từ NeoMind.', confirmLabel: 'Xóa bản ghi', danger: true })) return;
    await action(async () => { await api('/api/memory/delete', 'POST', { type: record.header.type, id: record.header.id, expectedRevision: record.revision }); setSelected(null); setMessage('Đã xóa bản ghi.'); });
  };
  const submitNote = (value: Note) => action(async () => {
    await api('/api/memory/note', 'POST', { type: value.type, scope: value.scope.trim() || 'project', tags: splitTags(value.tags), body: value.body, ...(value.supersedes ? { supersedes: [value.supersedes.header.id] } : {}) });
    setNote(null); setSelected(null); setMessage(value.supersedes ? `Đã tạo bản ghi thay thế ${value.supersedes.header.id}.` : 'Đã lưu ghi chú vào memory.');
  });
  const where = !location ? null : location.inRepository
    ? <>Lưu trong repo ở <code>{location.relativePath}</code> và được commit cùng code.{location.exists ? '' : ' Thư mục được tạo khi bạn ghi bản đầu tiên.'}</>
    : <>Lưu ngoài repo ở <code>{location.root}</code>; không đi theo commit.</>;

  return <section className="library-page"><div className="library-heading"><div><h1>Memory</h1><p>Context, quyết định và lesson agent nhận trong mỗi run. Chỉ bản bạn duyệt mới được dùng.</p></div><Button variant="primary" onClick={() => setNote({ type: 'lesson', scope: 'project', tags: '', body: '' })}><Plus />Ghi chú</Button></div>
    {error && <Callout tone="danger">{error}</Callout>}{message && <Callout tone="success">{message}</Callout>}
    <div className="memory-root"><Database className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><strong>{location?.configured && !location.inRepository ? 'Thư mục memory riêng' : 'Memory của project'}</strong><p>{where} {memory.records.length} bản ghi.</p></div>
      <Button disabled={busy} onClick={() => { setExternalRoot(''); setRootOpen(true); }}><FolderOpen />Dùng thư mục khác…</Button>
    </div>
    <div className="memory-block"><div className="memory-block-heading"><div><h2>Đề xuất chờ duyệt ({pending.length})</h2><p>Từ các run (vòng sửa, yêu cầu sửa kế hoạch, rule bị vi phạm, run bị chặn), từ AI trong session và từ "Ghi nhớ điều này".</p></div></div>
      {proposalError && <Callout tone="danger">{proposalError}</Callout>}{proposals?.errors.map(item => <Callout key={item.runId} tone="danger">Không đọc được {item.runId}: {item.error}</Callout>)}
      {proposals && !pending.length && <p className="memory-empty-line">Không có đề xuất chờ duyệt.</p>}
      {pending.map(item => <ProposalRow key={`${item.runId ?? 'project'}/${item.proposal.proposalId}/${item.proposalHash}`} item={item} memoryRoot={proposals!.memoryRoot} onDone={text => { setMessage(text); void refresh().catch(e => setError(String(e))); void refreshProposals(); }} />)}
    </div>
    <div className="memory-block"><div className="memory-block-heading"><div><h2>Bản ghi memory</h2><p>Dùng: số run đã ghim bản ghi. Điểm: cộng từ "Hữu ích", trừ từ "Không liên quan" và "Sai"; điểm đổi thứ tự chọn memory ở run sau.</p></div></div>
      <Tabs value={typeFilter} onValueChange={setTypeFilter}><TabsList className="px-4 pt-2">{['all', 'context', 'decision', 'lesson'].map(kind => <TabsTrigger key={kind} value={kind} count={count(kind)}>{kind === 'all' ? 'Tất cả' : typeLabels[kind]!}</TabsTrigger>)}</TabsList></Tabs>
      <div className="memory-filters"><div className="min-w-0 flex-1"><Input aria-label="Tìm memory" placeholder="Tìm nội dung, ID hoặc tag…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="w-44"><Select label="Phạm vi" value={scopeFilter} onValueChange={setScopeFilter} options={[{ value: 'all', label: 'Mọi phạm vi' }, ...scopes.map(value => ({ value: `scope:${value}`, label: value }))]} /></div><Search className="size-4 text-muted-foreground" /></div>
      {!memory.records.length ? <EmptyState title="Chưa có bản ghi">Bấm "Ghi chú" để thêm điều agent nên biết, hoặc duyệt một đề xuất ở trên.</EmptyState> : !filtered.length ? <EmptyState title="Không có bản ghi phù hợp" /> : <div className="memory-records">
        <div className={`${rowGrid} bg-muted py-2.5 text-[10px] font-semibold text-muted-foreground`}><span>ID / NỘI DUNG</span><span>LOẠI</span><span>PHẠM VI</span><span className="text-right">DÙNG</span><span className="text-right">ĐIỂM</span></div>
        {filtered.map(record => { const recordStats = stats(record), score = recordStats?.score ?? 0, state = inactive.get(record.header.id);
          return <button className={`memory-record-row ${rowGrid} w-full cursor-pointer border-0 border-t border-solid border-border bg-background py-2.5 text-left text-fg-2 hover:bg-accent`} key={key(record)} onClick={() => open(record)}>
            <span className="min-w-0"><span className="flex items-center gap-1.5"><strong className="truncate text-[13px]">{record.header.id}</strong>{state && <Badge status="idle" dot={false}>{inactiveLabels[state] ?? state}</Badge>}</span><small className="block truncate text-[12px] text-muted-foreground">{record.body}</small></span>
            <Tag>{typeLabels[record.header.type]}</Tag><span className="truncate text-[12.5px]">{record.header.scope}</span><span className="text-right text-[12.5px] tabular-nums">{recordStats?.uses ?? 0}</span>
            <span className={`text-right text-[12.5px] tabular-nums ${score < 0 ? 'text-danger' : score > 0 ? 'text-success' : 'text-muted-foreground'}`}>{scoreText(recordStats)}</span></button>; })}</div>}
    </div><MemorySelection />
    <Dialog open={rootOpen} onOpenChange={setRootOpen}><DialogContent title="Dùng thư mục memory khác" description="Mặc định memory nằm trong neomind/memory của repo. Nhập đường dẫn tuyệt đối tới một thư mục memory đã có nếu muốn dùng chung giữa nhiều repo hoặc giữ ngoài Git."><form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/api/memory/configure', 'POST', { root: externalRoot.trim(), initializeDefault: false, expectedPrevious: location?.configured ? location.root : null }); setRootOpen(false); }); }}><div className="mt-4"><Field label="Đường dẫn tuyệt đối"><Input autoFocus required value={externalRoot} onChange={e => setExternalRoot(e.target.value)} /></Field></div><DialogActions><Button variant="ghost" onClick={() => setRootOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy || !externalRoot.trim()}>Dùng thư mục này</Button></DialogActions></form></DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={value => { if (!value) setSelected(null); }}><SheetContent title={selected?.header.id ?? 'Bản ghi'} description={selected ? `${typeLabels[selected.header.type]} · ${selected.header.scope}` : undefined}>{selected && <div className="flex flex-col gap-4 p-4">
      {inactive.has(selected.header.id) && <Callout tone="attention">Run mới không dùng bản ghi này ({(inactiveLabels[inactive.get(selected.header.id)!] ?? inactive.get(selected.header.id))!.toLocaleLowerCase()}).</Callout>}
      {editing ? <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(selected, { body: editBody, tags: splitTags(editTags), scope: editScope.trim() || 'project' }); }}>
        <Field label="Nội dung"><Textarea aria-label="Nội dung bản ghi" rows={8} value={editBody} onChange={e => setEditBody(e.target.value)} /></Field>
        <Field label="Phạm vi" help="project, hoặc thư mục trong repo (vd. src/ui)."><Input value={editScope} onChange={e => setEditScope(e.target.value)} /></Field>
        <Field label="Tags (ngăn bằng dấu phẩy)"><Input value={editTags} onChange={e => setEditTags(e.target.value)} /></Field>
        <div className="flex gap-2"><Button type="submit" variant="primary" disabled={busy || !editBody.trim()}>Lưu revision mới</Button><Button variant="ghost" onClick={() => open(selected)}>Hủy</Button></div></form>
        : <p className="m-0 whitespace-pre-wrap">{selected.body}</p>}
      {!editing && <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy} onClick={() => setEditing(true)}>Sửa</Button>
        <Button disabled={busy} onClick={() => setNote({ type: selected.header.type, scope: selected.header.scope, tags: selected.header.tags.join(', '), body: selected.body, supersedes: selected })}>Thay thế bằng…</Button>
        {!selected.header.expiresAt && <Button disabled={busy} onClick={() => void expire(selected)}>Hết hạn</Button>}
        <Button variant="ghost" className="text-danger hover:text-danger" disabled={busy} onClick={() => void remove(selected)}>Xóa</Button></div>}
      <div><strong>Dùng và đánh giá</strong><p>{stats(selected) ? `Dùng trong ${stats(selected)!.uses} run · Hữu ích ${stats(selected)!.helpful} · Không liên quan ${stats(selected)!.irrelevant} · Sai ${stats(selected)!.wrong} · điểm ${scoreText(stats(selected))}` : 'Chưa run nào dùng bản ghi này.'}</p></div>
      <div><strong>Nguồn</strong><p className="break-all">{selected.header.sources.join(', ') || 'Không có'}</p></div>
      {selected.header.tags.length > 0 && <div><strong>Tags</strong><p>{selected.header.tags.map(tag => <Tag key={tag} className="mr-1">{tag}</Tag>)}</p></div>}
      <div><strong>Revision</strong><p className="break-all font-mono text-[11px]">{selected.revision}</p></div>{selected.header.updatedAt && <p>Cập nhật: {selected.header.updatedAt}</p>}
      {selected.header.expiresAt && <p>Hết hạn: {selected.header.expiresAt}</p>}{selected.header.supersedes?.length ? <p>Thay thế: {selected.header.supersedes.join(', ')}</p> : null}</div>}</SheetContent></Dialog>
    <Dialog open={!!note} onOpenChange={value => { if (!value) setNote(null); }}><DialogContent title={note?.supersedes ? `Thay thế ${note.supersedes.header.id}` : 'Ghi chú mới'} description={note?.supersedes ? 'Bản ghi mới cùng loại thay thế bản cũ; bản cũ vẫn còn nhưng run mới không dùng.' : 'Bạn tự ghi nên bản ghi được lưu ngay, không cần duyệt.'}>{note && <form className="mt-3 flex max-h-[70vh] flex-col gap-3 overflow-auto" onSubmit={event => { event.preventDefault(); void submitNote(note); }}>
      <Field label="Loại"><Select label="Loại memory" value={note.type} disabled={!!note.supersedes} onValueChange={value => setNote({ ...note, type: value as Kind })} options={kindOptions} /></Field>
      <Field label="Nội dung"><Textarea aria-label="Nội dung ghi chú" autoFocus required rows={6} value={note.body} onChange={e => setNote({ ...note, body: e.target.value })} placeholder="Ví dụ: Mọi API mới phải có test trong test/editor-server.test.ts." /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Phạm vi" help="project hoặc thư mục trong repo."><Input value={note.scope} onChange={e => setNote({ ...note, scope: e.target.value })} /></Field>
        <Field label="Tags" help="Ngăn bằng dấu phẩy."><Input value={note.tags} onChange={e => setNote({ ...note, tags: e.target.value })} /></Field></div>
      <DialogActions><Button variant="ghost" onClick={() => setNote(null)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy || !note.body.trim()}>{note.supersedes ? 'Lưu bản thay thế' : 'Lưu ghi chú'}</Button></DialogActions></form>}</DialogContent></Dialog>
  </section>;
}
