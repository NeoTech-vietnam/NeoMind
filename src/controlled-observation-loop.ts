import { hash } from './storage.js';
import { redactControlledValue } from './controlled-observability.js';

interface EvidenceSelector { kind: 'execution' | 'workflow' | 'registration'; title?: string }
export interface ControlledObservationNotice {
  kind: 'notice' | 'reconcile';
  code: 'CONTROLLED_OBSERVATION_REPEAT' | 'CONTROLLED_OBSERVATION_LOOP';
  selector: EvidenceSelector;
  unchanged_observations: number;
  already_read_selectors: EvidenceSelector[];
  next_action: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function semanticEvidence(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const original = value as Record<string, unknown>;
  if (original.kind !== 'workflow') return value;
  const result: Record<string, unknown> = { ...original };
  delete result.observed_at;
  if (original.preservation && typeof original.preservation === 'object' && !Array.isArray(original.preservation)) {
    const preservation = { ...original.preservation as Record<string, unknown> };
    delete preservation.checked_at; result.preservation = preservation;
  }
  if (original.state && typeof original.state === 'object' && !Array.isArray(original.state)) {
    const state = { ...original.state as Record<string, unknown> };
    delete state.revision; result.state = state;
  }
  return result;
}
function resultHash(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content.map(block => {
    if (!block || typeof block !== 'object') return block;
    const item = block as Record<string, unknown>;
    if (item.type !== 'text' || typeof item.text !== 'string') return item;
    try { return { ...item, text: semanticEvidence(JSON.parse(item.text)) }; }
    catch { return item; }
  }) : result.content;
  return hash(canonical({ ...result, content }));
}
function evidenceSelector(input: Record<string, unknown>): EvidenceSelector {
  const kind = input.kind === 'workflow' || input.kind === 'registration' ? input.kind : 'execution';
  return { kind, ...(kind === 'execution' && typeof input.title === 'string' ? { title: input.title.trim() } : {}) };
}
function publicSelector(input: EvidenceSelector): EvidenceSelector {
  const safeTitle = typeof input.title === 'string' ? redactControlledValue(input.title.slice(0, 256)) : undefined;
  return { kind: input.kind,
    ...(safeTitle !== undefined ? { title: (typeof safeTitle === 'string' ? safeTitle : JSON.stringify(safeTitle)).slice(0, 256) } : {}) };
}

/** Observe fresh successful evidence reads, never cache or manufacture evidence. */
export class ControlledObservationLoop {
  private state?: string;
  private observation = 0;
  private selectors = new Map<string, { selector: EvidenceSelector; result: string; count: number; notice_round?: number }>();

  observe(tool: string, input: unknown, result: unknown, state: string, modelRound = ++this.observation): ControlledObservationNotice | undefined {
    if (tool !== 'check_evidence' || !result || typeof result !== 'object' ||
      (result as Record<string, unknown>).isError === true) return undefined;
    if (this.state !== state) { this.state = state; this.selectors.clear(); }
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const selected = evidenceSelector(args), request = hash(canonical(selected));
    const fingerprint = resultHash(result as Record<string, unknown>), prior = this.selectors.get(request);
    const count = prior?.result === fingerprint ? prior.count + 1 : 1;
    const selector = publicSelector(selected);
    const noticeRound = count >= 2 ? prior?.notice_round ?? modelRound : undefined;
    this.selectors.set(request, { selector, result: fingerprint, count, notice_round: noticeRound });
    if (count < 2) return undefined;
    // Calls in one model response have not seen this response's pending notice.
    // Give the next SDK round a chance to act on it before reconciling.
    if (count > 2 && noticeRound === modelRound) return undefined;
    const reconcile = count > 2;
    return { kind: reconcile ? 'reconcile' : 'notice',
      code: reconcile ? 'CONTROLLED_OBSERVATION_LOOP' : 'CONTROLLED_OBSERVATION_REPEAT',
      selector, unchanged_observations: count,
      already_read_selectors: [...this.selectors.values()].slice(-8).map(entry => entry.selector),
      next_action: !reconcile
        ? 'This fresh evidence is unchanged and has already been read. Use the returned facts to finish the assigned professional work, inspect a genuinely different fact, or save honest blocked/failed findings if needed. A completed verification/review still requires your explicit supported pass/fail verdict. No acceptance or verdict is inferred.'
        : 'The same fresh evidence remains unchanged after the backend repeat notice. Retain existing artifacts and partial reports. The runtime must reconcile this session using its existing protocol recovery before continuing the same stage; no verdict or workflow acceptance was produced.' };
  }
}
