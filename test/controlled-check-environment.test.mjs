import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { controlledCheckEnvironment } from '../dist/controlled-check-environment.js';

function fixture(t) {
  const base = resolve('artifacts/test-temp'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'wf-check-environment-'));
  t.after(() => { assert.equal(dirname(root), base); rmSync(root, { recursive: true, force: true }); });
  for (const name of ['one', 'two']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'g++.exe'), 'compiler metadata fixture, never executed'); }
  const compiler = join(root, 'one/g++.exe'), build = [compiler, '-std=c++17', 'src/current.cpp', '-o', 'build/current.exe'];
  const run = ['./build/current.exe', '--self-test'], checks = [{ command: build }, { command: run }];
  return { root, compiler, build, run, checks };
}

test('a frozen absolute compiler and its exact later output receive only their compiler directory on child PATH', t => {
  const { root, compiler, build, run, checks } = fixture(t), inherited = { Path: 'C:\\existing-one;C:\\existing-two', PRIVATE: 'must-not-copy' };
  const expected = { PATH: `${win32.dirname(compiler)};${inherited.Path}` };
  assert.deepEqual(controlledCheckEnvironment(root, build, checks, inherited, 'win32'), expected);
  assert.deepEqual(controlledCheckEnvironment(root, run, checks, inherited, 'win32'), expected);
  assert.deepEqual(inherited, { Path: 'C:\\existing-one;C:\\existing-two', PRIVATE: 'must-not-copy' });
  assert.deepEqual(controlledCheckEnvironment(root, run, checks, {}, 'win32'), { PATH: win32.dirname(compiler) });
});

test('separate, joined and absolute -o output forms retain Windows path identity', t => {
  const { root, compiler } = fixture(t);
  for (const output of ['build/current.exe', join(root, 'build/current.exe')]) {
    for (const flags of [['-o', output], [`-o${output}`]]) {
      const build = [compiler, 'src/current.cpp', ...flags], run = ['./BUILD/./current.exe'];
      assert.ok(controlledCheckEnvironment(root, run, [{ command: build }, { command: run }], {}, 'win32'));
    }
  }
});

test('relative, foreign, missing or undeclared compilers never extend the environment', t => {
  const { root, build, run } = fixture(t);
  for (const program of ['g++', './one/g++.exe', join(root, 'one/not-a-compiler.exe'), join(root, 'missing/g++.exe')]) {
    const current = [program, ...build.slice(1)], checks = [{ command: current }, { command: run }];
    assert.equal(controlledCheckEnvironment(root, current, checks, {}, 'win32'), undefined);
    assert.equal(controlledCheckEnvironment(root, run, checks, {}, 'win32'), undefined);
  }
  assert.equal(controlledCheckEnvironment(root, build, [{ command: run }], {}, 'win32'), undefined);
});

test('undeclared executables, future builds, escaped outputs and ambiguous producer directories do not gain PATH entries', t => {
  const { root, build, run, checks } = fixture(t);
  assert.equal(controlledCheckEnvironment(root, ['./build/another.exe'], checks, {}, 'win32'), undefined);
  assert.equal(controlledCheckEnvironment(root, run, [{ command: run }, { command: build }], {}, 'win32'), undefined);
  const escaped = [...build.slice(0, -1), '../outside.exe'], foreign = ['../outside.exe'];
  assert.equal(controlledCheckEnvironment(root, foreign, [{ command: escaped }, { command: foreign }], {}, 'win32'), undefined);
  const other = [join(root, 'two/g++.exe'), ...build.slice(1)];
  assert.equal(controlledCheckEnvironment(root, run, [{ command: build }, { command: other }, { command: run }], {}, 'win32'), undefined);
});

test('unrelated Node/Python checks and non-Windows execution retain their existing environment', t => {
  const { root, build, checks } = fixture(t);
  for (const command of [[process.execPath, 'checks/verify.mjs'], ['python', 'checks/oracle.py'], ['npm', 'test']])
    assert.equal(controlledCheckEnvironment(root, command, [...checks, { command }], { PATH: 'retained' }, 'win32'), undefined);
  assert.equal(controlledCheckEnvironment(root, build, checks, { PATH: 'retained' }, 'linux'), undefined);
});

test('ambiguous output flags are refused and frozen negative compile/run controls keep the same narrow binding', t => {
  const { root, compiler, run } = fixture(t), duplicate = [compiler, 'src/current.cpp', '-o', 'first.exe', '-osecond.exe'];
  assert.deepEqual(controlledCheckEnvironment(root, duplicate, [{ command: duplicate }], {}, 'win32'), { PATH: win32.dirname(compiler) });
  const ambiguousRun = ['./second.exe'];
  assert.equal(controlledCheckEnvironment(root, ambiguousRun, [{ command: duplicate }, { command: ambiguousRun }], {}, 'win32'), undefined);
  const build = [compiler, 'fixtures/wrong.cpp', '-o', 'build/current.exe'];
  const checks = [{ command: ['python', 'checks/verify.py'], negative_controls: [{ command: build }, { command: run }] }];
  assert.deepEqual(controlledCheckEnvironment(root, run, checks, {}, 'win32'), { PATH: win32.dirname(compiler) });
});

test('syntax-only compiler commands need their own DLL context without authorizing an inferred output', t => {
  const { root, compiler } = fixture(t), command = [compiler, '-std=c++17', '-fsyntax-only', 'src/current.cpp'];
  assert.deepEqual(controlledCheckEnvironment(root, command, [{ command }], {}, 'win32'), { PATH: win32.dirname(compiler) });
});

test('versioned and target-prefixed compiler names use the same validation as runtime_context', t => {
  const { root } = fixture(t);
  for (const name of ['clang++-20.exe', 'x86_64-w64-mingw32-gcc.exe']) {
    const compiler = join(root, 'one', name); writeFileSync(compiler, 'compiler metadata fixture, never executed');
    const command = [compiler, '-fsyntax-only', 'src/current.cpp'];
    assert.deepEqual(controlledCheckEnvironment(root, command, [{ command }], {}, 'win32'), { PATH: win32.dirname(compiler) });
  }
});

test('identical consumer argv in different frozen positions cannot pick the first conflicting compiler context', t => {
  const { root, build, run, compiler } = fixture(t), other = [join(root, 'two/g++.exe'), ...build.slice(1)];
  assert.equal(controlledCheckEnvironment(root, run,
    [{ command: build }, { command: run }, { command: other }, { command: run }], {}, 'win32'), undefined);
  assert.deepEqual(controlledCheckEnvironment(root, run,
    [{ command: build }, { command: run }, { command: run }], {}, 'win32'), { PATH: win32.dirname(compiler) });
});
