import { Check, Circle, Clock, X } from 'lucide-react';
import { StatusDot, type Status } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatClock, statusInfo } from './format';
import type { Listing, SessionTarget } from './RunActivity';
import { latestAttempt } from './RunActivity';
import { modelLabel } from './runners';
import { repairRounds, stepState, type Step } from './runSteps';
import { effectiveBindings, type Run } from './runTypes';
import type { Flow } from '../../src/domain/schema';

const bar: Record<Status, string> = { success: 'bg-success', running: 'bg-running', attention: 'bg-attention', danger: 'bg-danger', idle: 'bg-border' };
const icon: Record<Status, React.ReactNode> = {
  success: <Check className="size-3.5 text-success" />, running: <StatusDot status="running" className="mx-[3px]" />, attention: <Clock className="size-3.5 text-attention" />,
  danger: <X className="size-3.5 text-danger" />, idle: <Circle className="size-3 text-faint" />,
};

/** Second line of a step: how long it took, how many rounds it used, or which model is waiting to run. */
function detail(step: Step, run: Run, flow: Flow, listing: Listing, now: number): string {
  const state = stepState(step, run), phase = run.runtimeState?.phase, node = step.node;
  if (state.interrupted) return 'Dừng giữa chừng';
  const attempts = listing.transcripts.filter(item => step.nodeIds.includes(item.meta.nodeId));
  const ms = attempts.reduce((sum, item) => sum + Math.max(0, (item.endedAt ?? now) - (item.startedAt ?? now)), 0);
  const time = attempts.length ? formatClock(ms) : '';
  const bindings = effectiveBindings(run);
  if (node.type === 'repair_scope') { const rounds = repairRounds(run, flow); return rounds ? `${state.status === 'skipped' || (state.status === 'pending' && phase === 'completed') ? 'Không cần · ' : ''}${rounds.used}/${rounds.max} vòng` : ''; }
  if (node.type === 'approval') return state.status === 'succeeded' ? (run.approvals?.at(-1)?.approval.source === 'flow' ? 'Tự duyệt' : 'Bạn duyệt') : state.status === 'waiting' ? 'Chờ bạn' : '';
  if (state.status === 'running') return [step.branches ? `${step.branches} nhánh` : 'đang chạy', time].filter(Boolean).join(' · ');
  if (state.status === 'succeeded') return [attempts.length > 1 ? `${attempts.length} lượt` : '', time].filter(Boolean).join(' · ') || (node.type === 'git_commit' ? 'Đã commit' : '');
  if (state.status === 'failed') return 'Lỗi';
  if (state.status === 'waiting') return 'Chờ bạn';
  const values = node.type === 'review_group' ? bindings.get(`${node.id}/${node.reviewers[0]!.id}`) : bindings.get(step.nodeIds[0]!);
  return values ? modelLabel(values.model) : node.type === 'git_commit' ? 'Chờ' : '';
}

/** Horizontal progress of the run: one bar per step, colored by the step's state; a step with a session opens it. */
export function RunStepper({ run, flow, steps, listing, now, openSession }: { run: Run; flow: Flow; steps: Step[]; listing: Listing; now: number; openSession(target: SessionTarget): void }) {
  return <ol className="m-0 grid list-none grid-flow-col auto-cols-[minmax(88px,1fr)] gap-2 overflow-x-auto p-0 pb-0.5" aria-label="Các bước của run">{steps.map(step => {
    const state = stepState(step, run), info = state.interrupted ? { label: 'Dừng giữa chừng', status: 'attention' as Status } : statusInfo(state.status);
    const attempt = step.nodeIds.map(id => latestAttempt(listing, id)).filter(Boolean).at(-1), text = detail(step, run, flow, listing, now);
    const body = <>
      <span className={cn('block h-[3px] rounded-full', bar[info.status])} />
      <span className="mt-2 flex items-start gap-1.5"><span className="mt-px grid size-3.5 shrink-0 place-items-center">{icon[info.status]}</span>
        <span className={cn('text-[12.5px] leading-tight', info.status === 'idle' ? 'text-muted-foreground' : 'font-semibold text-foreground')}>{step.label}</span></span>
      <span className="mt-0.5 block truncate pl-5 text-[11.5px] text-muted-foreground">{text || info.label}</span></>;
    return <li key={step.id} aria-label={`${step.label}: ${info.label}`} className="min-w-0">{attempt
      ? <button type="button" title="Xem session" onClick={() => openSession(attempt)} className="block w-full cursor-pointer rounded-md border-0 bg-transparent p-0 pb-1 text-left font-sans outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring">{body}</button>
      : <div className="pb-1">{body}</div>}</li>;
  })}</ol>;
}
