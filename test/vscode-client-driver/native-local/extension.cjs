'use strict';
const vscode = require('vscode');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, watch, writeFileSync } = require('node:fs');
const { basename, dirname, join, relative, resolve, isAbsolute } = require('node:path');
const fixture = require('./fixture.json');
const hash = text => createHash('sha256').update(text).digest('hex');
const prompt = fixture.prompt ?? `Delegate once to ${fixture.worker}. Ask it to read m2-fixture.test.cjs, run node --test m2-fixture.test.cjs in this workspace, and report its observed result. Keep all files unchanged.`;
const commands = {
  local: 'workbench.action.chat.newLocalChat',
  open: 'workbench.action.chat.open',
  export: 'workbench.action.chat.export',
};
let lastAttemptDirectory = fixture.evidence;
let lastAttemptRequest;
let dispatchQueue = Promise.resolve();
const evidencePath = (name, directory = fixture.evidence) => join(directory, name);
const runId = basename(dirname(fixture.evidence));
const write = (name, value, flag = 'w', directory = fixture.evidence) =>
  writeFileSync(evidencePath(name, directory), JSON.stringify(value, null, 2) + '\n', { flag, mode: 0o600 });
const modelFields = model => ({ id: model.id, vendor: model.vendor, name: model.name, family: model.family, version: model.version });
const safeLabel = value => typeof value === 'string' && /^[a-z0-9._/ :()@-]{1,160}$/i.test(value) ? value : null;
const workspace = () => {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length !== 1 || folders[0].uri.scheme !== 'file') return;
  const canonical = path => {
    const absolute = realpathSync.native(path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  if (canonical(folders[0].uri.fsPath) === canonical(fixture.workspace)) return folders[0];
};

function requireTrustedFixture() {
  if (!workspace() || !vscode.workspace.isTrusted) throw new Error('Open and trust the WorkForce M2 fixture workspace first.');
}

const defaultRequest = () => ({ prompt, coordinator: fixture.coordinator, attachments: fixture.attachments ?? [] });
function proofRequest(input) {
  if (input === undefined) return defaultRequest();
  const invalid = () => { throw Object.assign(new Error('Invalid owned proof request or attachment.'), { code: 'PROOF_REQUEST_INVALID' }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['prompt', 'coordinator', 'attachments', 'wait_for_response'].includes(key)) ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000 ||
      !['WF.PM', 'WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester', fixture.coordinator].includes(input.coordinator) ||
      !Array.isArray(input.attachments) || input.attachments.length > 100 ||
      'wait_for_response' in input && typeof input.wait_for_response !== 'boolean') invalid();
  const root = realpathSync.native(fixture.workspace);
  for (const path of input.attachments) {
    if (typeof path !== 'string' || !path || path.length > 1024 || isAbsolute(path) || /[:\u0000-\u001f]/.test(path) || path.split(/[\\/]/).includes('..')) invalid();
    let actual;
    try { actual = relative(root, realpathSync.native(resolve(root, path))); } catch { invalid(); }
    if (isAbsolute(actual) || actual === '..' || actual.startsWith('../') || actual.startsWith('..\\')) invalid();
  }
  return { prompt: input.prompt, coordinator: input.coordinator, attachments: [...input.attachments],
    ...('wait_for_response' in input ? { wait_for_response: input.wait_for_response } : {}) };
}

async function inspect(directory = fixture.evidence, request = defaultRequest()) {
  requireTrustedFixture();
  const models = (await vscode.lm.selectChatModels({})).map(modelFields);
  const availableCommands = await vscode.commands.getCommands(true);
  const delegation = vscode.lm.tools.filter(tool => /(?:^|\/)runSubagent$/i.test(tool.name)).map(tool => ({
    name: tool.name,
    properties: Object.keys(tool.inputSchema?.properties ?? {}),
    required: tool.inputSchema?.required ?? [],
  }));
  const result = {
    run_id: runId,
    prompt_sha256: hash(request.prompt),
    workspace_trusted: true,
    vscode_version: vscode.version,
    copilot_chat_version: vscode.extensions.getExtension('GitHub.copilot-chat')?.packageJSON.version,
    models,
    local_commands: Object.fromEntries(Object.entries(commands).map(([key, name]) => [key, availableCommands.includes(name)])),
    delegation,
    // Public host inventory only. Command presence is not a supported argument
    // contract or evidence that a plugin has been installed/loaded/used.
    customization_commands: availableCommands.filter(name =>
      /(?:chat|agent|skill|mcp).*plugin|plugin.*(?:chat|agent)|customizations/i.test(name)).sort(),
    capability_tools: vscode.lm.tools.filter(tool => /fetch|skill|mcp|search|plugin|workforce/i.test(tool.name)).map(tool => ({
      name: tool.name, properties: Object.keys(tool.inputSchema?.properties ?? {}),
    })),
    hooks_enabled: vscode.workspace.getConfiguration('chat', workspace().uri).get('useHooks'),
    plugins_enabled: vscode.workspace.getConfiguration('chat').get('plugins.enabled'),
  };
  write('inspection.json', result, 'w', directory);
  return result;
}

async function capture(directory = lastAttemptDirectory, requestContext = lastAttemptRequest ?? defaultRequest()) {
  requireTrustedFixture();
  const path = evidencePath('current-chat.raw.json', directory);
  if (existsSync(path)) throw new Error('A prior temporary chat export must be reconciled first.');
  await vscode.commands.executeCommand(commands.export, vscode.Uri.file(path));
  if (!existsSync(path)) return;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const userRequests = (value.requests ?? []).filter(request => request.isSystemInitiated !== true);
    const request = userRequests.at(-1)?.message?.text?.trim() === requestContext.prompt.trim() ? userRequests.at(-1) : null;
    if (!request) return;
    const calls = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.toolId === 'string') {
        const subagent = node.toolSpecificData;
        calls.push({
          id: safeLabel(node.toolId),
          kind: safeLabel(node.kind),
          native_worker: /(?:^|\/)runSubagent$/i.test(node.toolId) &&
            [fixture.worker, ...['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'].map(role => `${role} Worker`)]
              .includes(subagent?.agentName ?? subagent?.name),
          agent_name: safeLabel(subagent?.agentName ?? subagent?.name),
          observed_child_model: safeLabel(subagent?.modelId),
        });
      }
      for (const item of Object.values(node)) visit(item);
    };
    visit(request.response);
    write('chat-observation.json', {
      prompt_sha256: hash(requestContext.prompt),
      export_sha256: hash(JSON.stringify(value)),
      mode: request.modeInfo?.modeInstructions?.name === requestContext.coordinator ? requestContext.coordinator : null,
      parent_model: safeLabel(request.modelId),
      calls,
      assistant_response_contains_fixture_marker: JSON.stringify(request.response ?? []).includes(fixture.marker),
      failure: classifyFailure(request.responseErrorDetails),
    }, 'w', directory);
  } finally { unlinkSync(path); }
}

