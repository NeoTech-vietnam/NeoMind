import { SingleOwnerJournal, type NewRunEvent, type RunEvent } from './journal.js';
import { WorkspaceCoordinator, type RunOwnerLease } from './coordination.js';

/**
 * Journal access for a cooperating scheduler holding the exclusive run lease.
 * Calls in this process are serialized. The coordinator must not release or
 * replace this lease until this instance is closed and the scheduler stopped.
 * A run lease does not fence processes or workers outside NeoMind.
 */
export class OwnedJournal {
  readonly file: string;
  readonly runId: string;
  private readonly journal: SingleOwnerJournal;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(file: string, private readonly coordinator: WorkspaceCoordinator, private readonly lease: RunOwnerLease) {
    this.file = file; this.runId = lease.runId;
    this.journal = new SingleOwnerJournal(file, lease.runId);
    if (!coordinator.isRunOwner(lease)) throw new Error('Stale run owner lease');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Owned journal is closed'));
    const result = this.pending.then(async () => {
      if (!this.coordinator.isRunOwner(this.lease)) throw new Error('Stale run owner lease');
      return operation();
    });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  read(): Promise<RunEvent[]> { return this.enqueue(() => this.journal.read()); }
  append(input: NewRunEvent, expectedSequence: number): Promise<RunEvent> {
    return this.enqueue(() => this.journal.append(input, expectedSequence));
  }
  async close(): Promise<void> { this.closed = true; await this.pending; }
}
