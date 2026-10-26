import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { researchFixture } from './cornell-research-fixture.mjs';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createRecord, hash, safePath } from '../dist/storage.js';
import { previewCornellArtifacts } from '../dist/notes.js';
import { validateControlledCornell, assertControlledCornellValidationCurrent } from '../dist/controlled-cornell-validation.js';

function fixture(t) {
  const a = researchFixture(t), assets = fileURLToPath(new URL('./fixtures/cornell-format-assets/', import.meta.url));
  const template = '.agents/skills/layout/assets/layout.md', validator = '.agents/skills/layout/scripts/check.py';
  for (const [path, name] of [[template, 'cornell-note-template.md'], [validator, 'validate_notes.py']]) {
    mkdirSync(join(a.root, path, '..'), { recursive: true }); copyFileSync(join(assets, name), safePath(a.root, path));
  }
  const profile = { schema_version: 1, id: 'leetcode-cornell-v1',
    template: { path: template, sha256: hash(readFileSync(safePath(a.root, template))) },
    validator: { path: validator, sha256: hash(readFileSync(safePath(a.root, validator))) } };
  const task = createRecord(a.root, { type: 'task', title: 'Validate the exact compiler boundary', owner: 'developer',
    links: [{ type: 'satisfies', target: a.requirement.meta.id }], data: { workflow_id: a.workflow.meta.id } });
  const flow = '```mermaid\nflowchart TD\n A[Inspect] --> B[Conclude]\n classDef sample fill:#123,stroke:#fff\n class A,B sample\n```';
  const input = { ...a.input, topic: 'Leetcode - 4242 - Canonical boundary fixture', task_id: task.meta.id,
    explanations: [{ heading: 'Strategy A: Independent method', body: '[expected] Compare the observed inputs before choosing the deterministic next operation.' },
      { heading: 'Strategy A Flow', body: flow }, { heading: 'Strategy A Worked Example Flow', body: flow }],
    worked_example: { ...a.input.worked_example } };
  delete input.worked_example.observed; delete input.worked_example.evidence_ids;
  return { ...a, input, profile, compile(value = input) { return compileCornellResearch(a.root, value, { approved_source_files: [], format_profile: profile }); } };
}

test('actual pinned validator runs before any managed files and binds exact preview bytes and renderer revision', async t => {
  const a = fixture(t), compiled = a.compile(), before = previewCornellArtifacts(a.root, compiled.note);
  assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
  const proof = await validateControlledCornell(a.root, compiled, { explanation_headings: a.input.explanations.map(item => item.heading) });
  assert.equal(proof.exit_code, 0); assert.equal(proof.renderer_revision, 2);
  assert.equal(proof.validator_sha256, a.profile.validator.sha256);
  assert.deepEqual(proof.artifact_hashes, Object.fromEntries(Object.entries(before).map(([path, text]) => [path, hash(text)])));
  assertControlledCornellValidationCurrent(a.root, compiled, proof);
  assert.equal(existsSync(safePath(a.root, compiled.note.path)), false, 'Validation does not create the deliverable or a success record.');
});

test('a renderer regression is rejected before persistence and the same generation stays stopped across actors', async t => {
  const a = fixture(t), compiled = a.compile();
  compiled.note.main_notes = compiled.note.main_notes.replace(/^## Strategy A:/m, '### Strategy A:');
  let failure;
  await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: a.input }), error => {
    failure = error.failure; return error.code === 'CORNELL_CANONICAL_INVALID' && failure.owner === 'runtime';
  });
  assert.ok(failure.diagnostics.some(value => value.includes('without matching strategies')));
  assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
  const originalPath = process.env.PATH; process.env.PATH = '';
  try {
    await assert.rejects(validateControlledCornell(a.root, compiled, { previous_failures: [failure] }), error => error.failure === failure,
      'The durable generation key refuses unchanged retries before resolving or invoking Python.');
  } finally { process.env.PATH = originalPath; }
});

