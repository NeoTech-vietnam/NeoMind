import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { claudeTranscriptEvents, CodexTranscriptMapper, codexItemEvents, listTranscripts, readTranscript, shellCommand, summarizeTranscript, TRANSCRIPT_LIMITS, TranscriptWriter } from '../src/core/transcript.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { claudeHistoryEvents, codexHistoryEvents, sessionTurnIndex } from '../src/runtime/session-history.js';
import { fakeScope } from './helpers/fake-runner.js';

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');

test('Claude stream events become reads, searches, edits, results and structured output', () => {
  const workspace = path.resolve('/work/repo');
  const events = claudeTranscriptEvents({ type: 'assistant', session_id: 's', message: { content: [
    { type: 'text', text: 'Looking at calc.js' },
    { type: 'thinking', thinking: 'Need to check the edge case' },
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(workspace, 'calc.js') } },
    { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'divide' } },
    { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(workspace, 'calc.js'), old_string: 'a / b', new_string: 'b === 0 ? NaN\n  : a / b' } },
    { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: path.join(workspace, 'test.js'), content: 'one\ntwo\n' } },
    { type: 'tool_use', id: 'o1', name: 'StructuredOutput', input: { verdict: 'pass' } },
  ] } });
  assert.deepEqual(events.map(event => [event.kind, event.id ?? '']), [['message', ''], ['reasoning', ''], ['read', 'r1'], ['search', 'g1'], ['edit', 'e1'], ['edit', 'w1'], ['structured_output', 'o1']]);
  assert.deepEqual([events[4]!.added, events[4]!.removed, events[5]!.added, events[5]!.change], [2, 1, 2, 'write']);
  const results = claudeTranscriptEvents({ type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'text', text: 'file text' }] },
    { type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'Permission denied' }] } });
  assert.deepEqual(results, [{ kind: 'result', id: 'r1', text: 'file text' }, { kind: 'result', id: 'x', text: 'Permission denied', error: true }]);
  assert.deepEqual(claudeTranscriptEvents({ type: 'user', message: { content: 'Do the task' } }), [{ kind: 'prompt', text: 'Do the task' }]);
  assert.deepEqual(claudeTranscriptEvents({ type: 'queue-operation' }), []);
});

