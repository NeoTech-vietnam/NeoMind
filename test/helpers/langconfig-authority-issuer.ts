// Synthetic loopback issuer for tests only. The private key never leaves this process.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import readline from 'node:readline';
import { hashJson } from '../../src/domain/resolve.js';

const input = JSON.parse(process.argv[2] ?? 'null') as { bindingHash: string; external: Record<string, unknown> };
const keys = generateKeyPairSync('ed25519');
let revoked = false;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '', 'http://127.0.0.1');
  const challenge = url.searchParams.get('challenge');
  if (request.method !== 'GET' || url.pathname !== '/observation' || !challenge || !/^[a-f0-9]{64}$/.test(challenge) ||
      [...url.searchParams.keys()].length !== 1) { response.writeHead(400).end(); return; }
  const now = Date.now();
  const claims = { issuer: 'fixture-issuer', keyId: 'fixture-key', issuedAtMs: now, expiresAtMs: now + 10_000,
    status: revoked ? 'revoked' : 'approved', bindingHash: input.bindingHash, challenge, external: input.external };
  const signature = sign(null, Buffer.from(`neomind/langconfig-authority-observation/v2:${hashJson(claims)}`), keys.privateKey).toString('base64url');
  const body = JSON.stringify({ claims, signature });
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
  process.stdout.write(`${JSON.stringify({ event: 'ready', port: address.port, publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })) })}\n`);
});
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (line !== 'revoke') throw new Error('Invalid fixture command');
  revoked = true;
  process.stdout.write('{"event":"revoked"}\n');
});
