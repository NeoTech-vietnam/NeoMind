import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createProcedureInputPacket, serializeProcedureInputPacket, procedureInputContractHint,
  registerProcedure, reviewProcedure, runProcedure } from '../dist/procedures.js';
import { controlledInstructions, controlledToolNames } from '../dist/controlled-tools.js';

test('controlled procedure hint matches the actual generator and checker stdin in both execution branches', async t => {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-packet-contract-')));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  for (const path of ['scripts', 'checks']) mkdirSync(join(root, path));
  writeFileSync(join(root, 'scripts/generate.mjs'), `import assert from 'node:assert/strict';import{mkdirSync,writeFileSync}from'node:fs';import{dirname}from'node:path';
let raw='';for await(const part of process.stdin)raw+=part;assert.ok(raw.endsWith('\\n'));const packet=JSON.parse(raw);
assert.equal(packet.schema_version,1);assert.equal(typeof packet.request_id,'string');assert.equal(typeof packet.procedure_id,'string');assert.equal(typeof packet.version,'string');
assert.ok(packet.parameters&&typeof packet.parameters==='object');assert.ok(Array.isArray(packet.outputs));
mkdirSync(dirname(packet.outputs[0]),{recursive:true});writeFileSync(packet.outputs[0],raw,{flag:'wx'});`);
  writeFileSync(join(root, 'scripts/verify.mjs'), `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
let raw='';for await(const part of process.stdin)raw+=part;const packet=JSON.parse(raw);
assert.ok(raw.endsWith('\\n'));assert.equal(raw,readFileSync(packet.outputs[0],'utf8'));process.stdout.write(raw);`);
  writeFileSync(join(root, 'checks/negative.json'), JSON.stringify({ fixture: 'Packet reader rejects absent schema version and unequal generator/checker bytes.' }));
  registerProcedure(root, { id: 'packet-contract', version: '1.2.3', title: 'Observe actual subprocess packet',
    description: 'Fixture procedure observing the public runner protocol only.', author: 'packet-fixture-author',
    script: 'scripts/generate.mjs', verification_script: 'scripts/verify.mjs',
    parameters: { number: { type: 'integer', min: 0 }, output: { type: 'string', path: true } },
    outputs: [{ path: '{output}', min_bytes: 1 }], environment: { platforms: [process.platform], clients: ['cli'] },
    effects: { write_roots: ['output'], network: false, publication: false }, timeout_ms: 10000 });
  reviewProcedure(root, { procedure_id: 'packet-contract', reviewer: 'independent-packet-fixture-reviewer', verdict: 'pass',
    rationale: 'Local contract observation fixture, not intended-use qualification evidence.',
    negative_cases: [{ name: 'packet reader assertion contract', evidence_path: 'checks/negative.json' }] });
  const hint = procedureInputContractHint(), marker = 'Procedure subprocess stdin contract: ';
  const example = JSON.parse(hint.split('\n')[0].slice(marker.length));
  assert.deepEqual(Object.keys(example), ['schema_version', 'request_id', 'procedure_id', 'version', 'parameters', 'outputs']);
  for (const actor of [
    { stage: 'planning', role: 'manager', procedure_bound: false },
    { stage: 'implementation', role: 'developer', procedure_bound: true },
    { stage: 'implementation', role: 'developer', procedure_bound: false },
    { stage: 'implementation', role: 'developer', procedure_bound: false, evidence_documentation: true, execution_steps: [] },
    { stage: 'verification', role: 'verifier', procedure_bound: false },
    { stage: 'review', role: 'reviewer', procedure_bound: false },
    { stage: 'synthesis', role: 'manager', procedure_bound: false },
    { stage: 'diagnosis', role: 'manager', procedure_bound: false },
  ]) {
    const binding = { ...actor, workflow_id: 'BACKEND-WORKFLOW',
      implementation_paths: ['scripts/generate.mjs'], verification_paths: ['scripts/verify.mjs'] };
    const instructions = controlledInstructions(binding);
    const needsPacketContract = actor.stage === 'planning' || controlledToolNames(binding).includes('procedure_run');
    assert.equal(instructions.includes(hint), needsPacketContract, `${actor.stage}: bound procedure ${actor.procedure_bound}`);
    if (needsPacketContract) {
      assert.match(instructions, /identical packet.*generator.*verification script/);
      assert.match(instructions, /backend-owned metadata, not model inputs/);
    } else {
      assert.doesNotMatch(instructions, /Procedure subprocess stdin contract:|Workers invoke the bound procedure_run tool/);
    }
    assert.doesNotMatch(hint, /BACKEND-WORKFLOW/);
  }
  for (const cancellable of [false, true]) {
    const request_id = `observed-packet-${cancellable}`, parameters = { number: 7, output: `output/${request_id}.json` };
    const result = await runProcedure(root, { procedure_id: 'packet-contract', parameters, request_id,
      actor: 'packet-fixture-worker', client: 'cli', mode: 'pilot', observation: 'fixture',
      authorized_effects: { write_roots: ['output'], network: false, publication: false } },
    cancellable ? { signal: new AbortController().signal } : {});
    assert.equal(result.status, 'succeeded', result.error);
    const raw = readFileSync(join(root, parameters.output), 'utf8'), packet = JSON.parse(raw);
    const expected = createProcedureInputPacket({ request_id, procedure_id: 'packet-contract', version: '1.2.3', parameters, outputs: [parameters.output] });
    assert.equal(raw, serializeProcedureInputPacket(expected)); assert.equal(result.verification.stdout, raw);
    assert.equal(raw.endsWith('\n'), true); assert.equal(raw.endsWith('\n\n'), false);
    assert.deepEqual(Object.keys(packet), Object.keys(example)); assert.deepEqual(packet, expected);
    assert.equal(result.observation, 'fixture');
  }
});
