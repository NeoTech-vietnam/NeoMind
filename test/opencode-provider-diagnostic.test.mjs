import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOpenCodeProviderFailure, boundOpenCodeProviderFailure, transientOpenCodeProviderFailure } from '../dist/opencode-provider-diagnostic.js';

const identity = { session_id: 'ses_current', user_message_id: 'msg_user', assistant_message_id: 'msg_assistant' };
const receipt = observation => ({ issuer: 'workforce-opencode', execution_mode: 'opencode-local', state: 'blocked', inference_completed: false,
  native_thread_id: identity.session_id, native_turn_id: identity.user_message_id,
  opencode: { response_message_id: identity.assistant_message_id, provider_failure: observation } });

test('canonical SDK provider metadata uses fixed diagnostics, observed fields and exact message identities only', () => {
  const secret = 'PRIVATE_PROVIDER_PAYLOAD';
  const result = canonicalOpenCodeProviderFailure({ name: 'APIError', data: { statusCode: 503, isRetryable: true,
    message: `[429] The usage limit has been reached. ${secret}`, responseBody: secret, responseHeaders: { authorization: secret } } }, identity);
  assert.deepEqual(result.observation, { schema_version: 1, code: 'RATE_LIMITED', status_code: 503, retryable: true, ...identity });
  assert.match(result.message, /^RATE_LIMITED:/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(transientOpenCodeProviderFailure(result.observation), true);
  assert.deepEqual(boundOpenCodeProviderFailure(receipt(result.observation)), result.observation);
  const unknown = canonicalOpenCodeProviderFailure({ data: { message: secret } }, identity);
  assert.deepEqual(unknown.observation, { schema_version: 1, code: 'PROVIDER_ERROR', ...identity });
  assert.equal(Object.values(unknown.observation).includes(undefined), false);
  assert.equal(JSON.stringify(unknown).includes(secret), false);
  assert.equal(JSON.stringify(canonicalOpenCodeProviderFailure({}, { ...identity, token: secret })).includes(secret), false);
});

test('request schema, context, unknown and nonretryable errors cannot authorize a healthy-provider retry loop', () => {
  for (const [error, code] of [
    [{ data: { statusCode: 400, isRetryable: false, message: 'Invalid tool JSON schema PRIVATE_SCHEMA' } }, 'PROVIDER_REQUEST_REJECTED'],
    [{ data: { statusCode: 503, isRetryable: false, message: 'PRIVATE_NONRETRYABLE' } }, 'PROVIDER_UNAVAILABLE'],
    [{ data: { isRetryable: false, message: 'PRIVATE_UNKNOWN' } }, 'PROVIDER_ERROR'],
    [{ data: { statusCode: 400, isRetryable: true, message: 'service_unavailable' } }, 'PROVIDER_UNAVAILABLE'],
    [{ data: { statusCode: 400, isRetryable: true, message: 'context_length_exceeded' } }, 'CONTEXT_LIMIT_EXCEEDED'],
    [{ data: { statusCode: 401, isRetryable: true, message: 'PRIVATE_AUTH' } }, 'AUTHENTICATION_REQUIRED'],
  ]) {
    const result = canonicalOpenCodeProviderFailure(error, identity);
    assert.equal(result.observation.code, code); assert.equal(transientOpenCodeProviderFailure(result.observation), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
  const malformed = canonicalOpenCodeProviderFailure({ data: { statusCode: '503', isRetryable: 'true' } }, identity);
  assert.deepEqual(malformed.observation, { schema_version: 1, code: 'PROVIDER_ERROR', ...identity });
  assert.equal(transientOpenCodeProviderFailure(malformed.observation), false);
});

test('typed error observations cannot cross the authenticated native session or downgrade to error prose', () => {
  const observation = canonicalOpenCodeProviderFailure({ data: { statusCode: 503, isRetryable: true } }, identity).observation;
  for (const changed of [
    { native_thread_id: 'ses_other' }, { native_turn_id: 'msg_other' }, { issuer: 'neomind-vscode-lm' },
    { execution_mode: 'protocol-fixture' }, { state: 'completed' }, { inference_completed: true },
    { opencode: { response_message_id: 'msg_other', provider_failure: observation } },
    { opencode: { response_message_id: identity.assistant_message_id, provider_failure: { ...observation, code: 'PRIVATE_CODE' } } },
    { opencode: { response_message_id: identity.assistant_message_id, provider_failure: { ...observation, responseBody: 'PRIVATE_BODY' } } },
    { opencode: { response_message_id: identity.assistant_message_id, provider_failure: { ...observation, retryable: 'true' } } },
  ]) assert.equal(boundOpenCodeProviderFailure({ ...receipt(observation), error: 'OPENCODE_PROVIDER_UNAVAILABLE:', ...changed }), undefined);
  assert.throws(() => canonicalOpenCodeProviderFailure({}, { ...identity, assistant_message_id: identity.user_message_id }), /identity/);
  assert.throws(() => canonicalOpenCodeProviderFailure({}, { ...identity, session_id: 'PRIVATE_PATH' }), /identity/);
  const hostile = { get data() { throw new Error('PRIVATE_GETTER'); } };
  assert.doesNotThrow(() => canonicalOpenCodeProviderFailure(hostile, identity));
});
