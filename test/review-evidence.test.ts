import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assessReviewEvidence, type ReviewEvidence } from '../src/core/review-evidence.js';

test('review evidence checks exact source locations, coverage, receipt baseline and path escape', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'neomind-evidence-'));
  await writeFile(path.join(workspace, 'code.c'), 'int add(int a, int b) {\n  return a + b;\n}\n');
  const source = { kind: 'source' as const, path: 'code.c', line: 2, quote: '  return a + b;' };
  const evidence: ReviewEvidence = { criteria: [{ criterion: 'addition', status: 'pass', references: [source] }], findings: [] };
  const input = { workspace, criteria: ['addition'], evidence, findingIds: [], baselineHash: 'baseline', checks: [] };
  assert.equal((await assessReviewEvidence(input)).evidenceValidated, true);
  assert.equal((await assessReviewEvidence({ ...input, criteria: ['addition', 'overflow'] })).criteriaCovered, false);
  for (const changed of [{ line: 1 }, { quote: 'invented' }, { path: '../secret' }]) {
    const invalid = structuredClone(evidence); invalid.criteria[0]!.references = [{ ...source, ...changed }];
    assert.equal((await assessReviewEvidence({ ...input, evidence: invalid })).evidenceValidated, false);
  }
  const external = await mkdtemp(path.join(tmpdir(), 'neomind-evidence-external-')); await writeFile(path.join(external, 'x'), source.quote);
  await symlink(path.join(external, 'x'), path.join(workspace, 'escape'));
  const escaped = structuredClone(evidence); escaped.criteria[0]!.references = [{ ...source, path: 'escape', line: 1 }];
  assert.equal((await assessReviewEvidence({ ...input, evidence: escaped })).evidenceValidated, false);
  const hash = 'a'.repeat(64), receiptEvidence: ReviewEvidence = { criteria: [{ criterion: 'addition', status: 'pass', references: [{ kind: 'check', command: 'make test', outputHash: hash }] }], findings: [] };
  assert.equal((await assessReviewEvidence({ ...input, evidence: receiptEvidence, checks: [{ command: 'make test', baselineHash: 'other', status: 'passed', outputHash: hash }] })).evidenceValidated, false);
  assert.equal((await assessReviewEvidence({ ...input, evidence: receiptEvidence, checks: [{ command: 'make test', baselineHash: 'baseline', status: 'failed', outputHash: hash }] })).evidenceValidated, false);
});
