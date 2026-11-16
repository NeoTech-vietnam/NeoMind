import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { hashJson } from '../domain/resolve.js';

const id = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({ version: z.literal(1), runId: id, nodeId: id, attemptId: id, requestId: id,
  checkpointHash: digest, taskHash: digest, actionHash: digest, receiptHash: digest, generation: z.number().int().safe().positive(),
  planHash: digest, approvalHash: digest, approvalEventId: id, policyHash: digest, journalHash: digest,
  journalSequence: z.number().int().safe().positive(), workspaceHash: digest, writableRootsHash: digest,
  leaseHostHash: digest, fence: z.number().int().safe().positive(), baselineHash: digest });
const fingerprintSchema = z.strictObject({ binding: bindingSchema, bindingHash: digest });
type Fingerprint = z.infer<typeof fingerprintSchema>;

/**
 * Durable local no-replay marker, not an authorization service. Only a trusted host may open this store or supply a
 * fingerprint. The caller must separately authenticate authority and verify journal, checkpoint, policy and worker stop.
 * A recorded reservation never authorizes dispatch and cannot be automatically reset or completed by this store.
 */
export class LangConfigReservations {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS langconfig_reservation (
        run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, request_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL UNIQUE, binding_hash TEXT NOT NULL,
        PRIMARY KEY (run_id, attempt_id), UNIQUE (run_id, request_id)
      );`);
  }

  reserve(value: Fingerprint): 'recorded' | 'unknown' | 'conflict' {
    const { binding, bindingHash } = fingerprintSchema.parse(value);
    if (hashJson(binding) !== bindingHash) throw new Error('Fingerprint hash mismatch');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT request_id, receipt_hash, binding_hash FROM langconfig_reservation WHERE run_id = ? AND attempt_id = ?')
        .get(binding.runId, binding.attemptId);
      let outcome: 'recorded' | 'unknown' | 'conflict';
      if (existing) {
        outcome = existing.request_id === binding.requestId && existing.receipt_hash === binding.receiptHash && existing.binding_hash === bindingHash ? 'unknown' : 'conflict';
      } else if (this.db.prepare('SELECT 1 FROM langconfig_reservation WHERE (run_id = ? AND request_id = ?) OR receipt_hash = ?')
        .get(binding.runId, binding.requestId, binding.receiptHash)) {
        outcome = 'conflict';
      } else {
        this.db.prepare('INSERT INTO langconfig_reservation VALUES (?, ?, ?, ?, ?)')
          .run(binding.runId, binding.attemptId, binding.requestId, binding.receiptHash, bindingHash);
        outcome = 'recorded';
      }
      this.db.exec('COMMIT');
      return outcome;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
