/** Local engine preparation is not provider execution. Each phase has its own
 * bounded clock; changing phases once cannot create an unbounded retry budget. */
export function createConnectionCheckBudget(parent?: AbortSignal,
  milliseconds = { preparation: 120000, model: 120000 }) {
  for (const value of Object.values(milliseconds))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Connection phase deadlines must be positive bounded milliseconds.');
  parent?.throwIfAborted();
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let phase: 'preparation' | 'model' = 'preparation', disposed = false;
  const expired = () => controller.abort(new Error(phase === 'preparation'
    ? 'WORKFORCE_ENGINE_PREPARATION_TIMEOUT: local engine preparation did not finish; no model request was sent.'
    : 'WORKFORCE_MODEL_CHECK_TIMEOUT: the configured model routes did not finish their tool-call check.'));
  let timer = setTimeout(expired, milliseconds.preparation);
  const clear = () => clearTimeout(timer);
  signal.addEventListener('abort', clear, { once: true });
  return {
    signal,
    beginModelCheck() {
      signal.throwIfAborted();
      if (disposed || phase !== 'preparation') throw new Error('A connection check cannot restart its model deadline.');
      clear(); phase = 'model'; timer = setTimeout(expired, milliseconds.model);
    },
    dispose() { disposed = true; clear(); signal.removeEventListener('abort', clear); },
  };
}
