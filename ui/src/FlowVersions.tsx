import { useEffect, useState } from 'react';
import type { Flow } from '../../src/domain/schema';
import { api } from './api';

/** Compare a published immutable version with the draft currently displayed in the editor. */
export function FlowVersions({ flow }: { flow: Flow }) {
  const [versions, setVersions] = useState<number[]>([]), [selected, setSelected] = useState(''), [published, setPublished] = useState<Flow | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; setVersions([]); setSelected(''); setPublished(null); setError('');
    void api<{ versions: number[] }>(`/api/flows/${encodeURIComponent(flow.flowId)}/versions`).then(data => { if (current) setVersions(data.versions); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [flow.flowId, reload]);
  useEffect(() => {
    if (!selected) { setPublished(null); return; }
    let current = true; setPublished(null); setError('');
    void api<{ version: Flow }>(`/api/flows/${encodeURIComponent(flow.flowId)}/versions?version=${encodeURIComponent(selected)}`).then(data => { if (current) setPublished(data.version); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [flow.flowId, selected]);
  const previous = new Map(published?.definition.nodes.map(node => [node.id, node]) ?? []), current = new Map(flow.definition.nodes.map(node => [node.id, node]));
  const added = [...current.keys()].filter(id => !previous.has(id)), removed = [...previous.keys()].filter(id => !current.has(id));
  const changed = [...current.keys()].filter(id => previous.has(id) && JSON.stringify(previous.get(id)) !== JSON.stringify(current.get(id)));
  return <details className="flow-versions"><summary>So sánh phiên bản đã lưu</summary>
    <button type="button" className="secondary-btn small" onClick={() => setReload(value => value + 1)}>Cập nhật danh sách</button>
    <label>Phiên bản <select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Chọn phiên bản</option>{versions.map(version => <option key={version} value={version}>v{version}</option>)}</select></label>
    {!versions.length && <p className="hint">Chưa có phiên bản đã lưu.</p>}{error && <p role="alert">{error}</p>}
    {published && <div><p>So với v{selected}: {added.length} bước mới · {removed.length} đã xóa · {changed.length} thay đổi</p>
      {!!added.length && <p>Thêm: {added.join(', ')}</p>}{!!removed.length && <p>Xóa: {removed.join(', ')}</p>}{!!changed.length && <p>Sửa: {changed.join(', ')}</p>}
      <p>Kết nối: {JSON.stringify(published.definition.edges) === JSON.stringify(flow.definition.edges) ? 'không đổi' : 'đã thay đổi'} · Binding: {JSON.stringify(published.definition.bindings) === JSON.stringify(flow.definition.bindings) ? 'không đổi' : 'đã thay đổi'} · Vị trí: {JSON.stringify(published.layout) === JSON.stringify(flow.layout) ? 'không đổi' : 'đã thay đổi'}</p>
    </div>}
  </details>;
}
