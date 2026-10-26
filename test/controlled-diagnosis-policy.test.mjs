import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { controlledDiagnosisDecision, controlledDiagnosisSource } from '../dist/controlled-diagnosis-policy.js';
import { controlledInstructions } from '../dist/controlled-tools.js';
import { hash } from '../dist/storage.js';

function failed(version) {
  return { id: randomUUID(), request_id: randomUUID(), invocation_id: randomUUID(), stage: 'verification', role: 'verifier', state: 'completed',
    report: { outcome: 'blocked', summary: 'The independently executed checker needs diagnosis.' }, report_fingerprint: hash(`report-${version}`),
    bound_hashes: { 'checks/check.cjs': hash(`checker-${version}`), 'src/value.txt': hash('1\n') } };
}
const diagnosis = () => ({ id: randomUUID(), request_id: randomUUID(), invocation_id: randomUUID(), stage: 'diagnosis', role: 'manager', state: 'completed',
  report: { outcome: 'completed', failure_kind: 'checker', summary: 'A concrete checker defect was independently diagnosed.' } });

test('new failed checker state gets a fresh bounded diagnosis while the same failed source never repeats', () => {
  const first = failed(1), state = { attempts: [first], checks: [], events: [], revision: 1 };
  const original = JSON.stringify(state.attempts), one = controlledDiagnosisDecision(state,3);
  assert.equal(one.allowed,true); state.diagnosis_sources=[one.source];
  state.revision++; state.events.push({ kind:'unrelated-progress' });
  assert.equal(controlledDiagnosisDecision(state,3).reason,'same-failure-source');
  assert.equal(JSON.stringify(state.attempts),original,'Source binding never rewrites historical results.');
  state.attempts.push(diagnosis(),failed(2));
  const two=controlledDiagnosisDecision(state,3); assert.equal(two.allowed,true); assert.notEqual(two.source.key,one.source.key);
  state.diagnosis_sources.push(two.source);
  assert.equal(controlledDiagnosisDecision(state,3).reason,'same-failure-source');
});

test('legacy diagnosis bindings are inferred without refunds and unique source count respects existing one-to-three caps', () => {
  const first=failed(1),second=failed(2),state={attempts:[first,diagnosis(),second],checks:[]};
  assert.equal(controlledDiagnosisDecision(state,1).reason,'diagnosis-budget-exhausted');
  assert.equal(controlledDiagnosisDecision(state,2).allowed,true);
  const before=JSON.stringify(state);
  assert.equal(controlledDiagnosisDecision(state,3).previous_sources.length,1); assert.equal(JSON.stringify(state),before);
  state.attempts.push(diagnosis(),failed(3),diagnosis(),failed(4));
  assert.equal(controlledDiagnosisDecision(state,3).reason,'diagnosis-budget-exhausted');
  for(const invalid of [0,4,Infinity])assert.throws(()=>controlledDiagnosisDecision(state,invalid));
});

test('recursive diagnosis, changed source ledger and incomplete actor state fail closed', () => {
  const source=failed(1),run={attempts:[source],checks:[]};
  const key=controlledDiagnosisSource(run,source);
  run.diagnosis_sources=[{...key,source_fingerprint:'0'.repeat(64)}];
  assert.equal(controlledDiagnosisDecision(run,3).reason,'invalid-source-ledger');
  delete run.diagnosis_sources; run.attempts.push(diagnosis());
  assert.equal(controlledDiagnosisDecision(run,3).reason,'no-new-failure-source');
  run.attempts=[{...source,state:'running'}];
  assert.equal(controlledDiagnosisDecision(run,3).reason,'no-new-failure-source');
});

test('Verifier and diagnostic instructions separate semantic JSON from its serialized tool display', () => {
  for(const [stage,role] of [['verification','verifier'],['diagnosis','manager']]) {
    const text=controlledInstructions({workflow_id:'workflow',stage,role,implementation_paths:['src'],verification_paths:['checks']});
    assert.match(text,/JSON\.parse it exactly once/); assert.match(text,/Never apply transport-unescaping/);
    assert.match(text,/Preserve literal code fences/); assert.match(text,/not the serialized project_read\/MCP display wrapper/);
  }
});
