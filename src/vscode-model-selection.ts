type Selector = { vendor: string; id: string };
interface Pending { reject(error: Error): void }

/** One enabled Bridge owner; handles are reusable only with live catalog invalidation. */
export class VSCodeModelSelection {
  private generation = 0;
  private closed = false;
  private subscription?: { dispose(): void };
  private handles = new Map<string, any>();
  private flights = new Map<string, Promise<any[]>>();
  private pending = new Set<Pending>();
  constructor(private readonly lm: any, private readonly active: () => boolean) {
    if (typeof lm.onDidChangeChatModels === 'function') {
      try {
        const subscription = lm.onDidChangeChatModels(() => this.invalidate('VS Code model catalog changed during selection.'));
        if (subscription && typeof subscription.dispose === 'function') this.subscription = subscription;
      } catch { /* Without a usable invalidation subscription, retain fresh selection per open. */ }
    }
  }
  private assertActive(): void {
    if (this.closed || !this.active()) throw new Error('Host closed during model selection.');
  }
  private invalidate(message: string): void {
    this.generation++; this.handles.clear(); this.flights.clear();
    for (const pending of [...this.pending]) pending.reject(new Error(message));
  }
  async select(selector: Selector): Promise<any[]> {
    this.assertActive();
    const key = JSON.stringify([selector.vendor, selector.id]);
    if (this.subscription) {
      const model = this.handles.get(key);
      if (model && model.id === selector.id && model.vendor === selector.vendor) return [model];
      this.handles.delete(key);
      const flight = this.flights.get(key);
      if (flight) return flight;
    }
    if (this.pending.size >= 256) throw new Error('Host model selection limit reached.');
    const generation = this.generation;
    const selection = this.query({ ...selector }, generation).then(models => {
      this.assertActive();
      if (generation !== this.generation) throw new Error('VS Code model catalog changed during selection.');
      if (!Array.isArray(models) || models.length > 1 || models.length === 1 &&
          (models[0]?.id !== selector.id || models[0]?.vendor !== selector.vendor))
        throw new Error('VS Code model selection is ambiguous or mismatched; require exactly one matching live model.');
      if (this.subscription && models.length === 1) {
        if (this.handles.size >= 256) this.handles.delete(this.handles.keys().next().value!);
        this.handles.set(key, models[0]);
      }
      return models;
    });
    if (this.subscription) this.flights.set(key, selection);
    void selection.finally(() => { if (this.flights.get(key) === selection) this.flights.delete(key); }).catch(() => {});
    return selection;
  }
  private query(selector: Selector, generation: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = performance.now() + 10000;
      const pending: Pending = { reject: error => finish(error) };
      const finish = (error?: unknown, models?: any[]) => {
        if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(pending);
        if (error !== undefined) reject(error); else resolve(models!);
      };
      const timer = setTimeout(() => finish(new Error('VS Code model selection timed out.')), 10000);
      this.pending.add(pending);
      void Promise.resolve().then(() => {
        this.assertActive();
        if (generation !== this.generation) throw new Error('VS Code model catalog changed during selection.');
        return this.lm.selectChatModels(selector);
      }).then(models => finish(performance.now() >= deadline ? new Error('VS Code model selection timed out.') : undefined, models), error => finish(error));
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidate('Host closed during model selection.');
    try { this.subscription?.dispose(); } catch { /* Closing never restores a stale handle. */ }
    this.subscription = undefined;
  }
}
