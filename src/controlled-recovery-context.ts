import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { safePath } from './storage.js';
import { redactControlledValue } from './controlled-observability.js';
import type { ControlledSnapshot } from './controlled-workflow.js';

/** A resumed planner gets prior validation, never credentials or an accepted replay. */
export function controlledPlanningRecovery(root: string, run: Pick<ControlledSnapshot, 'workflow_id' | 'epoch_id' | 'events'>) {
  const result: { code: string; rule: string; owner: string }[] = [], seen = new Set<string>();
  const events = run.events.filter(event => event.kind === 'tool' && /workflow_plan: failed; trace [a-f0-9-]{36}$/.test(event.summary)).slice(-8).reverse();
  for (const event of events) {
    const id = /trace ([a-f0-9-]{36})$/.exec(event.summary)![1]!;
    try {
      const path = safePath(root, `.neomind/controlled/traces/${id}.json`);
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128000) continue;
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value.workflow_id !== run.workflow_id || value.epoch_id !== run.epoch_id || value.tool !== 'workflow_plan' ||
          value.status !== 'failed' || typeof value.code !== 'string' || typeof value.validation?.rule !== 'string') continue;
      const rule = String(redactControlledValue(value.validation.rule)).slice(0, 1500);
      const code = /^[A-Z_]{1,80}$/.test(value.code) ? value.code : 'PLAN_INVALID';
      const owner = ['agent-content', 'runtime', 'environment'].includes(value.validation.owner) ? value.validation.owner : 'runtime';
      const key = `${code}:${rule}`;
      if (!seen.has(key)) { seen.add(key); result.push({ code, rule, owner }); }
    } catch { /* Missing diagnostic data cannot authorize or replay an operation. */ }
  }
  return result.reverse();
}
