import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalMatches, recordApproval } from '../src/domain/approval.js';
import { defaultProject } from '../src/domain/templates.js';
import { checkCapabilities, selectFallback, type CapabilityReport, type Requirements } from '../src/adapters/preflight.js';

const plan = { planId: 'plan1', version: 1, goal: 'Fix the defect', scope: ['src/a.ts'], approach: 'Correct the condition',
  acceptanceCriteria: ['Existing and new checks pass'], checks: ['npm test'], riskChanges: [] };
const action = { approvalId: 'approval1', actor: 'local-user', source: 'ui' as const,
  decision: 'approved' as const, timestamp: '2026-10-28T00:00:00Z' };

test('approval binds plan, scope, version and live policy; agent output is not an approval source', () => {
  const record = recordApproval(plan, defaultProject.policy, action);
  assert.equal(approvalMatches(record, plan, defaultProject.policy), true);
  assert.equal(approvalMatches(record, { ...plan, scope: ['src/b.ts'] }, defaultProject.policy), false);
  assert.equal(approvalMatches(record, { ...plan, version: 2 }, defaultProject.policy), false);
  assert.equal(approvalMatches(record, { ...plan, goal: 'Different goal' }, defaultProject.policy), false);
  assert.equal(approvalMatches(record, plan, { ...defaultProject.policy, allowGitCommit: false }), false);
  assert.equal(approvalMatches({ ...record, decision: 'rejected' }, plan, defaultProject.policy), false);
  assert.equal(approvalMatches({ ...record, source: 'agent' }, plan, defaultProject.policy), false);
});

const binding = { runner: 'runner-a', provider: 'provider-a', model: 'model-a', reasoning: 'high' };
const requirements: Requirements = { requireDelegationEnforcement: true, allowInstructionsOnly: false,
  requireStopConfirmation: true, requireWorkspaceWriteScope: true };
const report: CapabilityReport = { runner: 'runner-a', version: '1.0', auth: 'ready',
  models: [{ provider: 'provider-a', id: 'model-a', reasoning: ['low', 'high'] }],
  delegation: 'supported_verified', stopConfirmation: 'supported_verified', workspaceWriteScope: 'supported_verified' };

test('preflight blocks unknown or unsupported requirements and never assumes instructions-only enforcement', () => {
  assert.equal(checkCapabilities(binding, report, requirements).ok, true);
  const missing = checkCapabilities(binding, { ...report, auth: 'unknown', delegation: 'instructions_only',
    stopConfirmation: 'unknown', workspaceWriteScope: 'unsupported' }, requirements);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.blockers, ['auth_unknown', 'delegation_instructions_only', 'stop_unknown', 'workspace_scope_unsupported']);
  const explicitlyAllowed = checkCapabilities(binding, { ...report, delegation: 'instructions_only' }, { ...requirements, allowInstructionsOnly: true });
  assert.equal(explicitlyAllowed.ok, true);
  assert.deepEqual(explicitlyAllowed.warnings, ['delegation_instructions_only']);
  assert.ok(checkCapabilities({ ...binding, reasoning: 'max' }, report, requirements).blockers.includes('reasoning_unavailable'));
});

test('fallback is allowlisted, ordered, capability-checked and blocked for unknown effects or auth errors', () => {
  const first = { ...binding, model: 'missing' };
  const result = selectFallback('binding_unavailable', [first, binding], [report], requirements);
  assert.deepEqual(result, { selected: binding, reason: 'binding_unavailable', index: 1 });
  assert.deepEqual(selectFallback('effect_unknown', [binding], [report], requirements), { selected: null, reason: 'effect_unknown' });
  assert.deepEqual(selectFallback('auth_unavailable', [binding], [report], requirements), { selected: null, reason: 'auth_unavailable' });
  assert.deepEqual(selectFallback('binding_unavailable', [first], [report], requirements), { selected: null, reason: 'no_allowed_binding_available' });
});
