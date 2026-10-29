export type RunPhase = 'running' | 'stopping' | 'stop_unconfirmed' | 'paused' | 'cancelled' | 'waiting' | 'recovering';
export type StopIntent = 'pause' | 'cancel' | 'deadline';
export type AttemptState = 'running' | 'stop_requested' | 'unknown' | 'settled';
export interface Lifecycle {
  phase: RunPhase;
  stopIntent: StopIntent | null;
  attempts: Record<string, AttemptState>;
}

/** Pure transitions only. Persistence, runtime stop calls and ownership are separate responsibilities. */
export function admitAttempt(state: Lifecycle, attemptId: string, maxConcurrency: number): Lifecycle {
  if (state.phase !== 'running' || state.stopIntent) throw new Error('Run is not accepting work');
  if (!attemptId || Object.hasOwn(state.attempts, attemptId)) throw new Error('Duplicate or empty attempt ID');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('Invalid concurrency limit');
  if (Object.values(state.attempts).filter(s => s !== 'settled').length >= maxConcurrency) throw new Error('Concurrency limit reached');
  const next = structuredClone(state); next.attempts[attemptId] = 'running'; return next;
}

export function requestStop(state: Lifecycle, intent: StopIntent): Lifecycle {
  if (!['running', 'stopping', 'stop_unconfirmed', 'paused', 'waiting'].includes(state.phase)) throw new Error('Cannot stop this run');
  if (state.stopIntent && state.stopIntent !== intent && intent !== 'cancel') throw new Error('Cannot replace stop intent');
  const next = structuredClone(state); next.stopIntent = intent; next.phase = 'stopping';
  for (const [id, status] of Object.entries(next.attempts)) if (status === 'running') next.attempts[id] = 'stop_requested';
  return finalizeIfStopped(next);
}

function finalizeIfStopped(state: Lifecycle): Lifecycle {
  if (!state.stopIntent || Object.values(state.attempts).some(s => s !== 'settled')) return state;
  state.phase = state.stopIntent === 'pause' ? 'paused' : state.stopIntent === 'cancel' ? 'cancelled' : 'waiting';
  return state;
}

export function observeStop(state: Lifecycle, attemptId: string, outcome: 'confirmed' | 'unknown'): Lifecycle {
  if (!state.stopIntent || !Object.hasOwn(state.attempts, attemptId) || state.attempts[attemptId] === 'settled') throw new Error('No outstanding stop for attempt');
  const next = structuredClone(state);
  next.attempts[attemptId] = outcome === 'confirmed' ? 'settled' : 'unknown';
  next.phase = Object.values(next.attempts).includes('unknown') ? 'stop_unconfirmed' : 'stopping';
  return finalizeIfStopped(next);
}

export function beginRecovery(state: Lifecycle): Lifecycle {
  if (state.phase !== 'paused' && state.phase !== 'waiting') throw new Error('Run is not resumable');
  return { ...structuredClone(state), phase: 'recovering' };
}

export function finishRecovery(state: Lifecycle, userConfirmed: boolean, reconciled: boolean): Lifecycle {
  if (state.phase !== 'recovering') throw new Error('Run is not reconciling');
  if (!userConfirmed || !reconciled || Object.values(state.attempts).some(s => s !== 'settled')) throw new Error('Recovery is not safe to resume');
  return { ...structuredClone(state), phase: 'running', stopIntent: null };
}

/** An unresolved worker retains its slot and workspace ownership. */
export function mayReleaseWorkspace(state: Lifecycle): boolean {
  return Object.values(state.attempts).every(status => status === 'settled');
}
