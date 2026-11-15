import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FixtureRunnerFactory } from './runner.mjs';
import { requireDataRoot } from './runtime_paths.mjs';

const code = path.dirname(fileURLToPath(import.meta.url));
const root = requireDataRoot();
const neomind = path.resolve(process.env.NEOMIND_ROOT ?? path.join(code, '../../..'));
const { RunnerRegistry, assertSessionBound } = await import(pathToFileURL(path.join(neomind, 'dist/src/runners/registry.js')));
const workspace = path.join(root, 'runner-fixture');
await mkdir(workspace, { recursive: true });
const factory = new FixtureRunnerFactory();
const registry = new RunnerRegistry([factory]);
assert.equal(registry.get('opencode'), factory);
assert.deepEqual(await factory.verifyCapabilities('disabled'), { sandboxVerified: false, stopVerified: true });
const runner = await factory.start(workspace, 'disabled');
const binding = { runner: 'opencode', provider: 'fixture', model: 'fake-review', reasoning: 'high' };
try {
  const session = await runner.openSession({ workspace, binding, access: { kind: 'read' }, webAccess: false });
  assertSessionBound(session, binding, workspace);
  await runner.verifyNoDelegation(session);
  const outputSchema = { type: 'object', properties: { verdict: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, path: { type: 'string' } }, required: ['description', 'path'], additionalProperties: false } }, summary: { type: 'string' } }, required: ['verdict', 'findings', 'summary'], additionalProperties: false };
  const turn = await runner.startTurn(session, { prompt: 'Review synthetic fixture: Alder, retention 30 days.', effort: 'high', outputSchema });
  const result = await runner.waitForTurn(session, turn, () => false);
  assert.equal(result.status, 'completed');
  assert.equal(JSON.parse(result.messages[0]).verdict, 'needs_changes');
  assert.equal(await runner.scope.isActive(), false);
  console.log('PASS NeoMind RunnerRegistry -> experimental factory -> scoped private OpenCode -> fake upstream -> real TurnResult');
  console.log('PASS structured schema validation; sandboxVerified=false; systemd scope stop confirmed');
} finally {
  if (await runner.scope.isActive()) assert.equal(await runner.close(), true);
}
