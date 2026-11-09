'use strict';
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync, readFileSync } = require('node:fs');

async function openVModelAndObserve(vscode, timeoutMs = 5000) {
  const tabs = vscode.window.tabGroups;
  const isOpen = () => tabs.all.some(group => group.tabs.some(tab => tab.label === 'WorkForce V-model'));
  let notify, timer;
  const observed = new Promise(resolve => { notify = resolve; });
  const inspect = () => { if (isOpen()) notify(true); };
  // Editor tab registration follows a separate RPC from createWebviewPanel.
  const listeners = [tabs.onDidChangeTabs(inspect), tabs.onDidChangeTabGroups(inspect)];
  try {
    await vscode.commands.executeCommand('workforce.vModel.open');
    inspect();
    timer = setTimeout(() => notify(isOpen()), timeoutMs);
    return await observed;
  } finally {
    clearTimeout(timer);
    for (const listener of listeners) listener.dispose();
  }
}

async function openVModelFixture(vscode, context, fixture, write) {
  const root = fixture.workspace;
  const runtime = await import(pathToFileURL(join(fixture.repository, 'dist', 'index.js')).href);
  const { activateVModelPanel } = require(join(fixture.repository, 'extensions/vscode-model-bridge/v-model-panel.cjs'));
  runtime.initialize(root, { name: 'M1 display-only fixture' });
  const catalogPath = runtime.safePath(root, '.workforce/storage-layout.json');
  const catalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : { requests: [], relocations: [] };
  const seeded = ['M1-FIXTURE-1', 'M1-FIXTURE-2'].every(id => catalog.requests.some(request => request.workflow_id === id));
  if (!seeded && (catalog.requests.length || catalog.relocations.length))
    throw new Error('Existing fixture request history must be preserved; display seeding was skipped.');
  const updated_at = new Date().toISOString();
  const workflows = [];
  for (const number of seeded ? [] : [1, 2]) {
    const workflow_id = `M1-FIXTURE-${number}`;
    const epoch_id = `m1-fixture-${number}`;
    const title = `Synthetic V-model request ${number}`;
    const display_id = `WF-R000${number}`;
    const artifact = `m1-artifact-${number}.md`;
    const evidence = `m1-evidence-${number}.txt`;
    runtime.atomicWrite(runtime.safePath(root, artifact), `# ${title}\n\nSynthetic artifact for a display check.\n`);
    runtime.atomicWrite(runtime.safePath(root, evidence), 'Synthetic failed check output. No verification process ran.\n');
    const contract = JSON.stringify({
      plan: { outputs: [artifact], acceptance_criteria: ['Synthetic fixture criterion'] },
      verification_levels: [{ level: 'unit', applicable: true }, { level: 'integration', applicable: false }],
    });
    const base = `.workforce/controlled/workflows/${runtime.hash(workflow_id)}`;
    runtime.atomicWrite(runtime.safePath(root, `${base}.${epoch_id}.contract.json`), contract);
    runtime.atomicWrite(runtime.safePath(root, `${base}.json`), JSON.stringify({
      schema_version: 1, workflow_id, request_id: workflow_id, epoch_id, title,
      status: number === 1 ? 'paused' : 'interrupted', phase: 'implementation', process_contract: 'workforce/v1',
      transport: 'opencode', updated_at, revision: 1, requirement: 'Synthetic example for the M1 view.',
      contract_hash: runtime.hash(contract),
      attempts: [
        { stage: 'requirements', role: 'requirements', state: 'completed', report: { outcome: 'completed' } },
        { stage: 'implementation', role: 'developer', state: 'completed', report: { outcome: 'failed' } },
      ],
      checks: [{ evidence_id: `M1-EVIDENCE-${number}`, title: 'Synthetic failed check', log_path: evidence, exit_code: 1, passed: false }],
    }));
    workflows.push({ display_id, request_id: workflow_id, workflow_id, title, directory: `requests/${display_id}--m1-fixture-${number}` });
  }
  if (!seeded) runtime.atomicWrite(catalogPath, JSON.stringify({ schema_version: 1, requests: workflows, relocations: [] }));
  const snapshot = runtime.requestListForMonitor(root);
  if (['M1-FIXTURE-1', 'M1-FIXTURE-2'].some(id => {
    const request = snapshot.requests.find(request => request.workflow_id === id);
    return !request || request.artifacts.length !== 1 || request.evidence.length !== 1;
  })) {
    throw new Error('The WorkForce runtime did not project both synthetic requests with their files.');
  }
  let lastNative, sequence = 0;
  const observed = { ...runtime, requestListForMonitor(project, ownership) {
    const snapshot = runtime.requestListForMonitor(project, ownership);
    const native = snapshot.requests.filter(request => request.source === 'native-local');
    const text = JSON.stringify(native);
    if (native.length && text !== lastNative) {
      lastNative = text;
      write(`v-model-native-${Date.now()}-${++sequence}.json`, { observed_at: new Date().toISOString(), requests: native }, 'wx');
    }
    return snapshot;
  } };
  activateVModelPanel(vscode, context, async () => observed);
  const open = await openVModelAndObserve(vscode);
  write('v-model-fixture.json', { source: 'synthetic saved journal and real source projection', panel_open: open,
    panel_observation: open ? 'vscode-tab-observed' : 'not-observed-before-deadline', snapshot });
}

module.exports = { openVModelFixture, openVModelAndObserve };
