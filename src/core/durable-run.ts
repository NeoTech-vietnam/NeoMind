import { randomUUID } from 'node:crypto';
import { WorkspaceCoordinator, type RunOwnerLease } from '../storage/coordination.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { RunStore } from '../storage/run-store.js';
import { RunService } from './run-service.js';

/** Owns only scheduler coordination. Workspace leases require independent worker reconciliation. */
export class DurableRun {
  private closing = false;
  private constructor(readonly service: RunService, readonly journal: OwnedJournal,
    private readonly coordinator: WorkspaceCoordinator, private readonly owner: RunOwnerLease) {}
  static async create(store: RunStore, coordinator: WorkspaceCoordinator, runId: string, flow: unknown, policy: unknown): Promise<DurableRun> {
    const owner = coordinator.acquireRun(runId, randomUUID());
    try {
      const journal = new OwnedJournal(await store.create(runId), coordinator, owner);
      const service = await RunService.create(journal, flow, policy);
      return new DurableRun(service, journal, coordinator, owner);
    } catch (error) { coordinator.releaseRun(owner, true); throw error; }
  }
  static async createMaterialized(store: RunStore, coordinator: WorkspaceCoordinator, runId: string, snapshot: unknown): Promise<DurableRun> {
    const owner = coordinator.acquireRun(runId, randomUUID());
    try {
      const journal = new OwnedJournal(await store.create(runId), coordinator, owner);
      const service = await RunService.createMaterialized(journal, snapshot);
      return new DurableRun(service, journal, coordinator, owner);
    } catch (error) { coordinator.releaseRun(owner, true); throw error; }
  }
  static async recover(store: RunStore, coordinator: WorkspaceCoordinator, runId: string): Promise<DurableRun> {
    const previous = coordinator.getRunOwner(runId);
    if (previous) coordinator.reclaimDeadRun(previous);
    const owner = coordinator.acquireRun(runId, randomUUID());
    try {
      const journal = new OwnedJournal(await store.journal(runId), coordinator, owner);
      const service = await RunService.recover(journal);
      return new DurableRun(service, journal, coordinator, owner);
    } catch (error) { coordinator.releaseRun(owner, true); throw error; }
  }
  async close(): Promise<void> {
    if (this.closing) throw new Error('Run is closing');
    this.closing = true;
    await this.service.close(); await this.journal.close(); this.coordinator.releaseRun(this.owner, true);
  }
}
