/** Tracks domain work through durable persistence, independently of cancelled transport requests. */
export class ControlledOperationDrain {
  private pending = new Map<string, Set<Promise<unknown>>>();

  run<T>(workflow: string, operation: () => Promise<T>): Promise<T> {
    const promise = operation(), jobs = this.pending.get(workflow) ?? new Set<Promise<unknown>>();
    jobs.add(promise); this.pending.set(workflow, jobs);
    const remove = () => {
      jobs.delete(promise);
      if (!jobs.size && this.pending.get(workflow) === jobs) this.pending.delete(workflow);
    };
    void promise.then(remove, remove);
    return promise;
  }

  workflows(): string[] { return [...this.pending.keys()]; }

  async drain(workflow: string): Promise<void> {
    for (;;) {
      const jobs = this.pending.get(workflow);
      if (!jobs?.size) return;
      await Promise.allSettled([...jobs]);
    }
  }
}