// This is a development proof summary, never workflow authentication or an
// acceptance oracle. Keep the raw exported chat out of the retained evidence.
function classifyFailure(details) {
  if (details == null || details === false) return null;
  const value = JSON.stringify(details);
  if (/rate.limit|usage.limit|quota|\b429\b/i.test(value)) return 'provider-rate-limit';
  if (/unauthorized|authentication|\b401\b|\b403\b/i.test(value)) return 'provider-authorization';
  if (/model.not.supported|model.not.found/i.test(value)) return 'model-unavailable';
  return 'unclassified-native-error';
}

async function dispatch(inspection, parent, worker, directory = fixture.evidence, reuseSession = false, request = defaultRequest()) {
  requireTrustedFixture();
  if (!inspection.local_commands.local || !inspection.local_commands.open) throw new Error('Local chat commands are unavailable in this VS Code build.');
  if (worker && !inspection.delegation.some(tool => tool.properties.includes('model'))) {
    throw new Error('The observed native tool schema does not advertise a model input.');
  }
  write('dispatch.json', { run_id: runId, prompt_sha256: hash(request.prompt), coordinator: request.coordinator,
    request_sha256: hash(JSON.stringify(request)), wait_for_response: request.wait_for_response !== false,
    parent, worker: worker ?? null }, 'wx', directory);
  // Local model-name fields use the qualified display name, not the model ID.
  const policy = worker ? { override: `${worker.name} (${worker.vendor})` } : {};
  write('model-policy.json', policy, 'wx', directory);
  writeFileSync(join(fixture.evidence, 'model-policy.json'), JSON.stringify(policy) + '\n', { mode: 0o600 });
  if (!reuseSession) await vscode.commands.executeCommand(commands.local);
  const result = await vscode.commands.executeCommand(commands.open, {
    mode: request.coordinator,
    modelSelector: { id: parent.id, vendor: parent.vendor },
    query: request.prompt,
    ...(request.attachments.length ? { attachFiles: request.attachments.map(path => vscode.Uri.file(join(fixture.workspace, path))) } : {}),
    isPartialQuery: false,
    blockOnResponse: request.wait_for_response !== false,
  });
  // A nonblocking native command only submits the prompt. It is not proof of
  // a completed model response, product, check or accepted WorkForce request.
  write('command-outcome.json', { type: safeLabel(result?.type), kind: safeLabel(result?.kind),
    status: request.wait_for_response === false ? 'submitted' : 'returned' }, 'wx', directory);
  if (request.wait_for_response !== false) await capture(directory, request);
}

