// Real engine lifecycle fixture. No prompt is submitted to a model/provider.
import { registerControlledContext } from '../../dist/controlled-context.js';
import { startNative } from '../../dist/native.js';
import { OpenCodeSession } from '../../dist/opencode-session.js';
import { randomUUID } from 'node:crypto';
const [root, workflowId, taskId] = process.argv.slice(2);
OpenCodeSession.prototype.run = async function () {};
const requestId = randomUUID();
registerControlledContext(root, requestId, { epoch_id: randomUUID(),
  binding: { workflow_id: workflowId, task_id: taskId, role: 'developer', stage: 'implementation',
    process_contract: 'workforce/v1', implementation_paths: ['products'], verification_paths: [],
    read_paths: ['products'], execution_steps: [], procedure_bound: false, cornell_bound: false },
  bindInvocation() {}, callbacks: { assertActive() {}, saveReport() { throw new Error('No model report is expected.'); } } });
try {
  const receipt = await startNative(root, { role: 'developer', workflow_id: workflowId, task_id: taskId,
    request_id: requestId, prompt: 'Lifecycle fixture: the engine opens without submitting this prompt.' });
  process.send?.({ id: receipt.id, state: receipt.state, supervision: Boolean(receipt.opencode?.supervision) });
  setInterval(() => {}, 1000);
} catch (error) { process.send?.({ failed: true, name: error.name }); process.exitCode = 1; }
