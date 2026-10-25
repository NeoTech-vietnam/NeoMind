import { resolve } from 'node:path';
import type { ControlledBinding, ControlledCallbacks } from './controlled-tools.js';

/** Private process memory. A model never receives this binding or an authentication token. */
export interface OwnedContext {
  binding: ControlledBinding;
  callbacks: ControlledCallbacks;
  epoch_id: string;
  bindInvocation(id: string): void;
}
const contexts = new Map<string, OwnedContext>();
const key = (root: string, request: string) => `${resolve(root)}\0${request}`;
export function registerControlledContext(root: string, request: string, context: OwnedContext): () => void {
  const id = key(root, request);
  if (contexts.has(id)) throw new Error('Controlled attempt already has an owner.');
  contexts.set(id, context);
  return () => { if (contexts.get(id) === context) contexts.delete(id); };
}
export function ownedContext(root: string, request?: string | null): OwnedContext | undefined {
  return request ? contexts.get(key(root, request)) : undefined;
}