async function run() {
  requireTrustedFixture();
  if (existsSync(evidencePath('dispatch.json'))) throw new Error('This fixture already issued a prompt. Create a fresh fixture for another proof.');
  const inspection = await inspect();
  const entries = inspection.models.map(model => ({ label: model.name, description: model.vendor, detail: model.id, model }));
  if (entries.length === 0) throw new Error('No chat model is available to the proof extension.');
  const parent = await vscode.window.showQuickPick(entries, { placeHolder: 'Select the model to use in the proof chat' });
  if (!parent) return;
  const worker = await vscode.window.showQuickPick([{ label: 'Inherit the parent model' }, ...entries],
    { placeHolder: 'Select an optional worker override to test through the Local hook' });
  if (!worker) return;
  await dispatch(inspection, parent.model, worker.model);
}

function readAuthorization() {
  return JSON.parse(readFileSync(join(fixture.evidence, 'authorize.json'), 'utf8'));
}

function serializeDispatch(action) {
  const operation = dispatchQueue.then(action);
  dispatchQueue = operation.catch(() => {});
  return operation;
}

function queueAuthorizedProof(input = readAuthorization()) {
  // Keep an event's authorization independent of later writes to authorize.json.
  const authorization = JSON.parse(JSON.stringify(input));
  return serializeDispatch(() => runAuthorizedProof(authorization));
}

