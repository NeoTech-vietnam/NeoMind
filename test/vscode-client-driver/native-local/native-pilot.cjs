'use strict';
// Development-only native acceptance harness. Never activated in the product.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');

async function activateNativePilot(vscode, context, fixture, requireTrustedFixture) {
  const runtime = await import(pathToFileURL(join(fixture.repository, 'dist/index.js')).href);
  const { createLocalRequestRunner } = require(join(fixture.repository, 'extensions/vscode-model-bridge/local-request.cjs'));
  const { createLocalModelPolicy } = require(join(fixture.repository, 'extensions/vscode-model-bridge/local-models.cjs'));
  const policy = createLocalModelPolicy(vscode, context, fixture.workspace);
  const runner = createLocalRequestRunner(vscode, runtime, fixture.workspace, policy);
  const hostBuild = { runtime: runtime.createRuntimeInfo(fixture.workspace).build_fingerprint,
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
    const client = new Proxy({}, { get(_target, property) { return property === 'lm' ? lm : Reflect.get(vscode, property, vscode); } });
    require(join(fixture.repository, 'extensions/vscode-model-bridge/native-entry.cjs')).activateNativeEntry(client, context, async () => {
      requireTrustedFixture(); return runtime;
    });
    // This branch uses the production registered tool names and schemas.
    write('ready.json', { status: 'registered', contract: runtime.nativeLocalContractVersion, host_build: hostBuild, entry: 'product-native', model_calls: 0 });
    return;
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
}

module.exports = { activateNativePilot };
