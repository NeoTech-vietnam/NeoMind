import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledExecutionPublicText } from '../dist/controlled-execution-evidence.js';

test('producer stdout uses the same private-path policy as worker tools without reading mentioned paths', () => {
  const paths = ['.neomind/controlled/private.json', '.codex/config.toml', '.cursor/settings.json', 'node_modules/pkg/index.js',
    '.env', '.env.local', 'private/credentials.json', 'auth.json', 'private/secrets.json', 'private/tls.key', 'private/cert.pem',
    '.agents/private/input.json', 'C:\\Users\\Private Name\\settings\\.env', 'D:\\private\\credentials.json'];
  for (const path of paths) {
    const result = controlledExecutionPublicText(`Observed \"${path}\" and src/product.mjs`, 8000);
    assert.ok(result.includes('[private path]'), path);
    assert.ok(!result.includes(path), path);
    assert.ok(result.includes('src/product.mjs'), 'Public product paths remain useful evidence.');
  }
  const unquoted = controlledExecutionPublicText('paths: .env.local .cursor/config.json node_modules/pkg/index.js private/key.pem.', 8000);
  for (const path of ['.env.local', '.cursor/', 'node_modules/', 'key.pem']) assert.equal(unquoted.includes(path), false, path);
});

test('producer JSON observations remain readable after credential and private path redaction', () => {
  const text = controlledExecutionPublicText(JSON.stringify({ observed: 42, api_key: 'SECRET_CREDENTIAL', config: '.env.local', output: 'results/value.json' }), 8000);
  assert.notEqual(text, '[object Object]');
  const result = JSON.parse(text);
  assert.equal(result.observed, 42); assert.equal(result.output, 'results/value.json');
  assert.equal(result.config, '[private path]');
  assert.equal(text.includes('SECRET_CREDENTIAL'), false);
});

test('producer log truncation preserves the actual final tail instead of an earlier portion', () => {
  const text = controlledExecutionPublicText('OLD_PREFIX'.repeat(1000) + '\nFINAL_RESULT_OK', 8000);
  assert.ok(text.endsWith('FINAL_RESULT_OK'));
  assert.ok(text.startsWith('[truncated to final log tail]'));
  assert.ok(text.length <= 8000);
  assert.equal(controlledExecutionPublicText(undefined, 8000), '');
});
