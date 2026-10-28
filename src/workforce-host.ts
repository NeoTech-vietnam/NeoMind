import { exactRoot, serveHost } from './vscode-wire.js';
import { dispatchControlledHost } from './controlled-workflow.js';
import { readConfig, withOperationLock } from './storage.js';

/** VS Code owns lifetime and intake; OpenCode owns model conversations. */
export async function enableWorkForceHost(vscode: any, workspaceRoot: string): Promise<{ close(): Promise<void> }> {
  const root = exactRoot(workspaceRoot);
  const enabled = () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.some(
    (folder: any) => folder.uri.scheme === 'file' && exactRoot(folder.uri.fsPath) === root);
  if (!enabled()) throw new Error('WorkForce requires the exact open trusted workspace.');
  if (readConfig(root).execution_engine !== 'opencode') throw new Error('Migrate this project to the WorkForce OpenCode engine before connecting.');
  let closed = false;
  const server = await serveHost(root, async (operation, input) => {
    if (closed || !enabled()) throw new Error('WorkForce workspace owner is no longer available.');
    if (!['controlled-start', 'controlled-control', 'controlled-status', 'controlled-answer'].includes(operation))
      throw new Error('This WorkForce owner accepts request control only; model sessions use OpenCode.');
    return dispatchControlledHost(root, operation, input);
  }, { publish_descriptor: publish => withOperationLock(root, 'package-upgrade', publish) });
  return { close: async () => { if (closed) return; closed = true; await server.close(); } };
}
