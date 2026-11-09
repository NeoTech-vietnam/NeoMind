'use strict';
// Development-only native acceptance harness. Never activated in the product.
const { readFileSync, writeFileSync, lstatSync, realpathSync } = require('node:fs');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

/** Development observation only: every effect and returned value still comes
 * from the exact runtime function. Neither missing proof nor observer failure
 * may change its result, thrown error or native command behavior. */
function createNativeControlObserver(vscode, runtime, root, hostBuild, write) {
  const commands = new AsyncLocalStorage(), wrapped = new Map();
  const canonical = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const sameRoot = selected => {
    try { return canonical(realpathSync.native(selected)) === canonical(realpathSync.native(root)); } catch { return false; }
  };
  const emit = (prefix, value) => { try { write(`${prefix}-${value.event_id}.json`, value, 'wx'); } catch { /* An observer cannot change the actual control. */ } };
  const controlFields = value => ({ state: ['apply-now', 'deferred', 'unchanged', 'enabled', 'disabled', 'removed'].includes(value?.state) ? value.state : 'unknown',
    active_count: Number.isSafeInteger(value?.active_count) && value.active_count >= 0 ? value.active_count : null,
    new_admissions: typeof value?.new_admissions === 'boolean' ? value.new_admissions : null,
    ...(['disable', 'remove', 'disconnect'].includes(value?.pending_action) ? { pending_action: value.pending_action } : {}) });
  function fileHash(selected) {
    try {
      if (typeof selected !== 'string' || isAbsolute(selected) || selected.split(/[\\/]/).includes('..')) return { observed: false };
      const file = typeof runtime.safePath === 'function' ? runtime.safePath(root, selected) : resolve(root, selected);
      const state = lstatSync(file, { throwIfNoEntry: false });
      if (!state) return { path: selected, present: false, sha256: null };
      const actual = relative(realpathSync.native(root), realpathSync.native(file));
      if (isAbsolute(actual) || actual === '..' || actual.startsWith('../') || actual.startsWith('..\\') ||
          !state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 2 * 1024 * 1024) return { path: selected, observed: false };
      return { path: selected, present: true, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
    } catch { return { observed: false }; }
  }
  function snapshot(method, args, returned, stack) {
    try {
      if (!sameRoot(args[0])) return;
      const supplied = method === 'applyNativeMcpBindingControl' ? args[1] : null;
      const id = supplied?.key?.startsWith('mcp:') ? supplied.key.slice(4) : args[1];
      const action = supplied ? supplied.action : args[2];
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(id) || !['enable', 'disable', 'remove'].includes(action)) return;
      const command = commands.getStore();
      const value = { event_id: randomUUID(), id, action, at: new Date().toISOString(), api_method: method, host_build: hostBuild,
        control: controlFields(returned?.control),
        ui_command_context: command?.name === 'workforce.capabilities.manage',
        ui_sync_stack_contains_manage: /\bmanageNativeCapabilityControls\b/.test(stack),
        automatic_drain_stack: /\bdrainNativeCapabilityControls\b/.test(stack),
        ...(command ? { command_event_id: command.event_id } : {}) };
      if (method === 'controlWorkspaceSkillComponent') {
        const receipt = returned?.components?.find(item => item.id === id);
        const candidate = receipt?.target_name && runtime.listWorkspaceSkillComponents(root, { exact_name: receipt.target_name, limit: 10 }).components.find(item => item.id === id);
        value.skill_status = { state: typeof receipt?.state === 'string' ? receipt.state : 'unknown', published: receipt?.published === true,
          receipt: candidate?.receipt?.path ? fileHash(candidate.receipt.path) : { observed: false },
          files: Array.isArray(receipt?.files) ? receipt.files.map(file => fileHash(`${receipt.target}/${file.relative_path}`)) : [] };
      } else value.binding_status = controlFields(runtime.readNativeMcpBindingControl(root, id));
      emit('capability-control', value);
    } catch { /* Do not fabricate evidence if a read-only snapshot is unavailable. */ }
  }
  const observedRuntime = new Proxy(runtime, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (!['controlNativeMcpBinding', 'controlWorkspaceSkillComponent', 'applyNativeMcpBindingControl'].includes(property) || typeof value !== 'function') return value;
    if (!wrapped.has(property)) wrapped.set(property, function (...args) {
      const stack = new Error().stack ?? '';
      const returned = Reflect.apply(value, target, args);
      try {
        if (returned && typeof returned.then === 'function') void returned.then(result => snapshot(property, args, result, stack), () => {});
        else snapshot(property, args, returned, stack);
      } catch { /* Even a hostile return object cannot change the real result. */ }
      return returned;
    });
    return wrapped.get(property);
  } });
  const observedCommands = new Proxy(vscode.commands, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property !== 'registerCommand') return typeof value === 'function' ? value.bind(target) : value;
    return (name, callback, thisArg) => target.registerCommand(name, name !== 'workforce.capabilities.manage' ? callback : function (...args) {
      const event = { event_id: randomUUID(), name, at: new Date().toISOString(), host_build: hostBuild, status: 'entered' };
      emit('capability-command', event);
      return commands.run(event, () => Reflect.apply(callback, this, args));
    }, thisArg);
  } });
  return { runtime: observedRuntime, commands: observedCommands };
}