test('Codex notifications become commands with their script, file edits with diff stats, and bounded output deltas', () => {
  assert.equal(shellCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'git diff; Write-Output ''hi'''`), `git diff; Write-Output 'hi'`);
  assert.equal(shellCommand(`/bin/bash -lc 'npm test'`), 'npm test');
  assert.equal(shellCommand('npm test'), 'npm test');
  const mapper = new CodexTranscriptMapper(), threadId = 't', turnId = 'u';
  const started = mapper.accept('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: `/bin/bash -lc 'cat calc.js'`, commandActions: [{ type: 'read', command: 'cat calc.js', name: 'calc.js', path: 'calc.js' }], status: 'inProgress' } });
  assert.deepEqual(started, [{ kind: 'command', id: 'c1', command: 'cat calc.js', status: 'running', action: 'read', path: 'calc.js' }]);
  let delivered = 0;
  for (let index = 0; index < TRANSCRIPT_LIMITS.outputLines + 50; index++) delivered += mapper.accept('item/commandExecution/outputDelta', { threadId, turnId, itemId: 'c1', delta: `${index}\n` }).length;
  assert.equal(delivered, TRANSCRIPT_LIMITS.outputLines, 'deltas stop at the line limit');
  const completed = mapper.accept('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: 'npm test', commandActions: [], status: 'completed', exitCode: 1, durationMs: 40, aggregatedOutput: 'FAIL' } });
  assert.deepEqual(completed, [{ kind: 'command', id: 'c1', command: 'npm test', status: 'completed', exitCode: 1, durationMs: 40, text: 'FAIL' }]);
  const edits = codexItemEvents({ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'calc.js', kind: { type: 'update' }, diff: '--- a/calc.js\n+++ b/calc.js\n@@\n-a\n+b\n+c\n' }] }, 'completed');
  assert.deepEqual(edits.map(event => [event.path, event.change, event.added, event.removed]), [['calc.js', 'update', 2, 1]]);
  assert.deepEqual(mapper.accept('item/completed', { threadId, turnId, item: { type: 'userMessage', id: 'p', content: [{ type: 'text', text: 'prompt' }] } }), [], 'the echoed prompt is not written twice');
  assert.deepEqual(codexItemEvents({ type: 'reasoning', id: 'r', summary: ['Plan the fix'], content: ['secret raw reasoning'] }, 'completed'), [{ kind: 'reasoning', id: 'r', text: 'Plan the fix' }]);
  // Turn bookkeeping is unchanged by observers, and an observer that throws never faults the turn.
  const events = new CodexTurnEvents(), seen: string[] = [];
  events.observe(method => { seen.push(method); throw new Error('observer bug'); });
  events.accept('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  assert.deepEqual([seen, events.result(threadId, turnId)?.status], [['turn/completed'], 'completed']);
});

test('the writer clips each event, keeps paths workspace-relative, stops at the size limit and is read back incrementally', async () => {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), 'neomind-transcript-')), 'transcripts'), workspace = path.resolve(directory, '..', 'ws');
  const writer = TranscriptWriter.open(directory, { attemptId: 'a1', nodeId: 'implement', key: 'implement', role: 'write', runner: 'codex', model: 'gpt-6-luna', sessionId: 's', workspace });
  writer.write({ kind: 'prompt', text: 'Do it' });
  writer.write({ kind: 'command', id: 'c', command: 'npm test', text: lines(500) });
  writer.write({ kind: 'read', id: 'r', path: path.join(workspace, 'src', 'calc.js') });
  writer.write({ kind: 'result', id: 'r', text: lines(300) });
  writer.write({ kind: 'edit', id: 'e', path: path.join(workspace, 'calc.js'), added: 3, removed: 1, diff: '+x' });
  writer.end('completed', { usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 15 } });
  writer.write({ kind: 'message', text: 'after the end' });
  const events = readTranscript(directory, 'a1')!;
  assert.deepEqual(events.map(event => [event.i, event.kind]), [[0, 'meta'], [1, 'prompt'], [2, 'command'], [3, 'read'], [4, 'result'], [5, 'edit'], [6, 'end']]);
  const command = events[2]!, result = events[4]!;
  assert.equal(command.text!.split('\n').length, TRANSCRIPT_LIMITS.outputLines); assert.ok(command.text!.endsWith('line 500') && command.truncated, 'command output keeps its tail');
  assert.equal(result.text!.split('\n').length, TRANSCRIPT_LIMITS.readLines); assert.ok(result.text!.startsWith('line 1') && result.truncated, 'file reads keep their head');
  assert.deepEqual([events[3]!.path, events[5]!.path], ['src/calc.js', 'calc.js']);
  assert.deepEqual(readTranscript(directory, 'a1', 5)!.map(event => event.kind), ['edit', 'end'], 'polling resumes after the last seen event');
  const summary = summarizeTranscript(events)!;
  assert.deepEqual([summary.status, summary.reads, summary.commands, summary.edits, summary.files, summary.added, summary.removed, summary.usage?.totalTokens, summary.last?.kind],
    ['completed', 1, 1, 1, ['calc.js'], 3, 1, 15, 'edit']);
  assert.deepEqual(listTranscripts(directory).map(item => item.meta.attemptId), ['a1']);
  assert.equal(readTranscript(directory, 'missing'), undefined);
  assert.throws(() => readTranscript(directory, '../escape'), /Invalid attempt id/);

  const big = TranscriptWriter.open(directory, { attemptId: 'a2', nodeId: 'n', key: 'n', role: 'read', runner: 'codex', model: 'm', sessionId: 's', workspace });
  const chunk = 'x'.repeat(TRANSCRIPT_LIMITS.textChars - 10);
  for (let index = 0; index < Math.ceil(TRANSCRIPT_LIMITS.fileBytes / chunk.length) + 5; index++) big.write({ kind: 'message', text: chunk });
  big.write({ kind: 'message', text: 'dropped' });
  const capped = readTranscript(directory, 'a2')!;
  assert.equal(capped.at(-1)!.kind, 'gap', 'the size limit is shown as a gap');
  assert.ok(!capped.some(event => event.text === 'dropped'));
});

test('a stored Claude session yields the attempt turn by its prompt, or by its position when the prompt is unknown', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'neomind-claude-history-')), 'session.jsonl');
  const record = (value: unknown) => JSON.stringify(value);
  await writeFile(file, [
    record({ type: 'queue-operation', operation: 'enqueue' }),
    record({ type: 'user', timestamp: '2026-10-30T10:00:00Z', message: { role: 'user', content: 'Plan the change' } }),
    record({ type: 'assistant', timestamp: '2026-10-30T10:00:05Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/calc.js' } }] } }),
    record({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code' }] } }),
    record({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub-agent noise' }] } }),
    record({ type: 'user', timestamp: '2026-10-30T10:05:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Implement it' }] } }),
    record({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }),
    'not json',
  ].join('\n'));
  const byPrompt = claudeHistoryEvents(file, { sessionId: 's', prompt: 'Implement it', workspace: '/w' });
  assert.deepEqual(byPrompt.events.map(event => [event.i, event.kind, event.text]), [[0, 'prompt', 'Implement it'], [1, 'message', 'Done']]);
  const byIndex = claudeHistoryEvents(file, { sessionId: 's', turnIndex: 0, workspace: path.resolve('/w') });
  assert.deepEqual(byIndex.events.map(event => event.kind), ['prompt', 'read', 'result']);
  assert.equal(byIndex.events[1]!.path, 'calc.js');
  assert.equal(byIndex.events[0]!.t, Date.parse('2026-10-30T10:00:00Z'));
  assert.match(claudeHistoryEvents(file, { sessionId: 's', prompt: 'Other' }).note ?? '', /không tìm thấy/);
  // An attempt stopped before dispatch left no turn in the session and does not shift the turns after it.
  const attempts = [{ attemptId: 'stopped', sessionId: 's' }, { attemptId: 'plan', sessionId: 's', runnerTurnId: 'u1' }, { attemptId: 'other', sessionId: 'x', runnerTurnId: 'u9' },
    { attemptId: 'implement', sessionId: 's', runnerTurnId: 'u2' }];
  assert.deepEqual(['stopped', 'plan', 'implement', 'other'].map(id => sessionTurnIndex(attempts, id)), [undefined, 0, 1, 0]);
  assert.match(claudeHistoryEvents(file, { sessionId: 's' }).note ?? '', /chưa bắt đầu lượt/);
});

test('a Codex turn is read back through thread/items/list, filtered to the attempt turn, and the reader is stopped', async () => {
  const requests: unknown[] = [];
  let stopped = false;
  const pages = [
    { data: [{ turnId: 'u1', startedAtMs: 1000, item: { type: 'userMessage', id: 'p', content: [{ type: 'text', text: 'Review' }] } },
      { turnId: 'u1', item: { type: 'commandExecution', id: 'c', command: 'git diff', commandActions: [], status: 'completed', exitCode: 0, aggregatedOutput: 'diff' } }], nextCursor: 'next' },
    { data: [{ turnId: 'other', item: { type: 'agentMessage', id: 'x', text: 'not this turn' } }, { turnId: 'u1', item: { type: 'agentMessage', id: 'm', text: '{"verdict":"pass"}' } }] },
  ];
  const history = await codexHistoryEvents({ sessionId: 'thread', runnerTurnId: 'u1' }, async () => ({ ...fakeScope(), stop: async () => { stopped = true; return true; },
    transport: { request: async (method: string, params: unknown) => { requests.push([method, params]); return pages.shift()!; } } }));
  assert.deepEqual(history.events.map(event => [event.kind, event.text]), [['prompt', 'Review'], ['command', 'diff'], ['message', '{"verdict":"pass"}']]);
  assert.equal(history.events[0]!.t, 1000);
  assert.deepEqual(requests, [['thread/items/list', { threadId: 'thread', turnId: 'u1', limit: 100 }], ['thread/items/list', { threadId: 'thread', turnId: 'u1', limit: 100, cursor: 'next' }]]);
  assert.ok(stopped);
  assert.match((await codexHistoryEvents({ sessionId: 'thread' })).note ?? '', /chưa có turn/);
});
