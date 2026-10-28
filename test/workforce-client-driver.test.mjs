// Driver mechanics only: these synthetic services are not client acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const { createDriver, safeExport } = createRequire(import.meta.url)('./vscode-client-driver/driver-lib.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const prompt = 'I want a leetcode exercise and create a cornell note for me in vscode window';

function fixture(t, { authorized = false, trusted = true, runtimeMismatch = false, localResult = { opened: true, target: 'local', profile: 'WF.PM' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-driver-test-')), project = join(root, 'workspace'), output = join(root, 'evidence'), ext = join(root, 'extension');
  for (const path of [project, output, ext]) mkdirSync(path);
  writeFileSync(join(ext, 'package.json'), JSON.stringify({ name: 'synthetic', files: [] }));
  const config = { run_id: 'synthetic-driver-test', workspace_root: project, runtime_root: root, output_directory: output, prompt_file: join(root, 'prompt.txt'),
    authorization_file: join(root, 'authorization.json'), model_vendor: 'customendpoint', model_alias: 'top-models' };
  writeFileSync(config.prompt_file, prompt); writeFileSync(join(root, 'config.json'), JSON.stringify(config));
  writeFileSync(config.authorization_file, JSON.stringify({ allow_chat_dispatch: authorized, run_id: config.run_id, max_user_prompts: 1,
    workspace_root: project, prompt_sha256: hash(prompt) }));
  let configuredRuntime = runtimeMismatch ? project : root;
  const updates = [], calls = [], vscode = { version: 'synthetic-vscode', ExtensionMode: { Test: 3 }, ConfigurationTarget: { Global: 1 }, Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: { isTrusted: trusted, workspaceFolders: [{ uri: { scheme: 'file', fsPath: project } }], getConfiguration: section => ({ get: () => 'autoApprove', inspect: () => ({ globalValue: configuredRuntime }),
      update: async (name, value, target) => { updates.push({ section, name, value, target }); configuredRuntime = value; } }) },
    extensions: { getExtension: id => ({ id, extensionPath: ext, packageJSON: { version: 'synthetic' }, isActive: true }) },
    lm: { selectChatModels: async () => [{ id: 'top-models', vendor: 'customendpoint', name: 'top-models' }] },
    commands: { getCommands: async () => ['workforce.pm.openLocal', 'workbench.action.chat.open', 'workbench.action.chat.newLocalChat', 'workbench.action.chat.export'],
      executeCommand: async (name, input) => { calls.push([name, input]); if (name === 'workforce.pm.openLocal') return localResult;
        if (name === 'workbench.action.chat.export') writeFileSync(input.fsPath, JSON.stringify({ requests: [{ message: { text: prompt }, modelId: 'actual-export-id-fixture', modeInfo: { name: 'WF.PM' }, response: [{ kind: 'toolInvocationSerialized', toolId: 'mcp_workforce_request_submit', arguments: { apiKey: 'SECRET' } }] }] }));
        return { type: 'confirmation', kind: 'toolInvocation', toolId: 'workforce/request_submit' }; } },
  };
  const runtime = { createRuntimeInfo: () => ({ package_version: 'synthetic', runtime_root: root, build_fingerprint: 'fixture' }), requestSetupStatus: () => ({ ready: true }), requestStatus: () => ({ requests: [] }) };
  const driver = createDriver({ vscode, context: { extensionMode: 2 }, configPath: join(root, 'config.json'), loadRuntime: async () => runtime });
  t.after(async () => { await driver.close(); rmSync(root, { recursive: true, force: true }); });
  return { driver, calls, updates, root, output, vscode };
}

async function control(app, action) {
  await app.driver.listen();
  const endpoint = JSON.parse(readFileSync(join(app.output, 'control.json'), 'utf8'));
  const response = await fetch(`${endpoint.url}/${action}`, { method: 'POST', headers: { Authorization: endpoint.authorization } });
  return { status: response.status, result: await response.json() };
}

test('native setup sets only the reviewed User runtime and leaves dispatch and consent unapproved', async t => {
  const app = fixture(t, { runtimeMismatch: true });
  const configured = await control(app, 'configure-runtime');
  assert.equal(configured.status, 200); assert.equal(configured.result.runtime_binding.matches, true);
  assert.deepEqual(app.updates, [{ section: 'workforce.bridge', name: 'runtimePath', value: app.root, target: 1 }]);
  const connected = await control(app, 'connect');
  assert.deepEqual(connected.result, { connection_requested: true, consent_automatically_granted: false });
  assert.deepEqual(app.calls.map(([name]) => name), ['workforce.bridge.enable']);
  await assert.rejects(app.driver.runOnce(), /EXPLICIT_DISPATCH_AUTHORIZATION_REQUIRED/);
  assert.equal(app.driver.report().user_prompts_dispatched, 0);
});

test('setup refuses a different or untrusted workspace without changing settings or invoking consent', async t => {
  const app = fixture(t, { trusted: false });
  assert.equal((await control(app, 'configure-runtime')).status, 409);
  assert.equal((await control(app, 'connect')).status, 409);
  app.vscode.workspace.isTrusted = true; app.vscode.workspace.workspaceFolders = [];
  assert.equal((await control(app, 'configure-runtime')).status, 409);
  assert.equal((await control(app, 'connect')).status, 409);
  assert.deepEqual(app.updates, []); assert.deepEqual(app.calls, []);
});

test('disabled dispatch authorization cannot execute any chat command', async t => {
  const app = fixture(t); await assert.rejects(app.driver.runOnce(), /EXPLICIT_DISPATCH_AUTHORIZATION_REQUIRED/); assert.deepEqual(app.calls, []);
});

test('a different configured User runtime cannot be mistaken for the extracted acceptance candidate', async t => {
  const app = fixture(t, { authorized: true, runtimeMismatch: true });
  const inspected = await app.driver.inspect();
  assert.equal(inspected.runtime_binding.matches, false);
  await assert.rejects(app.driver.runOnce(), /CONFIGURED_RUNTIME_MUST_MATCH_REVIEWED_CANDIDATE/);
  assert.deepEqual(app.calls, []);
  assert.equal(app.driver.report().user_prompts_dispatched, 0);
});

test('native chat dispatch is exact and once-only even across repeated requests', async t => {
  const app = fixture(t, { authorized: true }); await app.driver.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(app.driver.runOnce(), /DISPATCH_ALREADY_ISSUED/);
  assert.equal(app.calls.filter(([name]) => name === 'workbench.action.chat.open').length, 1);
  const input = app.calls.find(([name]) => name === 'workbench.action.chat.open')[1];
  assert.equal(input.query, prompt); assert.equal(input.mode, 'WF.PM'); assert.equal(input.blockOnResponse, true); assert.equal(input.isPartialQuery, false);
  assert.deepEqual(input.modelSelector, { id: 'top-models', vendor: 'customendpoint' });
  assert.equal(JSON.stringify(app.driver.report()).includes('SECRET'), false);
});

test('untrusted workspaces and a failed Local profile opening cannot fall back to another chat transport', async t => {
  const untrusted = fixture(t, { authorized: true, trusted: false }); await assert.rejects(untrusted.driver.runOnce(), /WORKSPACE_TRUST_REQUIRED/); assert.deepEqual(untrusted.calls, []);
  const failed = fixture(t, { authorized: true, localResult: { opened: false } }); await assert.rejects(failed.driver.runOnce(), /LOCAL_PROFILE_OPEN_FAILED/);
  assert.equal(failed.calls.some(([name]) => name === 'workbench.action.chat.open'), false); assert.equal(failed.driver.report().user_prompts_dispatched, 0);
});

test('safe native exports expose actual tool/model identifiers without arguments or foreign chat contents', () => {
  const own = safeExport({ requests: [{ message: { text: prompt }, modelId: 'observed-id', modeInfo: { name: 'WF.PM' },
    response: [{ kind: 'toolInvocationSerialized', toolId: 'mcp_workforce_request_submit', invocationMessage: 'SECRET', parameters: { apiKey: 'SECRET' } }] }] }, prompt);
  assert.equal(own.matches_issued_prompt, true); assert.equal(own.observed_workforce_call, true); assert.equal(own.model_id, 'observed-id'); assert.equal(JSON.stringify(own).includes('SECRET'), false);
  const foreign = safeExport({ requests: [{ message: { text: 'Private unrelated conversation' } }] }, prompt);
  assert.equal(foreign.matches_issued_prompt, false); assert.equal(JSON.stringify(foreign).includes('Private unrelated'), false);
});
