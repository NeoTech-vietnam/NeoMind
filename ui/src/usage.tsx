/** Tokens, cost, guardrail rounds and transient retries of a run and its steps (phase-2 contract §1, §2). */
import { Coins } from 'lucide-react';
import { Tag } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { formatCost, formatDuration, formatTokens, totalTokens } from './format';
import type { HistoryEvent, RunDetail, Totals, Usage } from './types';

const usageKeys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const;

/** Does a history event belong to this graph node? Fan-out workers log as "<fanout>[i]"; their node is "<fanout>_worker". */
export function eventOf(event: HistoryEvent, node: string): boolean {
  if (event.step === node) return true;
  if (!node.endsWith('_worker') || !event.step) return false;
  const match = /^(.*)\[\d+\]$/.exec(event.step);
  return !!match && `${match[1]}_worker` === node;
}

export type StepUsage = Usage & { calls: number; costKnown: boolean; sources: string[] };

/**
 * Usage of one node, summed over every ai call it made (loop rounds, fan-out workers, guardrail rounds) from the
 * history; falls back to info[node].usage (the server's own sum) when the history has none.
 */
export function stepUsage(run: RunDetail, node: string): StepUsage | null {
  const sum: StepUsage = { calls: 0, costKnown: false, cost_usd: null, sources: [] };
  // Every event of the node that carries usage (done, failed, a guardrail round's "check failed"), like view.step_states.
  for (const event of run.history ?? []) {
    if (!eventOf(event, node)) continue;
    const usage = event.usage as Usage | undefined | null;
    if (!usage || typeof usage !== 'object') continue;
    add(sum, usage);
  }
  if (!sum.calls) { const usage = run.info[node]?.usage; if (usage) add(sum, usage); }
  return sum.calls ? sum : null;
}
function add(sum: StepUsage, usage: Usage) {
  sum.calls++;
  for (const key of usageKeys) if (typeof usage[key] === 'number') sum[key] = (sum[key] ?? 0) + usage[key]!;
  if (typeof usage.cost_usd === 'number') { sum.cost_usd = (sum.cost_usd ?? 0) + usage.cost_usd; sum.costKnown = true; }
  if (usage.cost_source && !sum.sources.includes(usage.cost_source)) sum.sources.push(usage.cost_source);
}

/** Guardrail rounds ("check failed") and transient retries ("retry") of one node. */
export function stepRounds(run: RunDetail, node: string) {
  const events = (run.history ?? []).filter(event => eventOf(event, node));
  const checks = events.filter(event => event.event === 'check failed'), retries = events.filter(event => event.event === 'retry');
  const lastRetry = retries.at(-1), lastCheck = checks.at(-1);
  return {
    checks: checks.length, retries: retries.length,
    lastRetryError: typeof lastRetry?.error === 'string' ? lastRetry.error : undefined, lastRetryWait: typeof lastRetry?.wait === 'number' ? lastRetry.wait : undefined,
    lastFeedback: typeof lastCheck?.feedback === 'string' ? lastCheck.feedback : undefined,
  };
}

const sourceLabel = (sources: string[] | string | null | undefined) => {
  const list = Array.isArray(sources) ? sources : sources ? [sources] : [];
  if (!list.length) return '';
  return list.map(source => source === 'agent' ? 'agent báo' : source === 'pricing' ? 'tính theo bảng giá' : source).join(', ');
};

/** "12.3k in · 1.2k out · 40k cache" */
export function tokenBreakdown(usage: Usage | Totals): string {
  return [usage.input_tokens ? `${formatTokens(usage.input_tokens)} vào` : '', usage.output_tokens ? `${formatTokens(usage.output_tokens)} ra` : '',
    usage.cache_read_tokens ? `${formatTokens(usage.cache_read_tokens)} đọc cache` : '', usage.cache_write_tokens ? `${formatTokens(usage.cache_write_tokens)} ghi cache` : '',
    'reasoning_tokens' in usage && usage.reasoning_tokens ? `${formatTokens(usage.reasoning_tokens)} suy luận` : ''].filter(Boolean).join(' · ');
}

/** Cost and tokens chips for a run header. */
export function TotalsChips({ totals }: { totals: Totals | null | undefined }) {
  if (!totals) return null;
  const tokens = totalTokens(totals), cost = formatCost(totals.cost_usd);
  if (!tokens && !cost) return null;
  const detail = [tokenBreakdown(totals), totals.steps ? `${totals.steps} lần gọi AI` : '', totals.ai_seconds ? `AI chạy ${formatDuration(totals.ai_seconds * 1000)}` : '',
    totals.cost_usd === null || totals.cost_usd === undefined ? 'chưa biết chi phí (agent không báo và chưa có [pricing] cho model)' : ''].filter(Boolean).join('\n');
  return <Tooltip label={<span className="whitespace-pre-line">{detail}</span>}>
    <Tag className="gap-1 tabular-nums"><Coins className="size-3 text-muted-foreground" />{cost || '$?'}{tokens ? <span className="text-faint">· {formatTokens(tokens)} tok</span> : null}</Tag>
  </Tooltip>;
}

export function costTitle(usage: StepUsage): string {
  return [tokenBreakdown(usage), usage.calls > 1 ? `${usage.calls} lần gọi` : '', sourceLabel(usage.sources)].filter(Boolean).join(' · ');
}
export { sourceLabel };
