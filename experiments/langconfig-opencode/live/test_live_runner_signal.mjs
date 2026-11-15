// Interrupt only the child fixture run after its worker scope has been journaled.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const code = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(code, 'test_live_local_run.mjs')], { cwd: code,
  env: { ...process.env, NEOMIND_EXPERIMENT_MODE: 'fake' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', stderr = '', journal;
child.stdout.on('data', chunk => { output += chunk; for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.runId && value.journal) journal = value.journal; } catch {} } });
child.stderr.on('data', chunk => { stderr += chunk; });
let closed = false;
const closedPromise = new Promise(resolve => child.on('close', (status, signal) => { closed = true; resolve({ status, signal }); }));
let bound;
try {
  const limit = Date.now() + 30000;
  while (!bound && !closed && Date.now() < limit) {
    if (journal) {
      try {
        const events = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        bound = events.find(event => event.type === 'worker_scope_bound')?.payload;
      } catch {}
    }
    if (!bound) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(bound, `worker scope was not observed before exit: ${stderr.slice(-500)}`);
  child.kill('SIGTERM');
  let timer;
  const outcome = await Promise.race([closedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture cancellation timed out')), 30000); })]).finally(() => clearTimeout(timer));
  assert.notEqual(outcome.status, 0);
  const properties = execFileSync('systemctl', ['--user', 'show', bound.unit, '--property=ActiveState,ControlGroup'], { encoding: 'utf8', timeout: 10000 });
  assert.match(properties, /^ActiveState=inactive$/m);
  try { assert.match(await readFile(path.join('/sys/fs/cgroup', bound.controlGroup, 'cgroup.events'), 'utf8'), /^populated 0$/m); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(JSON.stringify({ status: 'PASS', signal: 'SIGTERM', scopeStoppedVerified: true, journal }));
} finally {
  if (!closed) { child.kill('SIGTERM'); await closedPromise; }
}
