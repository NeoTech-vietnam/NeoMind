// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { atomicWrite, safePath, loadRecords, createRecord } from '../dist/storage.js';

test('controlled public entrypoints omit worker credentials and ignore stale client credential fields', async t => {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-public-entry-')));
  initialize(root, { name: 'Public controlled entrypoints', platforms: ['codex', 'copilot'] });
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify({ schema_version: 1, manager_enabled: true,
    documentation_required: true, automatic_pr: false, upstream: null, max_discussion_rounds: 3, execution_mode: 'neomind-controlled' }));
  const server = createMcpServer(root), client = new Client({name:'cached-local-client',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); assert.equal(dirname(root),parent); rmSync(root,{recursive:true,force:true}); });
  const tools = (await client.listTools()).tools;
  for (const name of ['manager_run','manager_status','manager_control']) {
    assert.ok(tools.some(tool => tool.name === name));
    assert.equal('reported_assignment' in tools.find(tool => tool.name === name).inputSchema.properties, false, name);
  }
  assert.ok('reported_assignment' in tools.find(tool => tool.name === 'record_update').inputSchema.properties,
    'Legacy record mutations retain their authenticated worker contract.');
  const stale = { id:'local-report-'+'a'.repeat(40), token:'CACHED_PRIVATE_CREDENTIAL' };
  const legacy = createRecord(root, {type:'knowledge',title:'Historical workflow with unavailable old references',owner:'manager',
    data:{kind:'manager-workflow',execution_mode:'copilot-native',phase:'execution',requirement_id:'MISSING-OLD-REQ',task_ids:['MISSING-OLD-TASK']},body:'# Historical work\nSelect explicitly before checking its original gates.\n'});
  const before = loadRecords(root).length;
  const status = await client.callTool({name:'manager_status',arguments:{reported_assignment:stale}});
  assert.equal(status.isError, undefined, JSON.stringify(status));
  assert.doesNotMatch(JSON.stringify(status), /AUTH_REQUIRED|CACHED_PRIVATE_CREDENTIAL/);
  const snapshot = JSON.parse(status.content[0].text);
  assert.equal(snapshot.execution_mode, 'neomind-controlled');
  assert.equal(snapshot.legacy_workflows.find(value=>value.workflow_id===legacy.meta.id).validation,'not-evaluated');
  for (const [name,args] of [['manager_run',{requirement:'Implement bounded software.',execution_mode:'neomind-controlled'}],
    ['manager_control',{workflow_id:'PUBLIC-KNW-0001',action:'resume'}]]) {
    const result = await client.callTool({name,arguments:{...args,reported_assignment:stale}});
    assert.equal(result.isError,true);
    assert.match(JSON.stringify(result),/bridge.*disabled|Enable Model Bridge/i);
    assert.doesNotMatch(JSON.stringify(result),/AUTH_REQUIRED|unclaimed|CACHED_PRIVATE_CREDENTIAL/);
  }
  assert.equal(loadRecords(root).length,before,'No disabled-owner call may manufacture accepted work.');
});

for (const mode of ['copilot-native', 'codex-native', 'strict', 'lightweight']) {
  test(`public controlled intake remains credential-free when the server starts in ${mode}`, async t => {
    const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-public-mode-')));
    initialize(root, { name: 'Public intake across execution modes', platforms: ['codex', 'copilot'] });
    const policy = { schema_version: 1, manager_enabled: true, documentation_required: true,
      automatic_pr: false, upstream: null, max_discussion_rounds: 3, execution_mode: mode };
    atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify(policy));
    const server = createMcpServer(root), client = new Client({ name: 'cached-local-client', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    t.after(async () => { await client.close(); await server.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
    const tools = (await client.listTools()).tools;
    assert.ok('reported_assignment' in tools.find(tool => tool.name === 'record_update').inputSchema.properties);
    const stale = { id: 'local-report-' + '0'.repeat(40), token: 'x' };
    // The user's explicit dispatch choice must reach its own preflight, even if
    // the editor retained a credential field from the older native schema.
    for (const executionMode of [mode, 'neomind-controlled']) {
      atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify({ ...policy, execution_mode: executionMode }));
      const status = await client.callTool({ name: 'manager_status', arguments: { reported_assignment: stale } });
      assert.equal(status.isError, undefined, JSON.stringify(status));
      for (const [name, args] of [
        ['manager_run', { requirement: 'I want a LeetCode exercise and a Cornell note.', execution_mode: 'neomind-controlled' }],
        ['manager_control', { workflow_id: 'PUBLIC-KNW-0001', action: 'resume' }],
      ]) {
        const result = await client.callTool({ name, arguments: { ...args, reported_assignment: stale } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /bridge.*disabled|Enable Model Bridge/i);
        assert.doesNotMatch(JSON.stringify(result), /AUTH_REQUIRED|reported-assignments|unclaimed/);
      }
    }
    for (const name of ['manager_run', 'manager_status', 'manager_control'])
      assert.equal('reported_assignment' in tools.find(tool => tool.name === name).inputSchema.properties, false, name);
    assert.equal(loadRecords(root).length, 0, 'Disabled Bridge calls cannot create accepted work.');
    if (mode === 'copilot-native' || mode === 'codex-native') {
      atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify(policy));
      const native = await client.callTool({ name: 'manager_run', arguments: {
        requirement: 'Inspect existing local documentation.', reported_assignment: stale,
      } });
      assert.equal(native.isError, undefined, JSON.stringify(native));
      const result = JSON.parse(native.content[0].text);
      assert.equal(result.workflow.execution_mode, mode, 'Omitting execution_mode preserves the saved native default.');
      assert.equal(result.handoff.agent, mode === 'codex-native' ? 'neomind-coordinator' : 'NeoMind Coordinator Agent');
    }
  });
}
