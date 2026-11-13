import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeV2Runner } from '../src/runners/opencode-v2-runner.js';
import type { OpenCodeServer } from '../src/adapters/opencode-server.js';
import type { ProcessScope } from '../src/adapters/worker-scope.js';

test('OpenCode V2 runner verifies and resumes a logical session with changed permissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-v2-runner-'));
  let saved: Record<string, unknown> | undefined, stops = 0;
  const scope = (): ProcessScope => ({ identity: { unit: 'test', controlGroup: 'test' }, start: async () => { throw new Error('server mock owns startup'); }, isActive: async () => true, stop: async () => { stops++; return true; } });
  const server = (async (options: { configHome: string; scope: ProcessScope }) => ({
    close: () => options.scope.stop(), subscribe: () => () => {},
    request: async (method: string, endpoint: string, body?: unknown) => {
      if (endpoint === '/api/config') return [{ type: 'directory', path: path.join(options.configHome, 'opencode') }, { type: 'document', path: path.join(options.configHome, 'opencode', 'opencode.json'), info: { policies: [] } }];
      if (endpoint === '/api/model') return { data: [{ id: 'model', providerID: 'fake', enabled: true, variants: [{ id: 'high' }] }] };
      if (endpoint === '/api/mcp' || endpoint === '/api/plugin') return { data: [] };
      if (endpoint === '/api/session') { const b = body as Record<string, unknown>; saved = { id: 'ses_ABC123', agent: b.agent, model: b.model, metadata: b.metadata, location: b.location, permissions: b.permissions, outcome: 'succeeded' }; return { data: saved }; }
      if (endpoint.endsWith('/prompt')) return { data: { id: 'msg_1', sessionID: 'ses_ABC123', type: 'user' } };
      if (endpoint.endsWith('/wait')) return undefined;
      if (endpoint.includes('/message?')) return { data: [{ id: 'msg_1', type: 'user' }, { id: 'msg_2', type: 'assistant', agent: 'build', model: saved!.model, finish: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] }], cursor: { next: null } };
      if (method === 'PATCH') { saved!.permissions = (body as { permissions: unknown }).permissions; return undefined; }
      if (endpoint === '/api/session/ses_ABC123') return { data: saved };
      throw new Error(`Unexpected ${method} ${endpoint}`);
    },
  } as unknown as OpenCodeServer)) as unknown as typeof OpenCodeServer.start;
  const options = { workspace: dir, stateDir: dir, dataHome: dir, config: {}, command: process.execPath, server };
  const binding = { runner: 'opencode', provider: 'fake', model: 'model', reasoning: 'high' };
  try {
    let sessionId = '';
    for (const write of [false, true]) {
      const runner = new OpenCodeV2Runner(scope(), options);
      const session = await runner.openSession({ workspace: dir, binding, access: write ? { kind: 'write', writableRoots: [dir] } : { kind: 'read' }, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      sessionId = session.sessionId;
      const turn = await runner.startTurn(session, { prompt: 'test', effort: 'high', outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
      assert.equal((await runner.waitForTurn(session, turn, () => false)).status, 'completed');
      const permissions = saved!.permissions as { action: string; effect: string }[];
      assert.equal(permissions.some(rule => rule.action === 'edit' && rule.effect === 'allow'), write);
    }
    assert.equal(stops, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OpenCode V2 stops before model discovery when an external policy is present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-v2-policy-'));
  let stops = 0, requests = 0;
  const scope: ProcessScope = { identity: { unit: 'test', controlGroup: 'test' }, start: async () => { throw new Error('server mock owns startup'); }, isActive: async () => true, stop: async () => { stops++; return true; } };
  const server = (async (options: { configHome: string; scope: ProcessScope }) => ({
    close: () => options.scope.stop(),
    request: async (_method: string, endpoint: string) => {
      requests++;
      assert.equal(endpoint, '/api/config');
      return [{ type: 'document', path: path.join(options.configHome, 'opencode', 'opencode.json'), info: { policies: [] } },
        { type: 'document', path: '/project/opencode.json', info: { policies: [{ action: 'plugin.use', resource: '*', effect: 'allow' }] } }];
    },
  } as unknown as OpenCodeServer)) as unknown as typeof OpenCodeServer.start;
  try {
    const runner = new OpenCodeV2Runner(scope, { stateDir: dir, dataHome: dir, command: process.execPath, server });
    const session = await runner.openSession({ workspace: dir, binding: { runner: 'opencode', provider: 'fake', model: 'model', reasoning: 'high' }, access: { kind: 'read' } });
    await assert.rejects(runner.startTurn(session, { prompt: 'test', effort: 'high' }), /external security-sensitive configuration/);
    assert.equal(requests, 1);
    assert.equal(stops, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
