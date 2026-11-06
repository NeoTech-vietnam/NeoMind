import { useEffect, useState } from 'react';
import type { Flow } from '../../src/domain/schema';
import { jsonChanges } from '../../src/domain/json-diff';
import { diffFlows } from '../../src/domain/flow-diff';
import { api } from './api';
import { Dialog, SheetContent } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Field } from './components/ui/input';
import { Select } from './components/ui/select';

/** Compare a published immutable version with the draft currently displayed in the editor. */
export function FlowVersions({ flow, open, onOpenChange }: { flow: Flow; open: boolean; onOpenChange(open: boolean): void }) {
  const [versionInfo, setVersionInfo] = useState<{ version: number; author: { kind: 'human' | 'ai'; reason?: string; sessionId?: string } }[]>([]);
  const [versions, setVersions] = useState<number[]>([]), [selected, setSelected] = useState(''), [published, setPublished] = useState<Flow | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true; setVersions([]); setVersionInfo([]); setSelected(''); setPublished(null); setError('');
    void api<{ versions: number[]; versionInfo?: { version: number; author: { kind: 'human' | 'ai'; reason?: string; sessionId?: string } }[] }>(`/api/flows/${encodeURIComponent(flow.flowId)}/versions`).then(data => { if (current) { setVersions(data.versions); setVersionInfo(data.versionInfo ?? []); setSelected(data.versions.length ? String(Math.max(...data.versions)) : ''); } }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [flow.flowId, reload, open]);
  useEffect(() => {
    if (!selected) { setPublished(null); return; }
    let current = true; setPublished(null); setError('');
    void api<{ version: Flow }>(`/api/flows/${encodeURIComponent(flow.flowId)}/versions?version=${encodeURIComponent(selected)}`).then(data => { if (current) setPublished(data.version); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [flow.flowId, selected]);
  const [diffLimit, setDiffLimit] = useState(200);
  useEffect(() => setDiffLimit(200), [flow.flowId, selected]);
  const diff = published ? diffFlows(published, flow) : null;
  const added = diff?.nodes.added.map(node => node.id) ?? [], removed = diff?.nodes.removed.map(node => node.id) ?? [], changed = diff?.nodes.changed.map(node => node.id) ?? [];
  const selectedAuthor = versionInfo.find(item => String(item.version) === selected)?.author;
  const details = published ? jsonChanges({ name: published.name, description: published.description, definition: published.definition, layout: published.layout }, { name: flow.name, description: flow.description, definition: flow.definition, layout: flow.layout }, diffLimit) : null;
  const value = (item: unknown) => item === undefined ? '(không có)' : JSON.stringify(item, null, 2);
  return <Dialog open={open} onOpenChange={onOpenChange}><SheetContent title="So sánh phiên bản"><div className="flow-versions">
    <Button size="sm" onClick={() => setReload(value => value + 1)}>Cập nhật danh sách</Button>
    <Field label="Phiên bản" className="mt-3"><Select label="Phiên bản" value={selected} placeholder="Chọn phiên bản" onValueChange={setSelected} options={versions.map(version => ({ value: String(version), label: `v${version} · ${versionInfo.find(item => item.version === version)?.author.kind === 'ai' ? 'AI' : 'Người'}${versionInfo.find(item => item.version === version)?.author.reason ? ` · ${versionInfo.find(item => item.version === version)!.author.reason}` : ''}` }))} /></Field>
    {!versions.length && <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">Chưa có phiên bản đã lưu.</p>}{error && <p role="alert">{error}</p>}
    {published && <div><div className="studio-version-summary"><span>{added.length} bước mới</span><span>{removed.length} đã xóa</span><span>{changed.length} bước đổi</span><span>Kết nối: {diff?.edges.added.length ?? 0} thêm · {diff?.edges.removed.length ?? 0} xóa</span><span>Vị trí: {JSON.stringify(published.layout) === JSON.stringify(flow.layout) ? 'không đổi' : 'đã đổi'}</span></div>
      {!!added.length && <p>Thêm: {added.join(', ')}</p>}{!!removed.length && <p>Xóa: {removed.join(', ')}</p>}{!!changed.length && <p>Sửa: {changed.join(', ')}</p>}
      <p>Binding: {diff?.bindings.length ?? 0} thay đổi · Giới hạn: {diff?.limits.length ?? 0} thay đổi</p>{selectedAuthor && <p>Tác giả: {selectedAuthor.kind === 'ai' ? 'AI' : 'Người'}{selectedAuthor.sessionId ? ` · ${selectedAuthor.sessionId}` : ''}{selectedAuthor.reason ? ` · ${selectedAuthor.reason}` : ''}</p>}
      {details && <details><summary>Thay đổi từng thuộc tính ({details.changes.length}{details.truncated ? '+' : ''})</summary>
        {details.changes.map((item, index) => <div key={`${item.path}-${index}`}><strong>{item.path}</strong><p>Trước:</p><pre>{value(item.before)}</pre><p>Sau:</p><pre>{value(item.after)}</pre></div>)}
        {details.truncated && <Button size="sm" onClick={() => setDiffLimit(value => value + 200)}>Hiện thêm 200 thay đổi</Button>}</details>}
    </div>}
  </div></SheetContent></Dialog>;
}
