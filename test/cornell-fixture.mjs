export function cornellFixture(workflow_id, requirement_id) {
  return {
    workflow_id, requirement_ids: [requirement_id], topic: 'Verified named export',
    kind: 'codebase-analysis', owner: 'curator', path: 'docs/knowledge/value.md',
    context: 'A bounded module export has an executable acceptance contract.',
    constraints: ['Reported invocation identities are unsigned observations.'],
    cues: ['How does the checked export satisfy its requirement?'],
    main_notes: '[source-reported] The saved requirement defines the export contract [S1]. [expected] A focused assertion checks that contract.',
    sources: [{ id: 'S1', title: 'Saved export requirement', uri: 'https://example.com/requirement',
      record_id: requirement_id, retrieved_at: '2026-10-11T00:00:00Z', locator: 'acceptance criteria' }],
    demonstration: { body: 'Inspect the saved requirement and repeat its focused export assertion.',
      expected: 'The export matches the documented acceptance value.' },
    failure_cases: ['Changed source invalidates evidence captured against an earlier baseline.'],
    practice: { exercise_path: 'docs/practice/value.md', answer_path: 'docs/practice/value-answer.md',
      command: [process.execPath, '--input-type=module', '-e', 'import assert from "node:assert/strict"; assert.equal(1, 1)'],
      exercise: '# Exercise\nExplain how an executable assertion establishes an export contract.\n',
      answer: '# Answer\nImport the named export and assert its value against the requirement.\n' },
    summary: 'Requirements, checked baselines and independent review establish bounded engineering acceptance.'
  };
}
