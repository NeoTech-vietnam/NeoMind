import { useEffect, useState } from 'react';
import { Database, FolderOpen, Plus, Search } from 'lucide-react';
import { api } from './api';
import { RunLessons } from './RunLessons';
import { MemorySelection } from './MemorySelection';
import { Button } from './components/ui/button';
import { Tag } from './components/ui/badge';
import { Field, Input, Textarea } from './components/ui/input';
import { Select } from './components/ui/select';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogActions, DialogContent, SheetContent } from './components/ui/dialog';
import { Callout, EmptyState } from './components/ui/misc';

type MemoryRecord = { revision: string; body: string; header: { id: string; type: 'context' | 'decision' | 'lesson'; scope: string; sources: string[]; tags: string[]; updatedAt?: string; contentHash?: string; status?: string; expiresAt?: string; supersedes?: string[] } };
type Queue = { runs: { runId: string; task: string; pending: number }[]; errors: { runId: string; error: string }[]; scanned: number; totalCompleted: number };
const labels = { context: 'Context', decision: 'Quyết định', lesson: 'Lesson' };

export function MemoryPanel() {
  const [memory, setMemory] = useState<{ root: string | null; records: MemoryRecord[] }>({ root: null, records: [] });
  const [queue, setQueue] = useState<Queue | null>(null), [queueError, setQueueError] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [scopeFilter, setScopeFilter] = useState('all'), [typeFilter, setTypeFilter] = useState('all');
  const [rootOpen, setRootOpen] = useState(false), [externalRoot, setExternalRoot] = useState('');
  const [selected, setSelected] = useState<MemoryRecord | null>(null), [editOpen, setEditOpen] = useState(false);
  const [id, setId] = useState(''), [type, setType] = useState<'context' | 'decision'>('context'), [scope, setScope] = useState('project');
  const [text, setText] = useState(''), [sources, setSources] = useState(''), [tags, setTags] = useState(''), [revision, setRevision] = useState<string | null>(null), [expiresAt, setExpiresAt] = useState(''), [supersedes, setSupersedes] = useState('');
  const refresh = async () => setMemory(await api('/api/memory'));
  const refreshQueue = async () => { try { setQueue(await api('/api/memory/lesson-queue')); setQueueError(''); } catch (e) { setQueueError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { void refresh().catch(e => setError(String(e))); void refreshQueue(); }, []);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  function edit(record?: MemoryRecord) {
    setId(record?.header.id ?? ''); setType(record?.header.type === 'decision' ? 'decision' : 'context'); setScope(record?.header.scope ?? 'project'); setText(record?.body ?? ''); setSources(record?.header.sources.join('\n') ?? ''); setTags(record?.header.tags.join(', ') ?? ''); setRevision(record?.revision ?? null); setExpiresAt(record?.header.expiresAt ?? ''); setSupersedes(record?.header.supersedes?.join(', ') ?? ''); setEditOpen(true);
  }
  const scopes = [...new Set(memory.records.map(record => record.header.scope))].sort();
  const filtered = memory.records.filter(record => (typeFilter === 'all' || record.header.type === typeFilter) && (scopeFilter === 'all' || record.header.scope === scopeFilter.slice(6)) && `${record.header.id} ${record.body} ${record.header.tags.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const count = (kind: string) => kind === 'all' ? memory.records.length : memory.records.filter(record => record.header.type === kind).length;
  const pending = queue?.runs.reduce((sum, item) => sum + item.pending, 0) ?? 0;
  return <section className="library-page"><div className="library-heading"><div><h1>Memory</h1><p>Context, quyết định và lesson dùng chung cho các run.</p></div>{memory.root && <Button onClick={() => edit()}><Plus />Tạo bản ghi</Button>}</div>
    {error && <Callout tone="danger">{error}</Callout>}{message && <Callout tone="success">{message}</Callout>}
    <div className="memory-root"><Database className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><strong>{memory.root ? 'Memory đã kết nối' : 'Chưa chọn thư mục memory'}</strong><p>{memory.root ? <><code>{memory.root}</code> · {memory.records.length} bản ghi</> : 'Chọn thư mục để lưu memory dùng chung của project.'}</p></div>
      {!memory.root && <Button variant="primary" disabled={busy} onClick={() => void action(async () => { setMemory(await api('/api/memory/configure', 'POST', { initializeDefault: true, expectedPrevious: null })); })}>Khởi tạo memory trong project</Button>}
      <Button disabled={busy} onClick={() => { setExternalRoot(''); setRootOpen(true); }}><FolderOpen />{memory.root ? 'Đổi thư mục…' : 'Chọn thư mục có sẵn…'}</Button>
    </div>
    <div className="memory-block"><div className="memory-block-heading"><div><h2>Lesson chờ duyệt ({pending})</h2><p>Chỉ lesson bạn duyệt mới được lưu vào memory.</p></div></div>
      {queueError && <Callout tone="danger">{queueError}</Callout>}{queue?.errors.map(item => <Callout key={item.runId} tone="danger">Không đọc được {item.runId}: {item.error}</Callout>)}
      {queue && !pending && <p className="memory-empty-line">Không có lesson chờ duyệt.</p>}
      {queue?.runs.map(item => <div className="memory-lesson-run" key={`${item.runId}:${memory.root ?? ''}`}><p className="m-0 mb-2 text-[12px] text-muted-foreground">Run: {item.task} · {item.runId}</p><RunLessons runId={item.runId} pendingOnly onPromoted={() => { void refresh().catch(e => setError(String(e))); void refreshQueue(); }} /></div>)}
      {queue && <p className="memory-empty-line">Đã kiểm tra {queue.scanned}/{queue.totalCompleted} run hoàn tất gần nhất.</p>}
    </div>
    <div className="memory-block"><div className="memory-block-heading"><div><h2>Bản ghi memory</h2><p>Chọn một bản ghi để xem nội dung và nguồn.</p></div></div>
      <Tabs value={typeFilter} onValueChange={setTypeFilter}><TabsList className="px-4 pt-2">{['all', 'context', 'decision', 'lesson'].map(kind => <TabsTrigger key={kind} value={kind} count={count(kind)}>{kind === 'all' ? 'Tất cả' : labels[kind as keyof typeof labels]}</TabsTrigger>)}</TabsList></Tabs>
      <div className="memory-filters"><div className="min-w-0 flex-1"><Input aria-label="Tìm memory" placeholder="Tìm nội dung, ID hoặc tag…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="w-44"><Select label="Phạm vi" value={scopeFilter} onValueChange={setScopeFilter} options={[{ value: 'all', label: 'Mọi phạm vi' }, ...scopes.map(value => ({ value: `scope:${value}`, label: value }))]} /></div><Search className="size-4 text-muted-foreground" /></div>
      {!memory.root ? <EmptyState title="Chưa chọn thư mục memory">Kết nối thư mục để xem bản ghi.</EmptyState> : !filtered.length ? <EmptyState title="Không có bản ghi phù hợp" /> : <div className="memory-records"><div className="memory-record-head"><span>ID / NỘI DUNG</span><span>LOẠI</span><span>PHẠM VI</span></div>{filtered.map(record => <button className="memory-record" key={`${record.header.type}/${record.header.id}`} onClick={() => setSelected(record)}><span className="min-w-0"><strong>{record.header.id}</strong><small>{record.body}</small></span><Tag>{labels[record.header.type]}</Tag><span className="truncate">{record.header.scope}</span></button>)}</div>}
    </div><MemorySelection />
    <Dialog open={rootOpen} onOpenChange={setRootOpen}><DialogContent title={memory.root ? 'Đổi thư mục memory' : 'Chọn thư mục memory'} description="Nhập đường dẫn tuyệt đối tới thư mục memory đã có."><form onSubmit={event => { event.preventDefault(); void action(async () => { setMemory(await api('/api/memory/configure', 'POST', { root: externalRoot.trim(), initializeDefault: false, expectedPrevious: memory.root })); setRootOpen(false); }); }}><div className="mt-4"><Field label="Đường dẫn tuyệt đối"><Input autoFocus required value={externalRoot} onChange={e => setExternalRoot(e.target.value)} /></Field></div><DialogActions><Button variant="ghost" onClick={() => setRootOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy || !externalRoot.trim()}>Dùng thư mục này</Button></DialogActions></form></DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><SheetContent title={selected?.header.id ?? 'Bản ghi'} description={selected ? `${labels[selected.header.type]} · ${selected.header.scope}` : undefined}>{selected && <div className="flex flex-col gap-4 p-4"><p className="m-0 whitespace-pre-wrap">{selected.body}</p><div><strong>Nguồn</strong><p>{selected.header.sources.join(', ') || 'Không có'}</p></div><div><strong>Tags</strong><p>{selected.header.tags.map(tag => <Tag key={tag} className="mr-1">{tag}</Tag>)}</p></div><div><strong>Revision</strong><p className="break-all font-mono text-[11px]">{selected.revision}</p></div>{selected.header.updatedAt && <p>Cập nhật: {selected.header.updatedAt}</p>}{selected.header.status && <p>Trạng thái: {selected.header.status}</p>}{selected.header.contentHash && <p className="break-all">Hash nội dung: {selected.header.contentHash}</p>}{selected.header.expiresAt && <p>Hết hạn: {selected.header.expiresAt}</p>}{selected.header.supersedes?.length ? <p>Thay thế: {selected.header.supersedes.join(', ')}</p> : null}{selected.header.type !== 'lesson' && <Button onClick={() => { const record = selected; setSelected(null); edit(record); }}>Sửa bản ghi</Button>}</div>}</SheetContent></Dialog>
    <Dialog open={editOpen} onOpenChange={setEditOpen}><DialogContent title={revision ? 'Cập nhật bản ghi' : 'Tạo bản ghi'}><form className="mt-3 flex max-h-[70vh] flex-col gap-3 overflow-auto" onSubmit={event => { event.preventDefault(); void action(async () => { const result = await api<{ record: MemoryRecord }>('/api/memory', 'POST', { record: { id, type, scope, sources: sources.split('\n').map(value => value.trim()).filter(Boolean), tags: tags.split(',').map(value => value.trim()).filter(Boolean), body: text, ...(expiresAt.trim() ? { expiresAt: expiresAt.trim() } : {}), ...(supersedes.trim() ? { supersedes: supersedes.split(',').map(value => value.trim()).filter(Boolean) } : {}) }, expectedRevision: revision }); setRevision(result.record.revision); setEditOpen(false); setMessage('Đã lưu memory kèm receipt xác nhận.'); }); }}>
      <Field label="ID"><Input required pattern="[a-z0-9][a-z0-9-]*" value={id} onChange={e => { setId(e.target.value); setRevision(null); }} /></Field><Field label="Loại"><Select label="Loại memory" value={type} onValueChange={value => { setType(value as typeof type); setRevision(null); }} options={[{ value: 'context', label: 'Context có nguồn' }, { value: 'decision', label: 'Quyết định tôi xác nhận' }]} /></Field>
      <Field label="Phạm vi"><Input required value={scope} onChange={e => setScope(e.target.value)} /></Field><Field label="Nội dung"><Textarea required value={text} onChange={e => setText(e.target.value)} /></Field><Field label="Nguồn (mỗi dòng một nguồn)"><Textarea required value={sources} onChange={e => setSources(e.target.value)} /></Field><Field label="Tags (ngăn bằng dấu phẩy)"><Input value={tags} onChange={e => setTags(e.target.value)} /></Field><Field label="Hết hạn (ISO 8601)"><Input value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></Field><Field label="Thay thế các ID cùng loại"><Input value={supersedes} onChange={e => setSupersedes(e.target.value)} /></Field>
      <DialogActions><Button variant="ghost" onClick={() => setEditOpen(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy}>Lưu bản ghi</Button></DialogActions></form></DialogContent></Dialog>
  </section>;
}
