import readline from 'node:readline';
import { FixtureBroker } from './broker.mjs';

// Owned stdio only. This process is a fixture, not an authenticated server.
const broker = new FixtureBroker();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let response;
  try {
    if (Buffer.byteLength(line) > 16384) throw new Error('oversize');
    response = await broker.execute(JSON.parse(line));
  } catch {
    response = { ok: false, error: 'invalid_request' };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
