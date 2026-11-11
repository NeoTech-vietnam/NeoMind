import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Clock, Info, MoreHorizontal, PanelRight, Pause, Shield, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/CopyButton';
import { Disclosure } from '@/components/ui/disclosure';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Callout, Separator } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { api } from './api';
import { confirmAction } from './dialog';
import { artifactLabel, formatDuration, formatTokens, phaseInfo, verdictInfo, workspaceName } from './format';
import { AgentSessions, latestAttempt, LiveActivity, SessionSheet, useTranscripts, type SessionTarget } from './RunActivity';
import { RunChecks } from './RunChecks';
import { RunGraph } from './RunGraph';
import { RunLessons } from './RunLessons';
import { RememberButton, RunMemoryUsed } from './RunMemory';
import { PlanBody } from './RunPlan';
import { RunCost, RunDelivery, RunHandoff } from './RunResult';
import { RunStepper } from './RunStepper';
import { modelLabel, runnerLabel } from './runners';
import { flowSteps, repairRounds } from './runSteps';
import { bindingLabel, effectiveBindings, type BindingValues, type Run } from './runTypes';
import type { Flow } from '../../src/domain/schema';
import { rerunDraft } from '../../src/domain/rerun';

const agentLine = (values: BindingValues | undefined) => values ? `${runnerLabel(values.runner)} · ${modelLabel(values.model)}` : '';

/** One-line facts for the "why did the run stop" card: checks, review, repair rounds, commit. */
function stopFacts(run: Run, flow: Flow) {
  const facts: { text: string; tone: 'success' | 'attention' | 'danger' | 'idle' }[] = [];
  if (run.checks.length) {
    const failed = run.checks.filter(check => check.status === 'failed').length, pending = run.checks.filter(check => check.status === 'unresolved').length;
    facts.push(failed ? { text: `Checks lỗi ${failed}/${run.checks.length}`, tone: 'danger' } : pending ? { text: 'Checks chưa xong', tone: 'attention' } : { text: 'Checks đạt', tone: 'success' });
  }
  const latest = run.reviewerOutputs.filter((output, index) => !run.reviewerOutputs.slice(index + 1).some(item => item.nodeId === output.nodeId && item.result.reviewerId === output.result.reviewerId));
  const criteria = latest.flatMap(output => output.evidence?.criteria ?? []);
  if (criteria.length) {
    const passed = criteria.filter(item => verdictInfo(item.status).status === 'success').length;
    facts.push({ text: `Review ${passed}/${criteria.length} tiêu chí · ${run.reviewerOutputs.length} lượt`, tone: passed === criteria.length ? 'success' : 'attention' });
  } else if (latest.length) facts.push({ text: `Review: ${verdictInfo(latest[0]!.result.verdict).label}`, tone: verdictInfo(latest[0]!.result.verdict).status === 'success' ? 'success' : 'attention' });
  const rounds = repairRounds(run, flow);
  if (rounds) facts.push({ text: `Vòng sửa ${rounds.used}/${rounds.max}${rounds.used >= rounds.max ? ' · đã dùng hết' : ''}`, tone: rounds.used >= rounds.max ? 'attention' : 'idle' });
  if (!(run.delivery ?? []).length && flow.definition.nodes.some(node => node.type === 'git_commit')) facts.push({ text: 'Chưa commit · worktree giữ nguyên', tone: 'idle' });
  return facts;
}
const factTone = { success: 'text-success', attention: 'text-attention', danger: 'text-danger', idle: 'text-muted-foreground' };

