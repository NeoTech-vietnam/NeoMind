import { useEffect, useState } from 'react';
import { api } from './api';
import { Button } from './components/ui/button';
import { Disclosure } from './components/ui/disclosure';
import { Field, Input } from './components/ui/input';
import { Select } from './components/ui/select';
import { Callout } from './components/ui/misc';

type Selection = { retrievalMode?: 'lexical' | 'semantic' | 'hybrid'; scopes?: string[]; tags?: string[]; requireTaskMatch?: boolean; inferTaskPaths?: boolean; maxRecords?: number; maxBodyBytes?: number };
export function MemorySelection() {
  const [revision, setRevision] = useState(''), [scopes, setScopes] = useState(''), [tags, setTags] = useState('');
  const [matching, setMatching] = useState(false), [maxRecords, setMaxRecords] = useState(30), [maxBytes, setMaxBytes] = useState(16000);
  const [retrievalMode, setRetrievalMode] = useState<'lexical' | 'semantic' | 'hybrid'>('lexical'), [inferPaths, setInferPaths] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [task, setTask] = useState(''), [preview, setPreview] = useState<{ root: string | null; records: { id: string; type: string; scope: string; selectionReason: string }[] } | null>(null);
  async function reload() {
    const data = await api<{ selection: Selection; revision: string }>('/api/memory/selection');
    setRetrievalMode(data.selection.retrievalMode ?? 'lexical'); setRevision(data.revision); setScopes((data.selection.scopes ?? []).join(', ')); setTags((data.selection.tags ?? []).join(', '));
    setMatching(data.selection.requireTaskMatch ?? false); setInferPaths(data.selection.inferTaskPaths ?? false); setMaxRecords(data.selection.maxRecords ?? 30); setMaxBytes(data.selection.maxBodyBytes ?? 16000);
  }
  useEffect(() => { void reload().catch(e => setError(String(e))); }, []);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const values = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
      const selection = { retrievalMode, scopes: values(scopes), tags: values(tags), requireTaskMatch: matching, inferTaskPaths: inferPaths, maxRecords, maxBodyBytes: maxBytes };
      const data = await api<{ revision: string }>('/api/memory/selection', 'PUT', { selection, expectedRevision: revision });
      setRevision(data.revision); setMessage('Đã lưu policy cho các run tiếp theo.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const mode = { lexical: 'Từ khóa', semantic: 'Ngữ nghĩa cục bộ', hybrid: 'Kết hợp' };
  return <Disclosure title="Chọn memory cho run" hint={`${mode[retrievalMode]} · tối đa ${maxRecords} bản ghi`} className="rounded-lg border">
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[12px] text-muted-foreground">Để trống scope hoặc tag để không lọc. Bản ghi phải có tất cả tags.</p>
      {error && <Callout tone="danger">{error} <Button variant="ghost" size="sm" onClick={() => void reload().catch(e => setError(String(e)))}>Tải lại</Button></Callout>}{message && <Callout tone="success">{message}</Callout>}
      <Field label="Cách tìm nội dung"><Select label="Cách tìm nội dung" value={retrievalMode} onValueChange={value => setRetrievalMode(value as typeof retrievalMode)} options={[{ value: 'lexical', label: 'Từ khóa' }, { value: 'semantic', label: 'Ngữ nghĩa cục bộ (LSA)' }, { value: 'hybrid', label: 'Kết hợp từ khóa và LSA' }]} /></Field>
      <Field label="Scope (phân tách bằng dấu phẩy)"><Input value={scopes} onChange={e => setScopes(e.target.value)} /></Field><Field label="Tags bắt buộc (phân tách bằng dấu phẩy)"><Input value={tags} onChange={e => setTags(e.target.value)} /></Field>
      <label className="flex items-center gap-2"><input type="checkbox" checked={matching} onChange={e => setMatching(e.target.checked)} />Chỉ chọn bản ghi khớp từ khóa task</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={inferPaths} onChange={e => setInferPaths(e.target.checked)} />Suy ra đường dẫn liên quan từ task</label>
      {inferPaths && <p className="m-0 text-[12px] text-muted-foreground">Nếu tìm thấy đường dẫn, chỉ chọn scope project hoặc scope giao với đường dẫn.</p>}
      <Field label="Số bản ghi tối đa"><Input type="number" min="0" max="30" value={maxRecords} onChange={e => setMaxRecords(Number(e.target.value))} /></Field>
      <Field label="Ngân sách nội dung (bytes)"><Input type="number" min="0" max="16000" value={maxBytes} onChange={e => setMaxBytes(Number(e.target.value))} /></Field>
      <div><Button disabled={busy || !revision || !Number.isInteger(maxRecords) || maxRecords < 0 || maxRecords > 30 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 16000} onClick={() => void save()}>Lưu policy</Button></div>
      <Field label="Xem thử memory với một task" help="Bản xem thử dùng policy đã lưu của project."><Input value={task} onChange={e => setTask(e.target.value)} placeholder="Nhập yêu cầu…" /></Field>
      <div><Button disabled={busy || !task.trim()} onClick={() => { setBusy(true); setError(''); void api<typeof preview>('/api/memory/preview', 'POST', { task: task.trim() }).then(setPreview).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>Xem thử</Button></div>
      {preview && <div className="text-[12px] text-muted-foreground">{!preview.root ? 'Chưa chọn thư mục memory.' : !preview.records.length ? 'Không có bản ghi phù hợp.' : preview.records.map(record => <p key={`${record.type}/${record.id}`}><strong>{record.id}</strong> · {record.scope} · {record.selectionReason}</p>)}</div>}
    </div>
  </Disclosure>;
}
