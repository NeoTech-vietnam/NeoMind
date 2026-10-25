import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hash } from '../dist/storage.js';
import { ControlledExecutionError, controlledExecutionSchema, controlledExecutionDeclarationSchema,
  validateControlledExecutionDeclaration, prepareControlledExecution, runControlledExecution,
  rollbackControlledExecutionOutputs } from '../dist/controlled-execution.js';

function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-execution-')));
  for (const path of ['scripts', 'generated', 'checks', '.agents/skills/example/scripts']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'scripts/generate.mjs'), 'import {writeFileSync} from "node:fs"; let text=""; for await(const chunk of process.stdin)text+=chunk; const input=JSON.parse(text); writeFileSync("generated/value.txt",input.content,{flag:"wx"}); console.log("generated");\n');
  writeFileSync(join(root, 'scripts/input.txt'), 'preserved input\n');
  const binding = { stage: 'implementation', role: 'developer', implementation_paths: ['generated'], verification_paths: ['checks'],
    preserved_hashes: { 'scripts/generate.mjs': hash(readFileSync(join(root, 'scripts/generate.mjs'))),
      'scripts/input.txt': hash(readFileSync(join(root, 'scripts/input.txt'))) } };
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, binding };
}
const request = (extra = {}) => ({ title: 'Generate the requested value', command: [process.execPath, 'scripts/generate.mjs'],
  input: { content: 'actual semantic input' }, input_paths: [], output_paths: ['generated/value.txt'], ...extra });
const coded = code => error => error instanceof ControlledExecutionError && error.code === code;

test('declaration and request expose semantic inputs without caller identity, cwd or hashes', () => {
  const declaration = { title: 'Observe Node', command: ['node', '--version'], output_paths: [] };
  assert.equal(controlledExecutionDeclarationSchema.safeParse(declaration).success, true);
  assert.equal(controlledExecutionDeclarationSchema.safeParse({ ...declaration, input: {} }).success, false);
  for (const field of ['workflow_id', 'task_id', 'invocation_id', 'contract_hash', 'cwd', 'env', 'shell'])
    assert.equal(controlledExecutionSchema.safeParse({ ...declaration, [field]: 'forged' }).success, false, field);
});

test('planning preflight is read-only and permits future scripts/dependencies only inside producer scope', t => {
  const { root, binding } = fixture(t);
  const declaration = { title: 'Run a future authored producer', command: [process.execPath, 'generated/future.mjs'],
    input_paths: ['generated/input.json'], output_paths: ['generated/future-output.txt'] };
  assert.deepEqual(validateControlledExecutionDeclaration(root, binding, declaration), declaration);
  assert.equal(existsSync(join(root, 'generated/future.mjs')), false);
  assert.equal(existsSync(join(root, 'generated/input.json')), false);
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.throws(() => prepareControlledExecution(root, binding, declaration), coded('INVALID_EXECUTION'));
  for (const path of ['scripts/not-authored.mjs', 'checks/not-authored.mjs', '.agents/skills/example/scripts/not-authored.mjs'])
    assert.throws(() => validateControlledExecutionDeclaration(root, binding,
      { ...declaration, command: [process.execPath, path] }), ControlledExecutionError, path);
  assert.throws(() => validateControlledExecutionDeclaration(root, binding,
    { ...declaration, input_paths: ['scripts/not-authored.json'] }), coded('SCOPE_DENIED'));
});

test('input duplicates, output duplicates and file-prefix overlaps are rejected in planning and execution', t => {
  const { root, binding } = fixture(t);
  const cases = [
    request({ input_paths: ['scripts/input.txt', 'scripts/input.txt'] }),
    request({ output_paths: ['generated/value.txt', 'generated/value.txt'] }),
    request({ output_paths: ['generated/path', 'generated/path/nested.txt'] }),
    request({ input_paths: ['generated/input'], output_paths: ['generated/input/nested.txt'] }),
  ];
  for (const source of cases) {
    assert.throws(() => prepareControlledExecution(root, binding, source), ControlledExecutionError);
    const { input, ...declaration } = source;
    assert.throws(() => validateControlledExecutionDeclaration(root, binding, declaration), ControlledExecutionError);
  }
});

