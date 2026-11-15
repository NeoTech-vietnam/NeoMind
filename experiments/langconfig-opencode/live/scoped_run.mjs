// Own one scope through completion or interruption, including failed startup.
export async function runScoped({ scope, launch, runChild, signals = process, onStop = () => {} }) {
  let interrupted;
  let wake;
  const cancelled = new Promise(resolve => { wake = resolve; });
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    if (!interrupted) { interrupted = name; wake(name); }
  }]));
  for (const [name, handler] of handlers) signals.on(name, handler);
  let stopped = false;
  let outcome;
  try {
    if (!interrupted) {
      const child = await scope.start(launch);
      if (!interrupted) {
        outcome = await Promise.race([
          runChild(child, controller.signal),
          cancelled.then(() => 'interrupted'),
        ]);
      }
    }
  } finally {
    controller.abort();
    try { stopped = await scope.stop(); }
    finally {
      for (const [name, handler] of handlers) signals.removeListener(name, handler);
      onStop(stopped);
    }
    if (!stopped) throw Error('fixture scope stop unconfirmed');
  }
  return { outcome: interrupted ? 'interrupted' : outcome, signal: interrupted };
}
