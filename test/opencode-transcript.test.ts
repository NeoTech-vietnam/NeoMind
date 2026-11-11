import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCodePartDone, openCodePartEvents, type TranscriptEvent } from '../src/core/transcript.js';
import { OpenCodeRunner, openCodeHistory } from '../src/runners/opencode-runner.js';
import type { OpenCodeServer } from '../src/adapters/opencode-server.js';
import type { ProcessScope } from '../src/adapters/worker-scope.js';

const part = (id: string, value: Record<string, unknown>) => ({ id, sessionID: 'ses_ABC123', messageID: 'msg_1', ...value });

test('OpenCode parts map to transcript events once they are final', () => {
  const read = part('prt_1', { type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed', input: { filePath: 'W:/repo/a.ts', offset: 10 }, output: 'line', title: 'a.ts', metadata: {}, time: { start: 1, end: 2 } } });
  assert.deepEqual(openCodePartEvents(read), [{ id: 'prt_1', name: 'read', kind: 'read', path: 'W:/repo/a.ts', text: 'từ dòng 10' }, { kind: 'result', id: 'prt_1', text: 'line' }]);
  const edit = part('prt_2', { type: 'tool', callID: 'c2', tool: 'edit', state: { status: 'error', input: { filePath: 'b.ts', oldString: 'a', newString: 'b\nc' }, error: 'denied', time: { start: 1, end: 2 } } });
  assert.deepEqual(openCodePartEvents(edit), [{ id: 'prt_2', name: 'edit', kind: 'edit', path: 'b.ts', change: 'update', added: 2, removed: 1, diff: '-a\n+b\n+c' }, { kind: 'result', id: 'prt_2', text: 'denied', error: true }]);
  const grep = part('prt_3', { type: 'tool', callID: 'c3', tool: 'grep', state: { status: 'completed', input: { pattern: 'TODO', path: 'src' }, output: '', title: '', metadata: {}, time: { start: 1, end: 2 } } });
  assert.equal(openCodePartEvents(grep)[0]!.kind, 'search');
  assert.deepEqual(openCodePartEvents(part('prt_4', { type: 'reasoning', text: 'think', time: { start: 1, end: 2 } })), [{ kind: 'reasoning', text: 'think' }]);
  assert.deepEqual(openCodePartEvents(part('prt_5', { type: 'text', text: 'Done.', time: { start: 1, end: 2 } })), [{ kind: 'message', text: 'Done.' }]);
  assert.deepEqual(openCodePartEvents(part('prt_6', { type: 'text', text: 'Task', time: { start: 1 } }), 'user'), [{ kind: 'prompt', text: 'Task' }]);
  assert.deepEqual(openCodePartEvents(part('prt_7', { type: 'step-finish', reason: 'stop', cost: 0, tokens: {} })), []);
  assert.equal(openCodePartDone(part('prt_8', { type: 'tool', tool: 'bash', state: { status: 'running', input: {}, time: { start: 1 } } })), false);
  assert.equal(openCodePartDone(part('prt_9', { type: 'text', text: 'partial', time: { start: 1 } })), false);
  assert.equal(openCodePartDone(read), true);
});

test('OpenCode reports finished parts of the running turn and reads the turn back from history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-oct-'));
  const stored: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[] = [];
  const session = { id: 'ses_ABC123', directory: dir, parentID: null, metadata: {} as unknown, permission: [] as unknown };
  let release!: () => void;
  const answered = new Promise<void>(resolve => { release = resolve; });
  const scope = (): ProcessScope => ({ identity: { unit: 'test', controlGroup: 'test' }, start: async () => { throw new Error('unused'); }, isActive: async () => true, stop: async () => true });
  const server = (async () => ({ close: async () => true, request: async (method: string, url: string, body?: unknown) => {
    if (url === '/global/health') return { healthy: true, version: '1.19.5' };
    if (url === '/mcp') return {};
    if (url === '/config') return { permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow' } };
    if (url === '/agent') return [{ name: 'build', mode: 'primary', permission: [] }];
    if (url === '/provider') return { connected: ['fake'], all: [{ id: 'fake', models: { model: {} } }] };
    if (url === '/session' && method === 'POST') { const value = body as { metadata: unknown; permission: unknown }; session.metadata = value.metadata; session.permission = value.permission; return session; }
    if (url === '/session/ses_ABC123' && method === 'GET') return session;
    if (url === '/session/ses_ABC123/message' && method === 'GET') return stored;
    if (url === '/session/ses_ABC123/message' && method === 'POST') {
      const value = body as { noReply?: boolean; tools?: Record<string, boolean>; parts: { text: string }[] };
      if (value.noReply) {
        session.permission = Object.entries(value.tools!).map(([permission, allow]) => ({ permission, pattern: '*', action: allow ? 'allow' : 'deny' }));
        stored.push({ info: { id: 'msg_v', role: 'user' }, parts: [part('prt_v', { type: 'text', text: value.parts[0]!.text })] });
        return { info: { sessionID: 'ses_ABC123', agent: 'build', model: { providerID: 'fake', modelID: 'model' } } };
      }
      stored.push({ info: { id: 'msg_u', role: 'user' }, parts: [part('prt_u', { type: 'text', text: value.parts[0]!.text })] });
      stored.push({ info: { id: 'msg_a', role: 'assistant' }, parts: [
        part('prt_r', { type: 'reasoning', text: 'Look first', time: { start: 1, end: 2 } }),
        part('prt_t', { type: 'tool', callID: 'c', tool: 'read', state: { status: 'completed', input: { filePath: path.join(dir, 'a.ts') }, output: 'x', title: '', metadata: {}, time: { start: 1, end: 2 } } }),
        part('prt_b', { type: 'tool', callID: 'd', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } } }),
      ] });
      await answered;
      // The running command finishes and the answer arrives after the first activity read.
      stored.at(-1)!.parts[2] = part('prt_b', { type: 'tool', callID: 'd', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.ts', title: '', metadata: {}, time: { start: 1, end: 3 } } });
      stored.at(-1)!.parts.push(part('prt_m', { type: 'text', text: 'All good.', time: { start: 3, end: 4 } }));
      return { info: { role: 'assistant', sessionID: 'ses_ABC123', providerID: 'fake', modelID: 'model' }, parts: [{ type: 'text', text: 'All good.' }] };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  } } as unknown as OpenCodeServer)) as unknown as typeof OpenCodeServer.start;
  const options = { stateDir: dir, dataHome: dir, config: {}, command: process.execPath, server, scopes: async () => scope() };
  try {
    const runner = new OpenCodeRunner(scope(), options), events: TranscriptEvent[] = [];
    runner.observe(event => events.push(event));
    const opened = await runner.openSession({ workspace: dir, binding: { runner: 'opencode', provider: 'fake', model: 'model', reasoning: 'medium' }, access: { kind: 'read' } });
    const turn = await runner.startTurn(opened, { prompt: 'Inspect the repo', effort: 'medium' });
    const waiting = runner.waitForTurn(opened, turn, () => false);
    await new Promise(resolve => setTimeout(resolve, 1300));
    // Only finished parts are reported while the turn runs: the command still running is held back.
    assert.deepEqual(events.map(event => event.kind), ['reasoning', 'read', 'result']);
    release();
    assert.equal((await waiting).status, 'completed');
    assert.deepEqual(events.map(event => event.kind), ['reasoning', 'read', 'result', 'command', 'result', 'message']);
    assert.equal(events.filter(event => event.kind === 'prompt').length, 0, 'NeoMind writes the prompt itself');

    const history = await openCodeHistory({ sessionId: opened.sessionId, workspace: dir, prompt: 'Inspect the repo' }, options);
    assert.equal(history.note, undefined);
    assert.deepEqual(history.events.map(event => event.kind), ['prompt', 'reasoning', 'read', 'result', 'command', 'result', 'message']);
    assert.match((await openCodeHistory({ sessionId: '00000000-0000-4000-8000-000000000000' }, options)).note ?? '', /Không tìm thấy session/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
