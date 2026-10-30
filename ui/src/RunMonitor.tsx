import { Fragment, useState } from 'react';
import { api } from './api';
import { artifactLabel, formatDuration, formatTokens, phaseInfo, statusInfo, verdictInfo } from './format';
import { RunLessons } from './RunLessons';
import { AgentSessions, latestAttempt, LiveActivity, SessionDrawer, useTranscripts, type SessionTarget } from './RunActivity';
import { modelLabel, reasoningLabel, runnerLabel } from './runners';
import { bindingLabel, effectiveBindings, type BindingValues, type Run } from './runTypes';
import type { FlowNode } from '../../src/domain/schema';

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) { return <span className={`badge tone-${tone}`}>{children}</span>; }
function Copy({ text, label = 'Sao chép' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="copy-btn" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? 'Đã chép' : label}</button>;
}
const agentLine = (values: BindingValues | undefined) => values ? `${runnerLabel(values.runner)} · ${modelLabel(values.model)} · ${reasoningLabel(values.reasoning)}` : '';

/** Runner/model lines a step uses: its own binding, or one per reviewer for a review group. */
function stepAgents(node: FlowNode, bindings: Map<string, BindingValues>): string[] {
  if (node.type === 'review_group') return node.reviewers.map(reviewer => `${reviewer.id}: ${agentLine(bindings.get(`${node.id}/${reviewer.id}`))}`);
  return bindings.has(node.id) ? [agentLine(bindings.get(node.id))] : [];
}

