// Real Linux process scope with a synthetic worker; no model or user repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allocateProcessScope } from '../../../dist/src/adapters/worker-scope.js';

test('authority loss requires a verified stop of the owned process scope', { timeout: 30000 }, async () => {
  if (process.platform !== 'linux') throw new Error('This fixture requires Linux user-systemd');
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-authority-stop-'));
  const scope = await allocateProcessScope();
  const env = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  let stopped = false;
  try {
    const child = await scope.start({ command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], cwd: root, env });
    assert.ok(child.pid);
    assert.equal(await scope.isActive(), true);
    // The actual authority-loss notification is simulated; no PostgreSQL is involved.
    stopped = await scope.stop();
    assert.equal(stopped, true, 'scope stop must be confirmed, not inferred from a signal');
    assert.equal(await scope.isActive(), false);
  } finally {
    if (!stopped) assert.equal(await scope.stop(), true, 'failed to confirm fixture scope stopped');
  }
});