async function runAuthorizedProof(input) {
  const request = proofRequest(input.request);
  if (input.allow_chat_dispatch !== true || input.run_id !== runId || input.prompt_sha256 !== hash(request.prompt) ||
      input.request !== undefined && input.request_sha256 !== hash(JSON.stringify(request))) {
    throw Object.assign(new Error('Unrecognized proof authorization.'), { code: 'PROOF_AUTHORIZATION_INVALID' });
  }
  requireTrustedFixture();
  if (typeof input.attempt_id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(input.attempt_id))
    throw Object.assign(new Error('A distinct proof attempt identifier is required.'), { code: 'PROOF_ATTEMPT_REQUIRED' });
  const directory = join(fixture.evidence, 'attempts', input.attempt_id);
  // Each authorized attempt has a durable ledger. Existing attempts are never
  // replayed, even after an editor reload or a duplicate filesystem event.
  if (existsSync(join(directory, 'attempt.json')) || existsSync(join(directory, 'dispatch.json')))
    return { status: 'already-recorded' };
  mkdirSync(directory, { recursive: true });
  try {
    write('attempt.json', { attempt_id: input.attempt_id, run_id: runId, prompt_sha256: hash(request.prompt),
      request_sha256: hash(JSON.stringify(request)), wait_for_response: request.wait_for_response !== false }, 'wx', directory);
  } catch (error) {
    if (error.code === 'EEXIST') return { status: 'already-recorded' };
    throw error;
  }
  lastAttemptDirectory = directory;
  lastAttemptRequest = request;
  try {
    const inspection = await inspect(directory, request);
    const select = route => inspection.models.filter(model => model.vendor === route.vendor && model.id === route.id);
    const candidates = input.parent ? select(input.parent) : inspection.models.filter(model => model.vendor === 'customendpoint' &&
      (model.id === 'top-models' || model.name === 'top-models'));
    const worker = input.worker ? select(input.worker) : [];
    if (candidates.length !== 1 || (input.worker && worker.length !== 1)) {
      write('command-outcome.json', { status: 'model-selection-unavailable', vendor_counts: inspection.models.reduce((counts, model) => {
        counts[model.vendor] = (counts[model.vendor] ?? 0) + 1;
        return counts;
      }, Object.create(null)) }, 'wx', directory);
      return { status: 'model-selection-unavailable' };
    }
    await dispatch(inspection, candidates[0], worker[0], directory, input.reuse_session === true, request);
    return { status: request.wait_for_response === false ? 'submitted' : 'returned' };
  } catch (error) {
    if (!existsSync(evidencePath('command-outcome.json', directory))) write('command-outcome.json', {
      status: vscode.workspace.isTrusted ? 'proof-dispatch-unconfirmed' : 'workspace-trust-required',
      code: safeLabel(error?.code),
    }, 'wx', directory);
    throw error;
  }
}

function activate(context) {
  if (!workspace() || context.extensionMode === vscode.ExtensionMode.Test) return;
  let preview;
  const previewVModel = () => preview ??= require('./v-model-fixture.cjs').openVModelFixture(vscode, context, fixture, write);
  const inspectTrusted = () => {
    if (!vscode.workspace.isTrusted) {
      write('inspection.json', { run_id: runId, prompt_sha256: hash(prompt), vscode_version: vscode.version, workspace_trusted: false });
      return;
    }
    // Inventory is metadata only. This never calls sendRequest or changes model settings.
    void inspect().catch(error => write('inspection-error.json', { name: error?.name, code: safeLabel(error?.code) }));
    if (fixture.showVModel) void previewVModel().catch(error => write('v-model-error.json', { name: error?.name, code: safeLabel(error?.code) }));
  };
  const control = watch(fixture.evidence, (_event, filename) => {
    if (filename !== 'authorize.json' || !existsSync(join(fixture.evidence, filename))) return;
    let authorization;
    try { authorization = readAuthorization(); }
    catch (error) { write('authorization-error.json', { code: safeLabel(error?.code), status: 'invalid-authorization-file' }); return; }
    void queueAuthorizedProof(authorization).catch(error => write('authorization-error.json', {
      status: vscode.workspace.isTrusted ? 'proof-dispatch-unconfirmed' : 'workspace-trust-required',
      code: safeLabel(error?.code),
    }));
  });
  context.subscriptions.push(
    { dispose: () => control.close() },
    vscode.commands.registerCommand('workforceM2.inspect', async () => {
      await inspect();
      await vscode.window.showTextDocument(vscode.Uri.file(evidencePath('inspection.json')));
    }),
    vscode.commands.registerCommand('workforceM2.run', () => serializeDispatch(run)),
    vscode.commands.registerCommand('workforceM2.capture', () => serializeDispatch(() => capture())),
    vscode.commands.registerCommand('workforceM2.previewVModel', () => {
      requireTrustedFixture();
      return previewVModel();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(inspectTrusted),
  );
  inspectTrusted();
  if (fixture.nativePilot) void require('./native-pilot.cjs').activateNativePilot(vscode, context, fixture, requireTrustedFixture)
    .catch(error => write('native-pilot-error.json', { name: error?.name, code: safeLabel(error?.code) }));
}

module.exports = { activate, queueAuthorizedProof };
