// Test-only domain probe. No model call or production state is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, getRecord, requestFolderForWorkflow } from '../dist/storage.js';
import { openNativeRequest, planNativeRequest, nextNativeAssignment, recordNativeResult,
  runNativeChecks, finishNativeRequest, getNativeRequest, resumeNativeRequest } from '../dist/native-request.js';
import { runCommand } from '../dist/command-runner.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-peer-proof-'));
  initialize(root, { project_id: 'WF-PEER-PROBE' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function plan(root, output, options = {}) {
  const opened = openNativeRequest(root, { requirement: `Create only ${output} with verified hello text.`, context: options.context ?? [] });
  return planNativeRequest(root, opened.request_ref, {
    summary: `Write ${output} and assert its exact bytes.`, requirements: ['The product equals hello followed by a newline.'],
    design: 'One isolated UTF-8 file with an inline Node assertion; no shared files or dependencies.', outputs: [output],
    checks: [{ title: `Assert ${output}`, level: 'acceptance', command: [process.execPath, '-e',
      `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(output)}, 'utf8'), ${JSON.stringify('hello\n')})`] }, ...(options.checks ?? [])],
  });
}

for (const mutation of ['user-addition', 'unproduced-claim', 'edited-peer', 'explicit-context', 'explicit-check', 'pre-existing-input', 'altered-producer-proof']) {
  test(`shared-root dependency fingerprints remain authoritative: ${mutation}`, t => {
    const root = project(t);
    if (mutation === 'pre-existing-input') writeFileSync(join(root, 'beta.txt'), 'Existing user-owned dependency\n');
    const a = plan(root, 'alpha.txt', mutation === 'explicit-context' ? { context: ['beta.txt'] } : mutation === 'explicit-check'
      ? { checks: [{ title: 'Explicit beta dependency', level: 'unit', command: [process.execPath, 'beta.txt'] }] } : {});
    const b = mutation === 'user-addition' ? undefined : plan(root, 'beta.txt');
    implement(root, a, 'alpha.txt');
    const review = nextNativeAssignment(root, a.request_ref);
    assert.equal(review.agentName, 'WF.Reviewer');
    if (mutation === 'user-addition') writeFileSync(join(root, 'unrelated-user.txt'), 'A genuine new user source');
    else if (mutation === 'unproduced-claim') {
      assert.equal(nextNativeAssignment(root, b.request_ref).agentName, 'WF.FnD');
      writeFileSync(join(root, 'beta.txt'), 'No actual completed producer callback exists');
    } else {
      const produced = implement(root, b, 'beta.txt');
      if (mutation === 'edited-peer') writeFileSync(join(root, 'beta.txt'), 'A concurrent user revision');
      if (mutation === 'altered-producer-proof') {
        const proof = getRecord(root, produced.assignments.at(-1).report_record_id);
        writeFileSync(join(root, proof.path), readFileSync(join(root, proof.path), 'utf8') + '\nChanged producer proof.\n');
      }
    }
    const result = callback(root, a, review);
    assert.equal(result.assignments.at(-1).state, 'uncertain', 'Changed source inputs require fresh inspection, regardless of another request ownership');
    assert.equal(result.accepted, false);
    if (mutation === 'pre-existing-input') assert.equal(typeof result.preservation_baseline['beta.txt'], 'string');
  });
}

test('read-only reconciliation preserves historical acceptance and its unchanged durable receipt', async t => {
  const root = project(t), a = plan(root, 'alpha.txt'), b = plan(root, 'beta.txt');
  implement(root, a, 'alpha.txt');
  assert.equal((await completeInspectionAndChecks(root, a)).accepted, true);
  const folder = requestFolderForWorkflow(root, a.request_ref).directory;
  const path = join(root, '.workforce', folder, 'native/execution.json');
  const historical = JSON.parse(readFileSync(path, 'utf8'));
  const bytes = JSON.stringify(historical, null, 2) + '\n';
  writeFileSync(path, bytes);
  implement(root, b, 'beta.txt');
  assert.equal((await completeInspectionAndChecks(root, b)).accepted, true);
  const current = getNativeRequest(root, a.request_ref);
  assert.equal(current.accepted, false, 'A new shared-root input needs current verification');
  assert.equal(current.historical_status, 'accepted');
  assert.equal(readFileSync(path, 'utf8'), bytes, 'History is not rewritten by a new read projection');
});
function callback(root, planned, job, professional) {
  assert.ok(job, 'The backend issued an actual domain assignment.');
  return recordNativeResult(root, { request_ref: planned.request_ref, assignment_ref: job.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true,
      agentName: job.agentName, status: 'returned' },
    raw_result: JSON.stringify(professional ?? { summary: `Test-only observed ${job.agentName} domain outcome.`, verdict: 'pass', findings: [] }) });
}

test('an indirect inline-check dependency cannot stay accepted after a peer repairs its produced bytes', async t => {
  const root = project(t);
  const checkA = [process.execPath, '--input-type=module', '-e',
    "import assert from 'node:assert/strict'; import { value } from './alpha.mjs'; assert.equal(value,1);"];
  const aOpen = openNativeRequest(root, { requirement: 'Expose alpha value one with an actual import assertion.', context: [] });
  const a = planNativeRequest(root, aOpen.request_ref, { summary: 'Expose the imported numeric value.',
    requirements: ['alpha exports numeric value one.'], design: 'An ES module with a runtime import assertion.', outputs: ['alpha.mjs'],
    checks: [{ title: 'Import alpha transitively', level: 'acceptance', command: checkA }] });
  const bOpen = openNativeRequest(root, { requirement: 'Export numeric value two from beta.', context: [] });
  const b = planNativeRequest(root, bOpen.request_ref, { summary: 'Provide beta numeric value two.',
    requirements: ['beta exports numeric value two.'], design: 'An independent ES module.', outputs: ['beta.mjs'],
    checks: [{ title: 'Import beta', level: 'acceptance', command: [process.execPath, '--input-type=module', '-e',
      "import assert from 'node:assert/strict'; import { value } from './beta.mjs'; assert.equal(value,2);"] }] });
  const bFirst = nextNativeAssignment(root, b.request_ref);
  writeFileSync(join(root, 'beta.mjs'), 'export const value = 1;\n');
  callback(root, b, bFirst);
  const aImplementation = nextNativeAssignment(root, a.request_ref);
  writeFileSync(join(root, 'alpha.mjs'), "export { value } from './beta.mjs';\n");
  callback(root, a, aImplementation);
  assert.equal((await completeInspectionAndChecks(root, a)).accepted, true);
  callback(root, b, nextNativeAssignment(root, b.request_ref), { summary: 'Beta violates its own value-two criterion.',
    verdict: 'findings', findings: ['Expected two; current beta exports one.'] });
  resumeNativeRequest(root, b.request_ref);
  const bRepair = nextNativeAssignment(root, b.request_ref);
  assert.equal(bRepair.agentName, 'WF.FnD');
  writeFileSync(join(root, 'beta.mjs'), 'export const value = 2;\n');
  callback(root, b, bRepair);
  const actual = await runCommand({ cwd: root, command: checkA });
  assert.notEqual(actual.exit_code, 0, 'The previously passing real checker now observes the changed indirect dependency');
  const after = getNativeRequest(root, a.request_ref);
  console.log(JSON.stringify({ probe: 'indirect-inline-check-peer-repair', actualExit: actual.exit_code,
    aStatus: after.status, aAccepted: after.accepted, aHistoricalStatus: after.historical_status }));
  assert.equal(after.accepted, false, 'Fresh peer proof cannot replace the exact dependency revision used by earlier acceptance');
});
function implement(root, planned, output) {
  const job = nextNativeAssignment(root, planned.request_ref);
  assert.equal(job.agentName, 'WF.FnD');
  mkdirSync(dirname(join(root, output)), { recursive: true });
  writeFileSync(join(root, output), 'hello\n');
  return callback(root, planned, job);
}
async function completeInspectionAndChecks(root, planned) {
  for (const role of ['WF.Reviewer', 'WF.Tester']) {
    const job = nextNativeAssignment(root, planned.request_ref);
    assert.equal(job?.agentName, role);
    callback(root, planned, job);
  }
  const checked = await runNativeChecks(root, planned.request_ref);
  assert.equal(checked.checks[0].result?.exit_code, 0, checked.checks[0].result?.stderr);
  return finishNativeRequest(root, planned.request_ref);
}

for (const nested of [false, true]) {
  test(`${nested ? 'nested' : 'root'} disjoint outputs retain authoritative membership during interleaved inspection`, async t => {
    const root = project(t), aPath = nested ? 'alpha/product.txt' : 'alpha.txt', bPath = nested ? 'beta/product.txt' : 'beta.txt';
    // Both plans precede either product write. No user-created file is introduced.
    const a = plan(root, aPath), b = plan(root, bPath);
    implement(root, a, aPath);
    const aReview = nextNativeAssignment(root, a.request_ref);
    assert.equal(aReview.agentName, 'WF.Reviewer');
    implement(root, b, bPath);
    const aReviewed = callback(root, a, aReview);
    const bAccepted = await completeInspectionAndChecks(root, b);
    let aAccepted = false, aError;
    try {
      const aTest = nextNativeAssignment(root, a.request_ref);
      if (aTest) callback(root, a, aTest);
      await runNativeChecks(root, a.request_ref);
      aAccepted = finishNativeRequest(root, a.request_ref).accepted;
    } catch (error) { aError = error.message; }
    console.log(JSON.stringify({ probe: 'peer-during-review', nested, aRequest: a.request_ref, bRequest: b.request_ref,
      aReviewState: aReviewed.assignments.at(-1).state, aStatus: getNativeRequest(root, a.request_ref).status,
      aAccepted, bAccepted: bAccepted.accepted, aError }));
    assert.equal(bAccepted.accepted, true);
    assert.equal(aAccepted, nested, nested ? 'A separate nested directory does not change this inspected input scope.'
      : 'A new shared-root input conservatively requires a fresh independent inspection.');
    if (!nested) {
      assert.equal(aReviewed.assignments.at(-1).state, 'uncertain');
      assert.match(aError, /Current independent/);
    }
  });
  test(`${nested ? 'nested' : 'root'} later peer publication preserves truthful current and historical acceptance`, async t => {
    const root = project(t), aPath = nested ? 'alpha/product.txt' : 'alpha.txt', bPath = nested ? 'beta/product.txt' : 'beta.txt';
    const a = plan(root, aPath), b = plan(root, bPath);
    implement(root, a, aPath);
    assert.equal((await completeInspectionAndChecks(root, a)).accepted, true);
    implement(root, b, bPath);
    const bAccepted = await completeInspectionAndChecks(root, b), after = getNativeRequest(root, a.request_ref);
    console.log(JSON.stringify({ probe: 'peer-after-acceptance', nested, aRequest: a.request_ref, bRequest: b.request_ref,
      aStatus: after.status, aHistoricalStatus: after.historical_status, aAccepted: after.accepted, bAccepted: bAccepted.accepted }));
    assert.equal(bAccepted.accepted, true);
    assert.equal(after.accepted, nested, 'Only evidence for an unchanged inspected input scope is currently accepted.');
    assert.equal(after.historical_status, 'accepted');
    assert.equal(after.status, nested ? 'accepted' : 'changed');
  });
}