export function RunMonitor({ run, setRun, rerun, remove }: { run: Run; setRun(run: Run): void; rerun?(): void; remove?(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState(''), [extraMinutes, setExtraMinutes] = useState(10);
  // Bumped when "Ghi nhớ điều này" adds a proposal, so the run's proposal list reloads.
  const [proposalsVersion, setProposalsVersion] = useState(0);
  const phase = run.runtimeState?.phase ?? 'recovering', info = phaseInfo(phase), flow = run.snapshot?.configuration.flow;
  const bindings = effectiveBindings(run), plan = run.plans.at(-1)?.plan;
  const timeLimitMs = run.timeLimitMs ?? (flow?.definition.limits.activeTimeSeconds ?? 0) * 1000 + run.timeExtensionsMs;
  const activeMs = run.runtimeState?.activeMs ?? 0, timeExhausted = timeLimitMs > 0 && activeMs >= timeLimitMs;
  // The token budget is optional (flow `limits.maxTokens`); the run pauses between steps once it is used up.
  const tokenLimit = run.tokenLimit ?? null, tokensUsed = run.usage.totalTokens ?? 0, tokensExhausted = tokenLimit !== null && tokensUsed >= tokenLimit && !timeExhausted;
  const [extraTokens, setExtraTokens] = useState(() => Math.max(10_000, Math.round((tokenLimit ?? 0) / 2 / 1000) * 1000));
  const locked = busy || run.busy, running = phase === 'running';
  const listing = useTranscripts(run.runId, running), [session, setSession] = useState<SessionTarget | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  const steps = useMemo(() => flowSteps(flow), [flow]);
  async function act(path: string, body?: unknown, after?: () => void) {
    setBusy(true); setError('');
    try { setRun(await api<Run>(`/api/runs/${run.runId}/${path}`, 'POST', body)); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const sharedWorkspace = !!run.runtimeContext?.workspaceMode && run.runtimeContext.workspaceMode !== 'isolated';
  const cleanup = run.workspaceCleanup, cleaned = !!cleanup?.cleaned, finished = phase === 'completed' || phase === 'cancelled';
  /** Remove the run's worktrees; when changes would be lost, ask before discarding them. */
  async function cleanWorktree() {
    setBusy(true); setError('');
    try { setRun(await api<Run>(`/api/runs/${run.runId}/clean`, 'POST', { force: false })); }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.startsWith('Run còn thay đổi')) { setError(message); return; }
      if (!await confirmAction({ title: 'Vẫn dọn worktree?', description: `${message}\n\nThay đổi được lưu trong ref snapshot của run; file bị ignore sẽ bị xóa.`, confirmLabel: 'Vẫn dọn', danger: true })) return;
      try { setRun(await api<Run>(`/api/runs/${run.runId}/clean`, 'POST', { force: true })); } catch (again) { setError(again instanceof Error ? again.message : String(again)); }
    } finally { setBusy(false); }
  }
  const cancel = () => void confirmAction({ title: 'Hủy run?', description: 'Thay đổi trong worktree của run được giữ lại; bạn có thể xem diff hoặc dọn worktree sau.', confirmLabel: 'Hủy run', cancelLabel: 'Giữ run chạy', danger: true }).then(ok => { if (ok) void act('cancel'); });
  const lastSession = listing.transcripts.at(-1), canWorktreeClean = finished && !sharedWorkspace && !cleaned;
  const reason = run.runtimeState?.reason ?? '', commitFailed = run.unresolvedCommitNodeIds.length > 0;
  const imported = phase === 'blocked' && reason.startsWith('Chồng lên thay đổi có sẵn');
  const stopped = !finished && !running && phase !== 'waiting_approval' && phase !== 'stopping';
  const canResume = ['paused', 'blocked', 'recovering'].includes(phase) && !commitFailed && !timeExhausted;
  const agents = flow ? flow.definition.nodes.flatMap(node => node.type === 'review_group' ? [{ label: 'Review', values: bindings.get(`${node.id}/${node.reviewers[0]!.id}`) }]
    : node.type === 'agent_task' && node.outputContract !== 'plan' ? [{ label: 'Thực hiện', values: bindings.get(node.id) }] : []) : [];
  const uniqueAgents = agents.filter((item, index) => item.values && agents.findIndex(other => other.label === item.label) === index);
  const meta = [flow && `${flow.name} v${flow.version}`, workspaceName(run.runtimeContext?.workspaceMode), formatDuration(activeMs), run.usage.totalTokens !== null ? `${formatTokens(run.usage.totalTokens)} tokens${run.usage.partial ? '*' : ''}` : ''].filter(Boolean);
  const facts = flow ? stopFacts(run, flow) : [];

  return <div className="flex flex-col gap-3.5 pb-8">
    <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-80">
        <Badge status={info.status}>{info.label}</Badge>
        <h2 className="m-0 mt-2 text-[18px] font-semibold leading-snug tracking-tight">{run.runtimeContext?.task}</h2>
        <p className="m-0 mt-1 text-[12.5px] text-muted-foreground" title={run.usage.partial ? 'Một số lượt chưa báo token' : undefined}>{meta.join(' · ')}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <RememberButton runId={run.runId} onCreated={() => setProposalsVersion(version => version + 1)} />
        {rerun && rerunDraft(run) && <Button disabled={busy} onClick={rerun}>Chạy lại</Button>}
        {running && <Button disabled={busy} onClick={() => void act('pause')}><Pause />Tạm dừng</Button>}
        {lastSession && !running && phase !== 'waiting_approval' && <Button onClick={() => setSession({ attemptId: lastSession.meta.attemptId, key: lastSession.meta.key, source: 'neomind' })}><PanelRight />Xem session</Button>}
        {!finished && <Button variant="ghost" className="text-danger hover:text-danger" disabled={busy} onClick={cancel}>Hủy run</Button>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Tùy chọn run"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(run.runId)}>Sao chép mã run</DropdownMenuItem>
            {canWorktreeClean && <DropdownMenuItem disabled={locked} onSelect={() => void cleanWorktree()}>Dọn worktree</DropdownMenuItem>}
            {remove && (phase === 'completed' || phase === 'cancelled') && <DropdownMenuItem danger disabled={locked} onSelect={remove}>Xóa run</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
      </div>
    </header>

    {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
    {flow && <RunStepper run={run} flow={flow} steps={steps} listing={listing} now={now} openSession={setSession} />}

    {(running || stopped) && timeLimitMs > 0 && <div className="flex items-center gap-3 text-[12.5px]"><Clock className="size-3.5 text-muted-foreground" /><span className="text-muted-foreground">Thời gian xử lý</span>
      <span className="h-1 w-36 overflow-hidden rounded-full bg-muted"><span className={cn('block h-full rounded-full', timeExhausted ? 'bg-attention' : 'bg-running')} style={{ width: `${Math.min(100, (activeMs / timeLimitMs) * 100)}%` }} /></span>
      <strong className="font-semibold tabular-nums">{Math.floor(activeMs / 60_000)}/{Math.round(timeLimitMs / 60_000)} phút</strong><span className="text-muted-foreground">không tính lúc chờ duyệt</span></div>}
    {(running || stopped) && tokenLimit !== null && <div className="flex items-center gap-3 text-[12.5px]"><Info className="size-3.5 text-muted-foreground" /><span className="text-muted-foreground">Ngân sách token</span>
      <span className="h-1 w-36 overflow-hidden rounded-full bg-muted"><span className={cn('block h-full rounded-full', tokensExhausted ? 'bg-attention' : 'bg-running')} style={{ width: `${Math.min(100, (tokensUsed / tokenLimit) * 100)}%` }} /></span>
      <strong className="font-semibold tabular-nums">{formatTokens(tokensUsed)}/{formatTokens(tokenLimit)}</strong><span className="text-muted-foreground">kiểm giữa các bước</span></div>}

    {phase === 'waiting_approval' && <Callout tone="attention" icon={<Shield />}><strong className="font-semibold text-foreground">Chưa file nào bị sửa.</strong> Duyệt để agent bắt đầu thực hiện.</Callout>}
    {[...bindings.values()].some(values => values.runner === 'opencode') && <Callout tone="attention" icon={<TriangleAlert />}>OpenCode chạy với quyền của tài khoản hiện tại; phạm vi ghi không được bảo đảm.</Callout>}

    {stopped && <section className={cn('flex flex-col gap-3 rounded-lg border px-4 py-3.5', phase === 'blocked' || timeExhausted || tokensExhausted || commitFailed ? 'border-attention/40 bg-card' : 'bg-card')}>
      <div className="flex items-center gap-2"><TriangleAlert className={cn('size-4', phase === 'blocked' || timeExhausted || tokensExhausted || commitFailed ? 'text-attention' : 'text-muted-foreground')} />
        <h3 className="m-0 text-[14px] font-semibold">{timeExhausted ? 'Đã dùng hết thời gian xử lý' : tokensExhausted && !commitFailed ? 'Đã dùng hết ngân sách token' : commitFailed ? 'Commit chưa xong' : phase === 'blocked' ? 'Vì sao run dừng?' : phase === 'paused' ? 'Run đang tạm dừng' : 'Run chờ tiếp tục'}</h3></div>
      {timeExhausted && !commitFailed ? <p className="m-0 text-[13px] leading-relaxed text-fg-2">Run đã dùng hết {Math.round(timeLimitMs / 60_000)} phút xử lý. Thêm thời gian để agent làm tiếp từ bước đang dừng; thay đổi trong worktree vẫn được giữ.</p>
        : reason && <p className="m-0 text-[13px] leading-relaxed text-fg-2">{reason}</p>}
      {facts.length > 0 && <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12.5px]">{facts.map(fact => <li key={fact.text} className={factTone[fact.tone]}>{fact.text}</li>)}</ul>}
      <Separator />
      {timeExhausted && !commitFailed ? <div className="flex flex-wrap items-end gap-3">
        <Field label="Thêm thời gian" className="w-32"><span className="relative block"><Input type="number" min="1" max="1440" value={extraMinutes} onChange={e => setExtraMinutes(Number(e.target.value))} className="pr-12" /><span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">phút</span></span></Field>
        <Button variant="primary" disabled={locked || extraMinutes < 1} onClick={() => void act('extend_time', { seconds: extraMinutes * 60 })}>Thêm thời gian và tiếp tục</Button></div>
        : tokensExhausted && !commitFailed ? <div className="flex flex-wrap items-end gap-3">
        <Field label="Thêm token" className="w-40"><Input type="number" min="1000" step="1000" value={extraTokens} onChange={e => setExtraTokens(Number(e.target.value))} /></Field>
        <Button variant="primary" disabled={locked || extraTokens < 1} onClick={() => void act('extend_time', { tokens: extraTokens })}>Thêm token và tiếp tục</Button></div>
        : <div className="flex flex-wrap items-center gap-2">
          {commitFailed && <Button variant="primary" disabled={locked} onClick={() => void act('retry_git')}>Thử commit lại</Button>}
          {imported && <Button variant="primary" disabled={locked} onClick={() => void act('include_imported')}>Commit kèm thay đổi có sẵn</Button>}
          {canResume && <Button variant={imported ? 'outline' : 'primary'} disabled={locked} onClick={() => void act('resume')}>Tiếp tục</Button>}
          <span className="text-[12px] text-muted-foreground">{canResume ? 'NeoMind chạy tiếp từ bước đang dừng.' : ''}</span></div>}
    </section>}

    {running && flow && <LiveActivity run={run} flow={flow} listing={listing} active={running} open={setSession} />}

    {phase === 'waiting_approval' && plan && <section className="overflow-hidden rounded-lg border border-attention/50 bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-3"><h3 className="m-0 text-[14px] font-semibold">Kế hoạch</h3>{run.plans.length > 1 && <span className="ml-auto text-[12px] text-muted-foreground">Phiên bản {run.plans.length}</span>}</div>
      <PlanBody plan={plan} />
      <div className="flex flex-col gap-3 border-t px-4 py-3.5">
        <Textarea aria-label="Yêu cầu điều chỉnh" rows={3} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Muốn đổi gì trong kế hoạch? Để trống nếu duyệt luôn." />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2"><span className="min-w-0 flex-1 text-[12px] text-muted-foreground">{uniqueAgents.map(item => <span key={item.label} className="mr-3">{item.label} <strong className="font-semibold text-foreground">{agentLine(item.values)}</strong></span>)}</span>
          <Button disabled={locked || !feedback.trim()} onClick={() => void act('changes', { feedback, planHash: run.proposedPlanHash }, () => setFeedback(''))}>Yêu cầu sửa kế hoạch</Button>
          <Button variant="primary" disabled={locked} onClick={() => void act('approve', { planHash: run.proposedPlanHash })}>Duyệt và thực hiện</Button></div>
      </div>
    </section>}

    <RunDelivery run={run} sharedWorkspace={sharedWorkspace} cleaned={cleaned} />
    <RunHandoff run={run} locked={locked} sharedWorkspace={sharedWorkspace} cleaned={cleaned} apply={() => void act('apply')} />
    {(run.checks.length > 0 || run.reviewerOutputs.length > 0) && <RunChecks run={run} flow={flow} />}
    {phase === 'completed' && <RunCost flow={flow} listing={listing} />}
    <RunLessons key={proposalsVersion} runId={run.runId} />

    {cleanup?.snapshots?.length ? <Callout tone="hint" icon={<Info />}><strong className="font-semibold text-foreground">Bản lưu của worktree đã dọn.</strong> Mọi file trong worktree lúc dọn (trừ file bị ignore) nằm trong ref dưới đây; lấy lại bằng lệnh:
      {cleanup.snapshots.map(item => <span key={item.ref} className="mt-1.5 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-code px-2 py-1 font-mono text-[12px]">git worktree add &lt;thư mục&gt; {item.ref}</code><CopyButton text={`git worktree add <thư mục> ${item.ref}`} label="Chép lệnh" /></span>)}</Callout>
      : cleanup?.retained && <Callout tone="hint" icon={<Info />}><strong className="font-semibold text-foreground">Worktree lưu khôi phục.</strong> Giữ nguyên dữ liệu khi dọn, gồm cả file ignored; các thư mục này vẫn chiếm dung lượng.
        {Object.values(cleanup.retained).map(directory => <code key={directory} className="mt-1 block font-mono text-[12px]">{directory}</code>)}</Callout>}

    <section className="divide-y overflow-hidden rounded-lg border bg-card">
      {phase !== 'waiting_approval' && plan && <Disclosure title={run.approvals?.at(-1)?.approval.source === 'flow' ? 'Kế hoạch (NeoMind tự duyệt)' : 'Kế hoạch đã duyệt'}
        hint={`${run.plans.length > 1 ? `bản ${run.plans.length} · ` : ''}${plan.scope.map(item => item === '.' ? 'toàn bộ project' : item).slice(0, 3).join(', ')}`} className="-mb-px"><div className="-mx-4 -mb-3.5 border-t"><PlanBody plan={plan} /></div></Disclosure>}
      <AgentSessions flow={flow} listing={listing} active={running} open={setSession} />
      {run.runtimeContext?.memory && <Disclosure title="Memory đã ghim cho run" hint={`${run.runtimeContext.memory.records?.length ?? 0} bản ghi`}>
        <p className="m-0 mb-2 text-[12.5px] text-muted-foreground">Nội dung và revision dưới đây là snapshot khi run bắt đầu, được đưa vào context agent.</p>
        <code className="font-mono text-[12px]">{run.runtimeContext.memory.root}</code>
        {run.runtimeContext.memory.inferredPaths && <p className="m-0 mt-2 text-[12.5px] text-muted-foreground">Path từ yêu cầu: {run.runtimeContext.memory.inferredPaths.join(', ') || 'không có; không lọc theo path'}</p>}
        {run.runtimeContext.memory.records?.map(record => <div key={`${record.type}/${record.id}`} className="mt-2 text-[12.5px]"><strong>{record.type} · {record.id}</strong><span className="block text-muted-foreground">{record.scope} · {record.selectionReason} · revision <code className="font-mono">{record.revision.slice(0, 12)}</code> · nguồn {record.sources.join(', ')}</span></div>)}
        {!!run.runtimeContext.memory.selectionPolicy && <details className="mt-2 text-[12.5px]"><summary className="cursor-pointer text-muted-foreground">Policy chọn memory khi run bắt đầu</summary><pre className="m-0 mt-1 overflow-auto rounded-md bg-code p-2.5 font-mono text-[11.5px]">{JSON.stringify(run.runtimeContext.memory.selectionPolicy, null, 2)}</pre></details>}
        <pre className="m-0 mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-code p-2.5 font-mono text-[11.5px]">{run.runtimeContext.memory.text || 'Không có bản ghi được chọn.'}</pre></Disclosure>}
      <RunMemoryUsed run={run} setRun={setRun} />
      <RunGraph run={run} hasSession={nodeId => !!latestAttempt(listing, nodeId)} openSession={nodeId => { const attempt = latestAttempt(listing, nodeId); if (attempt) setSession(attempt); }} />
      <Disclosure title="Logs và output" count={run.artifacts.length}><div className="flex flex-col gap-2">{run.artifacts.map((artifact, index) => <details key={index} className="text-[12.5px]"><summary className="cursor-pointer">{bindingLabel(artifact.nodeId, flow)} · {artifactLabel(artifact.kind)}</summary>
        <pre className="m-0 mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-code p-2.5 font-mono text-[11.5px]">{artifact.text}</pre></details>)}</div></Disclosure>
      <Disclosure title="Chi tiết kỹ thuật"><dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
        <dt className="text-muted-foreground">Run</dt><dd className="m-0 flex items-center gap-1"><code className="font-mono">{run.runId}</code><CopyButton text={run.runId} label="Chép mã run" /></dd>
        <dt className="text-muted-foreground">Worktree</dt><dd className="m-0 min-w-0 break-all"><code className="font-mono">{run.runtimeContext?.workspace}</code>
          {cleaned ? <span className="text-muted-foreground"> · đã dọn{cleanup!.discarded.length ? ` (${cleanup!.discarded.length} thay đổi chưa giao, xem bản lưu)` : ''}</span>
            : canWorktreeClean && <Button size="sm" className="ml-2" disabled={locked} onClick={() => void cleanWorktree()}>Dọn worktree</Button>}</dd>
        {run.bindingSelections.map((selection, index) => <div key={index} className="contents"><dt className="text-muted-foreground">Đổi model</dt><dd className="m-0">{bindingLabel(selection.key, flow)}: {agentLine(selection.values)} — {selection.reason}</dd></div>)}</dl></Disclosure>
    </section>
    {session && flow && <SessionSheet run={run} flow={flow} listing={listing} target={session} setTarget={setSession} close={() => setSession(null)} />}
  </div>;
}
