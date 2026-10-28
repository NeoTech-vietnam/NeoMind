import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { safePath, hash, atomicWrite, withOperationLock } from './storage.js';
import { canonicalJson } from './routing.js';
import type { ControlledStartInput } from './controlled-workflow.js';

interface Admission { id: string; payload_hash: string; acknowledged: boolean; workflow_id?: string }
const path = '.workforce/controlled/request-admissions.json';
function load(root: string): Admission[] {
  const file = safePath(root, path); if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.schema_version !== 1 || !Array.isArray(value.entries) || value.entries.some((entry: Admission) =>
    !/^[a-f0-9-]{36}$/i.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.payload_hash) || typeof entry.acknowledged !== 'boolean'))
    throw new Error('WorkForce admission state needs reconciliation; no duplicate request was dispatched.');
  return value.entries;
}
function save(root: string, entries: Admission[]) { atomicWrite(safePath(root, path), JSON.stringify({ schema_version: 1, entries }, null, 2) + '\n'); }

/** The stable admission is committed before IPC. A lost MCP reply can recover it. */
export function prepareWorkForceIntake(root: string, input: ControlledStartInput, newRequest = false): ControlledStartInput {
  if (input.request_id || input.workflow_id) return input;
  const payload = { requirement: input.requirement?.trim(), requirements: input.requirements?.map(value => value.trim()),
    title: input.title?.trim(), context: input.context ?? [] };
  const digest = hash(canonicalJson(payload));
  return withOperationLock(root, 'workforce-admission', () => {
    const entries = load(root), prior = newRequest ? undefined : entries.findLast(entry => entry.payload_hash === digest && !entry.acknowledged);
    if (prior) return { ...input, request_id: prior.id };
    const entry = { id: randomUUID(), payload_hash: digest, acknowledged: false }; entries.push(entry); save(root, entries);
    return { ...input, request_id: entry.id };
  });
}
export function recordWorkForceAdmission(root: string, requestId: string, workflowId: string, acknowledge = false): void {
  withOperationLock(root, 'workforce-admission', () => {
    const entries = load(root), entry = entries.find(entry => entry.id === requestId);
    if (!entry) return;
    if (entry.workflow_id && entry.workflow_id !== workflowId) throw new Error('WorkForce admission differs from its saved request.');
    entry.workflow_id = workflowId; entry.acknowledged ||= acknowledge; save(root, entries);
  });
}
