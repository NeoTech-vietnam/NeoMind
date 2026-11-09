export class ProgressWaitError extends Error {
  constructor(code, snapshot) { super(code); this.code = code; this.snapshot = snapshot; }
}

/** Test observation only: a cheap journal probe cannot establish acceptance.
 * Meaningful progress can renew inactivity, but never the absolute time cap. */
export async function waitForProgress({ probe, inspect, accept, reject, progress, idleMs = 90000,
  totalMs = 270000, pollMs = 500, inspectMs = 5000,
  now = () => performance.now(), pause = ms => new Promise(done => setTimeout(done, ms)) }) {
  if (![idleMs, totalMs, pollMs, inspectMs].every(value => Number.isFinite(value) && value > 0))
    throw new RangeError('Test waiting budgets must be finite positive durations.');
  const started = now(), seen = new Set();
  let lastProgress = started, lastInspection = -Infinity;
  let snapshot;
  const checkDeadline = () => {
    if (now() - started >= totalMs) throw new ProgressWaitError('TOTAL_TIMEOUT', snapshot);
    if (now() - lastProgress >= idleMs) throw new ProgressWaitError('INACTIVITY_TIMEOUT', snapshot);
  };
  for (;;) {
    checkDeadline();
    snapshot = await probe();
    checkDeadline();
    // Revalidate candidates before returning and periodically detect owner loss
    // even when a stale journal still says running. Heartbeats never renew idle.
    if (accept(snapshot) || reject(snapshot) || now() - lastInspection >= inspectMs) {
      snapshot = await inspect();
      lastInspection = now();
      checkDeadline();
      if (accept(snapshot)) return snapshot;
      if (reject(snapshot)) throw new ProgressWaitError('UNEXPECTED_STATE', snapshot);
    }
    const key = progress(snapshot);
    if (typeof key !== 'string') throw new TypeError('Use a stable semantic progress key.');
    if (!seen.has(key)) { seen.add(key); lastProgress = now(); }
    await pause(Math.min(pollMs, idleMs - (now() - lastProgress), totalMs - (now() - started)));
  }
}