test('real direct JSON execution preserves input hashes and returns observed output evidence', async t => {
  const { root, binding } = fixture(t), before = JSON.stringify(binding), prepared = prepareControlledExecution(root, binding, request());
  assert.equal(prepared.cwd, root);
  assert.equal(prepared.input_sha256, hash(JSON.stringify(request().input)));
  assert.equal(prepared.baseline['scripts/generate.mjs'], binding.preserved_hashes['scripts/generate.mjs']);
  assert.equal(existsSync(join(root, 'generated/value.txt')), false, 'Preparing is read-only.');
  let activeChecks = 0, pid;
  const result = await runControlledExecution(prepared, { assertActive() { activeChecks++; }, onStart(value) { pid = value; } });
  assert.equal(activeChecks, 2); assert.ok(pid > 0); assert.equal(result.passed, true);
  assert.equal(result.result.exit_code, 0); assert.equal(result.result.stdout.trim(), 'generated');
  assert.equal(readFileSync(join(root, 'generated/value.txt'), 'utf8'), 'actual semantic input');
  assert.equal(result.output_hashes['generated/value.txt'], hash('actual semantic input'));
  assert.deepEqual(result.changed_inputs, []); assert.deepEqual(result.missing_outputs, []);
  assert.equal(JSON.stringify(binding), before);
  assert.equal('stdin' in result, false, 'Public execution result does not repeat source/input content.');
});

test('only developer scope can execute and no checker, preserved, private or escaping output is accepted', t => {
  const { root, binding } = fixture(t);
  for (const role of ['manager', 'verifier', 'reviewer'])
    assert.throws(() => prepareControlledExecution(root, { ...binding, role }, request()), coded('SCOPE_DENIED'));
  assert.throws(() => prepareControlledExecution(root, { ...binding, stage: 'verification' }, request()), coded('SCOPE_DENIED'));
  for (const path of ['checks/value.txt', 'scripts/generate.mjs', 'elsewhere/value.txt', 'generated/.env', '../escape.txt', 'generated/../escape.txt'])
    assert.throws(() => prepareControlledExecution(root, binding, request({ output_paths: [path] })), ControlledExecutionError, path);
  assert.throws(() => prepareControlledExecution(root, { ...binding, protected_paths: ['generated/protected'] },
    request({ output_paths: ['generated/protected/value.txt'] })), coded('SCOPE_DENIED'));
});

