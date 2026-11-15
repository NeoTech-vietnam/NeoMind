// Exercise the installed plugin callbacks locally; no fetch or external model request is made.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDataRoot } from './runtime_paths.mjs';

const code = path.dirname(fileURLToPath(import.meta.url));
const root = requireDataRoot();
const run = await mkdtemp(path.join(root, 'tmp', 'guard-unit-'));
const db = path.join(run, 'fake.sqlite');
const helper = path.join(code, 'quota.py');
execFileSync('/usr/bin/python3', ['-c', 'import quota,sys; quota.initialize(sys.argv[1], 5); quota.start_workflow(sys.argv[1], "wf", 5); quota.bind(sys.argv[1], "ses_test", "wf", 5)', db], { cwd: code, env: { PATH: '/usr/bin:/bin', HOME: run, TMPDIR: run, PYTHONDONTWRITEBYTECODE: '1' } });
const source = (await readFile(path.join(code, 'guard/index.js'), 'utf8')).replace("import { Plugin } from '@opencode/plugin';", 'const Plugin = { define: value => value };');
const plugin = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const hooks = new Map(), removed = [], defaults = [];
const model = { providerID: 'opencode', id: 'glm-5.3-flash-free', variant: 'high' };
const ctx = { options: { mode: 'live', providerID: model.providerID, modelID: model.id, database: db, helper, python: '/usr/bin/python3', trace: path.join(run, 'trace.jsonl'), origin: 'https://opencode.ai', home: run, tmp: run },
  model: { transform: async fn => fn({ list: () => [model, { providerID: 'opencode', id: 'glm-5.3-flash' }, { providerID: 'other', id: 'free' }], remove: (...args) => removed.push(args), default: { set: (...args) => defaults.push(args) } }) },
  session: { hook: async (name, fn) => hooks.set(name, fn) } };
await plugin.setup(ctx);
assert.deepEqual(defaults, [['opencode', model.id]]);
assert.equal(removed.length, 2);
const request = (m = model, kind = 'primary') => ({ sessionID: 'ses_test', model: m, kind, request: new Request('https://opencode.ai/inference/openai/v1/chat/completions', { method: 'POST', body: '{}' }) });
for (const m of [{ ...model, variant: undefined }, { ...model, variant: 'low' }, { ...model, id: 'glm-5.3-flash' }, { ...model, providerID: 'other' }]) await assert.rejects(() => hooks.get('http.request')(request(m)));
await assert.rejects(() => hooks.get('http.request')(request(model, 'generate')));
assert.throws(() => hooks.get('experimental.ws.handshake')());
await hooks.get('http.request')(request());
const trace = (await readFile(ctx.options.trace, 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(trace.filter(item => item.event === 'reserved').length, 1);
const retry = { attempt: 2, decision: { retry: true, delay: 1 } }; hooks.get('retry')(retry); assert.equal(retry.decision.retry, false);
await assert.rejects(() => plugin.setup({ ...ctx, options: { ...ctx.options, modelID: 'glm-5.3-flash' } }));
console.log('PASS GLM guard selection, exact variant/kind, unknown rejection, websocket denial, retry veto, durable reservation; no fetch');
