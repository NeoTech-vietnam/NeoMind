// Synthetic request admission only; this test performs no fetch or inference.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDataRoot } from './runtime_paths.mjs';

const code = path.dirname(fileURLToPath(import.meta.url)), root = requireDataRoot();
const dir = await mkdtemp(path.join(root, 'tmp', 'luna-guard-')), db = path.join(dir, 'fake.sqlite');
execFileSync('/usr/bin/python3', ['-c', 'import quota,sys; quota.initialize(sys.argv[1],40); quota.start_workflow(sys.argv[1],"wf",5); quota.bind(sys.argv[1],"ses_test","wf",5)', db], { cwd: code, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
const source = (await readFile(path.join(code, 'guard/index.js'), 'utf8')).replace("import { Plugin } from '@opencode/plugin';", 'const Plugin = { define: value => value };');
const plugin = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const hooks = new Map(), ref = { providerID: 'openai', id: 'gpt-6-luna', variant: 'high' };
const ctx = { options: { mode: 'live', providerID: ref.providerID, modelID: ref.id, origin: 'https://chatgpt.com', database: db, helper: path.join(code, 'quota.py'), python: '/usr/bin/python3', trace: path.join(dir, 'trace'), home: dir, tmp: dir }, model: { transform: async fn => fn({ list: () => [ref], remove: () => {}, default: { set: () => {} } }) }, session: { hook: async (name, fn) => hooks.set(name, fn) } };
await plugin.setup(ctx);
const body = { model: 'gpt-6-luna', max_output_tokens: 8192, reasoning: { effort: 'high' }, input: 'Synthetic fixture', tools: [] };
const event = (data = body, model = ref, url = 'https://chatgpt.com/backend-api/codex/responses', kind = 'primary', headers = {}) => ({ sessionID: 'ses_test', model, kind, request: new Request(url, { method: 'POST', body: JSON.stringify(data), headers }) });
for (const bad of [{ ...body, model: 'gpt-6-luna-fast' }, { ...body, max_output_tokens: 8193 }, { ...body, max_output_tokens: undefined }, { ...body, reasoning: { effort: 'low' } }, { ...body, tools: [{ type: 'web_search' }] }, { ...body, plugins: [] }, { ...body, max_completion_tokens: 8193 }]) await assert.rejects(() => hooks.get('http.request')(event(bad)));
for (const bad of [{ ...ref, variant: 'low' }, { ...ref, providerID: 'other' }, { ...ref, id: 'gpt-6-luna-fast' }]) await assert.rejects(() => hooks.get('http.request')(event(body, bad)));
await assert.rejects(() => hooks.get('http.request')(event(body, ref, 'https://chatgpt.com/backend-api/other')));
await assert.rejects(() => hooks.get('http.request')(event(body, ref, undefined, 'title')));
await assert.rejects(() => hooks.get('http.request')(event(body, ref, undefined, 'primary', { 'Content-Encoding': 'zstd' })));
for (let i = 0; i < 5; i++) await hooks.get('http.request')(event());
await assert.rejects(() => hooks.get('http.request')(event()));
const retry = { attempt: 2 }; hooks.get('retry')(retry); assert.equal(retry.decision.retry, false);
console.log('PASS synthetic Luna high: exact endpoint and model, 8192 output cap, no tools/fallback, five-request cap, retry veto; no fetch');
