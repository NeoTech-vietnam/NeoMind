import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAvailableBinding } from '../src/runtime/model-selection.js';
import type { ResolvedBinding } from '../src/domain/resolve.js';
const binding: ResolvedBinding = { values: { runner: 'codex', provider: 'openai', model: 'gpt-6.1-sol', reasoning: 'high' },
  sources: { runner: 'project', provider: 'project', model: 'project', reasoning: 'project' }, fallback: [] };
const models = [{ id: 'luna', model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
test('model selection only uses explicitly allowed and available model/effort pairs', () => {
  assert.throws(() => selectAvailableBinding(binding, models), /danh sách thay thế/);
  const fallback = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  assert.deepEqual(selectAvailableBinding({ ...binding, fallback: [fallback] }, models), { values: fallback, fallback: true });
  assert.throws(() => selectAvailableBinding({ ...binding, fallback: [{ ...fallback, reasoning: 'ultra' }] }, models), /khả dụng/);
  assert.equal(selectAvailableBinding({ ...binding, values: fallback }, models).fallback, false);
});
