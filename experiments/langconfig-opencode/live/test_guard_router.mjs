// Test router body admission without sending any HTTP request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDataRoot } from './runtime_paths.mjs';

const code = path.dirname(fileURLToPath(import.meta.url)), root = requireDataRoot();
const dir = await mkdtemp(path.join(root, 'tmp', 'router-guard-')), db = path.join(dir, 'fake.sqlite'), helper = path.join(code, 'quota.py');
execFileSync('/usr/bin/python3', ['-c', 'import quota,sys; quota.initialize(sys.argv[1], 5); quota.start_workflow(sys.argv[1], "wf", 5); quota.bind(sys.argv[1], "ses_test", "wf", 5)', db], { cwd: code, env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, PYTHONDONTWRITEBYTECODE: '1' } });
const source = (await readFile(path.join(code, 'guard/index.js'), 'utf8')).replace("import { Plugin } from '@opencode/plugin';", 'const Plugin = { define: value => value };');
const plugin = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const hooks = new Map(), ref = { providerID: 'openrouter', id: 'openrouter/free' };
const ctx = { options: { mode: 'live', providerID: ref.providerID, modelID: ref.id, database: db, helper, python: '/usr/bin/python3', trace: path.join(dir, 'trace'), origin: 'https://openrouter.ai', home: dir, tmp: dir },
  model: { transform: async fn => fn({ list: () => [ref], remove: () => {}, default: { set: () => {} } }) }, session: { hook: async (name, fn) => hooks.set(name, fn) } };
await plugin.setup(ctx);
const resolve = hooks.get('experimental.model.resolve');
for (const model of [ref, { ...ref, variant: 'default' }]) {
  const e = { model: { ...model } }; resolve(e); assert.deepEqual(e.model, ref);
}
for (const model of [{ ...ref, variant: 'high' }, { ...ref, id: 'paid/model', variant: 'default' }, { ...ref, providerID: 'other', variant: 'default' }]) {
  const e = { model: { ...model } }; resolve(e); assert.deepEqual(e.model, model);
}
const valid = { model: 'openrouter/free', provider: { allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } } };
const event = (body = valid, model = ref, url = 'https://openrouter.ai/api/v1/chat/completions') => ({ sessionID: 'ses_test', model, kind: 'primary', request: new Request(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-only' }, body: JSON.stringify(body) }) });
for (const invalid of [{ ...valid, model: 'paid/model' }, { ...valid, models: ['paid/model'] }, { ...valid, plugins: [] }, { ...valid, tools: [] },
  { ...valid, provider: { ...valid.provider, allow_fallbacks: true } }, { ...valid, provider: { ...valid.provider, max_price: { prompt: 0, completion: 1 } } }]) await assert.rejects(() => hooks.get('http.request')(event(invalid)));
await assert.rejects(() => hooks.get('http.request')(event(valid, { ...ref, variant: 'high' })));
await assert.rejects(() => hooks.get('http.request')(event(valid, { ...ref, variant: 'default' })));
await assert.rejects(() => hooks.get('http.request')(event(valid, { ...ref, providerID: 'other' })));
await assert.rejects(() => hooks.get('http.request')(event(valid, ref, 'https://example.com/api/v1/chat/completions')));
await assert.rejects(() => hooks.get('http.request')(event(valid, ref, 'https://openrouter.ai/api/v1/models')));
await hooks.get('http.request')(event());
const trace = await readFile(ctx.options.trace, 'utf8');
assert.equal(trace.trim().split('\n').map(JSON.parse).filter(item => item.event === 'reserved').length, 1);
assert.ok(!trace.includes('fixture-only'));
console.log('PASS router exact model, no variant, endpoint, zero prices, no fallbacks/plugins/tools; trace redacts auth; no fetch');
