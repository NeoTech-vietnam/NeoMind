// One owned systemd scope for an explicitly authorized LC experiment attempt.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDataRoot } from './runtime_paths.mjs';
import { runScoped } from './scoped_run.mjs';

const code = path.dirname(fileURLToPath(import.meta.url));
const root = requireDataRoot();
const neomind = path.resolve(process.env.NEOMIND_ROOT ?? path.join(code, '../../..'));
if (process.env.NEOMIND_LIVE_AUTHORIZED !== 'f21c6cfacd571ede17407ad839d5ada908f2ced3' || !process.env.LIVE_BUDGET_PATH || !path.isAbsolute(process.env.LIVE_BUDGET_PATH) || !process.env.LANGCONFIG_BACKEND || !process.env.LANGCONFIG_PYTHON || !path.isAbsolute(process.env.LANGCONFIG_BACKEND) || !path.isAbsolute(process.env.LANGCONFIG_PYTHON)) throw Error('live opt-in, LC paths and existing absolute shared budget required');
const model = process.env.LIVE_MODEL_ID === 'openrouter/openrouter/free' ? { providerID: 'openrouter', id: 'openrouter/free' } : process.env.LIVE_MODEL_ID === 'zai/glm-5.3-flash' ? { providerID: 'zai', id: 'glm-5.3-flash', variant: 'high' } : process.env.LIVE_MODEL_ID === 'openai/gpt-6-luna' ? { providerID: 'openai', id: 'gpt-6-luna', variant: 'high' } : undefined;
const fixtureCase = process.env.LIVE_FIXTURE_CASE ?? 'contradictory';
const experimentMode = process.env.LIVE_EXPERIMENT_MODE ?? 'review';
if (!model || !['contradictory', 'matching'].includes(fixtureCase) || !['review', 'fixture-cycle'].includes(experimentMode) || (experimentMode === 'fixture-cycle' && (model.providerID !== 'openai' || fixtureCase !== 'contradictory')) || !path.isAbsolute(process.env.OPENCODE_ACCOUNT_DB ?? '')) throw Error('explicit approved model, fixture case and official account database required');
if (existsSync(path.join(root, 'LIVE_PAUSED')) || existsSync(path.join(code, 'LIVE_PAUSED'))) throw Error('live evaluation is paused');
const { allocateProcessScope } = await import(pathToFileURL(path.join(neomind, 'dist/src/adapters/worker-scope.js')));
const workflow = `lc-${randomUUID()}`;
const attempts = path.join(root, 'live-attempts');
await mkdir(attempts, { recursive: true, mode: 0o700 });
await mkdir(path.join(root, 'runs'), { recursive: true, mode: 0o700 });
const metadata = await open(path.join(attempts, `${workflow}.json`), 'wx', 0o600);
try {
  await metadata.writeFile(JSON.stringify({ workflow, budget: process.env.LIVE_BUDGET_PATH, model, requestCap: 5, maxOutputTokens: 8192, fixtureCase, experimentMode, created: new Date().toISOString() }) + '\n');
  await metadata.sync();
} finally { await metadata.close(); }
const attemptDirectory = await open(attempts, 'r');
try { await attemptDirectory.sync(); } finally { await attemptDirectory.close(); }
const scope = await allocateProcessScope();
let finished = false;
try {
  const env = { HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: process.env.LANGCONFIG_BACKEND, LIVE_GUARD_DATA: root,
    DATABASE_URL: 'postgresql://fixture:dummy@127.0.0.1:1/fixture',
    NEOMIND_LIVE_AUTHORIZED: process.env.NEOMIND_LIVE_AUTHORIZED, LIVE_BUDGET_PATH: process.env.LIVE_BUDGET_PATH, LIVE_WORKFLOW_ID: workflow, LIVE_MODEL_ID: process.env.LIVE_MODEL_ID, LIVE_FIXTURE_CASE: fixtureCase, LIVE_EXPERIMENT_MODE: experimentMode, OPENCODE_ACCOUNT_DB: process.env.OPENCODE_ACCOUNT_DB,
    ...(process.env.OPENCODE_BIN ? { OPENCODE_BIN: process.env.OPENCODE_BIN } : {}),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
  const result = await runScoped({ scope,
    launch: { command: process.env.LANGCONFIG_PYTHON, args: ['-u', path.join(code, experimentMode === 'fixture-cycle' ? 'live_full_lc.py' : 'live_lc.py')], cwd: root, env },
    onStop: stopped => console.log(JSON.stringify({ scope: scope.identity.unit, stoppedVerified: stopped })),
    runChild: async (child, signal) => {
      child.stderr.on('data', () => {});
      const lines = createInterface({ input: child.stdout });
      let timer;
      const cancel = () => lines.close();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return await Promise.race([
          (async () => { for await (const line of lines) { if (line === 'LIVE_HOST_DONE') return 'completed'; if (line.startsWith('{"status":')) console.log(line); } return 'exited'; })(),
          new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 180000); }),
        ]);
      } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); lines.close(); }
    },
  });
  finished = result.outcome === 'completed' && !result.signal;
  console.log(JSON.stringify({ workflow, outcome: result.outcome, ...(result.signal ? { signal: result.signal } : {}) }));
  if (result.signal) process.exitCode = result.signal === 'SIGINT' ? 130 : 143;
} finally {
  if (!finished && !process.exitCode) process.exitCode = 1;
  try {
    const db = new DatabaseSync(process.env.LIVE_BUDGET_PATH, { readOnly: true });
    try {
      const reservations = db.prepare('SELECT count(*) AS n FROM reservations').get().n;
      const workflows = db.prepare('SELECT count(*) AS n FROM workflows').get().n;
      console.log(JSON.stringify({ liveWorkflows: workflows, physicalRequestUpperBound: reservations, globalLimit: 40 }));
    } finally { db.close(); }
  } catch { console.log(JSON.stringify({ liveBudget: 'unavailable' })); }
}
