import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let text = ''; for await (const part of process.stdin) text += part;
const { parameters, outputs } = JSON.parse(text), inventory = JSON.parse(readFileSync(outputs[0], 'utf8'));
assert.equal(inventory.schema_version, 1); assert.equal(inventory.artifacts.length, 3);
assert.deepEqual(inventory.artifacts.map(item => item.kind), ['note', 'practice', 'answers']);
for (const item of inventory.artifacts) {
  assert.equal(item.path, parameters[item.kind]);
  const bytes = readFileSync(item.path);
  if (parameters.include_bytes) assert.equal(item.bytes, bytes.length);
  else assert.equal(Object.hasOwn(item, 'bytes'), false);
  assert.ok(bytes.length > 0);
  assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
}
