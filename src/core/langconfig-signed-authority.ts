import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { hashJson } from '../domain/resolve.js';
import type { LangConfigAuthorityReader } from './langconfig-authority-observation.js';

const id = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
const claimsSchema = z.strictObject({
  issuer: id, keyId: id, issuedAtMs: z.number().int().safe().nonnegative(), expiresAtMs: z.number().int().safe().positive(),
  status: z.enum(['approved', 'revoked']), bindingHash: digest, challenge: digest,
  external: z.strictObject({ threadId: id, checkpointId: id, interruptId: id, taskHash: digest, actionHash: digest,
    receiptId: id, generation: z.number().int().safe().positive() }),
});
const envelopeSchema = z.strictObject({ claims: claimsSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
const domain = 'neomind/langconfig-authority-observation/v2:';
const maxLifetimeMs = 30_000;

/**
 * Verifies a signed observation against a host-pinned Ed25519 public key. This does not authenticate the caller or prove
 * that an observation remains current after it was signed. The host must bound the transport before decoding JSON and
 * must not let graph input select the key, issuer, transport, or clock. This reader cannot authorize or dispatch a writer.
 */
export class SignedLangConfigAuthorityReader implements LangConfigAuthorityReader {
  private readonly key: KeyObject;
  private readonly issuer: string;
  private readonly keyId: string;
  private readonly fetch: (signal: AbortSignal, challenge: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(input: { publicKeyPem: string; issuer: string; keyId: string; fetch: (signal: AbortSignal, challenge: string) => Promise<unknown>;
    now?: () => number; timeoutMs?: number }) {
    this.issuer = id.parse(input.issuer); this.keyId = id.parse(input.keyId);
    if (typeof input.publicKeyPem !== 'string' || input.publicKeyPem.length > 16_384) throw new Error('Invalid authority key');
    this.key = createPublicKey(input.publicKeyPem);
    if (this.key.asymmetricKeyType !== 'ed25519' || typeof input.fetch !== 'function') throw new Error('Invalid authority configuration');
    this.fetch = input.fetch; this.now = input.now ?? Date.now;
    this.timeoutMs = z.number().int().min(1).max(10_000).parse(input.timeoutMs ?? 3_000);
  }

  async observe(): Promise<unknown> {
    const controller = new AbortController();
    const challenge = randomBytes(32).toString('hex');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([this.fetch(controller.signal, challenge), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Authority timeout')); }, this.timeoutMs);
      })]);
      const { claims, signature } = envelopeSchema.parse(raw);
      const bytes = Buffer.from(signature, 'base64url'), now = this.now();
      if (bytes.length !== 64 || bytes.toString('base64url') !== signature || !Number.isSafeInteger(now) ||
          claims.issuer !== this.issuer || claims.keyId !== this.keyId || claims.challenge !== challenge || claims.issuedAtMs > now ||
          claims.expiresAtMs <= now || claims.expiresAtMs <= claims.issuedAtMs || claims.expiresAtMs - claims.issuedAtMs > maxLifetimeMs ||
          !verify(null, Buffer.from(domain + hashJson(claims), 'utf8'), this.key, bytes)) throw new Error('Invalid authority observation');
      return { status: claims.status, bindingHash: claims.bindingHash, external: claims.external };
    } catch {
      // Keep raw transport errors, signatures, and input out of callers' diagnostics.
      throw new Error('Authority observation unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}
