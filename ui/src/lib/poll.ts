import { useEffect, useRef } from 'react';

/**
 * Call `tick` now and then every `ms` while mounted; a slow call is never overlapped by the next one. `ms` may change
 * between renders (fast while a run is active, slow once it ended) without restarting the loop.
 */
export function usePoll(tick: () => Promise<void> | void, ms: number, deps: unknown[]): void {
  const latest = useRef(tick), delay = useRef(ms);
  latest.current = tick; delay.current = ms;
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (disposed) return;
      try { await latest.current(); } catch { /* the caller shows its own errors */ }
      if (!disposed) timer = setTimeout(() => void loop(), delay.current);
    };
    void loop();
    return () => { disposed = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
