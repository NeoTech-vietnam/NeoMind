import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';

const execFileAsync = promisify(execFile);

test('workspace fencing persists across coordinators and unconfirmed stops cannot release', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-coordination-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const db = path.join(dir, 'coordination.sqlite');
  const first = new WorkspaceCoordinator(db);
  const lease = first.acquire(workspace, 'run-a', 'host-a');
  first.close();
  const second = new WorkspaceCoordinator(db);
  assert.throws(() => second.acquire(workspace, 'run-b', 'host-b'), /already has a writer/);
  assert.throws(() => second.release(lease, false), /unconfirmed/);
  second.quarantine(lease);
  assert.equal(second.isCurrent(lease), false);
  assert.throws(() => second.acquire(workspace, 'run-b', 'host-b'), /already has a writer/);
  second.release(lease, true);
  const next = second.acquire(workspace, 'run-b', 'host-b');
  assert.ok(next.fence > lease.fence);
  assert.throws(() => second.release(lease, true), /Stale/);
  second.release(next, true); second.close();
});

test('separate processes cannot acquire the same workspace writer simultaneously', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-process-'));
  const workspace = path.join(dir, 'workspace'); mkdirSync(workspace);
  const db = path.join(dir, 'coordination.sqlite');
  const init = new WorkspaceCoordinator(db); init.close();
  const worker = path.resolve('dist/test/helpers/coordination-worker.js');
  const results = await Promise.all(['run-a', 'run-b'].map(async runId => {
    const { stdout } = await execFileAsync(process.execPath, [worker, db, workspace, runId]);
    return JSON.parse(stdout) as { acquired: boolean; message?: string };
  }));
  assert.equal(results.filter(r => r.acquired).length, 1);
  assert.match(results.find(r => !r.acquired)?.message ?? '', /already has a writer/);
});

test('run ownership persists, fences stale owners and requires confirmed scheduler stop', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-run-owner-'));
  const db = path.join(dir, 'coordination.sqlite');
  const first = new WorkspaceCoordinator(db);
  const lease = first.acquireRun('run-a', 'host-a'); first.close();
  const second = new WorkspaceCoordinator(db);
  assert.equal(second.isRunOwner(lease), true);
  assert.deepEqual(second.getRunOwner('run-a'), lease);
  assert.equal(second.getRunOwner('unknown'), undefined);
  assert.throws(() => second.acquireRun('run-a', 'host-b'), /already has an owner/);
  assert.throws(() => second.releaseRun(lease, false), /unconfirmed/);
  second.releaseRun(lease, true);
  const next = second.acquireRun('run-a', 'host-b');
  assert.ok(next.fence > lease.fence);
  assert.equal(second.isRunOwner(lease), false);
  assert.throws(() => second.releaseRun(lease, true), /Stale/);
  second.releaseRun(next, true); second.close();
});

test('separate processes cannot own the same run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-run-process-'));
  const db = path.join(dir, 'coordination.sqlite');
  const init = new WorkspaceCoordinator(db); init.close();
  const worker = path.resolve('dist/test/helpers/run-owner-worker.js');
  const results = await Promise.all(['host-a', 'host-b'].map(async host => {
    const { stdout } = await execFileAsync(process.execPath, [worker, db, 'run-a', host]);
    return JSON.parse(stdout) as { acquired: boolean; message?: string };
  }));
  assert.equal(results.filter(r => r.acquired).length, 1);
  assert.match(results.find(r => !r.acquired)?.message ?? '', /already has an owner/);
});
