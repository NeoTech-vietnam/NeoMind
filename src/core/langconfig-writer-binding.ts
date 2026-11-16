import { z } from 'zod';
import { approvalSchema, planSchema } from '../domain/approval.js';
import { hashJson } from '../domain/resolve.js';
import { flowSchema, projectPolicySchema } from '../domain/schema.js';
import type { OwnedJournal } from '../storage/owned-journal.js';
import { admitIsolatedWorkspaceWrite } from '../workspace/write-admission.js';
import { captureBaseline } from '../workspace/baseline.js';
import { replayRun } from './recovery.js';

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const externalIdentity = z.strictObject({
  threadId: id, checkpointId: id, interruptId: id, taskHash: digest, actionHash: digest,
  receiptId: id, generation: z.number().int().safe().positive(),
});
type Admission = Parameters<typeof admitIsolatedWorkspaceWrite>[0];

/**
 * Construct a comparison fingerprint, not an authority or dispatch grant. The trusted host must independently
 * authenticate and read the external identity; caller-supplied values and this hash do not prove authorization.
 * No external transaction, worker stop, lock, or journal append is performed here.
 */
export async function prepareLangConfigWriterBinding(input: {
  journal: OwnedJournal; admission: Admission; nodeId: string; attemptId: string; requestId: string;
  external: z.infer<typeof externalIdentity>;
}) {
  const external = externalIdentity.parse(input.external);
  const nodeId = id.parse(input.nodeId), attemptId = id.parse(input.attemptId), requestId = id.parse(input.requestId);
  const leaseHash = hashJson(input.admission.lease), policyHash = hashJson(input.admission.livePolicy);
  if (input.admission.lease.runId !== input.journal.runId) throw new Error('Workspace lease belongs to another run');
  const events = await input.journal.read(), report = replayRun(events);
  const created = z.object({ flow: flowSchema, policy: projectPolicySchema }).parse(events[0]?.payload);
  if (hashJson(created.policy) !== policyHash) throw new Error('Live policy does not match journal');
  const flow = created.flow;
  const node = flow.definition.nodes.find(item => item.id === nodeId);
  if (!((node?.type === 'agent_task' && node.permissions.write) || (node?.type === 'integration' && node.bindingId))) throw new Error('Node cannot write the workspace');
  if (report.graph.nodes[nodeId]?.status !== 'ready') throw new Error('Writer is not ready');
  if (report.attempts.some(item => item.attemptId === attemptId) || events.some(event => event.requestId === requestId)) throw new Error('Attempt or request already exists');
  if (report.attempts.some(item => item.status === 'unresolved' && (!item.workspace || item.workspace === input.admission.lease.workspace)) || report.unresolvedCheckIds.length) {
    throw new Error('Reconcile unresolved work before binding');
  }
  const planHash = hashJson(input.admission.plan), approvalHash = hashJson(input.admission.approval);
  const approvals = events.filter(event => {
    if (event.type !== 'approval_recorded') return false;
    const parsed = z.object({ plan: planSchema, approval: approvalSchema }).safeParse(event.payload);
    return parsed.success && hashJson(parsed.data.plan) === planHash && hashJson(parsed.data.approval) === approvalHash;
  });
  if (approvals.length !== 1 || !report.approvals.some(item => hashJson(item.plan) === planHash && hashJson(item.approval) === approvalHash)) {
    throw new Error('Expected one matching journaled approval');
  }
  const grant = await admitIsolatedWorkspaceWrite(input.admission);
  // Recheck observed state, without claiming an atomic snapshot or dispatch fence.
  const currentEvents = await input.journal.read();
  if (hashJson(currentEvents) !== hashJson(events) || !input.admission.coordinator.isCurrent(input.admission.lease) ||
      (await captureBaseline(grant.workspace)).baselineHash !== grant.baseline.baselineHash ||
      hashJson(input.admission.lease) !== leaseHash || hashJson(input.admission.livePolicy) !== policyHash ||
      hashJson(input.admission.plan) !== planHash || hashJson(input.admission.approval) !== approvalHash) throw new Error('Binding changed during preparation');
  const binding = Object.freeze({ version: 1 as const, runId: input.journal.runId, nodeId, attemptId, requestId,
    checkpointHash: hashJson({ threadId: external.threadId, checkpointId: external.checkpointId, interruptId: external.interruptId }),
    taskHash: external.taskHash, actionHash: external.actionHash, receiptHash: hashJson(external.receiptId), generation: external.generation,
    planHash, approvalHash, approvalEventId: approvals[0]!.eventId, policyHash,
    journalHash: hashJson(events), journalSequence: events.length, workspaceHash: hashJson(grant.workspace),
    writableRootsHash: hashJson(grant.writableRoots), leaseHostHash: hashJson(input.admission.lease.hostId),
    fence: grant.fence, baselineHash: grant.baseline.baselineHash });
  return Object.freeze({ binding, bindingHash: hashJson(binding) });
}
