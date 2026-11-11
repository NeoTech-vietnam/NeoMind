import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeRunner, OpenCodeRunnerFactory } from '../src/runners/opencode-runner.js';
import type { OpenCodeServer } from '../src/adapters/opencode-server.js';
import type { ProcessScope } from '../src/adapters/worker-scope.js';

type Session = { id: string; directory: string; parentID: null; metadata: unknown; permission: unknown };

test('OpenCode preserves logical session identity across turns and rejects a changed binding', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-oc-'));
  const sessions = new Map<string, Session>();
  let starts = 0, stops = 0;
  const scope = (): ProcessScope => ({ identity: { unit: 'test', controlGroup: 'test' }, start: async () => { throw new Error('server mock owns startup'); },
    isActive: async () => true, stop: async () => { stops++; return true; } });
  const server = (async () => {
    starts++;
    return { close: async () => { stops++; return true; }, subscribe: () => () => {}, request: async (method: string, url: string, body?: unknown) => {
      if (url === '/global/health') return { healthy: true, version: '1.18.25' };
      if (url === '/mcp') return {};
      if (url === '/config') return { plugin: [], permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow', StructuredOutput: 'allow' } };
      if (url === '/agent') return [{ name: 'build', mode: 'primary', permission: [] }];
      if (url === '/provider') return { connected: ['fake'], all: [{ id: 'fake', models: { model: {} } }] };
      if (url === '/session') {
        const value = body as { metadata: unknown; permission: unknown }, session = { id: 'ses_ABC123', directory: dir, parentID: null, metadata: value.metadata, permission: value.permission };
        sessions.set('ses_ABC123', session);
        return session;
      }
      if (method === 'GET' && url === '/session/ses_ABC123') return sessions.get('ses_ABC123');
      if (method === 'GET' && url === '/session/ses_ABC123/message') return [];
      if (url === '/session/ses_ABC123/message') {
        const value = body as { noReply?: boolean; tools: Record<string, boolean>; variant?: string };
        if (value.noReply) {
          const saved = sessions.get('ses_ABC123')!;
          saved.permission = Object.entries(value.tools).map(([permission, allow]) => ({ permission, pattern: '*', action: allow ? 'allow' : 'deny' }));
          return { info: { sessionID: 'ses_ABC123', agent: 'build', model: { providerID: 'fake', modelID: 'model' } } };
        }
        // A model without variants must not receive a reasoning variant.
        assert.equal(value.variant, undefined);
        return { info: { role: 'assistant', sessionID: 'ses_ABC123', providerID: 'fake', modelID: 'model', structured: { ok: true } }, parts: [] };
      }
      throw new Error(`Unexpected ${method} ${url}`);
    } } as unknown as OpenCodeServer;
  }) as unknown as typeof OpenCodeServer.start;
  const options = { stateDir: dir, dataHome: dir, config: {}, command: process.execPath, server };
  const binding = { runner: 'opencode', provider: 'fake', model: 'model', reasoning: 'medium' };
  try {
    let sessionId = '';
    for (let i = 0; i < 2; i++) {
      const runner = new OpenCodeRunner(scope(), options);
      const session = await runner.openSession({ workspace: dir, binding, access: i === 0 ? { kind: 'read' } : { kind: 'write', writableRoots: [dir] }, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
      sessionId = session.sessionId;
      await runner.verifyNoDelegation(session);
      const turn = await runner.startTurn(session, { prompt: 'test', effort: 'medium', outputSchema: { type: 'object' } });
      const result = await runner.waitForTurn(session, turn, () => false);
      assert.equal(result.threadId, sessionId);
      assert.deepEqual(result.messages, ['{"ok":true}']);
    }
    const changed = new OpenCodeRunner(scope(), options);
    const session = await changed.openSession({ workspace: dir, binding: { ...binding, model: 'other' }, access: { kind: 'read' }, resumeSessionId: sessionId });
    await assert.rejects(changed.startTurn(session, { prompt: 'test', effort: 'medium' }), /unavailable|binding changed/);
    assert.equal(starts, 3);
    assert.equal(stops, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OpenCode is found through a Windows-style Path key in a copied environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-ocp-'));
  try {
    const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    await writeFile(path.join(dir, name), '');
    let command = '';
    const server = (async (options: { command: string }) => {
      command = options.command;
      return { close: async () => true, request: async (_method: string, url: string) => {
        if (url === '/global/health') return { healthy: true, version: '1.19.5' };
        if (url === '/mcp') return {};
        if (url === '/config') return { permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow', StructuredOutput: 'allow' } };
        if (url === '/agent') return [{ name: 'build', mode: 'primary', permission: [] }];
        if (url === '/provider') return { connected: ['fake'], all: [{ id: 'fake', models: { model: {} } }] };
        throw new Error(`Unexpected ${url}`);
      } } as unknown as OpenCodeServer;
    }) as unknown as typeof OpenCodeServer.start;
    const scopes = async (): Promise<ProcessScope> => ({ identity: { unit: 'test', controlGroup: 'test' }, start: async () => { throw new Error('unused'); }, isActive: async () => true, stop: async () => true });
    const factory = new OpenCodeRunnerFactory({ workspace: dir, stateDir: dir, dataHome: dir, config: {}, env: { Path: dir }, scopes, server });
    assert.deepEqual(await factory.models(), [{ runner: 'opencode', provider: 'fake', model: 'model', reasoning: ['medium'] }]);
    assert.equal(command, path.join(dir, name));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OpenCode allows StructuredOutput and stops a turn that keeps calling tools without answering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-ocl-'));
  let created: { permission: { permission: string; action: string }[] } | undefined, aborted = false;
  const session = () => ({ id: 'ses_LOOP1', directory: dir, parentID: null, metadata: { neomindSession: created ? (created as unknown as { metadata: { neomindSession: string } }).metadata.neomindSession : '' }, permission: created!.permission });
  let listener: ((event: unknown) => void) | undefined;
  const server = (async () => ({ close: async () => true, subscribe: (on: (event: unknown) => void) => { listener = on; return () => { listener = undefined; }; }, request: async (method: string, url: string, body?: unknown) => {
    if (url === '/global/health') return { healthy: true, version: '1.19.5' };
    if (url === '/mcp') return {};
    if (url === '/config') return { permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow', StructuredOutput: 'allow' } };
    if (url === '/agent') return [{ name: 'build', mode: 'primary', permission: [] }];
    if (url === '/provider') return { connected: ['openai'], all: [{ id: 'openai', models: { 'gpt-6-luna': {} } }] };
    if (url === '/session') { created = body as typeof created; return session(); }
    if (method === 'GET' && url === '/session/ses_LOOP1') return session();
    if (url === '/session/ses_LOOP1/message') {
      const value = body as { noReply?: boolean };
      if (value.noReply) return { info: { sessionID: 'ses_LOOP1', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-6-luna' } } };
      // The model keeps reading: one assistant message per step, and the reply never arrives.
      for (let i = 0; i < 70; i++) {
        listener?.({ type: 'message.part.updated', properties: { part: { id: `prt_s${i}`, sessionID: 'ses_LOOP1', messageID: `msg_${i}`, type: 'step-start' } } });
        listener?.({ type: 'message.part.updated', properties: { part: { id: `prt_t${i}`, sessionID: 'ses_LOOP1', messageID: `msg_${i}`, type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a.md' }, output: 'x' } } } });
      }
      return new Promise((_, reject) => setTimeout(() => { aborted = true; reject(new Error('aborted')); }, 10000));
    }
    throw new Error(`Unexpected ${method} ${url}`);
  } }) as unknown as OpenCodeServer) as unknown as typeof OpenCodeServer.start;
  const scope = (): ProcessScope => ({ identity: { unit: 'test', controlGroup: 'test' }, start: async () => { throw new Error('unused'); }, isActive: async () => true, stop: async () => true });
  try {
    const runner = new OpenCodeRunner(scope(), { stateDir: dir, dataHome: dir, config: {}, command: process.execPath, server });
    // LocalRun registers the observer before dispatch, so events emitted while the prompt is sent are kept.
    const events: string[] = [];
    runner.observe(event => events.push(event.kind));
    const opened = await runner.openSession({ workspace: dir, binding: { runner: 'opencode', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' }, access: { kind: 'read' } });
    const turn = await runner.startTurn(opened, { prompt: 'plan', effort: 'medium', outputSchema: { type: 'object' } });
    assert.ok(created!.permission.some(rule => rule.permission === 'StructuredOutput' && rule.action === 'allow'));
    const result = await runner.waitForTurn(opened, turn, () => false);
    assert.equal(result.status, 'failed');
    assert.ok(events.includes('read') && events.includes('result'));
    assert.match(result.error ?? '', /60 model steps/);
    assert.equal(aborted, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
