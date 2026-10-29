import { WorkspaceCoordinator } from '../../src/storage/coordination.js';
const [, , file, runId, hostId] = process.argv;
if (!file || !runId || !hostId) throw new Error('Expected database, run ID and host ID');
const coordinator = new WorkspaceCoordinator(file);
try { const lease = coordinator.acquireRun(runId, hostId); process.stdout.write(JSON.stringify({ acquired: true, fence: lease.fence })); }
catch (error) { process.stdout.write(JSON.stringify({ acquired: false, message: error instanceof Error ? error.message : String(error) })); }
finally { coordinator.close(); }
