import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileFlow } from '../src/domain/compiler.js';
import { flowJsonSchema, flowSchema } from '../src/domain/schema.js';
import { hashJson, resolveBinding, snapshotConfiguration } from '../src/domain/resolve.js';
import { defaultProject, templates } from '../src/domain/templates.js';
import { FakeAdapter } from '../src/adapters/fake.js';

const diagnosticCodes = (flow: unknown) => {
  const result = compileFlow(flow, defaultProject.policy);
  return result.ok ? [] : result.diagnostics.map(d => d.code);
};

test('all built-in templates round-trip and compile under the default policy', () => {
  for (const template of Object.values(templates)) {
    const roundTrip: unknown = JSON.parse(JSON.stringify(template));
    assert.deepEqual(flowSchema.parse(roundTrip), template);
    const result = compileFlow(roundTrip, defaultProject.policy);
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.diagnostics));
  }
});

test('rejects unsupported schema versions and unknown executable fields', () => {
  const data: Record<string, unknown> = JSON.parse(JSON.stringify(templates.dev));
  data.schemaVersion = 2;
  assert.ok(diagnosticCodes(data).includes('schema'));
  data.schemaVersion = 1;
  (data.definition as Record<string, unknown>).typoLimits = {};
  assert.ok(diagnosticCodes(data).includes('schema'));
});

test('approval and independent review cannot be bypassed by alternative edges', () => {
  const bypassApproval = structuredClone(templates.dev);
  bypassApproval.definition.edges.push({ from: 'plan', to: 'implement', outcome: 'completed' });
  assert.ok(diagnosticCodes(bypassApproval).includes('approval_bypass'));
  const deniedApproval = structuredClone(templates.dev);
  deniedApproval.definition.edges.find(e => e.from === 'approval')!.outcome = 'blocked';
  assert.ok(diagnosticCodes(deniedApproval).includes('approval_bypass'));
  const failedReview = structuredClone(templates.dev);
  failedReview.definition.edges.find(e => e.from === 'verify')!.outcome = 'needs_changes';
  assert.ok(diagnosticCodes(failedReview).includes('review_bypass'));
  const bypassReview = structuredClone(templates.dev);
  bypassReview.definition.edges.push({ from: 'implement', to: 'commit', outcome: 'completed' });
  assert.ok(diagnosticCodes(bypassReview).includes('review_bypass'));
  const finishWithoutReview = structuredClone(templates.dev);
  finishWithoutReview.definition.edges.push({ from: 'implement', to: 'finish', outcome: 'completed' });
  assert.ok(diagnosticCodes(finishWithoutReview).includes('review_bypass'));
});

test('review must target an upstream latest writer in a different session', () => {
  const flow = structuredClone(templates.dev);
  const review = flow.definition.nodes.find(n => n.type === 'review_group')!;
  if (review.type !== 'review_group') throw new Error('bad fixture');
  review.targetNodeId = 'plan';
  assert.ok(diagnosticCodes(flow).includes('review_bypass'));
  review.targetNodeId = 'implement';
  review.reviewers[0]!.sessionGroup = 'implementation-session';
  assert.ok(diagnosticCodes(flow).includes('non_independent_review'));
});

test('rejects cycles, invalid write paths and over-budget repair scopes', () => {
  const flow = structuredClone(templates.dev);
  flow.definition.edges.push({ from: 'verify', to: 'implement', outcome: 'needs_changes' });
  assert.ok(diagnosticCodes(flow).includes('cycle'));
  const writer = flow.definition.nodes.find(n => n.type === 'agent_task' && n.permissions.write)!;
  if (writer.type !== 'agent_task') throw new Error('bad fixture');
  for (const scope of ['../secret', 'C:/outside', '\\server\\share']) {
    writer.writeScopes = [scope];
    assert.ok(diagnosticCodes(flow).includes('invalid_write_scope'), scope);
  }
  const repair = flow.definition.nodes.find(n => n.type === 'repair_scope')!;
  if (repair.type !== 'repair_scope') throw new Error('bad fixture');
  repair.maxRounds = 3;
  assert.ok(diagnosticCodes(flow).includes('repair_limit'));
});

