import { useEffect, useState } from 'react';
import { api } from './api';

export type RunnerModels = { runner: string; provider: string; models: string[]; reasoning: string[] };

let cached: Promise<RunnerModels[]> | undefined;
/** Per-runner model allowlist from the server; the first model of a runner is its default. */
export function useRunners(): RunnerModels[] {
  const [runners, setRunners] = useState<RunnerModels[]>([]);
  useEffect(() => {
    let disposed = false;
    (cached ??= api<{ runners: RunnerModels[] }>('/api/runners').then(value => value.runners).catch(error => { cached = undefined; throw error; }))
      .then(value => { if (!disposed) setRunners(value); }, () => {});
    return () => { disposed = true; };
  }, []);
  return runners;
}

export const runnerLabels: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };
export const runnerLabel = (runner: string) => runnerLabels[runner] ?? runner;

const modelLabels: Record<string, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-opus-5-5': 'Opus 5.5',
  'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol',
};
/** Short display name of a model id; unknown ids are shown as they are. */
export const modelLabel = (model: string) => modelLabels[model] ?? model;

const reasoningLabels: Record<string, string> = { low: 'Thấp', medium: 'Vừa', high: 'Cao', xhigh: 'Rất cao', minimal: 'Tối thiểu' };
export const reasoningLabel = (reasoning: string) => reasoningLabels[reasoning] ?? reasoning;
