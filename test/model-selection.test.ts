import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAvailableBinding } from '../src/runtime/model-selection.js';
import type { ResolvedBinding } from '../src/domain/resolve.js';
const binding: ResolvedBinding = { values: { runner: 'codex', provider: 'openai', model: 'gpt-6.1-sol', reasoning: 'high' },
  sources: { runner: 'project', provider: 'project', model: 'project', reasoning: 'project' }, fallback: [] };
const models = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low'] }];
test('model selection only uses explicitly allowed and available model/effort pairs', () => {
  assert.throws(() => selectAvailableBinding(binding, models), /danh sách thay thế/);
  const fallback = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  assert.deepEqual(selectAvailableBinding({ ...binding, fallback: [fallback] }, models), { values: fallback, fallback: true });
  assert.throws(() => selectAvailableBinding({ ...binding, fallback: [{ ...fallback, reasoning: 'ultra' }] }, models), /khả dụng/);
  assert.equal(selectAvailableBinding({ ...binding, values: fallback }, models).fallback, false);
  // A model is available only from the runner (and provider) that reported it.
  assert.throws(() => selectAvailableBinding({ ...binding, values: { ...fallback, runner: 'claude-code' } }, models), /khả dụng/);
  const claude = { runner: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium' };
  assert.deepEqual(selectAvailableBinding({ ...binding, fallback: [claude] }, [...models, { runner: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: ['low', 'medium', 'high'] }]), { values: claude, fallback: true });
});
