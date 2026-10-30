import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  claudeAbsolutePattern, claudeEffort, claudeEnvironment, claudeExpectedTools, claudeModel, claudePolicyArgs, claudeRunnerModels,
  claudeSettings, claudeWriteScopes, CLAUDE_DEFAULT_MODEL,
} from '../src/adapters/claude-policy.js';

const workspace = path.resolve('claude-policy-workspace');
const configDir = path.resolve('claude-config');
const config = `${claudeAbsolutePattern(configDir)}/**`;
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test('readers get only read tools, no allow rules, and every isolation flag', () => {
  const args = claudePolicyArgs({ workspace, access: { kind: 'read' }, model: 'haiku', effort: 'low', configDir });
  assert.deepEqual(args.slice(0, 8), ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep']);
  assert.deepEqual(JSON.parse(flag(args, '--settings')!), {
    autoMemoryEnabled: false, permissions: { allow: [], deny: ['WebFetch', 'WebSearch', 'Task', 'Agent', `Write(${config})`, `Edit(${config})`] },
  });
  assert.equal(flag(args, '--model'), 'claude-haiku-5-5');
  assert.equal(flag(args, '--effort'), 'low');
  assert.deepEqual(claudeExpectedTools({ kind: 'read' }, false), ['Glob', 'Grep', 'Read']);
});

test('writers get Write and Edit scoped to each writable root and never a shell', () => {
  const access = { kind: 'write' as const, writableRoots: [path.join(workspace, 'src', 'app'), path.join(workspace, 'docs')] };
  const args = claudePolicyArgs({ workspace, access, model: 'claude-sonnet-5-5', effort: 'high', configDir });
  assert.equal(flag(args, '--tools'), 'Read,Glob,Grep,Write,Edit');
  assert.ok(!/Bash|PowerShell|Task|Agent/.test(flag(args, '--tools')!));
  assert.deepEqual(claudeSettings(workspace, access, configDir).permissions.allow, ['Write(src/app/**)', 'Edit(src/app/**)', 'Write(docs/**)', 'Edit(docs/**)']);
  assert.deepEqual(claudeExpectedTools(access, false), ['Edit', 'Glob', 'Grep', 'Read', 'Write']);
  assert.deepEqual(claudeExpectedTools(access, true), ['Edit', 'Glob', 'Grep', 'Read', 'StructuredOutput', 'Write']);
});

test('writable roots become verified rule syntax or are refused', () => {
  assert.deepEqual(claudeWriteScopes(workspace, [workspace]), ['**']);
  assert.deepEqual(claudeWriteScopes(workspace, ['.', 'src', path.join(workspace, 'src')]), ['**', 'src/**']);
  assert.deepEqual(claudeWriteScopes(workspace, [path.join(workspace, 'sub dir', 'deep')]), ['sub dir/deep/**']);
  // Unescaped brackets are a glob class: `app/[slug]/**` also matched `app/s/`.
  assert.deepEqual(claudeWriteScopes(workspace, [path.join(workspace, 'app', '[slug]')]), ['app/\\[slug\\]/**']);
  assert.throws(() => claudeWriteScopes(workspace, []), /at least one writable root/);
  assert.throws(() => claudeWriteScopes(workspace, [path.dirname(workspace)]), /escapes the workspace/);
  assert.throws(() => claudeWriteScopes(workspace, [path.join(workspace, '..', 'other')]), /escapes the workspace/);
  for (const name of ['a{b}', 'a(b)', 'a!b', '~home', '#x']) assert.throws(() => claudeWriteScopes(workspace, [path.join(workspace, name)]), /cannot be expressed/);
});

test('absolute rules use the lower-case drive form that Claude Code matches on Windows', () => {
  assert.equal(claudeAbsolutePattern('C:\\Users\\me\\.claude', 'win32'), '//c/Users/me/.claude');
  assert.equal(claudeAbsolutePattern('D:\\', 'win32'), '//d');
  assert.equal(claudeAbsolutePattern('C:\\Users\\[x]\\.claude', 'win32'), '//c/Users/\\[x\\]/.claude');
  assert.equal(claudeAbsolutePattern('/home/me/.claude/', 'linux'), '//home/me/.claude');
  assert.throws(() => claudeAbsolutePattern('\\\\server\\share\\.claude', 'win32'), /cannot be expressed/);
  assert.throws(() => claudeAbsolutePattern('C:\\Users\\a (b)\\.claude', 'win32'), /cannot be expressed/);
});

test('only allowlisted models and efforts are accepted', () => {
  assert.equal(CLAUDE_DEFAULT_MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(['sonnet', 'haiku', 'opus', 'claude-opus-5-5'].map(claudeModel), ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  assert.throws(() => claudeModel('claude-sonnet-4-5'), /not allowed/);
  assert.throws(() => claudeModel('fable'), /not allowed/);
  assert.deepEqual(['low', 'medium', 'high'].map(claudeEffort), ['low', 'medium', 'high']);
  for (const effort of ['minimal', 'xhigh', 'max', '']) assert.throws(() => claudeEffort(effort), /not supported/);
  assert.throws(() => claudePolicyArgs({ workspace, access: { kind: 'read' }, model: 'gpt-5', effort: 'low', configDir }), /not allowed/);
  assert.deepEqual(claudeRunnerModels().map(model => [model.runner, model.provider, model.model, model.reasoning.join()]), [
    ['claude-code', 'anthropic', 'claude-sonnet-5-5', 'low,medium,high'],
    ['claude-code', 'anthropic', 'claude-haiku-5-5', 'low,medium,high'],
    ['claude-code', 'anthropic', 'claude-opus-5-5', 'low,medium,high'],
  ]);
});

test('the worker environment drops a parent Claude Code session but keeps its config dir', () => {
  const env = claudeEnvironment({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_EFFORT: 'max', CLAUDE_CODE_ENABLE_TASKS: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_MODEL: 'm' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_MODEL: 'm' });
});
