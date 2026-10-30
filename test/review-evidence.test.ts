import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileSymlink } from './helpers/symlink.js';
import { tmpdir } from 'node:os';
import { assessReviewEvidence, checkReceiptId, referenceProblems, structureProblems, type ReviewEvidence } from '../src/core/review-evidence.js';

test('review evidence checks exact source locations, coverage, receipt baseline and path escape', async t => {
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
  if (await fileSymlink(t, path.join(external, 'x'), path.join(workspace, 'escape'))) {
    const escaped = structuredClone(evidence); escaped.criteria[0]!.references = [{ ...source, path: 'escape', line: 1 }];
    assert.equal((await assessReviewEvidence({ ...input, evidence: escaped })).evidenceValidated, false);
  }
  // A rejected reference explains itself, including where a misnumbered quote actually is.
  const misplaced = structuredClone(evidence); misplaced.criteria[0]!.references = [{ ...source, line: 3 }, { ...source, quote: 'invented' }];
  const problems = await referenceProblems({ ...input, evidence: misplaced });
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /not at line 3; it starts at line 2/); assert.match(problems[1]!, /does not appear verbatim/);
  assert.deepEqual(await referenceProblems(input), []);
  // A CRLF checkout cites the same lines and quotes as LF.
  await writeFile(path.join(workspace, 'code.c'), 'int add(int a, int b) {\r\n  return a + b;\r\n}\r\n');
  assert.equal((await assessReviewEvidence(input)).evidenceValidated, true);
  await writeFile(path.join(workspace, 'code.c'), 'int add(int a, int b) {\n  return a + b;\n}\n');
  const hash = 'a'.repeat(64), receiptEvidence: ReviewEvidence = { criteria: [{ criterion: 'addition', status: 'pass', references: [{ kind: 'check', command: 'make test', outputHash: hash }] }], findings: [] };
  assert.equal((await assessReviewEvidence({ ...input, evidence: receiptEvidence, checks: [{ command: 'make test', baselineHash: 'other', status: 'passed', outputHash: hash }] })).evidenceValidated, false);
  assert.equal((await assessReviewEvidence({ ...input, evidence: receiptEvidence, checks: [{ command: 'make test', baselineHash: 'baseline', status: 'failed', outputHash: hash }] })).evidenceValidated, false);
  assert.equal((await assessReviewEvidence({ ...input, evidence: receiptEvidence, checks: [{ command: 'make test', baselineHash: 'baseline', status: 'passed', outputHash: hash }] })).evidenceValidated, true);
  // A short core-issued receipt ID is accepted in place of the full hash; a miscopied one is not.
  const receipt = { command: 'make test', baselineHash: 'baseline', status: 'passed', outputHash: '0123456789ab'.padEnd(64, 'c') };
  const byId = (receiptId: string): ReviewEvidence => ({ criteria: [{ criterion: 'addition', status: 'pass', references: [{ kind: 'check', command: 'make test', receiptId }] }], findings: [] });
  assert.equal((await assessReviewEvidence({ ...input, evidence: byId(checkReceiptId(receipt.outputHash)), checks: [receipt] })).evidenceValidated, true);
  assert.equal((await assessReviewEvidence({ ...input, evidence: byId('0123456789ac'), checks: [receipt] })).evidenceValidated, false);
  assert.match((await referenceProblems({ ...input, evidence: byId('0123456789ac'), checks: [receipt] }))[0]!, /receiptId do not match/);
});

test('structural evidence problems are named for the validation retry', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'neomind-structure-'));
  await writeFile(path.join(workspace, 'a.js'), 'ok();\n');
  const reference = { kind: 'source' as const, path: 'a.js', line: 1, quote: 'ok();' };
  const evidence: ReviewEvidence = { criteria: [{ criterion: 'works', status: 'pass', references: [reference] }, { criterion: 'safe', status: 'blocked', references: [reference] }],
    findings: [{ id: 'F1', criterion: 'works', explanation: 'note on a passing criterion', references: [reference] }] };
  // A pass with an advisory finding is rejected by the assessment; the retry must say why.
  const assessment = await assessReviewEvidence({ workspace, criteria: ['works', 'safe'], evidence, findingIds: ['F1'], baselineHash: 'b', checks: [] });
  assert.equal(assessment.evidenceValidated, false);
  assert.deepEqual(await referenceProblems({ workspace, evidence, baselineHash: 'b', checks: [] }), []);
  const problems = structureProblems(evidence, ['F2']);
  assert.ok(problems.some(problem => /criterion "safe" is blocked/.test(problem)));
  assert.ok(problems.some(problem => /finding F1 is attached to criterion "works", which is not failed/.test(problem)));
  assert.ok(problems.some(problem => /finding F1 is missing from findingIds/.test(problem)));
  assert.ok(problems.some(problem => /findingIds lists F2 without a matching finding/.test(problem)));
  assert.deepEqual(structureProblems({ criteria: [{ criterion: 'works', status: 'fail', references: [reference] }], findings: [{ ...evidence.findings[0]! }] }, ['F1']), []);
});
