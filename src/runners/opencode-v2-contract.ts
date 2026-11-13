import { z } from 'zod';
import type { AvailableRunnerModel } from './agent-runner.js';

// V2 configuration and APIs are different from V1; do not infer compatibility from the major version.
export const OPENCODE_V2_VERSION = '2.2.7';

export function verifyOpenCodeV2Info(response: unknown): void {
  const info = z.object({ version: z.string(), pid: z.number().int().positive() }).parse(response);
  if (info.version !== OPENCODE_V2_VERSION) throw new Error(`Unsupported OpenCode version: expected ${OPENCODE_V2_VERSION}`);
}

export type OpenCodeV2Rule = { action: string; resource: string; effect: 'allow' | 'deny' };

/** Rules are ordered: later matches override earlier ones. Not an OS sandbox. */
export function openCodeV2Rules(write: boolean, webAccess: boolean): OpenCodeV2Rule[] {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep', ...(write ? ['edit'] : []), ...(webAccess ? ['websearch', 'webfetch'] : [])]
      .map(action => ({ action, resource: '*', effect: 'allow' as const })),
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ];
}

/** Only the V2 model snapshot is accepted, not the V1 provider response. */
export function openCodeV2Models(response: unknown): AvailableRunnerModel[] {
  const snapshot = z.object({ data: z.array(z.object({ id: z.string().min(1), providerID: z.string().min(1),
    enabled: z.boolean(), type: z.string().optional(), variants: z.array(z.object({ id: z.string().min(1) })) })) }).parse(response);
  return snapshot.data.filter(model => model.enabled && (model.type === undefined || model.type === 'chat')).map(model => ({
    runner: 'opencode', provider: model.providerID, model: model.id,
    reasoning: model.variants.length ? model.variants.map(variant => variant.id) : ['medium'],
  }));
}

/** Refuse discovered security-sensitive configuration outside the instance NeoMind created. */
export function verifyOpenCodeV2ConfigSources(response: unknown, instanceConfig: string): void {
  const entries = z.array(z.object({ type: z.enum(['document', 'directory']), path: z.string().optional(), info: z.record(z.string(), z.unknown()).optional() })).parse(response);
  const sensitive = ['policies', 'experimental', 'permissions', 'permission', 'plugins', 'plugin', 'mcp', 'agents', 'agent', 'skills', 'instructions', 'references', 'reference'];
  for (const entry of entries) {
    if (entry.type !== 'document' || entry.path === instanceConfig) continue;
    // Inline configuration must also be rejected unless it is the instance's explicitly identified file.
    if (entry.info && sensitive.some(key => Object.hasOwn(entry.info!, key))) throw new Error('OpenCode V2 found external security-sensitive configuration');
  }
}
