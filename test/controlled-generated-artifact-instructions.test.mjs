// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as toml } from 'smol-toml';
import { atomicWrite, safePath } from '../dist/storage.js';
import { controlledInstructions, controlledToolNames, controlledPlanSchema } from '../dist/controlled-tools.js';
import { controlledPlanSubmissionExample, controlledPlanSubmissionGuide } from '../dist/controlled-plan-request.js';
import { adapterOutputs } from '../dist/adapters.js';

function binding(extra = {}) {
  return { workflow_id: 'NM-GENERATED-KNW-0001', stage: 'implementation', role: 'developer',
    implementation_paths: ['src', 'notes'], verification_paths: ['checks'], execution_steps: [], ...extra };
}

test('controlled Cornell instructions reserve the generated trio for the actual compiler instead of generic source writes', () => {
  const actor = binding({ cornell_bound: true, cornell_source: { path: 'requests/research.json', sha256: 'a'.repeat(64) } });
  assert.ok(controlledToolNames(actor).includes('cornell_research_compile'));
  const instructions = controlledInstructions(actor);
  assert.match(instructions, /note\.md, exercises\.md and answers\.md are compiler-owned generated artifacts/);
  assert.match(instructions, /do not create, patch or overwrite this managed trio with task_file_write/);
  assert.match(instructions, /Write only ordinary assigned source and report files with task_file_write/);
  assert.match(instructions, /Call cornell_research_compile with \{\} or its exact input_path/);
  assert.match(instructions, /do not copy, rewrite or override the prepared research/);
  const ordinary = controlledInstructions(binding({ cornell_bound: false }));
  assert.equal(controlledToolNames(binding({ cornell_bound: false })).includes('cornell_research_compile'), false);
  assert.doesNotMatch(ordinary, /Author their professional content through cornell_research_compile|Call cornell_research_compile/);
  assert.doesNotMatch(controlledInstructions(binding({ evidence_documentation: true })), /Author their professional content through cornell_research_compile/);
});

test('an executable producer receives the canonical file-backed stdin call without command or wrapper invention', () => {
  const actor = binding({ cornell_bound: false,
    execution_steps: [{ title: 'Generate report', command: ['node', 'scripts/generate.mjs'], input_paths: [], output_paths: ['artifacts/report.json'] }] });
  const instructions = controlledInstructions(actor);
  const example = JSON.parse(/send (\{"title":"<declared step title>","input_path":"project\/prepared-input\.json"\})/.exec(instructions)[1]);
  assert.deepEqual(example, { title: '<declared step title>', input_path: 'project/prepared-input.json' });
  assert.match(instructions, /parses that JSON object and supplies it to the declared script on stdin/);
  assert.match(instructions, /Do not change the saved command or invent node -e, wrapper scripts or stdin_path/);
  assert.doesNotMatch(controlledInstructions(binding({ cornell_bound: false })), /send \{"title":"<declared step title>"/);
});

test('generated Copilot and Codex profiles carry the same conditional compiler ownership and canonical execution boundary', t => {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'neomind-generated-ownership-'));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const config = initialize(root, { platforms: ['copilot', 'codex'], copilot_integration: 'local' });
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify({ execution_mode: 'neomind-controlled' }));
  const surfaces = adapterOutputs(root, config).filter(output => output.path === 'AGENTS.md' ||
    output.path === '.github/instructions/neomind.instructions.md' || /^\.(?:github|codex)\/agents\/neomind-/.test(output.path));
  assert.equal(surfaces.filter(surface => /^\.github\/agents\//.test(surface.path)).length, 9);
  assert.equal(surfaces.filter(surface => /^\.codex\/agents\//.test(surface.path)).length, 9);
  let expected;
  for (const surface of surfaces) {
    const instructions = surface.path.endsWith('.toml') ? toml(surface.content).developer_instructions : surface.content;
    const guidance = instructions.split(/\r?\n/).find(line => line.startsWith('When the assignment supplies a Cornell compiler,'));
    assert.ok(guidance, surface.path); expected ??= guidance; assert.equal(guidance, expected, surface.path);
    assert.match(guidance, /canonical note\.md, exercises\.md and answers\.md are compiler-owned generated artifacts/);
    assert.match(guidance, /command and output_paths in execution_steps/);
    assert.match(guidance, /task_run with title and input_path supplies prepared JSON on stdin/);
  }
});

test('controlled guides and skills preserve the same managed-Cornell and prepared-data boundaries', () => {
  for (const path of ['resources/guides/controlled-workflows.md', 'docs/controlled-workflows.md', 'docs/cornell-workflow.md',
    'resources/skills/neomind-implement/SKILL.md', 'resources/skills/neomind-cornell/SKILL.md']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(text, /compiler-owned generated artifacts/, path);
    assert.match(text, /note\.md.*exercises\.md.*answers\.md/, path);
    assert.match(text, /(?:do not create, patch or overwrite|not raw|cannot create or overwrite|instead of creating, patching or overwriting|instead of hand-writing or patching)/, path);
  }
  const guide = readFileSync(new URL('../resources/guides/controlled-workflows.md', import.meta.url), 'utf8');
  assert.match(guide, /parses that file as a JSON object.*stdin/);
  assert.match(guide, /`command`.*`output_paths`.*`outputs`/);
  assert.match(guide, /Do not invent `stdin_path`, `node -e`/);
});

test('the runtime guide, actual planning instructions and tool schema share the same complete canonical example', () => {
  const guide = readFileSync(new URL('../resources/guides/controlled-workflows.md', import.meta.url), 'utf8');
  const example = JSON.parse(/### Canonical plan example[\s\S]*?```json\r?\n([\s\S]*?)\r?\n```/.exec(guide)[1]);
  assert.deepEqual(example, controlledPlanSubmissionExample(), 'Documentation cannot drift into an unsupported planning payload.');
  assert.doesNotThrow(() => controlledPlanSchema.parse(example));
  const instructions = controlledInstructions({ ...binding(), stage: 'planning', role: 'manager' });
  assert.ok(instructions.includes(controlledPlanSubmissionGuide(controlledPlanSchema)));
  assert.match(instructions, /task_run\(\{"title":"Generate the prepared result","input_path":"inputs\/example.json"\}\)/);
  assert.match(instructions, /resulting JSON object on the producer script stdin/);
  assert.doesNotMatch(controlledInstructions(binding({ cornell_bound: false })), /Canonical planning shape example only/);
});
