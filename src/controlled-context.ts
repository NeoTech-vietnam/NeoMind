import { realpathSync, statSync } from 'node:fs';
import type { ControlledBinding, ControlledCallbacks } from './controlled-tools.js';

/** Private process memory. A model never receives this binding or an authentication token. */
export interface OwnedContext {
  binding: ControlledBinding;
  callbacks: ControlledCallbacks;
  epoch_id: string;
  bindInvocation(id: string): void;
}
const contexts = new Map<string, OwnedContext>();
function key(root: string, request: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(root);
    if (!statSync(physical).isDirectory()) throw new Error('not a project directory');
  } catch { throw new Error('Controlled context requires an existing project directory.'); }
  return `${process.platform === 'win32' ? physical.toLowerCase() : physical}\0${request}`;
}
export function registerControlledContext(root: string, request: string, context: OwnedContext): () => void {
  const id = key(root, request);
  if (contexts.has(id)) throw new Error('Controlled attempt already has an owner.');
  contexts.set(id, context);
  return () => { if (contexts.get(id) === context) contexts.delete(id); };
}
export function ownedContext(root: string, request?: string | null): OwnedContext | undefined {
  if (!request) return undefined;
  try { return contexts.get(key(root, request)); }
  catch { return undefined; }
}
