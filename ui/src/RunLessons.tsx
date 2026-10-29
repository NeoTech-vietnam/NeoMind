import { useEffect, useState } from 'react';
import { api } from './api';
type Lesson = { proposal: { proposalId: string; record: { body: string; sources: string[] } }; proposalHash: string; expectedRevision: string | null; promoted: boolean };
export function RunLessons({ runId }: { runId: string }) {
  const [data, setData] = useState<{ memoryRoot: string | null; proposals: Lesson[] }>({ memoryRoot: null, proposals: [] });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = async () => setData(await api(`/api/runs/${runId}/lessons`));
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [runId]);
  if (!data.proposals.length && !error) return null;
  return <div className="run-card"><h3>Lessons đề xuất</h3><p>Chỉ bản bạn duyệt mới được đưa vào memory dùng chung.</p>{error && <div className="alert error" role="alert">{error}</div>}
    {!data.memoryRoot && <p className="run-note">Mở Project memory để chọn thư mục lưu trước khi duyệt.</p>}
    {data.proposals.map(lesson => <div key={lesson.proposal.proposalId}><details><summary>{lesson.proposal.proposalId}{lesson.promoted ? ' · Đã lưu vào memory' : ''}</summary><pre>{lesson.proposal.record.body}</pre><p className="run-note">{lesson.proposal.record.sources.join(', ')}</p></details>
      {!lesson.promoted && <button className="secondary-btn" disabled={busy || !data.memoryRoot} onClick={() => { setBusy(true); setError(''); void api(`/api/runs/${runId}/lessons/approve`, 'POST', { proposalId: lesson.proposal.proposalId, proposalHash: lesson.proposalHash, expectedRevision: lesson.expectedRevision, memoryRoot: data.memoryRoot }).then(refresh).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>Duyệt lesson này</button>}</div>)}
  </div>;
}
