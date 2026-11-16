// Fixture-only monitor and real owned process scope; no user workspace or model.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateProcessScope } from '../../../dist/src/adapters/worker-scope.js';

const root = await mkdtemp(path.join(tmpdir(), 'neomind-auto-watchdog-'));
const scope = await allocateProcessScope();
const env = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const monitorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog-monitor.py');
let monitor, stopped = false;
const commands = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
commands.on('line', line => {
  if (line === 'crash_monitor' && process.env.FIXTURE_ALLOW_MONITOR_CRASH === '1' && monitor?.exitCode === null) monitor.kill('SIGKILL');
  if (line === 'stall_monitor' && process.env.FIXTURE_ALLOW_MONITOR_CRASH === '1' && monitor?.exitCode === null) monitor.kill('SIGSTOP');
});
process.on('SIGTERM', () => {
  if (monitor && monitor.exitCode === null) monitor.kill('SIGKILL');
  void scope.stop().then(ok => process.exit(ok ? 1 : 2), () => process.exit(2));
});
try {
  await scope.start({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], cwd: root, env });
  if (!await scope.isActive()) throw Error('Fixture scope is not active');
  monitor = spawn(process.env.FIXTURE_PYTHON, [monitorPath], { env: { ...env, FIXTURE_DSN: process.env.FIXTURE_DSN }, stdio: ['ignore', 'pipe', 'pipe'] });
  monitor.on('error', () => {});
  let seenReady = false, reason = 'monitor_unavailable';
  const lines = readline.createInterface({ input: monitor.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  while (true) {
    let timer;
    const item = await Promise.race([iterator.next(), new Promise(resolve => {
      timer = setTimeout(() => resolve({ timeout: true }), seenReady ? 2000 : 10000);
    })]);
    clearTimeout(timer);
    if (item.timeout) { reason = 'heartbeat_timeout'; break; }
    if (item.done) break;
    const line = item.value;
    const event = JSON.parse(line);
    if (!seenReady && event.event === 'ready' && Number.isInteger(event.pid)) {
      seenReady = true;
      process.stdout.write(`${JSON.stringify({ event: 'ready', unit: scope.identity.unit, pid: event.pid })}\n`);
    } else if (seenReady && event.event === 'heartbeat') {
      continue;
    } else if (seenReady && event.event === 'lost') {
      reason = 'session_lost';
      break;
    } else throw Error('Invalid fixture monitor event');
  }
  if (!seenReady) throw Error('Fixture monitor did not become ready');
  const activeBeforeStop = await scope.isActive();
  stopped = await scope.stop();
  process.stdout.write(`${JSON.stringify({ event: 'stopped', activeBeforeStop, stopVerified: stopped,
    reason })}\n`);
  if (reason !== 'session_lost' || !stopped) process.exitCode = 1;
} finally {
  commands.close();
  process.stdin.pause();
  if (monitor && monitor.exitCode === null) monitor.kill('SIGKILL');
  if (!stopped && !await scope.stop()) throw Error('Fixture scope stop unconfirmed');
}