export function RunMonitor({ run, setRun }: { run: Run; setRun(run: Run): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState(''), [extraMinutes, setExtraMinutes] = useState(10);
  const phase = run.runtimeState?.phase ?? 'recovering', info = phaseInfo(phase), flow = run.snapshot?.configuration.flow;
  const bindings = effectiveBindings(run), plan = run.plans.at(-1)?.plan;
  const timeLimitMs = run.timeLimitMs ?? (flow?.definition.limits.activeTimeSeconds ?? 0) * 1000 + run.timeExtensionsMs;
  const timeExhausted = timeLimitMs > 0 && (run.runtimeState?.activeMs ?? 0) >= timeLimitMs;
  const locked = busy || run.busy;
  const listing = useTranscripts(run.runId, phase === 'running'), [session, setSession] = useState<SessionTarget | null>(null);
  async function act(path: string, body?: unknown, after?: () => void) {
    setBusy(true); setError('');
    try { setRun(await api<Run>(`/api/runs/${run.runId}/${path}`, 'POST', body)); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const cleanup = run.workspaceCleanup, cleaned = !!cleanup?.cleaned, finished = phase === 'completed' || phase === 'cancelled';
  /** Remove the run's worktrees; when changes would be lost, ask before discarding them. */
  async function cleanWorktree() {
    setBusy(true); setError('');
    try { setRun(await api<Run>(`/api/runs/${run.runId}/clean`, 'POST', { force: false })); }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.startsWith('Run còn thay đổi') || !window.confirm(`${message}\n\nVẫn dọn và bỏ các thay đổi này?`)) { if (!message.startsWith('Run còn thay đổi')) setError(message); return; }
      try { setRun(await api<Run>(`/api/runs/${run.runId}/clean`, 'POST', { force: true })); } catch (again) { setError(again instanceof Error ? again.message : String(again)); }
    } finally { setBusy(false); }
  }
  const nodes =(flow?.definition.nodes ?? []).filter(node => node.type !== 'start' && node.type !== 'finish');
  const reviews = run.reviewerOutputs;
  const checkOutputs = run.artifacts.filter(item => item.kind === 'check');
  const delivery = run.delivery ?? [];

  return <>
    <div className="run-card run-header">
      <div className="run-header-top">
        <div className="run-header-text"><Badge tone={info.tone}>{phase === 'running' && <i className="pulse" />}{info.label}</Badge><h2>{run.runtimeContext?.task}</h2>
          <div className="meta-row">{flow && <span>{flow.name} v{flow.version}</span>}<span>⏱ {formatDuration(run.runtimeState?.activeMs ?? 0)}</span>
            {run.usage.totalTokens !== null && <span title={run.usage.partial ? 'Một số lượt chưa báo token' : undefined}>{formatTokens(run.usage.totalTokens)} tokens{run.usage.partial ? '*' : ''}</span>}</div></div>
        <div className="run-actions">
          {phase === 'running' && <button className="secondary-btn" disabled={busy} onClick={() => void act('pause')}>Tạm dừng</button>}
          {['paused', 'blocked', 'recovering'].includes(phase) && run.unresolvedCommitNodeIds.length === 0 && !timeExhausted && <button className="primary-btn" disabled={locked} onClick={() => void act('resume')}>Tiếp tục</button>}
          {run.unresolvedCommitNodeIds.length > 0 && <button className="primary-btn" disabled={locked} onClick={() => void act('retry_git')}>Thử commit lại</button>}
          {!['completed', 'cancelled'].includes(phase) && <button className="secondary-btn subtle" disabled={busy} onClick={() => { if (window.confirm('Hủy run? Thay đổi trong worktree của run được giữ lại.')) void act('cancel'); }}>Hủy run</button>}
        </div>
      </div>
      {phase !== 'completed' && run.runtimeState?.reason && <div className={`callout tone-${info.tone}`}>{run.runtimeState.reason}</div>}
      {phase === 'blocked' && (run.runtimeState?.reason ?? '').startsWith('Chồng lên thay đổi có sẵn') && <button className="primary-btn" disabled={locked} onClick={() => void act('include_imported')}>Commit kèm thay đổi có sẵn</button>}
      {timeExhausted && !['completed', 'cancelled', 'running'].includes(phase) && <div className="inline-form">
        <span>Đã dùng hết thời gian xử lý.</span><label className="input-suffix"><input type="number" min="1" max="1440" value={extraMinutes} onChange={e => setExtraMinutes(Number(e.target.value))} /><em>phút</em></label>
        <button className="primary-btn" disabled={locked || extraMinutes < 1} onClick={() => void act('extend_time', { seconds: extraMinutes * 60 })}>Thêm thời gian và tiếp tục</button></div>}
      {error && <div className="callout tone-red" role="alert">{error}</div>}
      <ol className="stepper">{nodes.map(node => {
        const raw = run.graph.nodes[node.id]?.status, agents = stepAgents(node, bindings);
        // A step recorded as running is only live while the run itself is running.
        const status = raw === 'running' && !['running', 'stopping'].includes(phase) ? { label: 'Dừng giữa chừng', tone: 'amber', icon: '❚❚' } : statusInfo(raw);
        const attempt = latestAttempt(listing, node.id), liveStep = raw === 'running' && phase === 'running';
        return <li key={node.id} className={`step tone-${status.tone}`}><span className="step-icon">{status.icon}</span>
          <div><strong>{node.label}</strong><small>{status.label}</small>{agents.map(line => <small key={line} className="step-agent">{line}</small>)}
            {attempt && (liveStep ? <button type="button" className="step-link" onClick={event => (event.currentTarget.getRootNode() as Document | ShadowRoot).getElementById('live-activity')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Xem trực tiếp ↓</button>
              : <button type="button" className="step-link" onClick={() => setSession(attempt)}>Xem session</button>)}</div></li>;
      })}</ol>
    </div>

    <LiveActivity run={run} flow={flow} listing={listing} active={phase === 'running'} open={setSession} />

    {delivery.length > 0 && <div className="run-card delivery-card">
      <div className="card-title"><h3>Kết quả</h3><Badge tone="green">Đã commit local</Badge></div>
      {delivery.map(item => <div key={item.commit} className="delivery">
        <div className="delivery-commit"><span>Commit</span><code>{item.commit.slice(0, 12)}</code><Copy text={item.commit} label="Chép mã đầy đủ" /></div>
        {item.files.length > 0 && <ul className="file-list">{item.files.map(file => <li key={file}>{file}</li>)}</ul>}
        <p className="hint">{cleaned ? <>Commit chưa vào branch của bạn; NeoMind giữ nó ở <code>refs/neomind/{run.runId}/delivery/{item.nodeId}</code> (worktree của run đã dọn).</> : 'Commit nằm trong worktree riêng của run, chưa vào branch của bạn.'} Lấy về checkout hiện tại:</p>
        <div className="command"><code>git cherry-pick {item.commit.slice(0, 12)}</code><Copy text={`git cherry-pick ${item.commit}`} /></div>
      </div>)}
    </div>}

    {run.handoff && <div className={`run-card ${run.handoff.applied ? 'delivery-card' : 'handoff-card'}`}>
      <div className="card-title"><h3>{run.handoff.applied ? 'Đã áp dụng vào checkout' : 'Thay đổi để bạn review'}</h3>{run.handoff.applied ? <Badge tone="green">Đã áp dụng</Badge> : run.handoff.files.length > 0 && <Badge tone="amber">Chờ bạn</Badge>}</div>
      {run.handoff.files.length === 0 ? <p className="hint">Run không thay đổi file nào.</p> : <>
        <ul className="file-list">{run.handoff.files.map(file => <li key={file}>{file}</li>)}</ul>
        {run.handoff.applied ? <p className="hint">Các thay đổi đã được chép vào checkout của bạn (chưa stage, chưa commit). Xem bằng <code>git diff</code> rồi tự commit khi ưng.</p>
          : cleaned ? <p className="hint">Worktree của run đã được dọn mà chưa áp dụng; các thay đổi này không còn.</p> : <>
          <p className="hint">Flow này không có agent review và không commit. Xem thay đổi trong worktree của run, rồi áp dụng vào checkout của bạn (chỉ chép file, không stage, không commit).</p>
          <div className="command"><code>git -C &quot;{run.runtimeContext?.workspace}&quot; diff</code><Copy text={`git -C "${run.runtimeContext?.workspace ?? ''}" diff`} /></div>
          <div className="approval-actions" style={{ marginTop: 12 }}><button className="primary-btn" disabled={locked} onClick={() => void act('apply')}>Áp dụng vào checkout</button></div></>}</>}
    </div>}

    {plan && <div className={`run-card plan-card ${phase === 'waiting_approval' ? 'needs-action' : ''}`}>
      <div className="card-title"><h3>{phase === 'waiting_approval' ? 'Kế hoạch đang chờ bạn duyệt' : run.approvals?.at(-1)?.approval.source === 'flow' ? 'Kế hoạch (NeoMind tự duyệt)' : 'Kế hoạch đã duyệt'}</h3>{run.plans.length > 1 && <span className="muted-inline">Phiên bản {run.plans.length}</span>}</div>
      <p className="plan-goal">{plan.goal}</p>
      <p className="plan-approach">{plan.approach}</p>
      <div className="plan-grid">
        <div><h4>Tiêu chí hoàn thành</h4><ul className="criteria">{plan.acceptanceCriteria.map(item => <li key={item}>{item}</li>)}</ul></div>
        <div><h4>Phạm vi sửa</h4><div className="chips">{plan.scope.map(item => <code key={item}>{item === '.' ? 'toàn bộ project' : item}</code>)}</div>
          <h4>Checks</h4><div className="chips">{plan.checks.length ? plan.checks.map(item => <code key={item}>{item}</code>) : <span className="muted-inline">Không có check</span>}</div>
          {plan.riskChanges.length > 0 && <><h4>Rủi ro</h4><ul>{plan.riskChanges.map(item => <li key={item}>{item}</li>)}</ul></>}</div>
      </div>
      {phase === 'waiting_approval' && <div className="approval-bar">
        <textarea aria-label="Yêu cầu điều chỉnh" rows={2} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Muốn đổi gì trong kế hoạch? (không bắt buộc)" />
        <div className="approval-actions">
          <button className="secondary-btn" disabled={locked || !feedback.trim()} onClick={() => void act('changes', { feedback, planHash: run.proposedPlanHash }, () => setFeedback(''))}>Yêu cầu sửa kế hoạch</button>
          <button className="primary-btn" disabled={locked} onClick={() => void act('approve', { planHash: run.proposedPlanHash })}>Duyệt và thực hiện</button>
        </div></div>}
    </div>}

    {(run.checks.length > 0 || reviews.length > 0) && <div className="run-card">
      <div className="card-title"><h3>Kiểm tra</h3>{run.acceptedReviews.length > 0 && <Badge tone="green">Review đã chấp nhận</Badge>}</div>
      {run.checks.map(check => { const verdict = verdictInfo(check.status), output = [...checkOutputs].reverse().find(item => item.text.startsWith(`${check.command}\n`));
        return <div className="verify-row" key={check.checkId}><Badge tone={verdict.tone}>{verdict.label}</Badge><div className="verify-body"><code>{check.command}</code>
          {output && <details><summary>Output</summary><pre>{output.text}</pre></details>}</div></div>; })}
      {reviews.map((output, index) => { const verdict = verdictInfo(output.result.verdict), key = `${output.nodeId}/${output.result.reviewerId}`;
        const latest = !reviews.slice(index + 1).some(item => item.nodeId === output.nodeId && item.result.reviewerId === output.result.reviewerId);
        return <div className={`verify-row ${latest ? '' : 'superseded'}`} key={output.attemptId}><Badge tone={verdict.tone}>{verdict.label}</Badge>
          <div className="verify-body"><strong>{bindingLabel(key, flow)}</strong><small className="muted-inline"> {agentLine(bindings.get(key))}{latest ? '' : ' · lượt trước'}</small>
            <p>{output.summary}</p>
            {output.evidence && <details open={latest && output.result.verdict !== 'pass'}><summary>{output.evidence.criteria.length} tiêu chí</summary><ul className="criteria-status">{output.evidence.criteria.map(item => {
              const status = verdictInfo(item.status);
              return <li key={item.criterion}><Badge tone={status.tone}>{status.label}</Badge>{item.criterion}</li>;
            })}</ul>{output.evidence.findings.map(finding => <p key={finding.id} className="finding"><strong>{finding.id}</strong> · {finding.criterion}: {finding.explanation}</p>)}</details>}
          </div></div>; })}
    </div>}

    <AgentSessions flow={flow} listing={listing} active={phase === 'running'} open={setSession} />

    {phase === 'completed' && <RunLessons runId={run.runId} />}

    <div className="run-card">
      <details className="logs"><summary>Logs và output ({run.artifacts.length})</summary>
        {run.artifacts.map((artifact, index) => <details key={index}><summary>{bindingLabel(artifact.nodeId, flow)} · {artifactLabel(artifact.kind)}</summary><pre>{artifact.text}</pre></details>)}</details>
      <details className="logs"><summary>Chi tiết kỹ thuật</summary>
        <dl className="tech"><dt>Run</dt><dd><code>{run.runId}</code></dd><dt>Worktree</dt><dd><code>{run.runtimeContext?.workspace}</code>
            {cleaned ? <span className="muted-inline"> · đã dọn{cleanup!.discarded.length ? ` (bỏ ${cleanup!.discarded.length} thay đổi chưa lưu)` : ''}</span>
              : finished && <button type="button" className="secondary-btn small tech-action" disabled={locked} onClick={() => void cleanWorktree()}>Dọn worktree</button>}</dd>
          {run.bindingSelections.map((selection, index) => <Fragment key={index}><dt>Đổi model</dt><dd>{bindingLabel(selection.key, flow)}: {agentLine(selection.values)} — {selection.reason}</dd></Fragment>)}</dl></details>
    </div>
    {session && <SessionDrawer run={run} flow={flow} listing={listing} target={session} setTarget={setSession} close={() => setSession(null)} />}
  </>;
}
