import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialize } from '../dist/storage.js';
import { observeNativeHook, readNativeHooks, nativeHookOutputs, hookTtlMs } from '../dist/agent-hooks.js';
import { readAgentMap } from '../dist/agent-map.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "neomind hook's "));
  initialize(root, { project_id: 'HOOK', name: 'Hook regression' });
  mkdirSync(join(root, 'src'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const payload = root => ({ session_id: 'private-session', agent_id: 'private-agent', agent_type: 'neomind-explorer',
  cwd: join(root, 'src'), prompt: 'PRIVATE PROMPT', tool_response: 'PRIVATE RESULT', transcript_path: 'PRIVATE PATH' });

test('native lifecycle persists only metadata, links actual parents and stops without claiming acceptance', t => {
  const root = setup(t), event = payload(root);
  const parent = observeNativeHook(root, 'codex', { ...event, agent_id: 'parent', agent_type: 'neomind-coordinator' }, 'SubagentStart');
  const child = observeNativeHook(root, 'codex', { ...event, parent_agent_id: 'parent' }, 'SubagentStart');
  assert.equal(child.status, 'recorded');
  let map = readAgentMap(root);
  assert.ok(map.edges.some(edge => edge.from === `native-hook:${parent.observation.id}` && edge.to === `native-hook:${child.observation.id}` && edge.animated));
  const node = map.nodes.find(item => item.id === `native-hook:${child.observation.id}`);
  assert.equal(node.workflow_id, null); assert.equal(node.confirmed_model, null);
  const saved = readFileSync(join(root, `.neomind/runs/native-hooks/${child.observation.id}.json`), 'utf8');
  for (const forbidden of ['PRIVATE', 'private-agent', 'private-session', 'transcript_path']) assert.ok(!saved.includes(forbidden));
  observeNativeHook(root, 'codex', { session_id: event.session_id, agent_id: event.agent_id, cwd: root }, 'SubagentStop');
  map = readAgentMap(root);
  assert.equal(map.nodes.find(item => item.id === node.id).state, 'idle');
  assert.ok(!map.edges.find(edge => edge.to === node.id).animated);
});

test('ambiguous identities and another project are ignored, aged metadata becomes unknown', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const root = setup(t);
  assert.equal(observeNativeHook(root, 'copilot', { agentName: 'NeoMind Explorer Agent', sessionId: 's' }, 'SubagentStart').status, 'ignored');
  assert.equal(observeNativeHook(root, 'codex', { ...payload(root), cwd: tmpdir() }, 'SubagentStart').status, 'ignored');
  observeNativeHook(root, 'copilot', { ...payload(root), agent_type: 'NeoMind Explorer Agent' }, 'SubagentStart');
  t.mock.timers.tick(hookTtlMs + 1);
  assert.equal(readNativeHooks(root).observations[0].expired, true);
  assert.equal(readAgentMap(root).nodes.find(node => node.kind === 'agent').state, 'unknown');
});

test('one unsafe hash-named hook entry cannot hide an independent valid observation', t => {
  const root = setup(t), recorded = observeNativeHook(root, 'codex', payload(root), 'SubagentStart');
  const foreign = mkdtempSync(join(tmpdir(), 'neomind-foreign-hook-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  symlinkSync(foreign, join(root, `.neomind/runs/native-hooks/${'f'.repeat(64)}.json`), process.platform === 'win32' ? 'junction' : 'dir');
  const read = readNativeHooks(root);
  assert.equal(read.invalid, 1);
  assert.ok(read.observations.some(item => item.id === recorded.observation.id));
  assert.ok(readAgentMap(root).nodes.some(item => item.id === `native-hook:${recorded.observation.id}`));
});

test('generated command runs the actual CLI from a subdirectory with quoted absolute paths', t => {
  const root = setup(t), outputs = nativeHookOutputs(root, ['codex', 'copilot']);
  for (const output of outputs) { const path = join(root, output.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, output.content); }
  const config = JSON.parse(outputs.find(item => item.path === '.codex/hooks.json').content);
  const hook = config.hooks.SubagentStart[0].hooks[0];
  const command = process.platform === 'win32' ? hook.commandWindows : hook.command;
  const run = spawnSync(command, { cwd: join(root, 'src'), shell: true, input: JSON.stringify(payload(root)), encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readNativeHooks(root).observations.length, 1, 'The configured shell command must actually record the hook.');
});

test('shared Copilot repository hook runs the documented shell command with apostrophes in project paths', t => {
  const root = setup(t), outputs = nativeHookOutputs(root, ['copilot']);
  for (const output of outputs) { const path = join(root, output.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, output.content); }
  const config = JSON.parse(outputs.find(item => item.path === '.github/hooks/neomind.json').content);
  const hook = config.hooks.SubagentStart[0];
  const run = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.powershell ?? hook.command],
      { cwd: join(root, 'src'), input: JSON.stringify(payload(root)), encoding: 'utf8', timeout: 20000, windowsHide: true })
    : spawnSync('bash', ['-c', hook.bash ?? hook.command],
      { cwd: join(root, 'src'), input: JSON.stringify(payload(root)), encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readNativeHooks(root).observations.length, 1);
});
