import test from 'node:test';
import assert from 'node:assert/strict';
import { vscodeProviderDiagnostic } from '../dist/vscode-provider-diagnostic.js';

test('provider diagnostics classify bounded structured and escaped error metadata with fixed output', () => {
  const secret = 'PRIVATE_ENDPOINT_CREDENTIAL';
  const cases = [
    [{ error: { code: 'model_not_supported', message: secret }, status: 400 }, 'MODEL_NOT_SUPPORTED'],
    [new Error(`HTTP 400: ${JSON.stringify(JSON.stringify({ error: { code: 'model_not_supported', message: secret } }))}`), 'MODEL_NOT_SUPPORTED'],
    [{ cause: { response: { data: { error: { code: 'model_not_found', message: secret } } } } }, 'MODEL_NOT_FOUND'],
    [{ code: 'invalid_api_key', message: secret }, 'AUTHENTICATION_REQUIRED'],
    [{ response: { status: 401, body: secret } }, 'AUTHENTICATION_REQUIRED'],
    [new Error(`HTTP 403: ${secret}`), 'AUTHORIZATION_DENIED'],
    [{ cause: { code: 'rate_limit_exceeded' }, message: secret }, 'RATE_LIMITED'],
    [{ statusCode: 429, message: secret }, 'RATE_LIMITED'],
    [{ error: { code: 'context_length_exceeded', message: secret } }, 'CONTEXT_LIMIT_EXCEEDED'],
    [{ code: 'tool_calling_not_supported', message: secret }, 'TOOL_CALLING_UNSUPPORTED'],
    [new Error(`HTTP 503: ${secret}`), 'PROVIDER_UNAVAILABLE'],
  ];
  for (const [error, code] of cases) {
    const diagnostic = vscodeProviderDiagnostic(error);
    assert.equal(diagnostic?.code, code);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }
  const unsupported = vscodeProviderDiagnostic(new Error('model_not_supported'));
  assert.match(unsupported.message, /9router alias.*upstream model target/);
  assert.match(unsupported.message, /No substitute model was selected/);
});

test('unknown, hostile and cyclic provider errors do not become raw persisted diagnostics', () => {
  const cyclic = { message: 'PRIVATE_UNKNOWN_PROVIDER_TEXT' }; cyclic.cause = cyclic;
  for (const error of [null, cyclic, new Error('PRIVATE_UNKNOWN_PROVIDER_TEXT'), { code: 'PRIVATE_UNKNOWN_PROVIDER_CODE' },
    { get message() { throw new Error('PRIVATE_GETTER_FAILURE'); } }]) assert.equal(vscodeProviderDiagnostic(error), undefined);
  assert.equal(vscodeProviderDiagnostic({ message: 'x'.repeat(100000) + 'model_not_supported' }), undefined);
});
