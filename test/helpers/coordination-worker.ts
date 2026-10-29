import { WorkspaceCoordinator } from '../../src/storage/coordination.js';

const [, , file, workspace, runId] = process.argv;
if (!file || !workspace || !runId) throw new Error('Expected file, workspace and run ID');
const coordinator = new WorkspaceCoordinator(file);
try {
  const lease = coordinator.acquire(workspace, runId, 'host');
  process.stdout.write(JSON.stringify({ acquired: true, fence: lease.fence }));
} catch (error) {
  process.stdout.write(JSON.stringify({ acquired: false, message: error instanceof Error ? error.message : String(error) }));
} finally { coordinator.close(); }
