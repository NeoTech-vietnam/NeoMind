'use strict';

// Stable VS Code Language Model Chat Provider API. This translates one native
// call; the editor continues to own the agent/tool loop and its permissions.
function convertGatewayMessages(vscode, messages, capabilities) {
  const result = [];
  const contentPart = part => {
    if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
    if (part instanceof vscode.LanguageModelDataPart) {
      if (/^image\/(?:png|jpeg|webp|gif)$/.test(part.mimeType)) {
        if (capabilities.imageInput !== true) throw Error('VISION_UNSUPPORTED: choose a model declaring image input; no image was dropped.');
        return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } };
      }
      if (/^(?:text\/|application\/json$)/.test(part.mimeType))
        return { type: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(part.data) };
    }
    throw Error('INPUT_PART_UNSUPPORTED: this native content type cannot be transmitted losslessly by the gateway.');
  };
  const compact = parts => parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;
  for (const message of messages) {
    if (![vscode.LanguageModelChatMessageRole.User, vscode.LanguageModelChatMessageRole.Assistant].includes(message.role))
      throw Error('MESSAGE_ROLE_UNSUPPORTED');
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    let content = [], calls = [];
    const flush = () => {
      if (!content.length && !calls.length) return;
      result.push({ role, content: content.length ? compact(content) : null,
        ...(message.name ? { name: message.name } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
      content = []; calls = [];
    };
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        if (role !== 'assistant' || !part.callId || !part.name) throw Error('TOOL_CALL_INVALID');
        calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (role !== 'user' || !part.callId) throw Error('TOOL_RESULT_INVALID');
        flush();
        result.push({ role: 'tool', tool_call_id: part.callId, content: compact(part.content.map(contentPart)) });
      } else content.push(contentPart(part));
    }
    flush();
  }
  return result;
}

function gatewayModelInformation(row) {
  if (typeof row.id !== 'string' || !row.id || !Number.isSafeInteger(row.context_length) ||
      !Number.isSafeInteger(row.max_output_tokens) || row.max_output_tokens <= 0 || row.context_length <= row.max_output_tokens) return null;
  return { id: row.id, name: row.name || row.id, family: row.family || '9router', version: '0.5.116',
    maxInputTokens: row.context_length - row.max_output_tokens, maxOutputTokens: row.max_output_tokens,
    capabilities: { toolCalling: row.capabilities?.tools === true, imageInput: row.capabilities?.vision === true },
    tooltip: `Managed 9router. Capabilities and capacity are ${row.capability_source === 'upstream-and-user-declaration' ? 'upstream/User' : 'upstream catalog'} declarations; the routed upstream identity is not established. Token counting is a conservative byte estimate; actual usage comes from the gateway.`,
    detail: row.kind === 'combo' ? 'WorkForce managed combo' : 'WorkForce managed provider' };
}

function cancellation(token) {
  const controller = new AbortController();
  if (token?.isCancellationRequested) controller.abort();
  const listener = token?.onCancellationRequested?.(() => controller.abort());
  return { signal: controller.signal, dispose() { listener?.dispose(); } };
}

function createGatewayChatProvider(vscode, { service, client, onDidChangeLanguageModelChatInformation, enabled = () => true, observe = () => {} }) {
  return {
    onDidChangeLanguageModelChatInformation,
    async provideLanguageModelChatInformation(_options, token) {
      if (!enabled()) return [];
      const cancel = cancellation(token);
      let lease;
      try {
        lease = await service.acquire(cancel.signal);
        const connection = client(lease);
        return (await connection.listUsableModels(lease.signal ?? cancel.signal)).map(gatewayModelInformation).filter(Boolean);
      } catch (error) {
        try { observe({ type: 'discovery-unavailable', code: /^GATEWAY_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'GATEWAY_DISCOVERY_UNAVAILABLE' }); } catch {}
        return []; // An optional provider cannot invalidate other native models.
      } finally { cancel.dispose(); await lease?.release(); }
    },
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      if (!enabled()) throw Error('GATEWAY_DISABLED: enable the managed provider in WorkForce gateway settings.');
      const converted = convertGatewayMessages(vscode, messages, model.capabilities ?? {});
      const tools = (options.tools ?? []).map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
      if (tools.length && model.capabilities?.toolCalling !== true && typeof model.capabilities?.toolCalling !== 'number')
        throw Error('TOOLS_UNSUPPORTED: the selected model has no declared tool support.');
      const cancel = cancellation(token);
      let lease;
      try {
        lease = await service.acquire(cancel.signal);
        // Do not forward arbitrary modelOptions: they can override routing,
        // authorization, system messages or endpoint credentials.
        const input = { model: model.id, messages: converted, ...(tools.length ? { tools,
          tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' } : {}) };
        const signal = lease.signal ?? cancel.signal;
        for await (const event of client(lease).chat(input, signal)) {
          if (signal.aborted) { const error = new Error('GATEWAY_CANCELLED'); error.name = 'CancellationError'; throw error; }
          if (event.type === 'text') progress.report(new vscode.LanguageModelTextPart(event.text));
          else if (event.type === 'tool-call') progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, event.args));
          else if (event.type === 'usage' || event.type === 'routing') {
            // Metadata only; do not persist prompts, tool results or auth.
            try { observe({ type: event.type, model: model.id, generation: lease.generation, ...event }); } catch { /* Telemetry is optional. */ }
          }
          // Stable provider API has no reasoning response part. Reasoning
          // deltas are not converted to normal assistant output or re-sent.
        }
      } catch (error) {
        if (cancel.signal.aborted || lease?.signal?.aborted || error?.name === 'CancellationError' || error?.code === 'GATEWAY_CANCELLED') {
          const cancelled = new Error('GATEWAY_CANCELLED'); cancelled.name = 'CancellationError'; throw cancelled;
        }
        if (/^GATEWAY_[A-Z_]+$/.test(error?.code ?? '')) {
          const failure = new Error(`[${error.code}] ${error.message}`); failure.code = error.code; throw failure;
        }
        throw error;
      } finally { cancel.dispose(); await lease?.release(); }
    },
    async provideTokenCount(_model, input, token) {
      if (token?.isCancellationRequested) throw Error('GATEWAY_CANCELLED');
      // Deliberately conservative, disclosed as an estimate. Never report this
      // as provider-billed usage or drop tool/image bytes from the estimate.
      return Math.max(1, Buffer.byteLength(typeof input === 'string' ? input : JSON.stringify(input), 'utf8'));
    },
  };
}

module.exports = { convertGatewayMessages, gatewayModelInformation, createGatewayChatProvider };
