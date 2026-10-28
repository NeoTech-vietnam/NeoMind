import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand } from '../dist/command-runner.js';

test('Windows npm executes its Node CLI with literal argv rather than interpreting a batch shim', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf npm literal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules/npm/bin'), { recursive: true });
  writeFileSync(join(root, 'npm.cmd'), 'THIS SHIM MUST NEVER EXECUTE');
  writeFileSync(join(root, 'node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: '0.0.0-fixture' }));
  writeFileSync(join(root, 'node_modules/npm/bin/npm-cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const literal = '& echo injected > unintended.txt', env = { PATH: `${root}${delimiter}${dirname(process.execPath)}` };
  const result = await runCommand({ cwd: root, command: ['npm.cmd', '--literal', literal, '%PATH%', '!value!'], env });
  assert.equal(result.error, null); assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ['--literal', literal, '%PATH%', '!value!']);
  assert.equal(existsSync(join(root, 'unintended.txt')), false);
});
test('existing Windows npm project test script runs through the async runner', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf npm project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test project.test.cjs' } }));
  writeFileSync(join(root, 'project.test.cjs'), 'const test=require("node:test"),assert=require("node:assert/strict");test("actual project",()=>assert.equal(6*7,42));');
  const result = await runCommand({ cwd: root, command: ['npm', 'test'], timeout_ms: 30000 });
  assert.equal(result.error, null); assert.equal(result.exit_code, 0, result.stderr);
  assert.match(result.stdout, /actual project/);
});
