import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledFailure } from '../dist/controlled-failure.js';

test('unexpected runtime diagnostics identify the code boundary without copying secrets or machine paths', () => {
  const error = new Error('Bearer PRIVATE_TOKEN secret=PRIVATE_TOKEN D:\\private\\file');
  error.stack = `${error.message}\n at operation (file:///D:/workspace/NeoMind/dist/native.js:132:25)\n at PRIVATE_TOKEN (/secret/PRIVATE_TOKEN:1:2)`;
  const result = controlledFailure(error);
  assert.equal(result.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.equal(result.owner, 'runtime');
  assert.deepEqual(result.frames, [{ module: 'native.js', line: 132, column: 25 }]);
  assert.match(result.message_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|D:|Bearer|secret=/);
});

test('signing and filesystem failures have actionable safe classifications', () => {
  const signing = Object.assign(new Error('private'), { code: 'NATIVE_SIGNING_HISTORY_REQUIRES_TRUST' });
  const result = controlledFailure(signing);
  assert.equal(result.kind, 'protocol');
  assert.match(result.next_action, /historical receipts/);
  assert.doesNotMatch(result.next_action, /claim_token/);
  assert.equal(controlledFailure(Object.assign(new Error('private'), { code: 'EACCES' })).kind, 'environment');
  assert.equal(controlledFailure(Object.assign(new Error(), { code: 'Bearer PRIVATE' })).code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.equal(controlledFailure(Object.assign(new Error(), { code: 'PRIVATE_PROVIDER_TOKEN' })).code, 'UNEXPECTED_RUNTIME_FAILURE');
});
