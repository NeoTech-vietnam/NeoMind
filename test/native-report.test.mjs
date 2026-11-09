import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeProfessionalReport } from '../dist/native-request.js';

const report = { summary: 'Observed implementation', verdict: 'pass', findings: [] };

test('a complete professional result with harmless preceding prose does not require another model invocation', () => {
  const raw = 'Implementation files created. Independent review and host checks remain host-owned; verdict covers inspected implementation only.' + JSON.stringify(report);
  assert.deepEqual(parseNativeProfessionalReport({ content: [{ value: raw }] }).report, report);
});

test('balanced report extraction respects braces, quotes and escaped strings inside JSON', () => {
  const value = { ...report, summary: 'Tested {x} and the string "quoted" without changing authority' };
  assert.deepEqual(parseNativeProfessionalReport(`Observed result:\n${JSON.stringify(value)}\nEnd.`).report, value);
});

test('an unmatched prose brace does not hide a complete professional report', () => {
  assert.deepEqual(parseNativeProfessionalReport('Updated helper foo() {\n' + JSON.stringify(report)).report, report);
});

test('conflicting professional reports remain incomplete instead of choosing the first pass', () => {
  const failure = { summary: 'A defect remains', verdict: 'findings', findings: ['Wrong result'] };
  const parsed = parseNativeProfessionalReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(failure)}\n\`\`\``);
  assert.equal(parsed.report, undefined);
});

test('duplicate observations can repeat one result, while authority fields remain model prose only', () => {
  const parsed = parseNativeProfessionalReport({ content: [{ value: JSON.stringify({ ...report, actor: 'invented', workflow_id: 'invented' }) },
    { value: JSON.stringify(report) }] });
  assert.deepEqual(parsed.report, report);
  assert.equal('actor' in parsed.report, false);
});