test('binding precedence, provenance and immutable snapshot are explicit', () => {
  const inherit = { mode: 'inherit' } as const;
  const step = { runner: inherit, provider: inherit, model: { mode: 'pinned' as const, value: 'step-model' }, reasoning: inherit, fallback: [] };
  const flow = { ...step, model: inherit, reasoning: { mode: 'pinned' as const, value: 'high' } };
  const project = { runner: 'codex', provider: 'example', model: 'project-model', reasoning: 'low' };
  const resolved = resolveBinding(step, flow, project, { provider: 'run-provider' });
  assert.deepEqual(resolved.values, { runner: 'codex', provider: 'run-provider', model: 'step-model', reasoning: 'high' });
  assert.deepEqual(resolved.sources, { runner: 'project', provider: 'run', model: 'step', reasoning: 'flow' });
  assert.throws(() => resolveBinding(step, undefined, undefined), /No value configured/);
  const config = structuredClone(defaultProject);
  config.roleDefaults = { implementer: project, verifier: project };
  const source = structuredClone(templates.dev);
  const snapshot = snapshotConfiguration(source, config);
  source.name = 'Changed';
  assert.equal(snapshot.flow.name, 'Dev');
  assert.ok(snapshot.bindings['verify/required-reviewer']);
  const relabeled = structuredClone(snapshot.flow);
  relabeled.definition.nodes[0]!.label = 'A new display label';
  const relabeledSnapshot = snapshotConfiguration(relabeled, config);
  assert.equal(snapshot.semanticHash, relabeledSnapshot.semanticHash);
  assert.notEqual(snapshot.contentHash, relabeledSnapshot.contentHash);
  const flowDefault = structuredClone(templates.dev);
  flowDefault.definition.bindingDefaults.implementer = { ...flowDefault.definition.bindings.implementer!,
    model: { mode: 'pinned', value: 'flow-model' } };
  const inheritedSnapshot = snapshotConfiguration(flowDefault, config);
  assert.equal(inheritedSnapshot.bindings.implement?.values.model, 'flow-model');
  assert.equal(inheritedSnapshot.bindings.implement?.sources.model, 'flow');
  assert.equal(hashJson({ b: 1, a: 2 }), hashJson({ a: 2, b: 1 }));
});

test('fake adapter deduplicates requests, records events and reports confirmed stop', () => {
  const fake = new FakeAdapter();
  fake.createSession('s1');
  fake.dispatch('s1', 'a1', 'request1');
  fake.dispatch('s1', 'a1', 'request1');
  assert.equal(fake.observe().length, 1);
  assert.throws(() => fake.dispatch('s1', 'a2', 'request1'), /reused/);
  fake.stop('a1');
  assert.equal(fake.status('a1')?.status, 'stopped');
  assert.deepEqual(fake.observe(1).map(e => e.type), ['stopped']);
  assert.throws(() => fake.complete('a1', {}), /not running/);
  assert.equal(fake.capabilities().simulated, true);
});

test('CLI validates a file and emits schema; invalid policy returns nonzero', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-cli-'));
  const file = path.join(dir, 'flow.json');
  writeFileSync(file, JSON.stringify(templates.dev));
  const cli = path.resolve('dist/src/cli/main.js');
  const good = spawnSync(process.execPath, [cli, 'flow', 'validate', file], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).valid, true);
  const policy = path.join(dir, 'policy.json');
  writeFileSync(policy, JSON.stringify({ ...defaultProject.policy, allowGitCommit: false }));
  const denied = spawnSync(process.execPath, [cli, 'flow', 'validate', file, policy], { encoding: 'utf8' });
  assert.equal(denied.status, 1, denied.stderr);
  assert.ok(JSON.parse(denied.stdout).diagnostics.some((d: { code: string }) => d.code === 'permission_denied'));
  const schema = JSON.parse(execFileSync(process.execPath, [cli, 'schema', 'flow'], { encoding: 'utf8' }));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal((flowJsonSchema() as { additionalProperties: boolean }).additionalProperties, false);
});

test('CLI flow library commands publish and export an immutable version', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-cli-library-'));
  const root = path.join(dir, 'flows');
  const file = path.join(dir, 'draft.json');
  writeFileSync(file, JSON.stringify(templates.dev));
  const cli = path.resolve('dist/src/cli/main.js');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  assert.equal(run('flow', 'create', root, 'dev', 'Development').flowId, 'dev');
  assert.equal(run('flow', 'draft', root, 'dev', file).saved, true);
  assert.equal(run('flow', 'publish', root, 'dev').version, 1);
  assert.equal(run('flow', 'export', root, 'dev', '1').name, 'Development');
  assert.equal(run('flow', 'archive', root, 'dev').archived, true);
  const refused = spawnSync(process.execPath, [cli, 'flow', 'delete', root, 'dev', '--confirm-name', 'wrong'], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
});
