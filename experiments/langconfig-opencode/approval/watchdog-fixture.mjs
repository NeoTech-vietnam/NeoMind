// Owned fake worker and test-controlled authority-loss notification; not a production watchdog.
import readline from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allocateProcessScope } from '../../../dist/src/adapters/worker-scope.js';

const root = await mkdtemp(path.join(tmpdir(), 'neomind-watchdog-fixture-'));
const scope = await allocateProcessScope();
const env = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
let stopped = false;
try {
  await scope.start({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], cwd: root, env });
  if (!await scope.isActive()) throw Error('Fixture scope is not active');
  process.stdout.write(`${JSON.stringify({ event: 'ready', unit: scope.identity.unit })}\n`);
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line !== 'authority_lost') throw Error('Invalid fixture notification');
    const activeBeforeStop = await scope.isActive();
    stopped = await scope.stop();
    process.stdout.write(`${JSON.stringify({ event: 'stopped', activeBeforeStop, stopVerified: stopped })}\n`);
    break;
  }
} finally {
  if (!stopped && !await scope.stop()) throw Error('Fixture scope stop unconfirmed');
}
