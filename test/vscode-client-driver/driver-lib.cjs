'use strict';
const { createServer } = require('node:http');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fields = (value, names) => Object.fromEntries(names.filter(name => ['string', 'number', 'boolean'].includes(typeof value?.[name])).map(name => [name, value[name]]));
function extensionFingerprint(extension) {
  if (!extension) return null;
  const root = extension.extensionPath, manifest = json(join(root, 'package.json')), digest = createHash('sha256');
  for (const name of [...new Set(['package.json', ...(manifest.files ?? [])])].sort()) {
    const path = resolve(root, name), child = relative(root, path);
    if (isAbsolute(child) || child.startsWith('..') || !existsSync(path) || !lstatSync(path).isFile()) continue;
    digest.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  return digest.digest('hex');
}
function safeExport(value, expectedPrompt) {
  const requests = Array.isArray(value?.requests) ? value.requests.filter(item => item.isSystemInitiated !== true) : [];
  const request = requests.length === 1 && requests[0].message?.text?.trim() === expectedPrompt.trim() ? requests[0] : null;
  if (!request) return { matches_issued_prompt: false, user_request_count: requests.length, export_sha256: sha(JSON.stringify(value)) };
  const calls = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.toolId === 'string') calls.push(fields(node, ['toolId', 'kind', 'toolCallId']));
    if (Array.isArray(node)) for (const item of node) visit(item);
    else for (const [key, item] of Object.entries(node)) if (!/token|api.?key|authorization|password|secret/i.test(key)) visit(item);
  }
  visit(request.response);
  const mode = fields(request.modeInfo, ['kind', 'isBuiltin', 'telemetryModeId', 'permissionLevel']);
  const modeInstructions = fields(request.modeInfo?.modeInstructions, ['name', 'isBuiltin']);
  if (Object.keys(modeInstructions).length) mode.modeInstructions = modeInstructions;
  return { matches_issued_prompt: true, user_request_count: requests.length, prompt_sha256: sha(expectedPrompt), export_sha256: sha(JSON.stringify(value)),
    model_id: request.modelId ?? null, mode, workforce_profile_observed: mode.isBuiltin === false && modeInstructions.isBuiltin !== true && /^WF\.PM$/i.test(modeInstructions.name ?? ''),
    agent: fields(request.agent, ['id', 'name', 'extensionId']),
    agent_host: fields(request.agentHostMetadata, ['sessionType', 'providerId', 'sessionId']),
    response_kinds: (request.response ?? []).map(item => item?.kind).filter(item => typeof item === 'string'),
    tool_calls: calls, observed_workforce_call: calls.some(item => /workforce|request_submit/i.test(item.toolId)) };
}
function createDriver({ vscode, context, configPath, loadRuntime }) {
  const config = json(configPath), root = realpathSync.native(config.workspace_root), output = resolve(config.output_directory);
  if (context.extensionMode === vscode.ExtensionMode?.Test) throw new Error('extensionTestsPath mode is not accepted as a production Copilot client test.');
  if (!isAbsolute(output) || (config.forbidden_roots ?? []).some(path => {
    const rel = relative(resolve(path), root); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../');
  })) throw new Error('This driver cannot use the configured protected workspace.');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const ledgerPath = join(output, 'dispatch.json'), reportPath = join(output, 'report.json'), prompt = readFileSync(config.prompt_file, 'utf8').trim();
  let report = { schema_version: 1, driver: 'actual-vscode-commands', run_id: config.run_id, workspace_root: root, status: 'prepared-not-dispatched',
    user_prompts_dispatched: 0, visual_local_label_observed: false, visual_permission_picker_observed: false,
    limitations: ['Public APIs do not expose the rendered Local label or current permission picker.', 'Native command execution and session exports are distinct from screenshots.', 'This report is not product acceptance until the actual request is accepted and its products/checks are observed.'] };
  let api, server, observer, running = false, closed = false, beforeIds = new Set();
  const persist = () => write(reportPath, report);
  const exact = () => {
    const folders = vscode.workspace.workspaceFolders?.filter(item => item.uri.scheme === 'file') ?? [];
    if (!vscode.workspace.isTrusted) throw new Error('WORKSPACE_TRUST_REQUIRED');
    if (folders.length !== 1 || !same(realpathSync.native(folders[0].uri.fsPath), root)) throw new Error('EXACT_SINGLE_WORKSPACE_REQUIRED');
    return folders[0];
  };
  async function runtime() { return api ??= await (loadRuntime ? loadRuntime() : import(pathToFileURL(join(config.runtime_root, 'dist/index.js')).href)); }
  function runtimeBinding(info) {
    const configured = vscode.workspace.getConfiguration('workforce.bridge').inspect('runtimePath')?.globalValue;
    let expectedRoot, configuredRoot, importedRoot;
    try {
      expectedRoot = realpathSync.native(config.runtime_root);
      if (typeof configured === 'string' && isAbsolute(configured)) configuredRoot = realpathSync.native(configured);
      if (typeof info?.runtime_root === 'string' && isAbsolute(info.runtime_root)) importedRoot = realpathSync.native(info.runtime_root);
    } catch { /* Inspection reports the missing/mismatched setting; it never repairs User settings. */ }
    return { expected_root: expectedRoot ?? null, configured_user_root: configuredRoot ?? null, imported_root: importedRoot ?? null,
      matches: Boolean(expectedRoot && configuredRoot && importedRoot && same(expectedRoot, configuredRoot) && same(expectedRoot, importedRoot)) };
  }
  async function inspect() {
    const folder = exact(), currentApi = await runtime(), info = currentApi.createRuntimeInfo(root);
    const workforce = vscode.extensions.getExtension('workforce.workforce-model-bridge'), copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
    // Contributed commands activate the installed extension on first use.
    // Enumerate its actual registrations after that normal activation.
    if (workforce && !workforce.isActive && typeof workforce.activate === 'function') await workforce.activate();
    const commands = await vscode.commands.getCommands(true);
    const required = ['workforce.pm.openLocal', 'workbench.action.chat.open', 'workbench.action.chat.newLocalChat', 'workbench.action.chat.export'];
    const models = (await vscode.lm.selectChatModels({})).map(model => fields(model, ['id', 'vendor', 'name', 'family', 'version']));
    const alias = config.model_alias, candidates = models.filter(model => model.vendor === config.model_vendor &&
      (model.id === alias || model.name === alias || model.name === `${alias} (customendpoint)`));
    report = { ...report, inspected_at: new Date().toISOString(), vscode_version: vscode.version, extension_mode: context.extensionMode,
      workspace_trusted: true, workspace_permission_default: vscode.workspace.getConfiguration('chat', folder.uri).get('permissions.default'),
      runtime: fields(info, ['package_version', 'runtime_root', 'build_fingerprint']),
      runtime_binding: runtimeBinding(info),
      workforce_extension: workforce ? { id: workforce.id, version: workforce.packageJSON.version, path: workforce.extensionPath, source_fingerprint: extensionFingerprint(workforce) } : null,
      copilot_extension: copilot ? { id: copilot.id, version: copilot.packageJSON.version, path: copilot.extensionPath, active: copilot.isActive } : null,
      required_commands_available: required.every(name => commands.includes(name)), missing_commands: required.filter(name => !commands.includes(name)),
      model_candidates: candidates, model_selection_unique: candidates.length === 1, setup: currentApi.requestSetupStatus(root),
      local_target_evidence: { command: 'workbench.action.chat.newLocalChat', semantics: 'Installed 1.143.1 implementation explicitly calls startNewLocalSession/an.Local.' } };
    persist(); return report;
  }
  async function configureRuntime() {
    exact();
    const currentApi = await runtime(), info = currentApi.createRuntimeInfo(root);
    if (!same(realpathSync.native(info.runtime_root), realpathSync.native(config.runtime_root))) throw new Error('REVIEWED_RUNTIME_REQUIRED');
    await vscode.workspace.getConfiguration('workforce.bridge').update('runtimePath', realpathSync.native(config.runtime_root), vscode.ConfigurationTarget.Global);
    return inspect();
  }
  async function connectWorkForce() {
    await inspect();
    if (!report.runtime_binding.matches) throw new Error('CONFIGURED_RUNTIME_MUST_MATCH_REVIEWED_CANDIDATE');
    // The actual product command presents its normal first-use consent. This
    // driver neither answers that dialog nor modifies its saved approval.
    void vscode.commands.executeCommand('workforce.bridge.enable').then(() => inspect()).catch(error => {
      report.connection_error = { name: error?.name ?? 'Error', message_sha256: sha(String(error?.message ?? error)) }; persist();
    });
    return { connection_requested: true, consent_automatically_granted: false };
  }
  async function capture() {
    if (closed) return { captured: false, reason: 'DRIVER_CLOSED' };
    exact();
    const path = join(output, 'current-chat.raw-export.json');
    await vscode.commands.executeCommand('workbench.action.chat.export', vscode.Uri.file(path));
    if (!existsSync(path)) return { captured: false, reason: 'NO_EXPORTABLE_CHAT_SESSION' };
    try { const exported = safeExport(json(path), prompt); write(join(output, 'chat-observation.json'), exported); report.chat = exported; persist(); return exported; }
    finally { unlinkSync(path); }
  }
  async function observe() {
    if (closed || !running) return;
    try {
      exact(); report.runtime_binding = runtimeBinding(report.runtime);
      if (!report.runtime_binding.matches) { report.status = 'runtime-binding-changed-client-evidence-incomplete'; running = false; persist(); clearInterval(observer); observer = undefined; return; }
      const status = await (await runtime()).requestStatus(root), requests = status.requests ?? [];
      const admitted = requests.filter(item => !beforeIds.has(item.workflow_id));
      report.new_request_count = admitted.length;
      if (admitted.length > 1) { report.status = 'failed-duplicate-request-admission'; running = false; }
      else if (admitted.length === 1) {
        const request = admitted[0]; report.request = request;
        report.requirement_preserved = request.requirement?.trim() === prompt.trim();
        if (!report.first_receipt_at) { report.first_receipt_at = new Date().toISOString(); await capture(); }
        if (request.accepted === true && request.status === 'completed') {
          await capture(); report.status = report.requirement_preserved && report.chat?.matches_issued_prompt && report.chat?.observed_workforce_call && report.chat?.workforce_profile_observed
            ? 'actual-client-request-accepted' : 'request-accepted-client-evidence-incomplete'; running = false;
        } else report.status = request.question ? 'awaiting-genuine-product-input' : request.runtime_health?.state === 'incident' ? 'actual-request-incident' : 'observing-actual-request';
      }
      if (Date.now() > report.observe_deadline) { report.status = 'observation-deadline-reached-no-retry'; running = false; }
      persist(); if (!running) { clearInterval(observer); observer = undefined; }
    } catch (error) { report.observer_error = { name: error?.name ?? 'Error', message_sha256: sha(String(error?.message ?? error)) }; persist(); }
  }
  async function runOnce() {
    if (closed) throw new Error('DRIVER_CLOSED');
    const authorization = json(config.authorization_file);
    if (authorization.allow_chat_dispatch !== true || authorization.run_id !== config.run_id || authorization.max_user_prompts !== 1 ||
      authorization.prompt_sha256 !== sha(prompt) || !same(realpathSync.native(authorization.workspace_root), root)) throw new Error('EXPLICIT_DISPATCH_AUTHORIZATION_REQUIRED');
    if (existsSync(ledgerPath)) throw new Error('DISPATCH_ALREADY_ISSUED_NO_RETRY');
    await inspect();
    if (!report.required_commands_available || !report.model_selection_unique || !report.copilot_extension || !report.workforce_extension) throw new Error('ACTUAL_CLIENT_PREREQUISITES_NOT_READY');
    if (!report.runtime_binding.matches) throw new Error('CONFIGURED_RUNTIME_MUST_MATCH_REVIEWED_CANDIDATE');
    if (report.setup.ready !== true) throw new Error('CONNECT_WORKFORCE_AND_COMPLETE_REAL_CAPABILITY_CHECK_FIRST');
    const currentApi = await runtime(), existing = currentApi.requestStatus(root);
    beforeIds = new Set((existing.requests ?? []).map(item => item.workflow_id));
    writeFileSync(ledgerPath, `${JSON.stringify({ run_id: config.run_id, prompt_sha256: sha(prompt), workspace_root: root, dispatch_started_at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    report.status = 'preparing-local-client'; report.prompt_sha256 = sha(prompt); report.observe_deadline = Date.now() + (config.observation_timeout_ms ?? 1200000); persist();
    const selected = report.model_candidates[0];
    const local = await vscode.commands.executeCommand('workforce.pm.openLocal'); exact();
    if (!runtimeBinding(report.runtime).matches) throw new Error('CONFIGURED_RUNTIME_CHANGED_NO_QUERY_SENT');
    report.local_open_result = fields(local, ['opened', 'target', 'profile', 'model_selection', 'permission_default']);
    if (local?.opened !== true || local.target !== 'local' || local.profile !== 'WF.PM') { report.status = 'local-profile-open-failed-no-query-sent'; persist(); throw new Error('LOCAL_PROFILE_OPEN_FAILED_NO_DISPATCH'); }
    report.status = 'dispatch-issued'; report.user_prompts_dispatched = 1; persist();
    const operation = vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'WF.PM', modelSelector: { id: selected.id, vendor: selected.vendor },
      query: prompt, isPartialQuery: false, blockOnResponse: true,
      attachFiles: (config.context_paths ?? []).map(path => vscode.Uri.file(path)) });
    running = true; observer = setInterval(() => { void observe(); }, 2500);
    void operation.then(async value => {
      if (closed) return;
      report.chat_command_result = fields(value, ['type', 'kind', 'toolId']);
      if (value?.type === 'confirmation') report.status = 'awaiting-native-platform-approval';
      await capture(); persist();
    }).catch(error => { if (!closed) { report.chat_command_error = { name: error?.name ?? 'Error', message_sha256: sha(String(error?.message ?? error)) }; report.status = 'dispatch-outcome-uncertain-no-retry'; persist(); } });
    return { accepted_for_observation: true, run_id: config.run_id, actual_user_prompts: 1 };
  }
  async function listen() {
    if (server || closed) return;
    const token = randomBytes(32).toString('hex');
    server = createServer(async (request, response) => {
      const expected = `Bearer ${token}`, observed = request.headers.authorization;
      const authenticated = typeof observed === 'string' && Buffer.byteLength(observed) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(observed), Buffer.from(expected));
      if (!authenticated || request.headers.origin || request.headers.host !== `127.0.0.1:${server.address()?.port}`) { response.writeHead(403).end(); return; }
      try {
        if (request.method === 'GET' && request.url === '/status') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(report)); return; }
        if (request.method !== 'POST' || !['/inspect', '/configure-runtime', '/connect', '/run-once', '/capture'].includes(request.url)) { response.writeHead(404).end(); return; }
        request.resume();
        const value = request.url === '/inspect' ? await inspect() : request.url === '/configure-runtime' ? await configureRuntime()
          : request.url === '/connect' ? await connectWorkForce() : request.url === '/capture' ? await capture() : await runOnce();
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
      } catch (error) { response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'DRIVER_OPERATION_FAILED', error_sha256: sha(String(error?.message ?? error)) })); }
    });
    await new Promise((fulfill, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', fulfill); });
    write(join(output, 'control.json'), { url: `http://127.0.0.1:${server.address().port}`, authorization: `Bearer ${token}` }); persist();
  }
  async function close() { closed = true; clearInterval(observer); if (server) { server.closeAllConnections(); await new Promise(fulfill => server.close(fulfill)); } }
  return { inspect, runOnce, capture, listen, close, report: () => report };
}
module.exports = { createDriver, safeExport, extensionFingerprint };
