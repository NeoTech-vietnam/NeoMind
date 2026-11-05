import { CircleCheck, GitBranch, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/CopyButton';
import { formatDuration, formatTokens } from './format';
import type { Listing } from './RunActivity';
import { modelLabel, runnerLabel } from './runners';
import { bindingLabel, type Run } from './runTypes';
import type { Flow } from '../../src/domain/schema';

const Files = ({ files }: { files: string[] }) => <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 font-mono text-[12px] text-fg-2">{files.map(file => <li key={file}>{file}</li>)}</ul>;

/** What the run delivered: the local commits, with the facts that make them trustworthy and the way to take them into the checkout. */
export function RunDelivery({ run, sharedWorkspace, cleaned }: { run: Run; sharedWorkspace: boolean; cleaned: boolean }) {
  const delivery = run.delivery ?? [];
  if (!delivery.length) return null;
  const checksOk = run.checks.length > 0 && run.checks.every(check => check.status === 'passed'), reviewOk = run.acceptedReviews.length > 0;
  return <>{delivery.map(item => <section key={item.commit} className="flex flex-col gap-3 rounded-lg border border-success/30 bg-success/8 px-4 py-3.5">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><CircleCheck className="size-4 text-success" /><strong className="text-[14px]">Đã commit local</strong>
      <span className="inline-flex items-center gap-1"><code className="font-mono text-[12.5px] font-semibold">{item.commit.slice(0, 7)}</code><CopyButton text={item.commit} label="Chép mã commit đầy đủ" /></span>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-2"><GitBranch className="size-3.5 text-muted-foreground" />{sharedWorkspace ? 'branch của checkout hiện tại' : <code className="font-mono">refs/neomind/{run.runId.slice(0, 8)}…/delivery/{item.nodeId}</code>}</span></div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-fg-2"><span>{item.files.length} file đã đổi</span>{checksOk && <span>Checks đạt</span>}{reviewOk && <span>Review đạt</span>}</div>
    {item.files.length > 0 && <Files files={item.files} />}
    <p className="m-0 flex gap-2 text-[12.5px] leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />
      {sharedWorkspace ? 'Commit đã nằm trên branch checkout hiện tại.' : cleaned ? <span>Commit chưa vào branch của bạn; NeoMind giữ nó ở <code className="font-mono">refs/neomind/{run.runId}/delivery/{item.nodeId}</code> (worktree của run đã dọn).</span>
        : 'Commit nằm trong worktree riêng của run, chưa vào branch của bạn. Lấy về checkout hiện tại bằng lệnh dưới đây.'}</p>
    {!sharedWorkspace && <div className="flex items-center gap-2 rounded-md bg-code px-3 py-2"><code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">git cherry-pick {item.commit.slice(0, 12)}</code>
      <CopyButton text={`git cherry-pick ${item.commit}`} label="Chép lệnh cherry-pick" /></div>}
  </section>)}</>;
}

/** A flow that ends without a commit hands the changed files over; applying them copies the files into the checkout. */
export function RunHandoff({ run, locked, sharedWorkspace, cleaned, apply }: { run: Run; locked: boolean; sharedWorkspace: boolean; cleaned: boolean; apply(): void }) {
  const handoff = run.handoff;
  if (!handoff) return null;
  const workspace = run.runtimeContext?.workspace ?? '', command = `git -C "${workspace}" diff`;
  return <section className={handoff.applied ? 'flex flex-col gap-3 rounded-lg border border-success/30 bg-success/8 px-4 py-3.5' : 'flex flex-col gap-3 rounded-lg border bg-card px-4 py-3.5'}>
    <div className="flex items-center gap-2.5"><h3 className="m-0 text-[14px] font-semibold">{handoff.applied ? 'Đã áp dụng vào checkout' : 'Thay đổi để bạn review'}</h3>
      {handoff.applied ? <Badge status="success">Đã áp dụng</Badge> : handoff.files.length > 0 && <Badge status="attention">Chờ bạn</Badge>}</div>
    {handoff.files.length === 0 ? <p className="m-0 text-[12.5px] text-muted-foreground">Run không thay đổi file nào.</p> : <>
      <Files files={handoff.files} />
      {handoff.applied ? <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">{sharedWorkspace ? 'Thay đổi đã nằm trực tiếp trong checkout của bạn' : 'Các thay đổi đã được chép vào checkout của bạn'} (chưa stage, chưa commit). Xem bằng <code className="font-mono">git diff</code> rồi tự commit khi ưng.</p>
        : cleaned ? <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">Worktree của run đã được dọn mà chưa áp dụng; thay đổi vẫn nằm trong bản lưu của worktree.</p> : <>
          <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">Flow này không có agent review và không commit. Xem thay đổi trong worktree của run, rồi áp dụng vào checkout của bạn (chỉ chép file, không stage, không commit).</p>
          <div className="flex items-center gap-2 rounded-md bg-code px-3 py-2"><code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{command}</code><CopyButton text={command} label="Chép lệnh xem diff" /></div>
          <div className="flex justify-end"><Button variant="primary" disabled={locked} onClick={apply}>Áp dụng vào checkout</Button></div></>}</>}
  </section>;
}

/** Time and tokens per step, from the agent transcripts; steps without an agent (approval, checks, commit) have no row. */
export function RunCost({ flow, listing }: { flow: Flow | undefined; listing: Listing }) {
  const keys = [...new Set(listing.transcripts.filter(item => item.usage).map(item => item.meta.key))];
  if (!keys.length) return null;
  const table = keys.map(key => {
    const turns = listing.transcripts.filter(item => item.meta.key === key), last = turns.at(-1)!;
    return { key, agent: `${runnerLabel(last.meta.runner)} · ${modelLabel(last.meta.model)}`, ms: turns.reduce((sum, item) => sum + Math.max(0, (item.endedAt ?? item.startedAt ?? 0) - (item.startedAt ?? 0)), 0),
      input: turns.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0), output: turns.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0) };
  });
  const total = table.reduce((sum, row) => ({ ms: sum.ms + row.ms, input: sum.input + row.input, output: sum.output + row.output }), { ms: 0, input: 0, output: 0 });
  const head = 'px-4 py-2 text-right text-[11.5px] font-normal text-muted-foreground', cell = 'px-4 py-2 text-right tabular-nums';
  return <section className="overflow-hidden rounded-lg border bg-card">
    <div className="flex items-baseline gap-2 border-b px-4 py-3"><h3 className="m-0 text-[14px] font-semibold">Chi phí theo bước</h3><span className="text-[12px] text-muted-foreground">thời gian chờ bạn duyệt không tính</span></div>
    <div className="overflow-x-auto"><table className="w-full border-collapse text-[12.5px]"><thead><tr className="border-b"><th className={head + ' !text-left'}>Bước</th><th className={head + ' !text-left'}>Agent</th><th className={head}>Thời gian</th><th className={head}>Token vào</th><th className={head}>Token ra</th></tr></thead>
      <tbody>{table.map(row => <tr key={row.key} className="border-b last:border-b-0"><td className="px-4 py-2 font-medium">{bindingLabel(row.key, flow)}</td><td className="px-4 py-2 text-muted-foreground">{row.agent}</td>
        <td className={cell}>{formatDuration(row.ms)}</td><td className={cell}>{formatTokens(row.input)}</td><td className={cell}>{formatTokens(row.output)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t bg-muted font-semibold"><td className="px-4 py-2" colSpan={2}>Tổng</td><td className={cell}>{formatDuration(total.ms)}</td><td className={cell}>{formatTokens(total.input)}</td><td className={cell}>{formatTokens(total.output)}</td></tr></tfoot></table></div>
  </section>;
}
