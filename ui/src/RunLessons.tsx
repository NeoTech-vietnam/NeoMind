import { useEffect, useState } from 'react';
import { api } from './api';
type Lesson = { proposal: { proposalId: string; record: { body: string; sources: string[] } }; version: number; proposalHash: string; expectedRevision: string | null; promoted: boolean; rejected?: boolean };
export function RunLessons({ runId, onPromoted }: { runId: string; onPromoted?(): void }) {
  const [data, setData] = useState<{ memoryRoot: string | null; proposals: Lesson[] }>({ memoryRoot: null, proposals: [] });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null), [editedBody, setEditedBody] = useState('');
  const refresh = async () => setData(await api(`/api/runs/${runId}/lessons`));
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [runId]);
  if (!data.proposals.length && !error) return null;
  return <div className="run-card"><h3>Lessons đề xuất</h3><p>Chỉ bản bạn duyệt mới được đưa vào memory dùng chung.</p>{error && <div className="alert error" role="alert">{error}</div>}
    {!data.memoryRoot && <p className="run-note">Mở Project memory để chọn thư mục lưu trước khi duyệt.</p>}
    {data.proposals.map(lesson => <div key={lesson.proposal.proposalId}><details><summary>{lesson.proposal.proposalId} · v{lesson.version}{lesson.promoted ? ' · Đã lưu vào memory' : lesson.rejected ? ' · Đã từ chối' : ''}</summary><pre>{lesson.proposal.record.body}</pre><p className="run-note">{lesson.proposal.record.sources.join(', ')}</p></details>
      {!lesson.promoted && !lesson.rejected && <>{editing === lesson.proposal.proposalId ? <><label>Nội dung bản đề xuất mới<textarea aria-label="Nội dung lesson" rows={6} value={editedBody} onChange={e => setEditedBody(e.target.value)} /></label><button className="secondary-btn" disabled={busy || !editedBody.trim()} onClick={() => { setBusy(true); setError(''); void api(`/api/runs/${runId}/lessons/revise`, 'POST', { proposalId: lesson.proposal.proposalId, proposalHash: lesson.proposalHash, body: editedBody }).then(async () => { await refresh(); setEditing(null); onPromoted?.(); }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>Lưu phiên bản mới</button><button className="secondary-btn" onClick={() => setEditing(null)}>Hủy chỉnh sửa</button></> : <button className="secondary-btn" disabled={busy} onClick={() => { setEditedBody(lesson.proposal.record.body); setEditing(lesson.proposal.proposalId); }}>Chỉnh sửa</button>}
        <button className="secondary-btn" disabled={busy || !!editing || !data.memoryRoot} onClick={() => { setBusy(true); setError(''); void api(`/api/runs/${runId}/lessons/approve`, 'POST', { proposalId: lesson.proposal.proposalId, proposalHash: lesson.proposalHash, expectedRevision: lesson.expectedRevision, memoryRoot: data.memoryRoot }).then(async () => { await refresh(); onPromoted?.(); }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>Duyệt lesson này</button>
        <button className="secondary-btn" disabled={busy || !!editing} onClick={() => { setBusy(true); setError(''); void api(`/api/runs/${runId}/lessons/reject`, 'POST', { proposalId: lesson.proposal.proposalId, proposalHash: lesson.proposalHash }).then(async () => { await refresh(); onPromoted?.(); }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>Từ chối lesson</button></>}</div>)}
  </div>;
}
