import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialize, getRecord, requestFolderForWorkflow } from '../dist/storage.js';
import { openNativeRequest, planNativeRequest, nextNativeAssignment, recordNativeResult, runNativeChecks, finishNativeRequest, getNativeRequest, recheckNativeRequest } from '../dist/native-request.js';
import { runCommand } from '../dist/command-runner.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-check-freshness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-CHECK-FRESH' });
  writeFileSync(join(root, 'product.txt'), 'hello');
  return root;
}
function inspected(root, checks) {
  const opened = openNativeRequest(root, { requirement: 'Create a verified text product' });
  const planned = planNativeRequest(root, opened.request_ref, { summary: 'Write hello', requirements: ['Exact hello'], design: 'Text file', outputs: ['product.txt'], checks });
  for (let index = 0; index < 3; index++) {
    const job = nextNativeAssignment(root, planned.request_ref);
    recordNativeResult(root, { request_ref: planned.request_ref, assignment_ref: job.assignment_ref,
      invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: job.agentName, status: 'returned' },
      raw_result: JSON.stringify({ summary: 'Inspected at the host-outcome test seam', verdict: 'pass', findings: [] }) });
  }
  return planned.request_ref;
}

test('an explicit checker added after inspection cannot execute outside the supplied context directories', { timeout: 60000 }, async t => {
  const root = project(t);
  const ref = inspected(root, [{ title: 'Late checker', level: 'acceptance', command: [process.execPath, 'tools/later.cjs'] }]);
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/later.cjs'), "require('node:fs').writeFileSync('.workforce/unreviewed-ran','yes');\n");
  await assert.rejects(runNativeChecks(root, ref), /Current independent/);
  assert.equal(existsSync(join(root, '.workforce/unreviewed-ran')), false);
});

test('checker changes after one result is saved stop before the next command is spawned', { timeout: 60000 }, async t => {
  const root = project(t);
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/check.cjs'), 'process.exit(0);\n');
  const ref = inspected(root, [
    { title: 'First check', level: 'unit', command: [process.execPath, '-e', 'process.exit(0)'] },
    { title: 'Must remain independently inspected', level: 'acceptance', command: [process.execPath, 'tools/check.cjs'] },
  ]);
  const result = await runNativeChecks(root, ref, { onCheckComplete({ index }) {
    if (index === 0) writeFileSync(join(root, 'tools/check.cjs'), "require('node:fs').writeFileSync('.workforce/unreviewed-ran','yes');\n");
  } });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.checks[1].execution_id, undefined);
  assert.equal(existsSync(join(root, '.workforce/unreviewed-ran')), false);
});

const compiler = process.platform === 'win32' ? 'C:/msys64/mingw64/bin/gcc.exe' : '/usr/bin/gcc';
const executable = name => process.platform === 'win32' ? `${name}.exe` : name;
async function compiledProject(t) {
  const root = project(t);
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'program.c'), '#include <stdio.h>\nint main(void){puts("expected");return 0;}\n');
  writeFileSync(join(root, 'replacement.c'), '#include <stdio.h>\nint main(void){FILE *f=fopen(".workforce/replacement-ran","w");if(f)fclose(f);return 0;}\n');
  const replacement = `build/${executable('replacement')}`, product = `build/${executable('program')}`;
  const built = await runCommand({ cwd: root, command: [compiler, '-std=c11', '-static', 'replacement.c', '-o', replacement] });
  assert.equal(built.exit_code, 0, built.stderr);
  const ref = inspected(root, [
    { title: 'Compile actual current source', level: 'integration', command: [compiler, '-std=c11', '-static', 'program.c', '-o', product] },
    { title: 'Execute actual built binary', level: 'acceptance', command: [join(root, product)] },
  ]);
  return { root, ref, replacement, product };
}

test('a generated executable cannot be replaced between its producer and its consumer', { timeout: 90000, skip: !existsSync(compiler) }, async t => {
  const { root, ref, replacement, product } = await compiledProject(t);
  const result = await runNativeChecks(root, ref, { onCheckComplete({ index }) {
    if (index === 0) copyFileSync(join(root, replacement), join(root, product));
  } });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.checks[1].execution_id, undefined);
  assert.equal(existsSync(join(root, '.workforce/replacement-ran')), false);
});

test('changing the generated binary after acceptance invalidates current evidence without rewriting its history', { timeout: 90000, skip: !existsSync(compiler) }, async t => {
  const { root, ref, replacement, product } = await compiledProject(t);
  await runNativeChecks(root, ref);
  const accepted = finishNativeRequest(root, ref);
  assert.equal(accepted.accepted, true);
  const priorDelivery = getRecord(root, accepted.final_report_id);
  const priorBytes = readFileSync(join(root, priorDelivery.path));
  copyFileSync(join(root, replacement), join(root, product));
  const changed = getNativeRequest(root, ref);
  assert.equal(changed.accepted, false);
  assert.equal(changed.historical_status, 'accepted');
  recheckNativeRequest(root, ref);
  await runNativeChecks(root, ref);
  const renewed = finishNativeRequest(root, ref);
  assert.equal(renewed.accepted, true);
  assert.notEqual(renewed.final_report_id, accepted.final_report_id);
  assert.deepEqual(readFileSync(join(root, priorDelivery.path)), priorBytes);
  // A runtime upgrade must not invent producer hashes for old accepted runs.
  const folder = requestFolderForWorkflow(root, ref);
  const statePath = join(root, '.workforce', folder.directory, 'native/execution.json');
  const oldState = JSON.parse(readFileSync(statePath)); delete oldState.generated_hashes;
  for (const check of oldState.checks) { delete check.generated_inputs; delete check.generated_outputs; }
  writeFileSync(statePath, JSON.stringify(oldState));
  assert.equal(getNativeRequest(root, ref).accepted, false);
  recheckNativeRequest(root, ref);
  await runNativeChecks(root, ref);
  assert.equal(finishNativeRequest(root, ref).accepted, true);
  assert.equal(getNativeRequest(root, ref).assignments.length, 3, 'no model result is regenerated for unchanged source');
  assert.deepEqual(readFileSync(join(root, priorDelivery.path)), priorBytes);
});
