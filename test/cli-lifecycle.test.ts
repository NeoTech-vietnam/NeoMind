import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseRunCommand, readRunCommandInput } from '../src/cli/run-command.js';
import { renderPlanMarkdown } from '../src/domain/plan-markdown.js';
import { installShutdown } from '../src/cli/shutdown.js';
import { RunManager } from '../src/runtime/run-manager.js';

const hash = 'a'.repeat(64), cli = path.resolve('dist/src/cli/main.js');
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-cli-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(path.join(root, 'README.md'), 'x\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
  return root;
}

test('run commands are fully validated before any state is opened', () => {
  assert.deepEqual(parseRunCommand(['run', 'changes', 'p', 'r', '--plan-hash', hash, 'Thêm test']), { kind: 'changes', project: 'p', runId: 'r', planHash: hash, feedback: 'Thêm test' });
  assert.deepEqual(parseRunCommand(['run', 'retry-git', 'p', 'r']), { kind: 'retry-git', project: 'p', runId: 'r' });
  assert.deepEqual(parseRunCommand(['run', 'extend-time', 'p', 'r', '600']), { kind: 'extend-time', project: 'p', runId: 'r', seconds: 600 });
  assert.deepEqual(parseRunCommand(['run', 'approve', 'p', 'r', '--plan-hash', hash]), { kind: 'approve', project: 'p', runId: 'r', planHash: hash });
  for (const invalid of [['run'], ['run', 'list', 'p', 'extra'], ['run', 'changes', 'p', 'r', '--plan-hash', 'short', 'x'], ['run', 'changes', 'p', 'r', '--plan-hash', hash, ' '],
    ['run', 'extend-time', 'p', 'r', '0'], ['run', 'extend-time', 'p', 'r', '86401'], ['run', 'extend-time', 'p', 'r', '1.5'], ['run', 'retry-git', 'p', 'r', 'x'], ['run', 'start', 'p', 'dev'], ['run', 'unknown', 'p', 'r']])
    assert.equal(parseRunCommand(invalid), undefined, invalid.join(' '));
});

test('task and feedback come from exactly one source, inline or file', () => {
  assert.deepEqual(parseRunCommand(['run', 'start', 'p', 'dev', '--task-file', 'task.md', '--workspace', 'current']), { kind: 'start', project: 'p', flowId: 'dev', taskFile: 'task.md', workspaceMode: 'current' });
  assert.deepEqual(parseRunCommand(['run', 'start', 'p', 'dev', '--import-dirty', hash, '--task-file', 'task.md']), { kind: 'start', project: 'p', flowId: 'dev', taskFile: 'task.md', importDirty: hash });
  assert.deepEqual(parseRunCommand(['run', 'start', 'p', 'dev', 'Sửa lỗi', '--workspace', 'shared']), { kind: 'start', project: 'p', flowId: 'dev', task: 'Sửa lỗi', workspaceMode: 'shared' });
  assert.deepEqual(parseRunCommand(['run', 'changes', 'p', 'r', '--plan-hash', hash, '--feedback-file', 'f.md']), { kind: 'changes', project: 'p', runId: 'r', planHash: hash, feedbackFile: 'f.md' });
  assert.deepEqual(parseRunCommand(['run', 'plan', 'p', 'r']), { kind: 'plan', project: 'p', runId: 'r' });
  assert.deepEqual(parseRunCommand(['run', 'plan', 'p', 'r', '--out', 'plan.md']), { kind: 'plan', project: 'p', runId: 'r', out: 'plan.md' });
  for (const invalid of [['run', 'start', 'p', 'dev', 'task', '--task-file', 'task.md'], ['run', 'start', 'p', 'dev', '--task-file', 'a.md', '--task-file', 'b.md'],
    ['run', 'start', 'p', 'dev', '--task-file'], ['run', 'start', 'p', 'dev', '--task-file', ' '], ['run', 'start', 'p', 'dev', '--workspace', 'current'],
    ['run', 'preview', 'p', 'dev', '--task-file', 'task.md'], ['run', 'changes', 'p', 'r', '--plan-hash', hash, 'x', '--feedback-file', 'f.md'],
    ['run', 'changes', 'p', 'r', '--plan-hash', hash, '--feedback-file'], ['run', 'changes', 'p', 'r', '--plan-hash', hash, 'x'.repeat(10001)],
    ['run', 'plan', 'p', 'r', '--out'], ['run', 'plan', 'p', 'r', 'extra']])
    assert.equal(parseRunCommand(invalid), undefined, invalid.join(' ').slice(0, 80));
});

test('a multi-line task file arrives intact; empty or oversized files are usage errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-cli-input-'));
  const task = 'Sửa hàm parse:\r\n- giữ dòng hai\n\n- và dòng “ba”\n';
  await writeFile(path.join(dir, 'task.md'), '﻿' + task, 'utf8');
  const start = parseRunCommand(['run', 'start', 'p', 'dev', '--task-file', path.join(dir, 'task.md')])!;
  assert.deepEqual(await readRunCommandInput(start), { kind: 'start', project: 'p', flowId: 'dev', task });
  await writeFile(path.join(dir, 'feedback.md'), 'Dòng một\nDòng hai\n', 'utf8');
  const changes = parseRunCommand(['run', 'changes', 'p', 'r', '--plan-hash', hash, '--feedback-file', path.join(dir, 'feedback.md')])!;
  assert.deepEqual(await readRunCommandInput(changes), { kind: 'changes', project: 'p', runId: 'r', planHash: hash, feedback: 'Dòng một\nDòng hai\n' });
  await writeFile(path.join(dir, 'empty.md'), ' \n\n', 'utf8'); await writeFile(path.join(dir, 'long.md'), 'x'.repeat(10001), 'utf8');
  assert.equal(await readRunCommandInput(parseRunCommand(['run', 'start', 'p', 'dev', '--task-file', path.join(dir, 'empty.md')])!), undefined);
  assert.equal(await readRunCommandInput(parseRunCommand(['run', 'changes', 'p', 'r', '--plan-hash', hash, '--feedback-file', path.join(dir, 'long.md')])!), undefined);
  const inline = parseRunCommand(['run', 'show', 'p', 'r'])!;
  assert.equal(await readRunCommandInput(inline), inline);
});

