import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deriveWorkForcePrerequisite, probeWorkForcePrerequisite } from '../dist/workforce-prerequisites.js';

const temporary = resolve('artifacts/test-temp');
function fixture(t) {
  mkdirSync(temporary, { recursive: true }); const container = mkdtempSync(join(temporary, 'wf-prerequisites-'));
  const root = join(container, 'project'), toolchain = join(container, 'toolchain'); mkdirSync(root); mkdirSync(toolchain);
  t.after(() => { assert.equal(dirname(container), temporary); rmSync(container, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, toolchain };
}
test('derivation requires a real backend start/resolution failure and a fixed recognized program class', () => {
  for (const [executable, kind] of [['node', 'node'], ['python3', 'python'], ['gcc', 'c11'], ['arm-none-eabi-gcc', 'c11'], ['g++', 'cpp17'], ['clang++', 'cpp17'], ['npm', 'npm'], ['npx', 'npm']]) {
    const input = deriveWorkForcePrerequisite([executable, 'untrusted-product-argument'], 'Command could not start (ENOENT).');
    assert.equal(input.kind, kind); assert.equal(input.executable, executable);
    assert.match(input.command_sha256, /^[a-f0-9]{64}$/); assert.match(input.failure_sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(input, 'arguments'), false, 'No model command arguments become a version-probe execution.');
  }
  for (const [command, error] of [ [['bash', '-c', 'anything'], 'ENOENT'], [['node'], 'Please install Node for me.'], [['scripts/gcc'], 'ENOENT'],
    [['node\0anything'], 'ENOENT'], [[], 'ENOENT'], [['project-checker'], 'NOT_FOUND'], [['gcc'], null] ])
    assert.equal(deriveWorkForcePrerequisite(command, error), undefined);
  assert.equal(deriveWorkForcePrerequisite(['python3', 'check.py'], 'Not found on the enabled Bridge process PATH. A fixed diagnostic.').kind, 'python');
  assert.equal(deriveWorkForcePrerequisite(['npm', 'test'], 'The installed Windows npm launcher could not be resolved without a shell.').kind, 'npm');
});

test('installing the actual known executable into the same existing PATH restores observation without a config edit or product argv', { timeout: 30000 }, async t => {
  const { root, toolchain } = fixture(t), previous = process.env.PATH;
  process.env.PATH = toolchain;
  try {
    const marker = join(root, 'must-not-run.txt'), reference = deriveWorkForcePrerequisite(['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong')`], 'Command could not start (ENOENT).');
    const before = await probeWorkForcePrerequisite(root, reference); assert.equal(before.ready, false); assert.equal(before.reason, 'exact-executable-unavailable');
    const installed = join(toolchain, process.platform === 'win32' ? 'node.exe' : 'node'); copyFileSync(process.execPath, installed);
    const restored = await probeWorkForcePrerequisite(root, reference), repeated = await probeWorkForcePrerequisite(root, reference);
    assert.equal(restored.ready, true); assert.equal(restored.executable, installed); assert.match(restored.version_output_sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(restored.evidence_sha256, before.evidence_sha256); assert.equal(restored.evidence_sha256, repeated.evidence_sha256);
    assert.equal(existsSync(marker), false, 'Only --version ran; the failed producer/check argv was never replayed.');
  } finally { process.env.PATH = previous; }
});

test('a renamed wrong program is not a restored compiler and a project-authored executable gains no probe authority', { timeout: 30000 }, async t => {
  const { root, toolchain } = fixture(t), candidate = join(toolchain, process.platform === 'win32' ? 'gcc.exe' : 'gcc');
  copyFileSync(process.execPath, candidate);
  const wrong = await probeWorkForcePrerequisite(root, deriveWorkForcePrerequisite([candidate, 'solution.c'], 'EACCES'));
  assert.equal(wrong.ready, false);
  const projectCandidate = join(root, process.platform === 'win32' ? 'node.exe' : 'node'); linkSync(candidate, projectCandidate);
  const untrusted = await probeWorkForcePrerequisite(root, deriveWorkForcePrerequisite([projectCandidate, '--version'], 'ENOENT'));
  assert.equal(untrusted.ready, false); assert.equal(untrusted.executable, null);
});

test('an actually installed npm can be observed with fixed --version and cancellation cannot trigger a product command', { timeout: 30000 }, async t => {
  const { root } = fixture(t), npm = deriveWorkForcePrerequisite(['npm', 'install', 'must-not-install-anything'], 'Command could not start (ENOENT).');
  const observed = await probeWorkForcePrerequisite(root, npm);
  assert.equal(observed.kind, 'npm'); assert.equal(observed.ready, true); assert.match(observed.version_output_sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(root, 'node_modules')), false);
  await assert.rejects(probeWorkForcePrerequisite(root, deriveWorkForcePrerequisite([process.execPath, '-e', 'throw Error("must not execute")'], 'ENOENT'), AbortSignal.abort()), { name: 'AbortError' });
});
