// Metadata-only probe in an owned scope; it creates a session but never submits a prompt.
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDataRoot } from './runtime_paths.mjs';
import { runScoped } from './scoped_run.mjs';
const code = path.dirname(fileURLToPath(import.meta.url)), root = requireDataRoot();
const neomind = path.resolve(process.env.NEOMIND_ROOT ?? path.join(code, '../../..'));
if (!path.isAbsolute(process.env.OPENCODE_ACCOUNT_DB ?? '') || !path.isAbsolute(process.env.LIVE_BUDGET_PATH ?? '')) throw Error('absolute official database and anchored budget paths required');
const { allocateProcessScope } = await import(pathToFileURL(path.join(neomind, 'dist/src/adapters/worker-scope.js')));
const scope = await allocateProcessScope();
const env = { HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', LIVE_GUARD_DATA: root,
  LIVE_BUDGET_PATH: process.env.LIVE_BUDGET_PATH, OPENCODE_ACCOUNT_DB: process.env.OPENCODE_ACCOUNT_DB, OPENCODE_BIN: process.env.OPENCODE_BIN,
  ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
const result = await runScoped({ scope, launch: { command: '/usr/bin/python3', args: ['-u', path.join(code, 'router_account_probe.py')], cwd: root, env },
  onStop: stopped => console.log(JSON.stringify({ scope: scope.identity.unit, stoppedVerified: stopped })),
  runChild: async (child, signal) => {
    child.stderr.resume(); const lines = createInterface({ input: child.stdout }); let timer;
    const cancel = () => lines.close(); signal.addEventListener('abort', cancel, { once: true });
    try { return await Promise.race([(async () => { for await (const line of lines) { if (line === 'PROBE_DONE') return 'done'; if (line === 'PROBE_FAILED') return 'failed'; if (line.startsWith('{"status"')) console.log(line); } return 'exited'; })(), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 60000); })]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); lines.close(); }
  } });
if (result.outcome !== 'done' || result.signal) process.exitCode = 1;
