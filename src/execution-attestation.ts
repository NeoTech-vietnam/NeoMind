import { createHash } from 'node:crypto';
import type { NativeReceipt } from './routing.js';

export const openCodeVersion = '1.19.4';
export const openCodeProtocol = 'workforce-opencode-v1';
export const openCodeIntegrity = 'sha512-O3rTc9OCd6CeeJohCAjFYD3MX5U0weKzKnySfsJ9sw9uAbNZZK4meIcjd+7k3inmZB5G2qONSen3yA45yECiFA==';
export const openCodeProtocolHash = createHash('sha256').update(openCodeProtocol).digest('hex');

/** This checks transport provenance only; callers must authenticate the signed
 * receipt and reconcile its task, scope, configuration and evidence separately. */
export function isControlledExecutionReceipt(receipt: NativeReceipt | undefined): boolean {
  if (!receipt) return false;
  if (receipt.issuer === 'neomind-vscode-lm') return receipt.execution_mode === 'vscode-extension-host';
  return receipt.issuer === 'workforce-opencode' && receipt.execution_mode === 'opencode-local' &&
    receipt.identity_provenance === 'local-opencode' && receipt.client_version === openCodeVersion &&
    receipt.protocol_sha256 === openCodeProtocolHash && receipt.runtime_integrity === openCodeIntegrity &&
    /^[a-f0-9]{64}$/.test(receipt.opencode?.binary_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(receipt.opencode?.gateway_instance ?? '') &&
    receipt.opencode?.version === openCodeVersion;
}
