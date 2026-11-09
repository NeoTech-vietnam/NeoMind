import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initialize, createRecord, getRecord } from '../dist/storage.js';
import { installProject, updateProject } from '../dist/installer.js';
import { nativeLocalToolReferences, nativeSpecialists, nativeWorkerProfiles } from '../dist/native-local-contract.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Local installation generates only the native process instructions and preserves existing project history', { timeout: 60000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { platforms: ['copilot', 'codex'], copilot_integration: 'local' });
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode/mcp.json'), '{"servers":{"existing":{"command":"keep"}}}\n');
  writeFileSync(join(root, '.gitignore'), '# User rules\n*.object\n');
  const historic = createRecord(root, { type: 'task', title: 'Historical pending task', body: 'Keep this history byte-for-byte.' });
  const bytes = readFileSync(join(root, getRecord(root, historic.meta.id).path));
  const installed = installProject(root);
  assert.equal(installed.conflicts.length, 0);
  const pm = readFileSync(join(root, '.github/agents/workforce-pm.agent.md'), 'utf8');
  const profile = parse(/^---\n([\s\S]*?)\n---/.exec(pm)[1]);
  assert.ok(profile.tools.includes(nativeLocalToolReferences.request));
  assert.equal(profile.tools.includes('workforce/request_submit'), false);
  assert.equal(profile.model, undefined, 'Native Local inherits the current model; aliases are not required');
  assert.equal(profile['user-invocable'], true);
  assert.deepEqual(profile.agents, ['*'], 'Host-owned versioned workers must pass native parent admission.');
  assert.ok(profile.tools.every(tool => !/^(?:agent|runSubagent)$/.test(tool)), 'Only backend role tools may launch workers.');
  const installedProfiles = readdirSync(join(root, '.github/agents')).filter(file => file.endsWith('.agent.md'))
    .map(file => parse(readFileSync(join(root, '.github/agents', file), 'utf8').split('---')[1]));
  assert.equal(installedProfiles.filter(item => item['user-invocable']).length, 6);
  assert.equal(installedProfiles.filter(item => item['user-invocable'] === false).length, 5);
  for (const role of nativeSpecialists) {
    const worker = installedProfiles.find(item => item.name === nativeWorkerProfiles[role]);
    assert.deepEqual(worker.agents, []);
    assert.ok(worker.tools.every(name => !/workforce|runSubagent|^agent$/i.test(name)));
  }
  const instructions = readFileSync(join(root, '.github/instructions/workforce.instructions.md'), 'utf8');
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(nativeLocalToolReferences.request), 'Shared instructions must describe the native tools when read by Local');
  assert.match(instructions, /vscode-native\/v1/);
  for (const text of [pm, instructions, agents]) {
    assert.doesNotMatch(text, /request_submit once|OpenCode workers|configured top-models|assignment_claim/);
  }
  assert.equal(JSON.parse(readFileSync(join(root, '.vscode/mcp.json'))).servers.existing.command, 'keep');
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '# User rules\n*.object\n');
  const hook = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'hook', '--project', root, '--platform', 'copilot'],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).additionalContext, /vscode-native\/v1/);
  assert.doesNotMatch(hook.stdout, /request_submit|assignment_claim/);
  updateProject(root, { copilot_integration: 'local' });
  assert.deepEqual(readFileSync(join(root, getRecord(root, historic.meta.id).path)), bytes);
});
