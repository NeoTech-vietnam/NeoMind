import { useEffect, useState } from 'react';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Callout } from '@/components/ui/misc';
import { api } from './api';
import { RunMonitor } from './RunMonitor';
import type { Run } from './runTypes';

/** The run a memory record came from, opened beside the Memory page; the run list does not need to change page. */
export function SourceRunSheet({ runId, onClose }: { runId: string | null; onClose(): void }) {
  const [run, setRun] = useState<Run | null>(null), [error, setError] = useState('');
  useEffect(() => {
    setRun(null); setError('');
    if (runId) void api<Run>(`/api/runs/${runId}`).then(setRun, e => setError(e instanceof Error ? e.message : String(e)));
  }, [runId]);
  return <Dialog open={!!runId} onOpenChange={open => { if (!open) onClose(); }}><SheetContent className="w-[min(1040px,100%)]" title="Run nguồn" description={runId ?? undefined}>
    <div className="p-4">{error ? <Callout tone="danger">Không mở được run {runId}: {error}</Callout> : run ? <RunMonitor run={run} setRun={setRun} /> : <p className="m-0 text-[12.5px] text-muted-foreground">Đang tải run…</p>}</div>
  </SheetContent></Dialog>;
}
