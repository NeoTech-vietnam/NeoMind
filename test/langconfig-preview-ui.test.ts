import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LANGCONFIG_FILE_BYTES, readLangConfigFile, safeLangConfigPreview } from '../ui/src/langconfig-preview-model.js';
import { requestLangConfigPreview, setApiTransport } from '../ui/src/api.js';

test('oversize file is refused before reading, including a misleading size after read', async () => {
  let reads = 0;
  await assert.rejects(readLangConfigFile({ size: MAX_LANGCONFIG_FILE_BYTES + 1, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }), /size/);
  assert.equal(reads, 0);
  await assert.rejects(readLangConfigFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(MAX_LANGCONFIG_FILE_BYTES + 1) }), /size/);
  await assert.rejects(readLangConfigFile({ size: 1, arrayBuffer: async () => Uint8Array.from([255]).buffer }), /encoding/);
  assert.equal(await readLangConfigFile({ size: 2, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }), '{}');
});

test('preview display allows only synthetic aliases and fixed diagnostics, never echoed values', () => {
  const input = { format: 'neomind-langconfig-preview-v1', executable: false, sourceFormat: 'blueprint',
    nodes: [{ id: 'node-0', suggestedType: 'start', label: 'SECRET' }, { id: 'node-1' }],
    edges: [{ from: 'node-0', to: 'node-1', suggestedOutcome: 'completed', secret: 'SECRET' }],
    diagnostics: [{ code: 'invalid_json', message: 'SECRET', location: '$.SECRET' }, { code: 'SECRET', location: '$.nodes[0]', message: 'SECRET' }] };
  const result = safeLangConfigPreview(input);
  assert.ok(result);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(result.diagnostics[0]?.location, '$');
  assert.equal(safeLangConfigPreview({ ...input, nodes: [{ id: 'SECRET' }] }), null);
  assert.equal(safeLangConfigPreview({ ...input, edges: [{ from: 'node-0', to: 'node-3' }] }), null);
  assert.equal(safeLangConfigPreview({ ...input, executable: true }), null);
});

test('preview transport sends the unwrapped JSON text only to the preview endpoint', async () => {
  let observed: unknown[] = [];
  setApiTransport(async (...args) => { observed = args; return { status: 400, body: { diagnostics: [] } }; });
  const raw = '{"x":1,"x":2}';
  const response = await requestLangConfigPreview(raw);
  assert.deepEqual(observed, ['/api/langconfig/preview', 'POST', raw]);
  assert.equal(response.status, 400);
});
