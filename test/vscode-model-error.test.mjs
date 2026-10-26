import test from 'node:test';
import assert from 'node:assert/strict';
import { vscodeModelErrorDiagnostic } from '../dist/vscode-host.js';

test('SDK diagnostics distinguish fixed builtin Error, AbortError and known nested network codes', () => {
  assert.deepEqual(vscodeModelErrorDiagnostic(new Error('SECRET')), { error_class: 'Error', cause_class: null, transport_code: null });
  const error = Object.assign(new Error('SECRET_OUTER'), { cause: { name: 'AbortError', code: 'ETIMEDOUT', message: 'SECRET_INNER' } });
  assert.deepEqual(vscodeModelErrorDiagnostic(error), { error_class: 'Error', cause_class: 'AbortError', transport_code: 'ETIMEDOUT' });
  assert.deepEqual(vscodeModelErrorDiagnostic({ name: 'AbortError', code: 'UND_ERR_ABORTED' }),
    { error_class: 'AbortError', cause_class: null, transport_code: 'UND_ERR_ABORTED' });
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
    assert.equal(vscodeModelErrorDiagnostic({ code }).transport_code, code);
});

test('SDK diagnostics never retain arbitrary names, codes, messages, URLs, headers or causes', () => {
  let secretReads = 0;
  const hostile = { name: 'SECRET_CLASS', code: 'UND_ERR_SECRET_TOKEN', cause: { name: 'SECRET_CAUSE', code: 'SECRET_CODE' },
    get message() { secretReads++; throw new Error('SECRET_MESSAGE'); }, get stack() { secretReads++; throw new Error('SECRET_STACK'); },
    get headers() { secretReads++; throw new Error('SECRET_HEADER'); }, get body() { secretReads++; throw new Error('SECRET_BODY'); } };
  assert.deepEqual(vscodeModelErrorDiagnostic(hostile), { error_class: 'unclassified error', cause_class: null, transport_code: null });
  assert.equal(secretReads, 0);
  assert.doesNotMatch(JSON.stringify(vscodeModelErrorDiagnostic(hostile)), /SECRET|https?:/);
  assert.deepEqual(vscodeModelErrorDiagnostic('SECRET_STRING_ERROR'), { error_class: 'unclassified error', cause_class: null, transport_code: null });
});

test('SDK diagnostic traversal is bounded and handles cycles and throwing metadata getters', () => {
  const cycle = { name: 'Error' }; cycle.cause = cycle;
  assert.deepEqual(vscodeModelErrorDiagnostic(cycle), { error_class: 'Error', cause_class: null, transport_code: null });
  const throwing = { get name() { throw new Error('SECRET'); }, get code() { throw new Error('SECRET'); }, get cause() { throw new Error('SECRET'); } };
  assert.deepEqual(vscodeModelErrorDiagnostic(throwing), { error_class: 'unclassified error', cause_class: null, transport_code: null });
  let deep = { code: 'ECONNRESET' }; for (let i = 0; i < 8; i++) deep = { cause: deep };
  assert.equal(vscodeModelErrorDiagnostic(deep).transport_code, null);
});
