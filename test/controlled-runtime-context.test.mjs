import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { controlledRuntimeGuide, controlledRuntimeContextGuide, controlledToolchain } from '../dist/controlled-runtime-context.js';

test('runtime context references trusted guide metadata without repeating setup instructions', () => {
  const metadata = controlledRuntimeContextGuide(), full = controlledRuntimeGuide();
  assert.deepEqual(Object.keys(metadata).sort(), ['exists', 'path', 'project_private_file_read', 'sha256', 'size_bytes', 'source']);
  assert.equal(metadata.source, 'trusted-installed-runtime'); assert.equal(metadata.project_private_file_read, false);
  assert.equal(metadata.path, full.path); assert.equal(metadata.sha256, full.sha256); assert.equal(metadata.size_bytes, full.size_bytes);
  assert.equal('text' in metadata, false); assert.equal('start_line' in metadata, false); assert.equal('truncated' in metadata, false);
  assert.match(full.text, /Backend-owned session/);
  assert.match(full.text, /Successful observations establish the current preflight checkpoint/);
  assert.equal(full.text.includes('Call `runtime_context` with `{}` first'), false);
  assert.equal(controlledRuntimeGuide(2, 100).text, full.text.split(/\r?\n/).slice(1).join('\n').slice(0, 100));
});

function fixture(t, emptyPath = true) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-runtime-context-')));
  const prior = process.env.PATH;
  if (emptyPath) process.env.PATH = '';
  t.after(() => { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, prior };
}

test('invalid optional Python/C paths retain trusted guidance and actual Node context as per-program diagnostics', async t => {
  const { root } = fixture(t);
  const query = { executables: { python: join(root, 'missing', 'python.exe'),
    c11: join(root, 'missing', 'gcc.exe'), cpp17: join(root, 'missing', 'g++.exe') } };
  const context = { guide: controlledRuntimeGuide(), toolchain: await controlledToolchain(root, query) };
  assert.equal(context.guide.source, 'trusted-installed-runtime');
  assert.match(context.guide.text, /Backend-owned session/);
  const node = context.toolchain.observations.find(item => item.program === 'node');
  assert.equal(node.available, true); assert.equal(node.exit_code, 0); assert.match(node.stdout, /^v\d+\./);
  for (const program of ['python', 'c11', 'cpp17']) {
    const observation = context.toolchain.observations.find(item => item.program === program);
    assert.equal(observation.available, false); assert.equal(observation.executable, null);
    assert.equal(observation.rejected_candidate.path, query.executables[program]);
    assert.match(observation.rejected_candidate.reason, /exist|found/i);
    assert.equal('command' in observation, false);
  }
});

test('absolute existing executables of the wrong program are never probed as Python or compilers', async t => {
  const { root } = fixture(t);
  let python = process.execPath;
  try { python = join(root, `python${process.platform === 'win32' ? '.exe' : ''}`); symlinkSync(process.execPath, python); }
  catch (error) { if (error.code !== 'EPERM') throw error; python = process.execPath; }
  const observed = await controlledToolchain(root, { executables: { python, c11: process.execPath, cpp17: process.execPath } });
  for (const program of ['python', 'c11', 'cpp17']) {
    const observation = observed.observations.find(item => item.program === program);
    assert.equal(observation.available, false); assert.equal(observation.executable, null);
    assert.match(observation.rejected_candidate.reason, /program|Python|compiler|type/i);
    assert.equal('command' in observation, false); assert.equal('exit_code' in observation, false);
  }
  assert.equal(observed.observations.find(item => item.program === 'node').available, true);
});

test('a rejected candidate falls back to an actual executable on the enabled process PATH', async t => {
  const { root, prior } = fixture(t, false);
  let selected;
  for (const directory of (prior ?? '').split(delimiter).filter(part => part && isAbsolute(part))) {
    for (const [program, name] of [['python', 'python3'], ['python', 'python'], ['c11', 'gcc'], ['c11', 'clang']]) {
      const path = join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
      try { if (existsSync(path) && statSync(path).isFile()) { selected = { program, path, directory }; break; } } catch {}
    }
    if (selected) break;
  }
  if (!selected) { t.skip('No actual Python/C executable is present on this process PATH.'); return; }
  process.env.PATH = selected.directory;
  const rejected = join(root, 'missing', selected.program === 'python' ? 'python.exe' : 'gcc.exe');
  const result = await controlledToolchain(root, { executables: { [selected.program]: rejected } });
  const observation = result.observations.find(item => item.program === selected.program);
  assert.equal(observation.available, true); assert.equal(observation.exit_code, 0);
  assert.equal(observation.executable, realpathSync(selected.path));
  assert.deepEqual(observation.command, [realpathSync(selected.path), '--version']);
  assert.equal(observation.rejected_candidate.path, rejected);
  assert.match(observation.rejected_candidate.reason, /exist|found/i);
  assert.equal(result.observations.find(item => item.program === 'node').available, true);
});

test('an actual LLVM clang++ alias retains C++ driver invocation when its realpath is clang', async t => {
  const { root, prior } = fixture(t, false);
  let alias;
  for (const directory of (prior ?? '').split(delimiter).filter(part => part && isAbsolute(part))) {
    const path = join(directory, `clang++${process.platform === 'win32' ? '.exe' : ''}`);
    try {
      if (statSync(path).isFile() && /(?:^|[\\/])clang(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(realpathSync(path))) {
        alias = path; break;
      }
    } catch {}
  }
  if (!alias) { t.skip('No actual LLVM clang++ to clang alias is present on this process PATH.'); return; }
  const result = await controlledToolchain(root, { executables: { cpp17: alias } });
  const cpp = result.observations.find(item => item.program === 'cpp17');
  assert.equal(cpp.available, true); assert.equal(cpp.exit_code, 0);
  assert.equal(cpp.executable, alias); assert.deepEqual(cpp.command, [alias, '--version']);
  assert.match(cpp.stdout, /clang version/i);
  assert.equal(cpp.rejected_candidate, undefined);
});