test('source-owned reserved heading duplicates and literal orphan flows retain exact content ownership', async t => {
  const a = fixture(t);
  for (const literal of ['# Cornell Notes', '### Problem Description', '#### Constraints', '#### Function Contract',
    '### Cue Column (Questions, Keywords, or Prompts)', '### Notes Section (Main Notes)', '### Summary Section (Summary of Notes)',
    '### Strategy Z Flow', '### Strategy Z Worked Example Flow']) {
    const input = structuredClone(a.input);
    input.explanations[0].body += `\n\n\`\`\`md\n${literal}\n\`\`\``;
    const compiled = a.compile(input);
    await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: input }), error =>
      error.failure?.owner === 'content' && error.message.includes('explanations['), literal);
    assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
  }
  const input = structuredClone(a.input);
  input.explanations.push({ heading: 'Problem Description', body: 'An authored ordinary heading collides with the fixed project heading.' });
  await assert.rejects(validateControlledCornell(a.root, a.compile(input), { semantic_input: input }), error =>
    error.failure?.owner === 'content' && error.message.includes('explanations[3].heading'));
});

test('valid semantic headers and harmless style-like text cannot conceal a renderer-owned canonical failure', async t => {
  const a = fixture(t);
  for (const defect of ['topic', 'reserved-heading', 'style', 'flow-level', 'worked-flow-level', 'flow-body', 'mixed']) {
    const input = structuredClone(a.input);
    if (defect === 'style') input.explanations[0].body += '\n<style-component>Harmless literal custom tag.</style-component>';
    if (defect === 'mixed') input.explanations[1].body = 'Authored content has no Mermaid fence.';
    const compiled = a.compile(input);
    if (defect === 'topic') compiled.note.topic = 'Broken renderer topic field';
    if (defect === 'reserved-heading') compiled.note.main_notes += '\n\n### Problem Description\n';
    if (defect === 'style') compiled.note.main_notes += '\n<style>Injected backend defect</style>\n';
    if (defect === 'flow-level') compiled.note.main_notes = compiled.note.main_notes.replace(/^### Strategy A Flow$/m, '## Strategy A Flow');
    if (defect === 'worked-flow-level') compiled.note.main_notes = compiled.note.main_notes.replace(/^### Strategy A Worked Example Flow$/m, '## Strategy A Worked Example Flow');
    if (defect === 'flow-body') compiled.note.main_notes = compiled.note.main_notes.replace('classDef sample fill:#123,stroke:#fff', 'class sample fill:#123');
    if (defect === 'mixed') compiled.note.topic = 'A backend topic regression coexists with authored malformed Mermaid.';
    await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: input }), error => error.failure?.owner === 'runtime', defect);
    assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
  }
});

test('backend-produced Topic prefix, Date, fixed-section and fence regressions remain runtime with valid semantic input', async t => {
  const a = fixture(t), originalDate = a.input.date;
  assert.throws(() => a.compile({ ...a.input, date: '23/10/2026' }), /YYYY|ISO|date|Invalid/i);
  for (const defect of ['topic-prefix', 'date-display', 'fixed-section', 'fence']) {
    const compiled = a.compile(), original = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function(file, data, ...args) {
      if (!injected && typeof file === 'string' && /\/neomind-cornell-validation-[^/]+\/note\.md$/.test(file.replaceAll('\\', '/'))) {
        injected = true;
        // Fault injection into the disposable renderer-to-validator boundary; the actual pinned Python checker is unchanged.
        if (defect === 'topic-prefix') data = String(data).replace(/^## Topic:/m, '## Broken Topic:');
        if (defect === 'date-display') data = String(data).replace(/^## Date: .+$/m, `## Date: ${originalDate}`);
        if (defect === 'fixed-section') data = String(data).replace(/^### Problem Description$/m, '## Broken Problem Description');
        if (defect === 'fence') data = String(data) + '\n~~~md\nBackend introduced an unclosed fence.\n';
      }
      return original.call(this, file, data, ...args);
    }; syncBuiltinESMExports();
    try {
      await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: a.input }), error => error.failure?.owner === 'runtime', defect);
    } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    assert.equal(injected, true); assert.equal(a.input.date, originalDate);
    assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
  }
});

