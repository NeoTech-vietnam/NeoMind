import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
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
  const generated = controlledValidation('GENERATED_ARTIFACT', 'Use the bound Cornell compiler for its managed artifacts.');
  assert.equal(generated.code, 'GENERATED_ARTIFACT'); assert.equal(generated.owner, 'agent-content');
  assert.match(generated.rule, /bound Cornell compiler/);
});

test('canonical producer schema feedback names execution_steps and output_paths while masking unknown or sensitive fields', () => {
  const issues = [
    { code: 'invalid_type', expected: 'array', path: ['execution_steps', 0, 'output_paths'], message: 'SECRET_INVALID_VALUE' },
    { code: 'invalid_type', expected: 'array', path: ['execution_steps', 0, 'command'], message: 'SECRET_INVALID_VALUE' },
    { code: 'invalid_type', expected: 'string', path: ['execution_steps', 0, 'api_key'], message: 'SECRET_INVALID_VALUE' },
    { code: 'invalid_type', expected: 'string', path: ['execution_steps', 0, 'private_customer_name'], message: 'SECRET_INVALID_VALUE' },
  ];
  const result = controlledValidation('SCHEMA_INVALID', undefined, issues);
  assert.deepEqual(result.issues[0].path, ['execution_steps', 0, 'output_paths']);
  assert.deepEqual(result.issues[1].path, ['execution_steps', 0, 'command']);
  assert.deepEqual(result.issues[2].path, ['execution_steps', 0, '[redacted-field]']);
  assert.deepEqual(result.issues[3].path, ['execution_steps', 0, '[field]']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|api_key|private_customer_name/);
});

test('actual SDK flat schema diagnostics become safe structured trace issues without changing the model result', async t => {
  const server = new McpServer({ name: 'actual-schema-diagnostics', version: '1' }),
    client = new Client({ name: 'schema-diagnostics-client', version: '1' });
  let called = 0;
  server.registerTool('research', { inputSchema: z.strictObject({
    sources: z.array(z.strictObject({ title: z.string().min(8) })),
    practice: z.strictObject({ command: z.array(z.string()).optional(), procedure: z.array(z.string()).optional() })
      .refine(value => Boolean(value.command || value.procedure), 'SECRET_CUSTOM_MESSAGE'),
  }) }, () => { called++; return { content: [{ type: 'text', text: '{}' }] }; });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'research', arguments: {
    sources: [{ title: 123 }], practice: {}, api_key: 'SECRET_INPUT_VALUE',
  } });
  assert.equal(result.isError, true); assert.equal(called, 0);
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes(' at sources[0].title')),
    'Use the installed SDK formatter rather than fabricating its schema error shape.');
  const original = JSON.stringify(result), failure = controlledResultFailure(result);
  assert.ok(Array.isArray(failure.issues), 'Human traces must retain safe field-level SDK validation issues.');
  assert.equal(failure.owner, 'agent-content'); assert.equal(failure.rule_id, 'controlled.schema_invalid');
  assert.ok(failure.issues.some(issue => issue.code === 'invalid_type' && JSON.stringify(issue.path) === '["sources",0,"title"]'));
  assert.ok(failure.issues.some(issue => issue.code === 'custom' && JSON.stringify(issue.path) === '["practice"]'));
  assert.ok(failure.issues.every(issue => typeof issue.message === 'string' && issue.message.length > 0));
  assert.doesNotMatch(JSON.stringify(failure), /SECRET_|api_key/);
  assert.equal(JSON.stringify(result), original, 'The raw SDK tool result delivered to the model is neither wrapped nor changed.');
});

test('schema issue projections bound paths and hide values, custom text, unknown field names and credential names', () => {
  const flat = controlledResultFailure({ isError: true, content: [{ type: 'text', text:
    'Input validation error: Invalid arguments for tool research: Invalid input: expected string, received SECRET_VALUE at sources[1].title\n' +
    'SECRET_CUSTOM_MESSAGE at private_customer_name\n' +
    'Invalid input: expected string, received undefined at api_key\n' +
    'Unrecognized key: "SECRET_EXTRA_FIELD"' }] });
  assert.ok(flat.issues.some(issue => JSON.stringify(issue.path) === '["sources",1,"title"]'));
  assert.doesNotMatch(JSON.stringify(flat), /SECRET_|private_customer_name|api_key/);
  const nested = controlledResultFailure({ isError: true, content: [{ type: 'text', text: 'Input validation error: ' + JSON.stringify(
    Array.from({ length: 30 }, (_, index) => ({ code: index ? 'custom' : 'invalid_type', expected: 'string',
      path: ['sources', index, 'title', 'api_key', 'SECRET_FIELD', 'command', 'practice', 'procedure', 'too_deep'],
      message: 'SECRET_CUSTOM_MESSAGE', input: 'SECRET_INPUT_VALUE', keys: ['SECRET_EXTRA_FIELD'] }))) }] });
  assert.equal(nested.issues.length, 8);
  assert.ok(nested.issues.every(issue => issue.path.length <= 8));
  assert.doesNotMatch(JSON.stringify(nested), /SECRET_|api_key|too_deep/);
  assert.ok(JSON.stringify(nested).length < 8000);
  const direct = controlledValidation('SCHEMA_INVALID', 'SECRET_RAW_SCHEMA_ERROR');
  assert.doesNotMatch(JSON.stringify(direct), /SECRET_/);
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
