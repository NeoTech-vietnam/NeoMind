import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { effectiveBinding } from '../core/run-binding.js';
import type { MaterializedRun } from '../domain/materialize.js';
import { projectDir } from '../storage/project-dir.js';
import { ESTIMATE_MIN_RUNS, flowRunnersKey } from '../domain/estimate.js';
import type { RunManager } from './run-manager.js';

/** Prices the user fills in themselves (USD per million tokens); without the file NeoMind shows tokens only. */
const priceSchema = z.strictObject({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative(), cachedInputPerMTok: z.number().nonnegative().optional() });
export const pricingSchema = z.strictObject({ schemaVersion: z.literal(1), currency: z.literal('USD').optional(), models: z.record(z.string().min(1), priceSchema) });
export type Pricing = z.infer<typeof pricingSchema>;
export { ESTIMATE_MIN_RUNS } from '../domain/estimate.js';

export async function readPricing(root: string): Promise<Pricing | undefined> {
  try { return pricingSchema.parse(JSON.parse(await readFile(path.join(projectDir(root), 'pricing.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export interface RunFacts {
  runId: string; flowId: string; flowName: string; createdAt?: string | undefined; phase: string; completed: boolean; delivered: boolean;
  tokens: number | null; activeMs: number; repairRounds: number; reviewed: boolean; firstPassReview: boolean;
  profiles: string[]; runnerModels: string[]; runners: string; costUSD: number | null;
}

type Report = Awaited<ReturnType<RunManager['get']>> & { handoff?: { applied: boolean; files: string[] } };
/** What one run did, from its journal report. */
export function runFacts(report: Report, pricing?: Pricing): RunFacts | undefined {
  const snapshot = report.snapshot as MaterializedRun | undefined;
  if (!snapshot) return undefined;
  const flow = snapshot.configuration.flow, phase = report.runtimeState?.phase ?? 'recovering', completed = phase === 'completed';
  const bindingOf = (key: string) => effectiveBinding(snapshot, report.bindingSelections, key);
  const keys = Object.keys(snapshot.configuration.bindings), values = keys.map(bindingOf).filter(item => item !== undefined);
  const delivered = completed && (report.delivery.length > 0 || !!report.handoff?.applied || (!!report.handoff && !report.handoff.files.length));
  // Cost per runner session: the model is the binding of the step whose attempt opened that session.
  let costUSD: number | null = null;
  if (pricing) {
    costUSD = 0;
    for (const [sessionId, usage] of Object.entries(report.usage.bySession ?? {})) {
      const attempt = report.attempts.find(item => item.sessionId === sessionId), key = attempt ? attempt.reviewerId ? `${attempt.nodeId}/${attempt.reviewerId}` : attempt.nodeId : undefined;
      const price = key ? pricing.models[bindingOf(key)?.model ?? ''] : undefined;
      if (!price) { costUSD = null; break; }
      const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
      costUSD += ((usage.inputTokens - cached) * price.inputPerMTok + cached * (price.cachedInputPerMTok ?? price.inputPerMTok) + usage.outputTokens * price.outputPerMTok) / 1_000_000;
    }
  }
  return { runId: report.runId, flowId: flow.flowId, flowName: flow.name, createdAt: undefined, phase, completed, delivered,
    tokens: report.usage.totalTokens, activeMs: report.runtimeState?.activeMs ?? 0, repairRounds: report.repairRounds.length,
    reviewed: report.acceptedReviews.length > 0, firstPassReview: report.acceptedReviews.length > 0 && report.repairRounds.length === 0,
    profiles: [...new Set(Object.values(snapshot.profilesByStep).map(profile => `${profile.profileId}@${profile.version}`))].sort(),
    runnerModels: [...new Set(values.map(value => `${value.runner}/${value.model}`))].sort(),
    runners: [...new Set(values.map(value => value.runner))].sort().join('+'), costUSD };
}

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
const rate = (part: number, whole: number) => whole ? part / whole : null;

/** Averages and medians of time, tokens and cost use completed runs only, so an abandoned run does not lower them. */
export function summarize(key: string, runs: RunFacts[]) {
  const done = runs.filter(run => run.completed), tokens = done.flatMap(run => run.tokens === null ? [] : [run.tokens]), active = done.map(run => run.activeMs);
  const costs = done.flatMap(run => run.costUSD === null ? [] : [run.costUSD]), reviewed = runs.filter(run => run.reviewed);
  return { key, runs: runs.length, completed: done.length, delivered: runs.filter(run => run.delivered).length,
    completionRate: rate(done.length, runs.length), deliveryRate: rate(runs.filter(run => run.delivered).length, runs.length),
    tokens: { average: average(tokens), median: median(tokens), samples: tokens.length },
    activeSeconds: { average: average(active) === null ? null : average(active)! / 1000, median: median(active) === null ? null : median(active)! / 1000 },
    repairRounds: average(runs.map(run => run.repairRounds)), firstPassReviewRate: rate(reviewed.filter(run => run.firstPassReview).length, reviewed.length),
    costUSD: costs.length === done.length && costs.length ? { average: average(costs), median: median(costs) } : null };
}
export type StatsGroup = ReturnType<typeof summarize>;

function group(runs: RunFacts[], keys: (run: RunFacts) => string[]) {
  const map = new Map<string, RunFacts[]>();
  for (const run of runs) for (const key of keys(run)) map.set(key, [...(map.get(key) ?? []), run]);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => summarize(key, items));
}

/** Run statistics by flow, profile, runner/model and flow + runners (the key the new-run estimate uses). */
export async function runStats(root: string, runs: RunManager, filter: { flowId?: string } = {}) {
  const pricing = await readPricing(root), facts: RunFacts[] = [], errors: { runId: string; error: string }[] = [];
  for (const item of await runs.list()) {
    if (filter.flowId && item.flowId !== filter.flowId) continue;
    try { const value = runFacts(await runs.get(item.runId) as Report, pricing); if (value) facts.push({ ...value, createdAt: item.createdAt }); }
    catch (error) { errors.push({ runId: item.runId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { pricing: !!pricing, estimateMinRuns: ESTIMATE_MIN_RUNS, total: summarize('all', facts),
    byFlow: group(facts, run => [run.flowId]), byProfile: group(facts, run => run.profiles), byRunnerModel: group(facts, run => run.runnerModels),
    byFlowRunners: group(facts, run => [flowRunnersKey(run.flowId, run.runners.split('+'))]), runs: facts, errors };
}
export type RunStats = Awaited<ReturnType<typeof runStats>>;

const csvCell = (value: unknown) => { const text = value === null || value === undefined ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
export function statsCsv(stats: RunStats): string {
  const header = ['group', 'key', 'runs', 'completed', 'delivered', 'completionRate', 'deliveryRate', 'avgTokens', 'medianTokens', 'avgActiveSeconds', 'medianActiveSeconds', 'avgRepairRounds', 'firstPassReviewRate', 'avgCostUSD'];
  const rows = ([['flow', stats.byFlow], ['profile', stats.byProfile], ['runnerModel', stats.byRunnerModel], ['flowRunners', stats.byFlowRunners]] as const).flatMap(([name, groups]) => groups.map(item =>
    [name, item.key, item.runs, item.completed, item.delivered, item.completionRate, item.deliveryRate, item.tokens.average, item.tokens.median, item.activeSeconds.average, item.activeSeconds.median, item.repairRounds, item.firstPassReviewRate, item.costUSD?.average ?? null]));
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}
