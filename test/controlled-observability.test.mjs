import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledModelInput, controlledValidation, controlledResultFailure, redactControlledValue, ControlledFailureLoop } from '../dist/controlled-observability.js';

test('semantic tracing keeps actionable plans and reports but redacts bounded nested credentials and file bodies', () => {
  const input = { title: 'Bounded LeetCode generator', allowed_paths: ['scripts/generate.mjs'],
    checks: [{ command: ['node', 'checks/verify.mjs', '--api-key', 'SECRET_POSITIONAL'],
      negative_controls: [{ title: 'Reject wrong result', command: ['node', 'checks/verify.mjs', '--negative-control', 'wrong-value'] }] }],
    reuse: { parameters: { apiKey: 'SECRET_KEY', nested: { password: 'SECRET_PASSWORD', authorization: 'Bearer SECRET_AUTHORIZATION' } } },
    rationale: 'Request with Bearer SECRET_BEARER and password=SECRET_INLINE; https://endpoint.invalid/path?api_key=SECRET_QUERY',
    content: 'SECRET_FILE_BODY', privateKey: 'SECRET_PRIVATE_KEY',
    examples: [{ file_content: ['SECRET_ARRAY_FILE_BODY'] }],
    quoted: 'password="FIRST_SECRET SECOND_SECRET"', basicLine: 'Authorization: Basic SECRET_BASE64',
    encoded: JSON.stringify(JSON.stringify({ api_key: 'SECRET_ENCODED_JSON' })) };
  const trace = controlledModelInput('workflow_plan', input), encoded = JSON.stringify(trace);
  assert.match(encoded, /Bounded LeetCode generator|scripts\/generate.mjs/);
  assert.match(encoded, /negative-control|wrong-value/);
  assert.doesNotMatch(encoded, /SECRET_/);
  assert.doesNotMatch(encoded, /FIRST_SECRET|SECOND_SECRET/);
  assert.match(encoded, /content_sha256/); assert.match(trace.input_sha256, /^[a-f0-9]{64}$/);
  const report = controlledModelInput('assignment_report', { outcome: 'failed', summary: 'Oracle rejected boundary input.', findings: ['Wrong result on empty list.'] });
  assert.match(JSON.stringify(report), /Wrong result on empty list/);
  const file = controlledModelInput('task_file_write', { path: 'scripts/generate.mjs', content: 'SECRET_BODY' });
  assert.equal(file.bytes, 11); assert.doesNotMatch(JSON.stringify(file), /SECRET_BODY/);
  const cyclic = { deep: [] }; cyclic.deep.push(cyclic);
  assert.match(JSON.stringify(redactControlledValue(cyclic)), /cycle/);
  assert.ok(JSON.stringify(redactControlledValue({ values: Array.from({ length: 1000 }, () => 'x'.repeat(10000)) })).length < 30000);
});

test('validation traces contain the actual redacted rule and static repair ownership', () => {
  const actual = controlledValidation('PLAN_INVALID', 'Checker must be disjoint from implementation. password=SECRET_TOKEN');
  assert.equal(actual.owner, 'agent-content'); assert.equal(actual.rule_id, 'controlled.plan_invalid');
  assert.match(actual.rule, /disjoint/); assert.doesNotMatch(JSON.stringify(actual), /SECRET_TOKEN/);
  const backend = controlledValidation('STATE_UNCERTAIN', 'Preserve the current journal and reconcile the file intent.');
  assert.equal(backend.owner, 'runtime');
  const unknown = controlledValidation('SECRET_UNKNOWN_CODE', 'SECRET_UNKNOWN_PAYLOAD');
  assert.doesNotMatch(JSON.stringify(unknown), /SECRET_/);
  const schema = controlledResultFailure({ isError: true, content: [{ type: 'text', text: 'Input validation error: ' + JSON.stringify([
    { code: 'invalid_type', path: ['checks', 0, 'command'], message: 'SECRET_ERROR_TEXT', received: 'SECRET_VALUE' },
  ]) }] });
  assert.equal(schema.code, 'SCHEMA_INVALID'); assert.match(schema.rule, /invalid_type|checks|command/);
  assert.doesNotMatch(JSON.stringify(schema), /SECRET_/);
});

test('loop guard refuses only a third identical failure in unchanged state, allowing corrected work', () => {
  const fail = rule => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'PLAN_INVALID', error: rule }) }] });
  const guard = new ControlledFailureLoop(), args = { title: 'same', outputs: ['a'] };
  guard.observe('workflow_plan', args, fail('disjoint paths'), 'state-1');
  assert.equal(guard.blocked('workflow_plan', args, 'state-1'), false);
  guard.observe('workflow_plan', { outputs: ['a'], title: 'same' }, fail('disjoint paths'), 'state-1');
  assert.equal(guard.blocked('workflow_plan', args, 'state-1'), true);
  assert.equal(guard.blocked('workflow_plan', { ...args, outputs: ['b'] }, 'state-1'), false);
  assert.equal(guard.blocked('workflow_plan', args, 'state-2'), false);
  guard.observe('workflow_plan', args, fail('different validation'), 'state-1');
  assert.equal(guard.blocked('workflow_plan', args, 'state-1'), false);
  guard.observe('workflow_plan', args, { content: [{ type: 'text', text: '{"saved":true}' }] }, 'state-1');
  assert.equal(guard.blocked('workflow_plan', args, 'state-1'), false);
});
