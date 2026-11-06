import { useState } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { Badge, StatusDot, type Status } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Callout } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { api } from './api';
import { confirmAction } from './dialog';

export type ProgramPhase = { id: string; title: string; flowId: string; dependsOn: string[]; status: string; reason: string; runId?: string; runs: string[]; commits?: string[]; note?: string };
export type ProgramSummary = { programId: string; name: string; goal: string; progress: { delivered: number; total: number }; currentPhaseId?: string; nextReady: string | null; phases: ProgramPhase[] };

const phaseStatus: Record<string, { label: string; status: Status }> = {
  blocked_by_dependency: { label: 'Chờ giai đoạn trước', status: 'idle' }, ready: { label: 'Sẵn sàng', status: 'attention' },
  running: { label: 'Đang chạy', status: 'running' }, waiting_user: { label: 'Cần bạn', status: 'attention' },
  delivered: { label: 'Đã giao', status: 'success' }, failed: { label: 'Không thành công', status: 'danger' },
};
const statusOf = (status: string) => phaseStatus[status] ?? { label: status, status: 'idle' as Status };

/** One program in the Runs list: progress, the current phase and the button that starts the next ready phase. */
function ProgramRow({ program, select }: { program: ProgramSummary; select(): void }) {
  const current = program.phases.find(phase => phase.id === program.currentPhaseId), info = statusOf(current?.status ?? (program.progress.delivered === program.progress.total ? 'delivered' : 'blocked_by_dependency'));
  return <button type="button" onClick={select} className="flex w-full cursor-pointer items-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left font-sans outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
    <StatusDot status={info.status} className="mt-[5px]" />
    <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium text-foreground">{program.name}</span><span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{program.progress.delivered}/{program.progress.total}</span></span>
      <span className="block truncate text-[11.5px] text-muted-foreground">{current ? `${current.title} · ${info.label}` : 'Đã giao đủ'}</span></span>
    <ChevronRight className="mt-[3px] size-3.5 shrink-0 text-faint" />
  </button>;
}

/** The "Chương trình" group above the runs; a phase never starts by itself, only through this button or `program_next`. */
export function RunPrograms({ programs, open, changed }: { programs: ProgramSummary[]; open(runId: string): void; changed(runId?: string): void }) {
  const [selected, setSelected] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const program = programs.find(item => item.programId === selected);
  async function next(item: ProgramSummary) {
    const phase = item.phases.find(value => value.id === item.nextReady);
    if (!phase || !await confirmAction({ title: `Bắt đầu giai đoạn "${phase.title}"?`, description: 'Kết quả các giai đoạn trước phải đã có trong branch hiện tại. Task của giai đoạn kèm bài học từ các giai đoạn trước.', confirmLabel: 'Bắt đầu' })) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ started: boolean; runId?: string; blockers?: string[]; reason?: string }>(`/api/programs/${encodeURIComponent(item.programId)}/next`, 'POST', {});
      if (result.started && result.runId) { setSelected(null); changed(result.runId); }
      else setError(result.blockers?.join(' ') ?? result.reason ?? 'Không bắt đầu được giai đoạn');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  if (!programs.length) return null;
  return <section className="mt-1">
    <div className="flex h-6 items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Chương trình<span className="font-normal tabular-nums text-faint">{programs.length}</span></div>
    <div className="flex flex-col gap-px">{programs.map(item => <div key={item.programId}>
      <ProgramRow program={item} select={() => { setError(''); setSelected(item.programId); }} />
      {item.nextReady && <div className="px-2.5 pb-1.5 pl-[26px]"><Button size="sm" disabled={busy} onClick={() => void next(item)}><Play />Bắt đầu giai đoạn tiếp theo</Button></div>}
    </div>)}</div>
    <Dialog open={!!program} onOpenChange={value => { if (!value) setSelected(null); }}>
      {program && <SheetContent title={program.name} description={program.goal}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2"><span className="flex-1 text-[12px] text-muted-foreground">Đã giao {program.progress.delivered}/{program.progress.total} giai đoạn</span>
            {program.nextReady && <Button variant="primary" size="sm" disabled={busy} onClick={() => void next(program)}><Play />Bắt đầu giai đoạn tiếp theo</Button>}</div>
          {error && <Callout tone="danger">{error}</Callout>}
          <ol className="m-0 flex list-none flex-col gap-2 p-0">{program.phases.map((phase, index) => { const info = statusOf(phase.status);
            return <li key={phase.id} className={cn('rounded-md border p-3', phase.id === program.currentPhaseId && 'border-foreground/40')}>
              <div className="flex items-center gap-2"><span className="text-[12px] tabular-nums text-faint">{index + 1}</span><strong className="min-w-0 flex-1 truncate text-[13px]">{phase.title}</strong><Badge status={info.status}>{info.label}</Badge></div>
              <p className="m-0 mt-1 text-[12px] text-muted-foreground">{phase.reason}{phase.dependsOn.length ? ` · sau ${phase.dependsOn.join(', ')}` : ''} · flow {phase.flowId}</p>
              {phase.note && <p className="m-0 mt-1 text-[12px] text-fg-2">Ghi chú: {phase.note}</p>}
              {phase.commits?.length ? <p className="m-0 mt-1 font-mono text-[11.5px] text-muted-foreground">{phase.commits.map(commit => commit.slice(0, 12)).join(', ')}</p> : null}
              {phase.runs.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{phase.runs.map((runId, n) => <Button key={runId} size="sm" variant="ghost" onClick={() => { setSelected(null); open(runId); }}>Run {n + 1}{runId === phase.runId ? ' (mới nhất)' : ''}</Button>)}</div>}
            </li>; })}</ol>
        </div>
      </SheetContent>}
    </Dialog>
  </section>;
}