test('actual canonical rejection with a provably missing semantic flow identifies content ownership', async t => {
  const a = fixture(t), input = { ...a.input, explanations: a.input.explanations.slice(0, 1) }, compiled = a.compile(input);
  await assert.rejects(validateControlledCornell(a.root, compiled, { explanation_headings: input.explanations.map(item => item.heading) }), error =>
    error.failure?.owner === 'content' && error.message.includes('Strategy A Flow') && error.failure.diagnostics.some(value => value.includes('missing Mermaid flows')));
  assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
});

test('source correction guidance describes the actual finding rather than inventing missing structured flow fields', async t => {
  const a = fixture(t), input = structuredClone(a.input);
  input.explanations = [input.explanations[0]];
  input.explanations[0].body += `\n\n### Strategy A Flow\n\n${a.input.explanations[1].body}\n\n### Strategy A Worked Example Flow\n\n${a.input.explanations[2].body}`;
  input.context += '\n<style>Authored style violates the pinned format.</style>\n';
  await assert.rejects(validateControlledCornell(a.root, a.compile(input), { semantic_input: input }), error =>
    error.failure?.owner === 'content' && error.message.includes('raw HTML style') && !error.message.includes('omit required flow'));
});

test('a runtime finding after the 24-line diagnostic projection cannot be hidden by earlier content findings', async t => {
  const a = fixture(t), input = structuredClone(a.input);
  input.explanations = Array.from({ length: 26 }, (_, index) => ({ heading: `Strategy ${String.fromCharCode(65 + index)} Flow`,
    body: 'Authored flow text lacks the required Mermaid fence.' }));
  const compiled = a.compile(input);
  await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: input }), error =>
    error.failure?.owner === 'content' && error.failure.diagnostics.length === 24);
  const original = fs.writeFileSync; let injected = false;
  fs.writeFileSync = function(file, data, ...args) {
    if (!injected && typeof file === 'string' && /\/neomind-cornell-validation-[^/]+\/validate\.py$/.test(file.replaceAll('\\', '/'))) {
      injected = true;
      // Fault injection appends a backend-owned finding after all real canonical content findings; the project validator stays pinned.
      data = String(data).replace('from __future__ import annotations',
        'from __future__ import annotations\nimport atexit\natexit.register(lambda: print("  - missing or invalid DD/MM/YYYY Date heading"))');
    }
    return original.call(this, file, data, ...args);
  }; syncBuiltinESMExports();
  try {
    await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: input }), error =>
      error.failure?.owner === 'runtime' && error.failure.diagnostics.length === 24 && !error.failure.diagnostics.some(value => value.includes('Date heading')));
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
});

test('actual malformed Mermaid, styling and topic findings stay with unchanged professional input fields', async t => {
  const a = fixture(t);
  for (const kind of ['styling', 'flow-content', 'worked-styling', 'worked-content', 'topic', 'style', 'context-style', 'literal-heading', 'orphan-flow', 'tilde', 'width']) {
    const input = structuredClone(a.input);
    if (kind === 'styling') input.explanations[1].body = input.explanations[1].body.replace('classDef sample fill:#123,stroke:#fff', 'class sample fill:#123');
    if (kind === 'flow-content') input.explanations[1].body = 'This professional flow omits its Mermaid fence.';
    if (kind === 'worked-styling') input.explanations[2].body = input.explanations[2].body.replace('classDef sample fill:#123,stroke:#fff', 'class sample fill:#123');
    if (kind === 'worked-content') input.explanations[2].body = 'This professional worked-example flow omits its Mermaid fence.';
    if (kind === 'topic') input.topic = 'A professional title that violates the pinned project topic contract';
    if (kind === 'style') input.explanations[0].body += '\n<style>body { color: red; }</style>';
    if (kind === 'context-style') input.context += '\n<style>body { color: red; }</style>';
    if (kind === 'literal-heading') input.explanations[0].body += '\n\n```md\n## Strategy B: Literal example\n```';
    if (kind === 'orphan-flow') input.explanations.push({ heading: 'Strategy Z Flow', body: input.explanations[1].body });
    if (kind === 'tilde') input.explanations[0].body += '\n~~~md\nA supplied fence is never closed.';
    if (kind === 'width') input.explanations[0].body += '\n````md\nA shorter supplied closing marker cannot close this fence.\n```';
    const compiled = a.compile(input);
    await assert.rejects(validateControlledCornell(a.root, compiled, { semantic_input: input }), error =>
      error.failure?.owner === 'content' && error.message.includes(kind === 'topic' ? 'topic' : kind === 'context-style' ? 'context' : 'explanations['), kind);
    assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
  }
});

