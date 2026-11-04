import { useEffect, useState } from 'react';
import { api } from './api';

type Selection = { retrievalMode?: 'lexical' | 'semantic' | 'hybrid'; scopes?: string[]; tags?: string[]; requireTaskMatch?: boolean; inferTaskPaths?: boolean; maxRecords?: number; maxBodyBytes?: number };
export function MemorySelection() {
  const [revision, setRevision] = useState(''), [scopes, setScopes] = useState(''), [tags, setTags] = useState('');
  const [matching, setMatching] = useState(false), [maxRecords, setMaxRecords] = useState(30), [maxBytes, setMaxBytes] = useState(16000);
  const [retrievalMode, setRetrievalMode] = useState<'lexical' | 'semantic' | 'hybrid'>('lexical');
  const [inferPaths, setInferPaths] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
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
      setRevision(data.revision); setMessage('Đã lưu policy cho các run tiếp theo. Run đang chạy giữ snapshot cũ.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <details className="run-card"><summary>Chọn memory cho run</summary>
    <p className="run-note">Để trống scope hoặc tag để không lọc. Scope gồm cả nhánh con; bản ghi phải có tất cả tags.</p>
    {error && <p role="alert">{error} <button type="button" className="text-link" onClick={() => void reload().then(() => setError('')).catch(e => setError(String(e)))}>Tải lại</button></p>}
    {message && <p role="status">{message}</p>}
    <label>Cách tìm nội dung<select value={retrievalMode} onChange={e => setRetrievalMode(e.target.value as typeof retrievalMode)}><option value="lexical">Từ khóa</option><option value="semantic">Ngữ nghĩa cục bộ (LSA)</option><option value="hybrid">Kết hợp từ khóa và LSA</option></select></label><p className="run-note">LSA học quan hệ từ nội dung memory của project, chạy cục bộ, không gửi dữ liệu tới dịch vụ ngoài. Corpus nhỏ hoặc không có từ chung có thể chưa tìm được kết quả.</p>
    <label>Scope (phân tách bằng dấu phẩy)<input value={scopes} onChange={e => setScopes(e.target.value)} /></label>
    <label>Tags bắt buộc (phân tách bằng dấu phẩy)<input value={tags} onChange={e => setTags(e.target.value)} /></label>
    <label><input type="checkbox" checked={matching} onChange={e => setMatching(e.target.checked)} /> Chỉ chọn bản ghi khớp từ khóa task</label>
    <label><input type="checkbox" checked={inferPaths} onChange={e => setInferPaths(e.target.checked)} /> Suy ra đường dẫn liên quan từ task và tên file trong repo</label>
    {inferPaths && <p className="run-note">Tìm cả đường dẫn ghi rõ và tên file/thư mục khớp task. Nếu tìm thấy đường dẫn, chỉ chọn scope project hoặc scope giao với đường dẫn; nếu không tìm thấy thì không lọc theo path.</p>}
    <label>Số bản ghi tối đa<input type="number" min="0" max="30" value={maxRecords} onChange={e => setMaxRecords(Number(e.target.value))} /></label>
    <label>Ngân sách nội dung (bytes)<input type="number" min="0" max="16000" value={maxBytes} onChange={e => setMaxBytes(Number(e.target.value))} /></label>
    <button type="button" className="secondary-btn" disabled={busy || !revision || !Number.isInteger(maxRecords) || maxRecords < 0 || maxRecords > 30 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 16000} onClick={() => void save()}>Lưu policy</button>
  </details>;
}
