import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WindowsJobScope } from '../src/adapters/windows-job.js';
import { stopExistingWorkerScope } from '../src/adapters/worker-scope.js';
import { resolveHostCommand } from '../src/adapters/worker-environment.js';
import { windowsHelperPath, windowsProcessInfo } from '../src/platform/windows-helper.js';
import { ownerLiveness } from '../src/storage/process-identity.js';

const windows = process.platform === 'win32';
const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const helper = (...args: string[]) => execFileSync(windowsHelperPath(), args, { encoding: 'utf8', windowsHide: true }).trim();

test('job recovery refuses malformed and cross-platform identities before invoking the helper', async () => {
  assert.equal(await WindowsJobScope.stopExisting({ unit: 'other.job', controlGroup: 'windows-job:Global\\other' }), false);
  const name = `neomind-run-${randomUUID()}`;
  assert.equal(await WindowsJobScope.stopExisting({ unit: `${name}.job`, controlGroup: `windows-job:Global\\neomind-run-${randomUUID()}` }), false);
  assert.equal(await WindowsJobScope.stopExisting({ unit: `${name}.job`, controlGroup: `windows-job:Local\\${name}` }), false);
  // A Linux scope is never confirmed stopped on Windows, and vice versa.
  const foreign = windows ? { unit: `${name}.scope`, controlGroup: `/user.slice/user-1000.slice/${name}.scope` } : { unit: `${name}.job`, controlGroup: `windows-job:Global\\${name}` };
  assert.equal(await stopExistingWorkerScope(foreign), false);
});

test('a Windows job contains grandchildren, stops them all and dies with its supervisor', { skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  const start = async () => {
    const name = `neomind-run-${randomUUID()}`;
    const child = spawn(windowsHelperPath(), ['run', name, powershell(), '-NoProfile', '-NonInteractive', '-Command',
      "$p = Start-Process -PassThru -NoNewWindow powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 120'; Write-Output $p.Id; Start-Sleep 120"], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const pid = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Grandchild did not start')), 20000);
      child.stdout.on('data', chunk => { output += String(chunk); const match = /^(\d+)\s/m.exec(output); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    return { name, child, pid };
  };
  const stopped = await start();
  try {
    assert.equal(windowsProcessInfo(stopped.pid)?.state, 'alive');
    assert.match(helper('query', stopped.name), /^active [3-9]\d*$/);
    assert.ok(await WindowsJobScope.stopExisting({ unit: `${stopped.name}.job`, controlGroup: `windows-job:Global\\${stopped.name}` }));
    assert.equal(helper('query', stopped.name), 'absent');
    assert.notEqual(windowsProcessInfo(stopped.pid)?.state, 'alive');
  } finally { stopped.child.kill(); }

  const crashed = await start();
  crashed.child.kill(); // TerminateProcess on the supervisor closes the only job handle.
  await new Promise<void>(resolve => crashed.child.once('exit', () => resolve()));
  for (let n = 0; n < 50 && helper('query', crashed.name) !== 'absent'; n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(helper('query', crashed.name), 'absent');
  assert.notEqual(windowsProcessInfo(crashed.pid)?.state, 'alive');
});

test('Windows process identity distinguishes live, exited and reused processes', { skip: !windows && 'Windows only', timeout: 30000 }, async () => {
  const self = windowsProcessInfo(process.pid)!;
  assert.equal(self.state, 'alive'); assert.match(self.bootId, /^\d+$/);
  assert.equal(ownerLiveness({ pid: process.pid, startTicks: self.start, bootId: self.bootId }), 'alive');
  assert.equal(ownerLiveness({ pid: process.pid, startTicks: '1', bootId: self.bootId }), 'dead');
  assert.equal(ownerLiveness({ pid: process.pid, startTicks: self.start, bootId: `${self.bootId}0` }), 'dead');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!, started = windowsProcessInfo(pid);
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (started?.start) assert.equal(ownerLiveness({ pid, startTicks: started.start, bootId: self.bootId }), 'dead');
});

test('bare check commands resolve through PATHEXT on Windows and batch metacharacters are refused', { skip: !windows && 'Windows only' }, () => {
  const [node] = resolveHostCommand(['node', '--version']);
  assert.ok(path.isAbsolute(node!) && /\.(?:exe|cmd)$/i.test(node!));
  assert.deepEqual(resolveHostCommand(['C:\\tools\\x.exe', 'a']), ['C:\\tools\\x.exe', 'a']);
  const npm = resolveHostCommand(['npm', 'test'])[0]!;
  if (/\.cmd$/i.test(npm)) assert.throws(() => resolveHostCommand(['npm', '%PATH%']), /batch metacharacters/);
});
