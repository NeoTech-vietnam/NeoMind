import { useEffect, useState } from 'react';
import { api } from './api';
type Record = { revision: string; body: string; header: { id: string; type: 'context' | 'decision' | 'lesson'; scope: string; sources: string[]; tags: string[] } };
export function MemoryPanel() {
  const [memory, setMemory] = useState<{ root: string | null; records: Record[] }>({ root: null, records: [] });
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [id, setId] = useState(''), [type, setType] = useState<'context' | 'decision'>('context'), [scope, setScope] = useState('project');
  const [text, setText] = useState(''), [sources, setSources] = useState(''), [tags, setTags] = useState(''), [revision, setRevision] = useState<string | null>(null), [externalRoot, setExternalRoot] = useState('');
  async function refresh() { setMemory(await api(`/api/memory${query ? `?q=${encodeURIComponent(query)}` : ''}`)); }
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  return <section className="runs-page"><div className="page-heading"><div><h1>Project memory</h1><p>Context, quyết định và lessons dùng chung cho các frontend.</p></div></div>
    {error && <div className="alert error" role="alert">{error}</div>}{message && <div className="alert success">{message}</div>}
    <div className="run-card"><h3>Memory root</h3>{memory.root ? <p><code>{memory.root}</code></p> : <p>Chưa chọn memory root. Run vẫn có thể chạy và lưu kết quả riêng.</p>}
      {!memory.root && <button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { setMemory(await api('/api/memory/configure', 'POST', { initializeDefault: true, expectedPrevious: null })); })}>Khởi tạo memory trong project</button>}
      <details><summary>Chọn thư mục memory đã có</summary><label>Đường dẫn tuyệt đối<input value={externalRoot} onChange={e => setExternalRoot(e.target.value)} /></label><button className="secondary-btn" disabled={busy || !externalRoot.trim()} onClick={() => void action(async () => { setMemory(await api('/api/memory/configure', 'POST', { root: externalRoot, initializeDefault: false, expectedPrevious: memory.root })); })}>Dùng thư mục này</button></details>
      <p className="run-note">Run ghim nội dung đã duyệt và revision khi bắt đầu. Cập nhật sau đó áp dụng cho run mới.</p></div>
    {memory.root && <div className="runs-layout"><aside className="runs-history"><label>Tìm memory<input value={query} onChange={e => setQuery(e.target.value)} /></label><button className="secondary-btn" disabled={busy} onClick={() => void action(refresh)}>Tìm</button>{memory.records.map(record => <button key={`${record.header.type}/${record.header.id}`} className="run-history-item" onClick={() => {
      if (record.header.type === 'lesson') { setMessage('Lesson đã duyệt. Xem nội dung bên dưới; lesson mới cần được đề xuất và duyệt từ run.'); return; }
      setId(record.header.id); setType(record.header.type); setScope(record.header.scope); setSources(record.header.sources.join('\n')); setTags(record.header.tags.join(', ')); setText(record.body); setRevision(record.revision);
    }}><strong>{record.header.id}</strong><small>{record.header.type} · {record.header.scope}</small></button>)}</aside>
      <div className="run-content"><form className="run-card" onSubmit={e => { e.preventDefault(); void action(async () => {
        const result = await api<{ record: Record }>('/api/memory', 'POST', { record: { id, type, scope, sources: sources.split('\n').map(value => value.trim()).filter(Boolean), tags: tags.split(',').map(value => value.trim()).filter(Boolean), body: text }, expectedRevision: revision });
        setRevision(result.record.revision); setMessage('Đã lưu memory kèm receipt xác nhận');
      }); }}><h3>{revision ? 'Cập nhật bản ghi' : 'Tạo bản ghi'}</h3><label>ID<input required value={id} onChange={e => { setId(e.target.value); setRevision(null); }} pattern="[a-z0-9][a-z0-9-]*" /></label><label>Loại<select aria-label="Loại memory" value={type} onChange={e => { setType(e.target.value as 'context' | 'decision'); setRevision(null); }}><option value="context">Context có nguồn</option><option value="decision">Quyết định tôi xác nhận</option></select></label><label>Phạm vi<input required value={scope} onChange={e => setScope(e.target.value)} /></label><label>Nội dung<textarea required rows={6} value={text} onChange={e => setText(e.target.value)} /></label><label>Nguồn (mỗi dòng một nguồn)<textarea required rows={3} value={sources} onChange={e => setSources(e.target.value)} /></label><label>Tags (ngăn bằng dấu phẩy)<input value={tags} onChange={e => setTags(e.target.value)} /></label><button className="primary-btn" disabled={busy}>{type === 'decision' ? 'Xác nhận quyết định và lưu' : 'Lưu context'}</button> <button type="button" className="secondary-btn" onClick={() => { setId(''); setText(''); setSources(''); setTags(''); setRevision(null); }}>Bản ghi mới</button></form>
        {memory.records.filter(record => record.header.type === 'lesson').map(record => <div className="run-card" key={record.header.id}><h3>Lesson · {record.header.id}</h3><pre>{record.body}</pre><p className="run-note">{record.header.sources.join(', ')}</p></div>)}
      </div></div>}
  </section>;
}
