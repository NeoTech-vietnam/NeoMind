import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { startEditorServer } from '../src/ui-server/server.js';

test('local editor persists drafts and published versions while rejecting unauthenticated writes', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'neomind-editor-project-'));
  const assets = await mkdtemp(path.join(tmpdir(), 'neomind-editor-assets-'));
  await writeFile(path.join(assets, 'index.html'), '<html><head><!-- NEOMIND_CONFIG --></head><body></body></html>');
  const editor = await startEditorServer(project, 0, assets);
  try {
    const headers = { 'Content-Type': 'application/json', Origin: editor.url, 'X-NeoMind-Token': editor.token };
    const index = await fetch(editor.url);
    assert.ok((await index.text()).includes(`content="${editor.token}"`));
    const denied = await fetch(`${editor.url}/api/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'demo', name: 'Demo', template: 'dev' }) });
    assert.equal(denied.status, 403);
    const created = await fetch(`${editor.url}/api/flows`, { method: 'POST', headers,
      body: JSON.stringify({ id: 'demo', name: 'Demo', template: 'dev' }) });
    assert.equal(created.status, 201);
    const data = await created.json() as { draft: { definition: { nodes: { id: string; label: string }[] } } };
    data.draft.definition.nodes.find(node => node.id === 'plan')!.label = 'My plan';
    const save = await fetch(`${editor.url}/api/flows/demo/draft`, { method: 'PUT', headers, body: JSON.stringify({ draft: data.draft }) });
    assert.equal(save.status, 200);
    const validate = await fetch(`${editor.url}/api/flows/demo/validate`, { method: 'POST', headers, body: JSON.stringify({ draft: data.draft }) });
    assert.equal((await validate.json() as { valid: boolean }).valid, true);
    const published = await fetch(`${editor.url}/api/flows/demo/publish`, { method: 'POST', headers });
    const payload = await published.json() as { version: { version: number; definition: { nodes: { id: string; label: string }[] } } };
    assert.equal(payload.version.version, 1);
    assert.equal(payload.version.definition.nodes.find(node => node.id === 'plan')?.label, 'My plan');
    const cloned = await fetch(`${editor.url}/api/flows/demo/clone`, { method: 'POST', headers,
      body: JSON.stringify({ targetId: 'demo-copy', name: 'Demo copy' }) });
    assert.equal(cloned.status, 201);
    const copy = await cloned.json() as { draft: { flowId: string; name: string; definition: { nodes: { id: string; label: string }[] } } };
    assert.equal(copy.draft.flowId, 'demo-copy');
    assert.equal(copy.draft.name, 'Demo copy');
    assert.equal(copy.draft.definition.nodes.find(node => node.id === 'plan')?.label, 'My plan');
    // Drafts carry revisions: a save from a stale view is refused with 409 instead of overwriting newer work.
    const current = await (await fetch(`${editor.url}/api/flows/demo/draft`)).json() as { draft: unknown; revision: string };
    const fresh = await fetch(`${editor.url}/api/flows/demo/draft`, { method: 'PUT', headers, body: JSON.stringify({ draft: current.draft, expectedRevision: current.revision }) });
    assert.equal(fresh.status, 200);
    const stale = await fetch(`${editor.url}/api/flows/demo/draft`, { method: 'PUT', headers, body: JSON.stringify({ draft: current.draft, expectedRevision: 'f'.repeat(64) }) });
    assert.equal(stale.status, 409);
    assert.equal((await fetch(`${editor.url}/api/flows/demo/publish`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 'f'.repeat(64) }) })).status, 409);
    const bootstrap = await fetch(`${editor.url}/api/bootstrap`);
    assert.equal((await bootstrap.json() as { runtimeAvailable: boolean }).runtimeAvailable, ['linux', 'win32'].includes(process.platform));
  } finally { await editor.close(); }
});

test('profile API protects writes and publishes immutable versions independently from drafts', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'neomind-profile-api-'));
  const editor = await startEditorServer(project);
  const headers = { 'Content-Type': 'application/json', Origin: editor.url, 'X-NeoMind-Token': editor.token };
  try {
    assert.equal((await fetch(`${editor.url}/api/profiles`, { method: 'POST', body: '{}' })).status, 403);
    const create = await fetch(`${editor.url}/api/profiles`, { method: 'POST', headers, body: JSON.stringify({ id: 'reviewer', name: 'Reviewer', template: 'verifier' }) });
    assert.equal(create.status, 201);
    const { draft } = await create.json() as { draft: { profileId: string; instructions: string; requestedPermissions: { write: boolean } } };
    assert.equal(draft.requestedPermissions.write, false); draft.instructions = 'Independent first version';
    assert.equal((await fetch(`${editor.url}/api/profiles/reviewer/draft`, { method: 'PUT', headers, body: JSON.stringify({ draft }) })).status, 200);
    const version = await (await fetch(`${editor.url}/api/profiles/reviewer/publish`, { method: 'POST', headers })).json() as { version: { version: number; instructions: string } };
    assert.equal(version.version.version, 1); assert.equal(version.version.instructions, 'Independent first version');
    draft.instructions = 'Changed draft';
    await fetch(`${editor.url}/api/profiles/reviewer/draft`, { method: 'PUT', headers, body: JSON.stringify({ draft }) });
    assert.equal(version.version.instructions, 'Independent first version');
    assert.equal((await fetch(`${editor.url}/api/profiles/reviewer/draft`, { method: 'PUT', headers, body: JSON.stringify({ draft: { ...draft, profileId: 'other' } }) })).status, 400);
    assert.equal((await fetch(`${editor.url}/api/profiles/reviewer/delete`, { method: 'POST', headers, body: JSON.stringify({ confirmedName: 'wrong' }) })).status, 400);
  } finally { await editor.close(); }
});

test('runner API lists the per-runner model allowlist with the default model first', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'neomind-runner-api-'));
  const editor = await startEditorServer(project);
  try {
    const response = await fetch(`${editor.url}/api/runners`);
    assert.equal(response.status, 200);
    const { runners } = await response.json() as { runners: { runner: string; provider: string; models: string[]; reasoning: string[] }[] };
    assert.deepEqual(runners.map(item => [item.runner, item.provider, item.models[0]]), [['codex', 'openai', 'gpt-6-luna'], ['claude-code', 'anthropic', 'claude-sonnet-5-5']]);
    assert.deepEqual(runners.find(item => item.runner === 'claude-code')?.models, ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
    assert.ok(runners.every(item => item.reasoning.join() === 'low,medium,high'));
    assert.equal((await fetch(`${editor.url}/api/runners`, { method: 'POST', headers: { Origin: editor.url, 'X-NeoMind-Token': editor.token } })).status, 404);
    // fetch drops a custom Host header, so DNS-rebinding protection is checked with a raw request.
    const status = await new Promise<number | undefined>((resolve, reject) => get(`${editor.url}/api/runners`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
    assert.equal(status, 403);
  } finally { await editor.close(); }
});
