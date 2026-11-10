import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installedWindowsCompilerCandidates, resolveWindowsCompilerExecutable } from '../dist/compiler-executable.js';

test('conventional installed candidates retain exact compiler driver names', () => {
  assert.deepEqual(installedWindowsCompilerCandidates(['gcc', 'g++', 'clang-18', 'arm-none-eabi-gcc', '../gcc'], { SystemDrive: 'D:' }),
    ['ucrt64', 'mingw64', 'clang64'].flatMap(name => ['gcc', 'g++', 'clang-18'].map(driver => `D:/msys64/${name}/bin/${driver}.exe`)));
});

test('compiler discovery retains explicit, cross-compiler and unknown program identity on every platform', () => {
  for (const program of [join(resolve('artifacts'), 'missing', 'gcc.exe'), './gcc', 'bin/g++', 'arm-none-eabi-gcc', 'not-a-compiler'])
    assert.equal(resolveWindowsCompilerExecutable(program, { PATH: '' }), undefined);
  if (process.platform !== 'win32')
    for (const driver of ['gcc', 'g++', 'clang', 'clang++'])
      assert.equal(resolveWindowsCompilerExecutable(driver, { PATH: '/usr/bin' }), undefined);
});

test('Windows compiler resolution uses the exact PATH driver before conventional installed tools', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-compiler-path-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  // Resolution is observed without executing these fixture bytes. A matching
  // directory, another compiler class or the working directory is insufficient.
  writeFileSync(join(root, 'gcc.exe'), 'fixture; not executed');
  mkdirSync(join(root, 'g++.exe'));
  assert.equal(resolveWindowsCompilerExecutable('gcc', { Path: root }), join(root, 'gcc.exe'));
  assert.notEqual(resolveWindowsCompilerExecutable('g++', { Path: root }), join(root, 'g++.exe'));
  assert.equal(resolveWindowsCompilerExecutable('clang-65535', { Path: root }), undefined);
});