test('missing Python, cancellation and changed preview cannot become canonical success', async t => {
  const a = fixture(t), compiled = a.compile(), originalPath = process.env.PATH;
  process.env.PATH = '';
  try { await assert.rejects(validateControlledCornell(a.root, compiled), error => error.code === 'CORNELL_VALIDATOR_UNAVAILABLE' && error.failure.owner === 'environment'); }
  finally { process.env.PATH = originalPath; }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(validateControlledCornell(a.root, compiled, { signal: abort.signal }), error => error.code === 'CORNELL_VALIDATOR_UNAVAILABLE');
  const proof = await validateControlledCornell(a.root, compiled);
  compiled.note.main_notes += '\n\nA changed paragraph requires its own actual validation.\n';
  assert.throws(() => assertControlledCornellValidationCurrent(a.root, compiled, proof), /changed after canonical validation/);
  assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
});

test('generic research does not require the optional profile interpreter or acquire a canonical receipt', async t => {
  const a = researchFixture(t), compiled = compileCornellResearch(a.root, a.input), originalPath = process.env.PATH;
  process.env.PATH = '';
  try { assert.equal(await validateControlledCornell(a.root, compiled), undefined); }
  finally { process.env.PATH = originalPath; }
});

test('compiler boundary cancels and times out an actually started validator child without producing success', async t => {
  for (const kind of ['cancel', 'timeout']) {
    const a = fixture(t), compiled = a.compile(), original = fs.writeFileSync, abort = new AbortController();
    let startedPath;
    fs.writeFileSync = function(file, data, ...args) {
      if (typeof file === 'string' && /\/neomind-cornell-validation-[^/]+\/validate\.py$/.test(file.replaceAll('\\', '/'))) {
        startedPath = file.replace(/\.py$/, '.started');
        // Fault injection in the disposable copy only. The approved project validator fingerprint stays immutable.
        data = 'from pathlib import Path\nimport time\nPath(__file__).with_suffix(".started").write_text("started")\ntime.sleep(30)\n';
      }
      return original.call(this, file, data, ...args);
    }; syncBuiltinESMExports();
    let outcome;
    try {
      outcome = validateControlledCornell(a.root, compiled, { signal: abort.signal });
      const deadline = Date.now() + 5000;
      while ((!startedPath || !existsSync(startedPath)) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(startedPath && existsSync(startedPath), 'The child actually entered the injected validation process before interruption.');
      if (kind === 'cancel') abort.abort();
      await assert.rejects(outcome, error => error.code === 'CORNELL_VALIDATOR_UNAVAILABLE' && error.failure.owner === 'environment');
      assert.equal(existsSync(safePath(a.root, compiled.note.path)), false);
      assert.equal(hash(readFileSync(safePath(a.root, a.profile.validator.path))), a.profile.validator.sha256);
    } finally {
      abort.abort(); await outcome?.catch(() => {}); fs.writeFileSync = original; syncBuiltinESMExports();
    }
  }
});