test('shells, inline evaluation, private scripts, absolute arguments and symlink scripts fail before start', t => {
  const { root, binding } = fixture(t);
  const invalid = [
    [process.execPath, '-e', 'process.exit(0)'], [process.execPath, '--eval=process.exit(0)'],
    [process.execPath, '--require', 'scripts/generate.mjs'],
    [process.execPath, '--require=scripts/generate.mjs'],
    [process.execPath, '.neomind/controlled/secret.mjs'],
    [process.execPath, 'scripts/generate.mjs', '../outside.json'],
    [process.execPath, 'scripts/generate.mjs', '--input=-../../outside.json'],
    [process.execPath, 'scripts/generate.mjs', '-f../outside.json'],
    [process.execPath, 'scripts/generate.mjs', join(root, 'scripts/input.txt')],
    [process.execPath, 'scripts/generate.mjs', '--input=.env'],
  ];
  for (const command of invalid) assert.throws(() => prepareControlledExecution(root, binding, request({ command })), ControlledExecutionError, command.join(' '));
  const shell = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/cmd.exe') : '/bin/sh';
  assert.throws(() => prepareControlledExecution(root, binding, request({ command: [shell, '--version'] })), coded('INVALID_EXECUTION'));
  try { symlinkSync(join(root, 'scripts/generate.mjs'), join(root, 'scripts/link.mjs')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => prepareControlledExecution(root, binding, request({ command: [process.execPath, 'scripts/link.mjs'] })), coded('INVALID_EXECUTION'));
  assert.equal(existsSync(join(root, 'generated/value.txt')), false);
});

test('approved exact hidden script is executable without widening private configuration or write permission', async t => {
  const { root, binding } = fixture(t), path = '.agents/skills/example/scripts/helper.mjs';
  writeFileSync(join(root, path), 'console.log("approved input script");\n');
  assert.throws(() => prepareControlledExecution(root, binding, request({ command: [process.execPath, path], input: undefined, output_paths: [] })), coded('PRIVATE_PATH'));
  const approved = { ...binding, approved_inputs: [path] };
  const result = await runControlledExecution(prepareControlledExecution(root, approved,
    request({ command: [process.execPath, path], input: undefined, output_paths: [] })), { assertActive() {} });
  assert.equal(result.passed, true); assert.match(result.result.stdout, /approved input script/);
  assert.throws(() => prepareControlledExecution(root, approved, request({ output_paths: [path] })), coded('PRIVATE_PATH'));
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex/config.mjs'), 'console.log("private config");\n');
  assert.throws(() => prepareControlledExecution(root, { ...binding, approved_inputs: ['.codex/config.mjs'] },
    request({ command: [process.execPath, '.codex/config.mjs'], input: undefined, output_paths: [] })), coded('PRIVATE_PATH'));
});

test('new-only outputs and immutable prestart baselines reject collision or user edits', async t => {
  const { root, binding } = fixture(t), prepared = prepareControlledExecution(root, binding, request());
  writeFileSync(join(root, 'scripts/input.txt'), 'user edit survives\n');
  await assert.rejects(runControlledExecution(prepared, { assertActive() {} }), coded('INPUT_CHANGED'));
  assert.equal(existsSync(join(root, 'generated/value.txt')), false);
  assert.equal(readFileSync(join(root, 'scripts/input.txt'), 'utf8'), 'user edit survives\n');
  const current = { ...binding, preserved_hashes: {} };
  writeFileSync(join(root, 'generated/value.txt'), 'existing authored output\n');
  assert.throws(() => prepareControlledExecution(root, current, request()), coded('OUTPUT_EXISTS'));
  assert.equal(readFileSync(join(root, 'generated/value.txt'), 'utf8'), 'existing authored output\n');
});

test('actual mutation, missing outputs and nonzero exits cannot become passing execution evidence', async t => {
  const { root, binding } = fixture(t);
  writeFileSync(join(root, 'scripts/mutate.mjs'), 'import{writeFileSync}from"node:fs";writeFileSync("scripts/input.txt","changed by child");\n');
  const mutation = await runControlledExecution(prepareControlledExecution(root, binding,
    request({ command: [process.execPath, 'scripts/mutate.mjs'], input: undefined })), { assertActive() {} });
  assert.equal(mutation.passed, false); assert.deepEqual(mutation.changed_inputs, ['scripts/input.txt']);
  assert.deepEqual(mutation.missing_outputs, ['generated/value.txt']);
  writeFileSync(join(root, 'scripts/fail.mjs'), 'console.error("actual failure");process.exit(7);\n');
  const failure = await runControlledExecution(prepareControlledExecution(root, { ...binding, preserved_hashes: {} },
    request({ command: [process.execPath, 'scripts/fail.mjs'], input: undefined, output_paths: [] })), { assertActive() {} });
  assert.equal(failure.passed, false); assert.equal(failure.result.exit_code, 7); assert.match(failure.result.stderr, /actual failure/);
});

test('real version observation is bounded and cannot claim payload or project effects', async t => {
  const { root, binding } = fixture(t);
  const observation = { title: 'Observe Node', command: [process.execPath, '--version'], output_paths: [] };
  const result = await runControlledExecution(prepareControlledExecution(root, binding, observation), { assertActive() {} });
  assert.equal(result.passed, true); assert.match(result.result.stdout.trim(), /^v\d+\./);
  assert.equal(result.executable, realpathSync.native(process.execPath));
  assert.throws(() => prepareControlledExecution(root, binding, { ...observation, input: {} }), coded('INVALID_EXECUTION'));
  assert.throws(() => prepareControlledExecution(root, binding, { ...observation, output_paths: ['generated/version.txt'] }), coded('INVALID_EXECUTION'));
});

test('existing runner cancellation, timeout and output bounds remain actual failure evidence', async t => {
  const { root, binding } = fixture(t);
  writeFileSync(join(root, 'scripts/wait.mjs'), 'setInterval(()=>{},1000);\n');
  writeFileSync(join(root, 'scripts/loud.mjs'), 'process.stdout.write("a".repeat(2048));setInterval(()=>{},1000);\n');
  const stopped = new AbortController(); stopped.abort(); let started = false;
  const cancelled = await runControlledExecution(prepareControlledExecution(root, binding,
    request({ command: [process.execPath, 'scripts/wait.mjs'], input: undefined, output_paths: [] })),
    { assertActive() {}, signal: stopped.signal, onStart() { started = true; } });
  assert.equal(started, false); assert.equal(cancelled.result.cancelled, true); assert.equal(cancelled.passed, false);
  const timed = await runControlledExecution(prepareControlledExecution(root, binding,
    request({ command: [process.execPath, 'scripts/wait.mjs'], input: undefined, output_paths: [], timeout_ms: 100 })), { assertActive() {} });
  assert.equal(timed.result.timed_out, true); assert.equal(timed.passed, false);
  const capped = await runControlledExecution(prepareControlledExecution(root, binding,
    request({ command: [process.execPath, 'scripts/loud.mjs'], input: undefined, output_paths: [], max_output_bytes: 512 })), { assertActive() {} });
  assert.equal(capped.result.output_limited, true); assert.equal(capped.passed, false);
  assert.ok(Buffer.byteLength(capped.result.stdout) + Buffer.byteLength(capped.result.stderr) <= 512);
});

test('structured input cap and authoritative cancellation fail before any owned output exists', async t => {
  const { root, binding } = fixture(t);
  assert.throws(() => prepareControlledExecution(root, binding, request({ input: { content: 'x'.repeat(1024 * 1024) } })), coded('INVALID_EXECUTION'));
  await assert.rejects(runControlledExecution(prepareControlledExecution(root, binding, request()),
    { assertActive() { throw new Error('inactive invocation'); } }), /inactive invocation/);
  assert.equal(existsSync(join(root, 'generated/value.txt')), false);
});

function partialGenerator(root) {
  writeFileSync(join(root, 'scripts/partial.mjs'), 'import{mkdirSync,writeFileSync}from"node:fs";let text="";for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);mkdirSync("generated/new/deep",{recursive:true});writeFileSync("generated/new/deep/one.txt",input.content,{flag:"wx"});if(input.fail)process.exit(1);writeFileSync("generated/new/deep/two.txt","complete",{flag:"wx"});\n');
  return request({ command: [process.execPath, 'scripts/partial.mjs'], input: { content: 'partial retained bytes', fail: true },
    output_paths: ['generated/new/deep/one.txt', 'generated/new/deep/two.txt'] });
}

test('actual partial generator failure is retained and rolled back before corrected input retries the same declared outputs', async t => {
  const { root, binding } = fixture(t), input = partialGenerator(root);
  const prepared = prepareControlledExecution(root, binding, input);
  assert.deepEqual(prepared.missing_parent_paths, ['generated/new/deep', 'generated/new']);
  const failed = await runControlledExecution(prepared, { assertActive() {} });
  assert.equal(failed.passed, false); assert.equal(failed.result.exit_code, 1);
  const unchangedReceipt = JSON.stringify(failed);
  mkdirSync(join(root, '.neomind/controlled/failure'), { recursive: true });
  writeFileSync(join(root, '.neomind/controlled/failure/result.json'), unchangedReceipt, { flag: 'wx' });
  const rollback = rollbackControlledExecutionOutputs(prepared, failed, '.neomind/controlled/failure/outputs');
  assert.equal(rollback.complete, true); assert.equal(rollback.archived.length, 1);
  assert.equal(rollback.archived[0].removed, true);
  assert.equal(readFileSync(join(root, rollback.archived[0].archive_path), 'utf8'), 'partial retained bytes');
  assert.equal(rollback.archived[0].sha256, hash('partial retained bytes'));
  assert.deepEqual(rollback.removed_directories, ['generated/new/deep', 'generated/new']);
  assert.equal(existsSync(join(root, 'generated/new')), false);
  assert.equal(existsSync(join(root, 'generated')), true, 'Pre-existing parent directory survives.');
  assert.equal(JSON.stringify(failed), unchangedReceipt, 'Failed execution history stays unchanged.');
  assert.equal(readFileSync(join(root, '.neomind/controlled/failure/result.json'), 'utf8'), unchangedReceipt);
  assert.equal(rollbackControlledExecutionOutputs(prepared, failed, '.neomind/controlled/failure/outputs').complete, true,
    'A completed rollback is readable without replaying a deletion.');
  const corrected = prepareControlledExecution(root, binding, { ...input, input: { content: 'corrected value', fail: false } });
  assert.notEqual(corrected.payload_hash, prepared.payload_hash);
  const success = await runControlledExecution(corrected, { assertActive() {} });
  assert.equal(success.passed, true); assert.equal(readFileSync(join(root, 'generated/new/deep/one.txt'), 'utf8'), 'corrected value');
  assert.equal(readFileSync(join(root, 'generated/new/deep/two.txt'), 'utf8'), 'complete');
  assert.equal(rollbackControlledExecutionOutputs(corrected, success, '.neomind/controlled/success-rollback').complete, false);
  assert.equal(readFileSync(join(root, 'generated/new/deep/one.txt'), 'utf8'), 'corrected value', 'Passing outputs cannot be rolled back.');
});

test('failed output rollback preserves user-edited files, changed inputs and unexpected directory contents', async t => {
  const { root, binding } = fixture(t), input = partialGenerator(root);
  const prepared = prepareControlledExecution(root, binding, input), failed = await runControlledExecution(prepared, { assertActive() {} });
  writeFileSync(join(root, 'generated/new/deep/one.txt'), 'user content after failed process');
  const edited = rollbackControlledExecutionOutputs(prepared, failed, '.neomind/controlled/edited-output');
  assert.equal(edited.complete, false); assert.ok(edited.uncertain_paths.includes('generated/new/deep/one.txt'));
  assert.equal(readFileSync(join(root, 'generated/new/deep/one.txt'), 'utf8'), 'user content after failed process');
  writeFileSync(join(root, 'generated/new/deep/one.txt'), 'partial retained bytes');
  writeFileSync(join(root, 'scripts/input.txt'), 'external preserved input edit');
  const changedInput = rollbackControlledExecutionOutputs(prepared, failed, '.neomind/controlled/edited-input');
  assert.equal(changedInput.complete, false); assert.equal(changedInput.archived.length, 0);
  assert.equal(readFileSync(join(root, 'generated/new/deep/one.txt'), 'utf8'), 'partial retained bytes');
  writeFileSync(join(root, 'scripts/input.txt'), 'preserved input\n');
  writeFileSync(join(root, 'generated/new/deep/user.txt'), 'unexpected authored file');
  const unexpected = rollbackControlledExecutionOutputs(prepared, failed, '.neomind/controlled/unexpected-content');
  assert.equal(unexpected.complete, false); assert.equal(unexpected.archived[0].removed, true);
  assert.ok(unexpected.uncertain_paths.includes('generated/new/deep'));
  assert.equal(readFileSync(join(root, 'generated/new/deep/user.txt'), 'utf8'), 'unexpected authored file');
  assert.equal(existsSync(join(root, 'generated/new/deep/one.txt')), false);
});

test('retained rollback completion never deletes a later recreated file with identical bytes', async t => {
  const { root, binding } = fixture(t), input = partialGenerator(root);
  const prepared = prepareControlledExecution(root, binding, input), failed = await runControlledExecution(prepared, { assertActive() {} });
  const archive = '.neomind/controlled/recreated-file';
  assert.equal(rollbackControlledExecutionOutputs(prepared, failed, archive).complete, true);
  mkdirSync(join(root, 'generated/new/deep'), { recursive: true });
  writeFileSync(join(root, 'generated/new/deep/one.txt'), 'partial retained bytes');
  const repeated = rollbackControlledExecutionOutputs(prepared, failed, archive);
  assert.equal(repeated.complete, false); assert.ok(repeated.uncertain_paths.includes('generated/new/deep/one.txt'));
  assert.equal(readFileSync(join(root, 'generated/new/deep/one.txt'), 'utf8'), 'partial retained bytes');
});
