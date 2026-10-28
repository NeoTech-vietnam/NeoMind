import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { initialize, createRecord, loadRecords, getRecord, updateRecord, safePath, sourceHash, readConfig, hash,
  requestFolderForWorkflow, retryWindowsFileOperation } from '../dist/storage.js';
import { migrateStorage, rollbackStorageMigration } from '../dist/migration.js';
import { rebuildIndex, searchMemory } from '../dist/indexing.js';
import { nativeAutomationPolicy } from '../dist/manager.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-TEST', execution_engine: 'vscode-lm' });
  return root;
}
function request(root, title, requestId) {
  return createRecord(root, { type: 'knowledge', title, data: { kind: 'manager-workflow', request_id: requestId } });
}

test('new projects use WorkForce root and each request owns its engineering records', t => {
  const root = project(t), first = request(root, 'Workflow: Linked list exercise', 'first'), second = request(root, 'Workflow: Fix UI', 'second');
  const req = createRecord(root, { type: 'requirement', title: 'Preserve existing exercises', data: { intake_workflow_id: first.meta.id } });
  const task = createRecord(root, { type: 'task', title: 'Create one exercise', data: { workflow_id: first.meta.id } });
  const check = createRecord(root, { type: 'check', title: 'Independent boundary checks', links: [{ type: 'verifies', target: req.meta.id }] });
  const shared = createRecord(root, { type: 'knowledge', title: 'Shared toolchain configuration' });
  assert.match(first.path, /^\.workforce\/requests\/WF-R0001--linked-list-exercise\/records\/knowledge\//);
  assert.match(second.path, /^\.workforce\/requests\/WF-R0002--fix-ui\/records\/knowledge\//);
  for (const item of [req, task, check]) assert.ok(item.path.startsWith('.workforce/requests/WF-R0001--linked-list-exercise/records/'));
  assert.match(shared.path, /^\.workforce\/shared\/records\/knowledge\//);
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.equal(existsSync(join(root, '.workforce/records')), false);
  const folder = requestFolderForWorkflow(root, first.meta.id);
  assert.ok(existsSync(join(root, '.workforce', folder.directory, 'README.md')));
  assert.equal(loadRecords(root).length, 6);
  updateRecord(root, first.meta.id, { title: 'A different title' });
  assert.equal(requestFolderForWorkflow(root, first.meta.id).directory, folder.directory);
  assert.equal(getRecord(root, first.meta.id).path, first.path);
  assert.equal(rebuildIndex(root).records, 6);
  assert.equal(searchMemory(root, 'boundary')[0].id, check.meta.id);
});

test('cross-request links remain shared instead of guessed ownership', t => {
  const root = project(t), first = request(root, 'A', 'a'), second = request(root, 'B', 'b');
  const shared = createRecord(root, { type: 'knowledge', title: 'Cross-request lesson', links: [
    { type: 'documents', target: first.meta.id }, { type: 'documents', target: second.meta.id },
  ] });
  assert.match(shared.path, /^\.workforce\/shared\/records\//);
  assert.equal(loadRecords(root).filter(item => item.meta.id === shared.meta.id).length, 1);
});

test('migration reconciles flat records beside an existing request catalog using linked grouped context', t => {
  const root = project(t), parent = request(root, 'Existing grouped request', 'existing');
  const req = createRecord(root, { type: 'requirement', title: 'Existing grouped requirement', data: { intake_workflow_id: parent.meta.id } });
  const child = createRecord(root, { type: 'check', title: 'New historical flat check', links: [{ type: 'verifies', target: req.meta.id }] });
  const original = readFileSync(safePath(root, child.path)), folder = requestFolderForWorkflow(root, parent.meta.id);
  mkdirSync(join(root, '.workforce/records'), { recursive: true });
  const oldPath = `.workforce/records/${child.meta.id}.md`;
  retryWindowsFileOperation(() => renameSync(safePath(root, child.path), join(root, oldPath)));
  assert.equal(migrateStorage(root).records_relocated, 1);
  assert.deepEqual(requestFolderForWorkflow(root, parent.meta.id), folder);
  assert.equal(getRecord(root, child.meta.id).path, oldPath);
  assert.ok(safePath(root, oldPath).includes(folder.directory.replaceAll('/', '\\')) || safePath(root, oldPath).includes(folder.directory));
  assert.deepEqual(readFileSync(safePath(root, oldPath)), original);
  assert.equal(loadRecords(root).length, 3);
  assert.equal(migrateStorage(root).moved, false);
});

test('legacy migration keeps record and receipt bytes, identity paths and index evidence', t => {
  const root = project(t);
  const parent = request(root, 'Workflow: Historical task', 'saved-request');
  const req = createRecord(root, { type: 'requirement', title: 'Current requirement', data: { intake_workflow_id: parent.meta.id } });
  const original = new Map([parent, req].map(item => [item.meta.id, readFileSync(safePath(root, item.path))]));
  // Recreate an old flat physical layout without rewriting any record bytes.
  mkdirSync(join(root, '.workforce/records'), { recursive: true });
  for (const item of [parent, req]) retryWindowsFileOperation(() => renameSync(safePath(root, item.path), join(root, '.workforce/records', `${item.meta.id}.md`)));
  rmSync(join(root, '.workforce/requests'), { recursive: true });
  rmSync(join(root, '.workforce/storage-layout.json'));
  mkdirSync(join(root, '.workforce/native/receipts'), { recursive: true });
  const signingKey = generateKeyPairSync('ed25519');
  const payload = JSON.stringify({ state: 'completed', workflow_id: parent.meta.id, record_path: `.neomind/records/${req.meta.id}.md` });
  // A real signature over synthetic history checks byte/path preservation. It
  // does not establish that an agent or provider ran in this unit fixture.
  const signed = Buffer.from(JSON.stringify({ state: 'completed', payload, signature: sign(null, Buffer.from(payload), signingKey.privateKey).toString('base64') }) + '\r\n');
  writeFileSync(join(root, '.workforce/native/receipts/history.json'), signed);
  mkdirSync(join(root, '.workforce/procedures/example'), { recursive: true });
  writeFileSync(join(root, '.workforce/procedures/example/manifest.json'), '{"version":"1.0.0"}\r\n');
  retryWindowsFileOperation(() => renameSync(join(root, '.workforce'), join(root, '.neomind')));
  const hashBefore = sourceHash(root), oldPaths = loadRecords(root).map(item => item.path).sort();
  const result = migrateStorage(root);
  assert.equal(result.records_relocated, 2);
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.equal(existsSync(result.backup), true);
  assert.deepEqual(readFileSync(join(root, '.workforce/native/receipts/history.json')), signed);
  const historical = JSON.parse(readFileSync(join(root, '.workforce/native/receipts/history.json'), 'utf8'));
  assert.equal(verify(null, Buffer.from(historical.payload), signingKey.publicKey, Buffer.from(historical.signature, 'base64')), true);
  assert.deepEqual(readFileSync(safePath(root, JSON.parse(historical.payload).record_path)), original.get(req.meta.id));
  assert.equal(readFileSync(join(root, '.workforce/procedures/example/manifest.json'), 'utf8'), '{"version":"1.0.0"}\r\n');
  assert.equal(sourceHash(root), hashBefore);
  assert.deepEqual(loadRecords(root).map(item => item.path).sort(), oldPaths);
  for (const item of [parent, req]) {
    const old = `.neomind/records/${item.meta.id}.md`;
    assert.deepEqual(readFileSync(safePath(root, old)), original.get(item.meta.id));
    assert.deepEqual(readFileSync(safePath(root, old.replace('.neomind', '.verythinker'))), original.get(item.meta.id));
    assert.deepEqual(readFileSync(join(result.backup, 'records', `${item.meta.id}.md`)), original.get(item.meta.id));
    assert.ok(safePath(root, old).includes('requests'));
  }
  assert.equal(rebuildIndex(root).records, 2);
  assert.equal(migrateStorage(root).moved, false);
  updateRecord(root, req.meta.id, { title: 'Revised requirement' });
  assert.equal(getRecord(root, req.meta.id).meta.revision, 2);
  assert.notEqual(sourceHash(root), hashBefore);
});

test('explicit WorkForce activation stages only engine/client/mode changes and remains byte-exactly rollbackable', t => {
  const root = project(t), parent = createRecord(root, { type: 'knowledge', title: 'Preserved old contract', data: {
    kind: 'manager-workflow', execution_mode: 'neomind-controlled', process_contract: 'software-tools/v2', transport: 'vscode-lm',
  } });
  const recordBytes = readFileSync(safePath(root, parent.path)), configBytes = readFileSync(join(root, '.workforce/config.json'));
  const oldPolicy = { ...nativeAutomationPolicy(), execution_mode: 'copilot-native', network_policy: 'remote-enabled',
    automatic_pr: true, upstream: 'author/private', authored_purpose: 'Retain this policy.' };
  const policyBytes = Buffer.from(JSON.stringify(oldPolicy, null, 4) + '\r\n');
  const routingBytes = Buffer.from('{ "strong_model": "author-top-alias", "worker_models": ["author-worker-alias"] }\r\n');
  writeFileSync(join(root, '.workforce/automation.json'), policyBytes);
  writeFileSync(join(root, '.workforce/routing.json'), routingBytes);
  retryWindowsFileOperation(() => renameSync(join(root, '.workforce'), join(root, '.neomind')));
  const result = migrateStorage(root, { activate_workforce: true });
  assert.equal(result.workforce_activated, true);
  assert.equal(readConfig(root).execution_engine, 'opencode');
  assert.equal(readConfig(root).copilot_integration, 'local');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.workforce/automation.json'))), { ...oldPolicy, execution_mode: 'neomind-controlled' });
  assert.deepEqual(readFileSync(join(root, '.workforce/routing.json')), routingBytes);
  assert.deepEqual(readFileSync(safePath(root, parent.path)), recordBytes);
  assert.deepEqual(readFileSync(join(result.backup, 'config.json')), configBytes);
  assert.deepEqual(readFileSync(join(result.backup, 'automation.json')), policyBytes);
  const receipt = JSON.parse(readFileSync(join(root, '.workforce/migrations', `${result.migration_id}.json`)));
  assert.equal(receipt.config_changes.length, 2);
  assert.equal(receipt.config_changes.find(item => item.path === 'config.json').before_sha256, hash(configBytes));
  assert.equal(receipt.config_changes.find(item => item.path === 'automation.json').before_sha256, hash(policyBytes));
  assert.equal(migrateStorage(root, { activate_workforce: true }).moved, false);
  rollbackStorageMigration(root, result.migration_id);
  assert.deepEqual(readFileSync(join(root, '.neomind/config.json')), configBytes);
  assert.deepEqual(readFileSync(join(root, '.neomind/automation.json')), policyBytes);
  assert.deepEqual(readFileSync(safePath(root, parent.path)), recordBytes);
});

test('migration refuses active state, malformed identities and conflicting roots without modifying source', t => {
  const root = project(t), item = createRecord(root, { type: 'requirement', title: 'Shared requirement' });
  const original = readFileSync(safePath(root, item.path));
  mkdirSync(join(root, '.workforce/operations'), { recursive: true });
  writeFileSync(join(root, '.workforce/operations/active.lock'), '{}');
  retryWindowsFileOperation(() => renameSync(join(root, '.workforce'), join(root, '.neomind')));
  assert.throws(() => migrateStorage(root), /lock/i);
  assert.deepEqual(readFileSync(safePath(root, item.path)), original);
  rmSync(join(root, '.neomind/operations/active.lock'));
  mkdirSync(join(root, '.workforce'));
  assert.throws(() => migrateStorage(root), /Both/i);
});

test('malformed relocation paths cannot escape project or redirect unrelated output', t => {
  const root = project(t);
  writeFileSync(join(root, '.workforce/storage-layout.json'), JSON.stringify({ schema_version: 1, requests: [], relocations: [
    { from: '.neomind/records/TEST-REQ-0001.md', to: '.workforce/../../outside.md', record_id: 'TEST-REQ-0001' },
  ] }));
  assert.throws(() => safePath(root, '.neomind/records/TEST-REQ-0001.md'), /Invalid record relocation/);
  assert.equal(existsSync(join(dirname(root), 'outside.md')), false);
});

test('interrupted root switch recovers verified staging without changing signed bytes', t => {
  const root = project(t), item = createRecord(root, { type: 'requirement', title: 'Interrupted original' });
  const original = readFileSync(safePath(root, item.path));
  retryWindowsFileOperation(() => renameSync(join(root, '.workforce'), join(root, '.neomind')));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const move = fs.renameSync;
    fs.renameSync = (from,to) => { const result=move(from,to); if(String(to).includes('.workforce-backups')) process.exit(77); return result; };
    syncBuiltinESMExports();
    const {migrateStorage} = await import(${JSON.stringify(new URL('../dist/migration.js', import.meta.url).href)});
    migrateStorage(${JSON.stringify(root)});
  `], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(child.status, 77, child.stderr);
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.equal(existsSync(join(root, '.workforce')), false);
  assert.equal(migrateStorage(root).moved, false);
  assert.deepEqual(readFileSync(safePath(root, item.path)), original);
  assert.equal(getRecord(root, item.meta.id).meta.title, 'Interrupted original');
  assert.equal(existsSync(join(root, '.neomind-migration.lock')), false);
});

test('rollback preserves original bytes and refuses to discard new WorkForce writes', t => {
  const root = project(t), item = createRecord(root, { type: 'requirement', title: 'Original baseline' });
  const original = readFileSync(safePath(root, item.path));
  retryWindowsFileOperation(() => renameSync(join(root, '.workforce'), join(root, '.neomind')));
  const migrated = migrateStorage(root);
  const rollback = rollbackStorageMigration(root, migrated.migration_id);
  assert.equal(existsSync(join(root, '.workforce')), false);
  assert.equal(existsSync(join(root, '.neomind/config.json')), true);
  assert.deepEqual(readFileSync(safePath(root, item.path)), original);
  assert.ok(existsSync(rollback.backup));
  const again = migrateStorage(root);
  createRecord(root, { type: 'knowledge', title: 'New user work' });
  assert.throws(() => rollbackStorageMigration(root, again.migration_id), /New WorkForce writes/);
  assert.equal(loadRecords(root).length, 2);
});