test('a task file that cannot be used exits with usage and creates no runtime state', async () => {
  const project = await repository(), state = await mkdtemp(path.join(tmpdir(), 'neomind-cli-state-'));
  const empty = path.join(state, 'empty.md'); await writeFile(empty, '\n', 'utf8');
  for (const args of [['dev', 'task', '--task-file', empty], ['dev', '--task-file', empty], ['dev', '--task-file', path.join(state, 'missing.md')]]) {
    const result = spawnSync(process.execPath, [cli, 'run', 'start', project, ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state } });
    assert.equal(result.status, 2, args.join(' ')); assert.equal(existsSync(path.join(state, 'neomind')), false);
  }
});

test('plan markdown shows identity, hash and every plan section', () => {
  const plan = { planId: 'plan-1', version: 2, goal: 'Thêm --task-file', approach: 'Đọc file UTF-8.\nGiữ giới hạn.', acceptanceCriteria: ['Task nhiều dòng\nnguyên vẹn'], checks: ['npm test'], riskChanges: [], scope: ['src/cli/run-command.ts', 'README.md'] };
  const markdown = renderPlanMarkdown(plan, { runId: 'run-1', phase: 'awaiting_approval', planHash: hash, approved: false });
  assert.match(markdown, /^# Plan plan-1 \(v2\)\n/);
  for (const text of ['- Run: `run-1`', '- Phase: awaiting_approval', '- Status: awaiting approval', `- Plan hash: \`${hash}\``, '## Goal\n\nThêm --task-file', '## Approach\n\nĐọc file UTF-8.\nGiữ giới hạn.',
    '## Acceptance criteria\n\n- Task nhiều dòng nguyên vẹn', '## Checks\n\n- npm test', '## Risks\n\n_None_', '## Scope\n\n- src/cli/run-command.ts\n- README.md'])
    assert.ok(markdown.includes(text), text);
  assert.doesNotMatch(markdown, /Work packets/);
  const parallel = renderPlanMarkdown({ ...plan, workPackets: [{ nodeId: 'writer-a', goal: 'CLI', scope: ['src/cli/'] }] }, { runId: 'run-1', planHash: hash, approved: true });
  assert.match(parallel, /- Status: approved/); assert.match(parallel, /## Work packets\n\n### writer-a\n\nCLI\n\n- src\/cli\//);
});

test('an invalid run command exits with usage and creates no runtime state', async () => {
  const project = await repository(), state = await mkdtemp(path.join(tmpdir(), 'neomind-cli-state-'));
  const result = spawnSync(process.execPath, [cli, 'run', 'extend-time', project, 'run-x', 'soon'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state } });
  assert.equal(result.status, 2); assert.match(result.stderr, /extend-time <project> <run-id> <seconds>/);
  assert.equal(existsSync(path.join(state, 'neomind')), false);
});

test('first signal stops gracefully before exit; a second signal exits at once', async () => {
  const source = new EventEmitter(), exits: number[] = [], logs: string[] = [];
  let release!: () => void; const stopping = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const uninstall = installShutdown(async () => { stops++; await stopping; }, { source, exit: code => exits.push(code), log: message => logs.push(message) });
  source.emit('SIGINT', 'SIGINT');
  assert.equal(stops, 1); assert.deepEqual(exits, []);
  source.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(exits, [143]); assert.equal(stops, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [143, 130]); assert.equal(logs.length, 2);
  uninstall(); assert.equal(source.listenerCount('SIGINT'), 0);

  const failed: number[] = [];
  const again = installShutdown(async () => { throw new Error('worker stop unconfirmed'); }, { source, exit: code => failed.push(code), log: () => {} });
  source.emit('SIGTERM', 'SIGTERM'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failed, [1]); again();
});

test('closing a run manager is idempotent and reports owned runs', async () => {
  const project = await repository(), state = await mkdtemp(path.join(tmpdir(), 'neomind-cli-state-'));
  const manager = await RunManager.open(project, state);
  assert.deepEqual(await manager.close(), []);
  assert.deepEqual(await manager.close(), []);
});

test('the editor process shuts down cleanly on SIGTERM', { skip: process.platform === 'win32' && 'Windows cannot deliver console signals to a child process', timeout: 30000 }, async () => {
  const project = await repository(), state = await mkdtemp(path.join(tmpdir(), 'neomind-cli-state-'));
  const editor = spawn(process.execPath, [cli, 'editor', project], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_STATE_HOME: state } });
  let stderr = '';
  editor.stderr.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Editor did not start')), 20000);
    editor.stdout.on('data', chunk => { if (String(chunk).includes('http://127.0.0.1:')) { clearTimeout(timer); resolve(); } });
  });
  editor.kill('SIGTERM');
  const code = await new Promise<number | null>(resolve => editor.once('exit', resolve));
  assert.equal(code, 143); assert.match(stderr, /SIGTERM/);
});
