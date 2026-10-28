// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateRecord } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';

export function researchFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-research-'));
  const notesRoot = mkdtempSync(join(tmpdir(), 'neomind-notes-target-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(notesRoot, { recursive: true, force: true }); });
  initialize(root, { project_id: 'CORNELL' });
  const workflow = beginWorkflow(root, { requirement: 'Explain Cartesian products with a worked example and independent practice.', execution_mode: 'copilot-native' });
  const requirement = updateRecord(root, workflow.meta.data.requirement_id, { data: { acceptance_criteria: ['The explanation enumerates a finite example and provides independently reviewable practice.'] } });
  const input = { schema_version: 1, requirement_id: requirement.meta.id, expected_requirement_revision: requirement.meta.revision,
    workflow_id: workflow.meta.id, topic: 'Counting a finite Cartesian product', date: '2026-10-23', output_dir: 'docs/research/product',
    context: 'Count combinations by choosing one element from each of two finite sets.', constraints: ['The two sets are finite and their elements remain distinct.'],
    abstract: 'A Cartesian product enumerates every ordered pair; counting its rows explains multiplication [S1].',
    learning_objectives: [{ id: 'O1', text: 'Enumerate and count the ordered pairs of two finite sets.' }],
    methods: '[source-reported] Read the saved requirement and enumerate a finite example independently [S1].',
    explanations: [{ heading: 'Pairs and multiplication', body: '[inferred] Each first-set element pairs with every second-set element [S1].' }],
    results: '[expected] A set of three elements and a set of two elements produce six ordered pairs [S1].',
    discussion: '[inferred] Enumerating pairs verifies this example, while infinite sets require a different scope [S1].',
    questions: [{ id: 'Q1', prompt: 'Why does each first-set element contribute the same number of pairs?', objective_ids: ['O1'], answer: 'Each first-set element can pair with all second-set elements, so the rows have equal length [S1].' }],
    worked_example: { body: 'List (a,1), (a,2), (b,1), (b,2), (c,1), and (c,2), then count them.', expected: 'The explicit enumeration contains six ordered pairs.' },
    practice: { questions: [{ id: 'P1', prompt: 'List and count the pairs for four letters and two digits.', objective_ids: ['O1'], answer: 'There are eight ordered pairs because each of the four letters pairs with each of two digits [S1].' }],
      procedure: ['List the four letters and two digits as two separate sets.', 'Write every ordered pair, then compare the count with multiplication.'],
      solution_path: 'docs/research/product/my-solution.md', starter: '# My solution\nRecord the pairs and reasoning here.\n' },
    sources: [{ id: 'S1', title: 'Saved Cartesian product requirement', uri: `record:${requirement.meta.id}`, record_id: requirement.meta.id, retrieved_at: '2026-10-23T00:00:00Z', locator: 'requirement statement' }],
    failure_cases: ['Repeated elements or unordered selections change the counting assumptions.'], summary: 'Ordered pairs and a rectangular enumeration explain the product of finite set sizes.' };
  return { root, notesRoot, workflow, requirement, input };
}
