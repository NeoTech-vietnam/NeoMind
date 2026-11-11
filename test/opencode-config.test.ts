import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCodeModels, readOpenCodeProviderConfig } from '../src/runners/opencode-config.js';

test('OpenCode provider config excludes unrelated tools and parses JSONC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-config-'));
  try {
    await mkdir(path.join(root, 'opencode'));
    await writeFile(path.join(root, 'opencode', 'opencode.jsonc'), '{// comment\n"provider":{"test":{"options":{"baseURL":"https://example.test/v1"}}},"mcp":{"unsafe":{}},"plugin":["unsafe"],}');
    const result = await readOpenCodeProviderConfig({ XDG_CONFIG_HOME: root });
    assert.deepEqual(result, { provider: { test: { options: { baseURL: 'https://example.test/v1' } } } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OpenCode models list includes connected providers and their variants only', () => {
  const response = { connected: ['local'], all: [{ id: 'local', models: { m: { variants: { low: {}, high: {} } } } }, { id: 'other', models: { hidden: {} } }] };
  assert.deepEqual(openCodeModels(response), [{ runner: 'opencode', provider: 'local', model: 'm', reasoning: ['low', 'high'] }]);
  assert.throws(() => openCodeModels({ connected: [] }), /provider response/);
});