async function activateNativePilot(vscode, context, fixture, requireTrustedFixture) {
  const runtime = await import(pathToFileURL(join(fixture.repository, 'dist/index.js')).href);
  const { createLocalRequestRunner } = require(join(fixture.repository, 'extensions/vscode-model-bridge/local-request.cjs'));
  const { createLocalModelPolicy } = require(join(fixture.repository, 'extensions/vscode-model-bridge/local-models.cjs'));
  const policy = createLocalModelPolicy(vscode, context, fixture.workspace);
  const runner = createLocalRequestRunner(vscode, runtime, fixture.workspace, policy);
  const hostBuild = { runtime: runtime.createRuntimeInfo(fixture.workspace).build_fingerprint,
    harness: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    adapters: Object.fromEntries(['native-entry.cjs', 'local-request.cjs', 'local-delegation.cjs', 'local-models.cjs', 'local-activity.cjs'].map(name =>
      [name, createHash('sha256').update(readFileSync(join(fixture.repository, 'extensions/vscode-model-bridge', name))).digest('hex')])) };
  const output = join(fixture.evidence, 'native-pilot');
  const write = (name, value, flag = 'w') => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag });
  if (fixture.nativeProductEntry) {
    // Observe the product entry's real tool invocations without replacing its
    // runtime, runner, identity binding or result with a development simulation.
    const lm = new Proxy({}, { get(_target, property) {
      const target = vscode.lm;
      if (property !== 'registerTool') { const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; }
      return (name, tool) => target.registerTool(name, { ...tool, async invoke(options, cancellation) {
        const observation = { id: randomUUID(), tool: name, started_at: new Date().toISOString(), host_build: hostBuild };
        if (name === 'workforce_native_capabilities') {
          const { workspace_folder: _root, ...content } = options.input ?? {};
          const parsed = runtime.nativeCapabilityInputSchema?.safeParse(content);
          // Owned proof only: preserve validated professional selection fields,
          // never arbitrary credentials, host policy, transport or generic input.
          if (parsed?.success) observation.capability_input = parsed.data;
        }
        try { write(`entry-${observation.id}.json`, { observation, status: 'running' }, 'wx'); } catch { /* An optional proof observer cannot interrupt production work. */ }
        const actual = await tool.invoke(options, cancellation);
        try {
          const result = JSON.parse(actual.content.map(part => part.value ?? '').join('\n'));
          write(`entry-${observation.id}.json`, { ...result, observation: { ...observation, finished_at: new Date().toISOString() } });
        } catch { /* Missing observation is not acceptance evidence. Return the actual tool result unchanged. */ }
        return actual;
      } });
    } });
    const observed = createNativeControlObserver(vscode, runtime, fixture.workspace, hostBuild, write);
    const client = new Proxy({}, { get(_target, property) { return property === 'lm' ? lm : property === 'commands' ? observed.commands : Reflect.get(vscode, property, vscode); } });
    const entry = require(join(fixture.repository, 'extensions/vscode-model-bridge/native-entry.cjs')).activateNativeEntry(client, context, async () => {
      requireTrustedFixture(); return observed.runtime;
    }, fixture.enable_mcp_fixture === true ? { readApprovedMcpConnectors: () => {
      requireTrustedFixture();
      try { return JSON.parse(readFileSync(join(fixture.evidence, 'native-mcp', 'approved-connectors.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    } } : {});
    // This branch uses the production registered tool names and schemas.
    write('ready.json', { status: 'registered', contract: runtime.nativeLocalContractVersion, host_build: hostBuild, entry: 'product-native', model_calls: 0 });
    return entry;
  }
  context.subscriptions.push(runner, vscode.lm.registerTool('workforce_m4_control', {
    prepareInvocation: () => ({ invocationMessage: 'WorkForce: continue checks on the retained request' }),
    async invoke(options, cancellation) {
      requireTrustedFixture();
      const observation = { id: randomUUID(), started_at: new Date().toISOString(), host_build: hostBuild };
      write(`control-${observation.id}.json`, { ...observation, status: 'running' }, 'wx');
      const result = await runner.control(options.input, options.toolInvocationToken, cancellation);
      write(`control-${observation.id}.json`, { ...result, observation: { ...observation, finished_at: new Date().toISOString() } });
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
    },
  }), vscode.lm.registerTool('workforce_m5_prepare', {
    prepareInvocation: () => ({ invocationMessage: 'WorkForce: find relevant accepted experience and qualified procedures' }),
    async invoke(options) {
      requireTrustedFixture();
      const result = runtime.prepareNativeWork(fixture.workspace, options.input);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
    },
  }), vscode.lm.registerTool('workforce_m4_role', {
    prepareInvocation: () => ({ invocationMessage: 'WorkForce: complete the selected role scope' }),
    async invoke(options, cancellation) {
      requireTrustedFixture();
      const observation = { id: randomUUID(), started_at: new Date().toISOString(), host_build: hostBuild };
      write(`role-${observation.id}.json`, { ...observation, status: 'running' }, 'wx');
      const result = await runner.role(options.input, options.toolInvocationToken, cancellation);
      write(`role-${observation.id}.json`, { ...result, observation: { ...observation, finished_at: new Date().toISOString() } });
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
    },
  }), vscode.lm.registerTool('workforce_m3_pilot', {
    prepareInvocation: () => ({ invocationMessage: 'WorkForce: implement, independently review and check this request' }),
    async invoke(options, cancellation) {
      requireTrustedFixture();
      const observation = { id: randomUUID(), started_at: new Date().toISOString(), host_build: hostBuild };
      write(`call-${observation.id}.json`, { ...observation, status: 'running' }, 'wx');
      const result = fixture.resumeRequest
        ? await runner.resume(fixture.resumeRequest, options.toolInvocationToken, cancellation)
        : await runner.run(options.input, options.toolInvocationToken, cancellation);
      const completed = { ...result, observation: { ...observation, finished_at: new Date().toISOString() } };
      write(`call-${observation.id}.json`, completed);
      write('backend-result.json', completed);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
    },
  }));
  // Reuse the M2 driver's durable, serialized authorization ledger for actual
  // chat dispatch. This helper only binds the isolated pilot tool.
  write('ready.json', { status: 'registered', contract: runtime.nativeLocalContractVersion, host_build: hostBuild, model_calls: 0 });
  return { dispose: () => runner.dispose() };
}

module.exports = { activateNativePilot, createNativeControlObserver };
