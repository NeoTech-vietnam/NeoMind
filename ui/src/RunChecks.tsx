import { Check, CircleHelp, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { verdictInfo } from './format';
import { modelLabel, reasoningLabel, runnerLabel } from './runners';
import { bindingLabel, effectiveBindings, type Run } from './runTypes';
import type { Flow } from '../../src/domain/schema';

type ReviewOutput = Run['reviewerOutputs'][number];

function Criteria({ output }: { output: ReviewOutput }) {
  if (!output.evidence) return null;
  return <>
    <ul className="m-0 mt-2 flex list-none flex-col overflow-hidden rounded-md border p-0">{output.evidence.criteria.map(item => {
      // For a criterion `unresolved` means the reviewer could not confirm it (a check being unresolved means it is still running).
      const info = item.status === 'unresolved' ? { label: 'Chưa xác nhận', status: 'attention' as const } : verdictInfo(item.status), status = info.status;
      return <li key={item.criterion} className={cn('flex items-start gap-2 border-b px-2.5 py-1.5 text-[12.5px] last:border-b-0', status === 'danger' && 'bg-danger/10', status === 'attention' && 'bg-attention/10')}>
        <span className="mt-0.5 shrink-0">{status === 'success' ? <Check className="size-3.5 text-success" /> : status === 'danger' ? <X className="size-3.5 text-danger" /> : <CircleHelp className="size-3.5 text-attention" />}</span>
        <span className="min-w-0 flex-1">{item.criterion}</span>{status !== 'success' && <span className={cn('shrink-0 text-[11.5px]', status === 'danger' ? 'text-danger' : 'text-attention')}>{info.label}</span>}</li>;
    })}</ul>
    {output.evidence.findings.map(finding => <p key={finding.id} className="m-0 mt-2 text-[12.5px] leading-relaxed"><code className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">{finding.id}</code><span className="text-muted-foreground">{finding.criterion}:</span> {finding.explanation}</p>)}
  </>;
}

/** Checks and independent review: the latest verdict of each reviewer in full, earlier rounds folded away. */
export function RunChecks({ run, flow }: { run: Run; flow: Flow | undefined }) {
  const bindings = effectiveBindings(run), checkOutputs = run.artifacts.filter(item => item.kind === 'check'), reviews = run.reviewerOutputs;
  const agentLine = (key: string) => { const values = bindings.get(key); return values ? `${runnerLabel(values.runner)} · ${modelLabel(values.model)} · ${reasoningLabel(values.reasoning)}` : ''; };
  const latest = reviews.filter((output, index) => !reviews.slice(index + 1).some(item => item.nodeId === output.nodeId && item.result.reviewerId === output.result.reviewerId));
  const earlier = reviews.filter(output => !latest.includes(output));
  return <section className="overflow-hidden rounded-lg border bg-card">
    <div className="flex items-baseline gap-2 border-b px-4 py-3"><h3 className="m-0 text-[14px] font-semibold">Kiểm tra</h3><span className="text-[12px] text-muted-foreground">checks + review độc lập</span>
      {run.acceptedReviews.length > 0 && <Badge status="success" className="ml-auto">Review đã chấp nhận</Badge>}</div>
    {run.checks.map(check => { const verdict = verdictInfo(check.status), output = [...checkOutputs].reverse().find(item => item.text.startsWith(`${check.command}\n`));
      return <div key={check.checkId} className="grid grid-cols-[116px_minmax(0,1fr)] items-start gap-3 border-b px-4 py-3 last:border-b-0"><Badge status={verdict.status} className="justify-self-start">{verdict.label}</Badge>
        <div className="min-w-0"><code className="font-mono text-[12.5px] font-semibold">{check.command}</code>
          {output && <Disclosure className="-mx-4" title={<span className="text-[12px] font-normal text-muted-foreground">Output</span>}><pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-code p-2.5 font-mono text-[11.5px]">{output.text}</pre></Disclosure>}</div></div>; })}
    {latest.map(output => { const verdict = verdictInfo(output.result.verdict), key = `${output.nodeId}/${output.result.reviewerId}`, turns = reviews.filter(item => item.nodeId === output.nodeId && item.result.reviewerId === output.result.reviewerId).length;
      return <div key={output.attemptId} className="grid grid-cols-[116px_minmax(0,1fr)] items-start gap-3 border-b px-4 py-3 last:border-b-0"><Badge status={verdict.status} className="justify-self-start">{verdict.label}</Badge>
        <div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2"><strong className="text-[13px]">{bindingLabel(key, flow)}</strong><span className="text-[12px] text-muted-foreground">{agentLine(key)}{turns > 1 ? ` · lượt ${turns}` : ''}</span></div>
          <p className="m-0 mt-1 text-[13px] leading-relaxed text-fg-2">{output.summary}</p><Criteria output={output} /></div></div>; })}
    {earlier.length > 0 && <Disclosure className="border-t" title={<span className="text-[12px] font-normal text-muted-foreground">{earlier.length} lượt review trước</span>}>
      <div className="flex flex-col gap-3">{earlier.map(output => { const verdict = verdictInfo(output.result.verdict);
        return <div key={output.attemptId} className="text-[12.5px]"><Badge status={verdict.status}>{verdict.label}</Badge><span className="ml-2 font-medium">{bindingLabel(`${output.nodeId}/${output.result.reviewerId}`, flow)}</span>
          <p className="m-0 mt-1 text-muted-foreground">{output.summary}</p></div>; })}</div></Disclosure>}
  </section>;
}
