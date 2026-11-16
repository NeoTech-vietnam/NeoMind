// Test-owned monitor; target identity comes only from the synthetic LocalRun host.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopExistingWorkerScope } from '../../../dist/src/adapters/worker-scope.js';

const identity = JSON.parse(await readFile(process.argv[2], 'utf8'));
const monitorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'revoke-monitor-fixture.py');
const monitor = spawn(process.env.FIXTURE_PYTHON, [monitorPath], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
monitor.on('error', () => {});
process.on('SIGTERM', () => { if (monitor.exitCode === null) monitor.kill('SIGKILL'); process.exit(1); });
try {
  const iterator = readline.createInterface({ input: monitor.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let ready = false, reason = 'monitor_unavailable';
  while (true) {
    let timer;
    const item = await Promise.race([iterator.next(), new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 3000); })]);
    clearTimeout(timer);
    if (item.timeout) { reason = 'heartbeat_timeout'; break; }
    if (item.done) break;
    const event = JSON.parse(item.value);
    if (!ready && event.event === 'ready') { ready = true; process.stdout.write('{"event":"ready"}\n'); }
    else if (ready && event.event === 'heartbeat') continue;
    else if (ready && ['revoked', 'unavailable'].includes(event.event)) { reason = event.event; break; }
    else throw Error('Invalid fixture monitor event');
  }
  const stopVerified = await stopExistingWorkerScope(identity);
  process.stdout.write(`${JSON.stringify({ event: 'stopped', reason, stopVerified })}\n`);
  if (!stopVerified) process.exitCode = 1;
} finally {
  if (monitor.exitCode === null) monitor.kill('SIGKILL');
}
