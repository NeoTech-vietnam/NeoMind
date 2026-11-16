import { z } from 'zod';
import { hashJson } from '../domain/resolve.js';
import { prepareLangConfigWriterBinding } from './langconfig-writer-binding.js';

type Preparation = Parameters<typeof prepareLangConfigWriterBinding>[0];
const id = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
const observationSchema = z.strictObject({
  status: z.literal('approved'), bindingHash: digest,
  external: z.strictObject({ threadId: id, checkpointId: id, interruptId: id, taskHash: digest, actionHash: digest,
    receiptId: id, generation: z.number().int().safe().positive() }),
});

/**
 * This read-only comparison is not an authentication boundary. The host must install an authenticated authority reader;
 * graph input, agents, and a remote caller must never select or implement it. No authority adapter is installed here.
 */
export interface LangConfigAuthorityReader {
  observe(): Promise<unknown>;
}

/**
 * Compare two authority observations with two independently prepared journal/admission fingerprints.
 * Even a match is only evidence: it cannot prove a worker stopped, fence effects, or authorize a dispatch. No writer
 * or recovery state is changed, and every result deliberately remains unknown until a future durable protocol exists.
 */
export async function observeLangConfigWriterBinding(input: {
  authority: LangConfigAuthorityReader;
  local: Omit<Preparation, 'external'>;
}): Promise<{ outcome: 'unknown'; comparison: 'matched' | 'unavailable' }> {
  const unknown = { outcome: 'unknown', comparison: 'unavailable' } as const;
  try {
    const first = observationSchema.parse(await input.authority.observe());
    const prepared = await prepareLangConfigWriterBinding({ ...input.local, external: first.external });
    if (prepared.bindingHash !== first.bindingHash) return unknown;
    const second = observationSchema.parse(await input.authority.observe());
    if (hashJson(first) !== hashJson(second)) return unknown;
    const current = await prepareLangConfigWriterBinding({ ...input.local, external: second.external });
    if (current.bindingHash !== first.bindingHash) return unknown;
    return { outcome: 'unknown', comparison: 'matched' };
  } catch {
    // Do not expose external errors or infer a stop/retry decision from a failed observation.
    return unknown;
  }
}
