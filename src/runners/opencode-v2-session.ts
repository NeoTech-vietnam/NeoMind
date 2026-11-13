import path from 'node:path';
import { z } from 'zod';
import type { OpenCodeV2Rule } from './opencode-v2-contract.js';

type Transport = { request(method: 'GET' | 'POST', endpoint: string, body?: unknown, timeoutMs?: number): Promise<unknown> };
const nativeSession = z.object({ data: z.object({ id: z.string().regex(/^ses_[A-Za-z0-9]+$/), parentID: z.string().optional(),
  agent: z.string(), model: z.object({ id: z.string(), providerID: z.string(), variant: z.string().optional() }),
  metadata: z.object({ neomindSession: z.string() }), location: z.object({ directory: z.string() }),
  permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.string() })) }) });

export type OpenCodeV2SessionSpec = { logicalId: string; workspace: string; provider: string; model: string; variant?: string; permissions: OpenCodeV2Rule[] };

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The server's response, not just the requested settings, must prove the binding. */
export function verifyOpenCodeV2Session(response: unknown, spec: OpenCodeV2SessionSpec, expectedId?: string): string {
  const { data } = nativeSession.parse(response);
  if ((expectedId && data.id !== expectedId) || data.parentID || !samePath(data.location.directory, spec.workspace)
    || data.metadata.neomindSession !== spec.logicalId || data.agent !== 'build'
    || data.model.id !== spec.model || data.model.providerID !== spec.provider || data.model.variant !== spec.variant
    || JSON.stringify(data.permissions) !== JSON.stringify(spec.permissions)) throw new Error('OpenCode V2 session identity or permissions mismatch');
  return data.id;
}

/** Create and independently reread the session before the caller may persist its mapping or dispatch. */
export async function createOpenCodeV2Session(server: Transport, spec: OpenCodeV2SessionSpec): Promise<string> {
  const created = await server.request('POST', '/api/session', { location: { directory: path.resolve(spec.workspace) },
    metadata: { neomindSession: spec.logicalId }, agent: 'build', model: { providerID: spec.provider, id: spec.model, ...(spec.variant ? { variant: spec.variant } : {}) }, permissions: spec.permissions });
  const id = verifyOpenCodeV2Session(created, spec);
  verifyOpenCodeV2Session(await server.request('GET', `/api/session/${encodeURIComponent(id)}`), spec, id);
  return id;
}
