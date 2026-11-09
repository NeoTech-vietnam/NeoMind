'use strict';

const { randomUUID } = require('node:crypto');

const nativeProfessionalRoles = Object.freeze(['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']);
const agents = new Set(nativeProfessionalRoles);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const validNativeWorkerProfiles = value => object(value) && Object.keys(value).length === nativeProfessionalRoles.length &&
  nativeProfessionalRoles.every(role => value[role] === `${role} Worker`);

function failure(code, category, message) { return { code, category, message }; }

function nativeFailure(error, cancelled) {
  if (cancelled || error?.name === 'CancellationError' || error?.code === 'CANCELLED')
    return failure('CANCELLED', 'cancellation', 'The native invocation was cancelled; its effects require reconciliation.');
  const code = String(error?.code ?? error?.status ?? error?.statusCode ?? '');
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4000) : '';
  const details = `${code} ${message}`;
  const gatewayCode = /^GATEWAY_[A-Z_]+$/.test(code) ? code : /^(?:Error:\s*)?\[?(GATEWAY_[A-Z_]+)\]?(?::|\s|$)/.exec(message)?.[1];
  if (gatewayCode === 'GATEWAY_CANCELLED') return failure('CANCELLED', 'cancellation', 'The managed provider request was cancelled; its effects require reconciliation.');
  if (gatewayCode === 'GATEWAY_AUTHORIZATION' || gatewayCode === 'GATEWAY_ADMIN_AUTHORIZATION')
    return failure('PROVIDER_AUTHORIZATION', 'provider-authorization', 'The managed gateway or provider requires valid authorization.');
  if (gatewayCode === 'GATEWAY_QUOTA') return failure('PROVIDER_QUOTA', 'provider-quota', 'The managed provider reported a quota or rate limit.');
  if (['GATEWAY_CONNECTION', 'GATEWAY_PROVIDER_UNAVAILABLE'].includes(gatewayCode))
    return failure('PROVIDER_CONNECTION', 'provider-connection', 'The managed provider connection or service is unavailable.');
  if (['GATEWAY_MODEL_UNAVAILABLE', 'GATEWAY_MODEL_NOT_APPROVED'].includes(gatewayCode))
    return failure('PROVIDER_MODEL_UNAVAILABLE', 'provider-model', 'The selected managed provider route is unavailable or outside the approved selection.');
  if (gatewayCode && /PROTOCOL|INCOMPLETE/.test(gatewayCode))
    return failure('PROVIDER_PROTOCOL', 'provider-protocol', 'The managed provider returned an incomplete or invalid model response.');
  if (/Requested agent .* is not allowed by the current agent\./i.test(message))
    return failure('NATIVE_AGENT_POLICY', 'compatibility', 'The current native parent profile excludes the host-prepared worker. Update the generated WorkForce selector profiles and open a new Local chat. No provider diagnosis or model retry is implied.');
  if (/\b429\b|rate[_ -]?limit|insufficient[_ -]?quota|quota[_ -]?(?:exceeded|exhausted)/i.test(details))
    return failure('PROVIDER_QUOTA', 'provider-quota', 'The native provider reported a rate or quota limit.');
  if (/\b40[13]\b|unauthorized|authentication[_ -]?(?:error|failed)|invalid[_ -]?api[_ -]?key/i.test(details))
    return failure('PROVIDER_AUTHORIZATION', 'provider-authorization', 'The native provider rejected its authorization.');
  if (/model[_ -]?(?:not[_ -]?found|not[_ -]?supported|unavailable)/i.test(details))
    return failure('PROVIDER_MODEL_UNAVAILABLE', 'provider-model', 'The native provider reported that the requested model is unavailable.');
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|\b50[234]\b/i.test(details))
    return failure('PROVIDER_CONNECTION', 'provider-connection', 'The native invocation reported a connection or service failure.');
  if (/\bResponse contained no choices\b/i.test(message))
    return failure('PROVIDER_PROTOCOL', 'provider-protocol', 'The native provider returned a response without any choices.');
  return failure('NATIVE_INVOCATION_FAILED', 'unknown', 'The native invocation failed without a recognized failure category.');
}

function returnedNativeFailure(result, cancelled) {
  // The installed runSubagent implementation returns these failures through its
  // one-text-part helper, not as a rejected API promise or an isError flag.
  // Match only its bare envelope. Quoted/fenced prose, JSON professional reports
  // and arbitrary mentions of errors are not native transport evidence.
  if (!object(result) || !Array.isArray(result.content) || result.content.length !== 1) return;
  const part = result.content[0];
  if (!object(part) || typeof part.value !== 'string' || part.kind !== undefined && part.kind !== 'text') return;
  const envelope = /^(?:Agent error: |Error invoking subagent: )([\s\S]+)$/.exec(part.value);
  if (!envelope) return;
  const body = envelope[1].slice(0, 16000);
  const reason = /^Sorry, your request failed\. Please try again\.\r?\n\r?\nClient Request Id: [a-f0-9-]{36}\r?\n\r?\nReason: ([^\r\n]*)/i.exec(body);
  // A native diagnostic can include its stack inside message. Line numbers and
  // request IDs are not provider status codes; classify only the actual reason.
  return nativeFailure({ message: reason?.[1] ?? body.split(/\r?\n/, 1)[0] }, cancelled);
}

function acceptsString(schema, value) {
  if (!object(schema) || schema.type !== 'string' || ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'pattern'].some(key => key in schema)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.every(item => typeof item === 'string') || !schema.enum.includes(value))) return false;
  if ('const' in schema && schema.const !== value) return false;
  for (const [key, passes] of [['minLength', length => value.length >= length], ['maxLength', length => value.length <= length]]) {
    if (key in schema && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || !passes(schema[key]))) return false;
  }
  return true;
}

function compatible(schema, input) {
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties) || !Array.isArray(schema.required) ||
      !['prompt', 'description'].every(key => schema.required.includes(key)) ||
      schema.required.some(key => !['prompt', 'description', 'agentName', 'model'].includes(key) || !(key in input)) ||
      ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'].some(key => key in schema)) return false;
  return Object.entries(input).every(([key, value]) => acceptsString(schema.properties[key], value));
}

function createLocalDelegator(vscode, workerProfiles, profileAuthority) {
  return {
    async invoke(handoff, toolInvocationToken, cancellationToken, observe, preparedProfile) {
      const metadata = { transport: 'vscode-native', tool: 'runSubagent', agentName: undefined, invoked: false,
        host_call_id: null, native_context_id: null,
        requested_model: { selection: 'inherit' }, resolved_model: 'unknown', resolved_provider: 'unknown', outcome: 'unknown' };
      const reject = error => ({ status: error.category === 'cancellation' ? 'cancelled' : 'rejected', error, metadata });
      if (!object(handoff) || !agents.has(handoff.agentName) || !text(handoff.prompt, 128000) || !text(handoff.description, 1000) ||
          Object.keys(handoff).some(key => !['agentName', 'prompt', 'description', 'model'].includes(key)))
        return reject(failure('INVALID_HANDOFF', 'contract', 'Use a backend-issued specialist handoff with agentName, prompt and description.'));
      metadata.agentName = handoff.agentName;
      if (toolInvocationToken === undefined || toolInvocationToken === null)
        return reject(failure('INVOCATION_TOKEN_REQUIRED', 'context', 'A current native tool invocation token is required.'));
      if (cancellationToken?.isCancellationRequested)
        return reject(nativeFailure(undefined, true));
      const tools = (vscode.lm?.tools ?? []).filter(tool => tool.name === 'runSubagent');
      if (tools.length !== 1 || typeof vscode.lm?.invokeTool !== 'function')
        return reject(failure('NATIVE_TOOL_UNAVAILABLE', 'compatibility', 'Exactly one native runSubagent tool must be available.'));
      // Undefined is the explicit historical adapter path. Current runtimes
      // supply their shared hidden-profile map; no model can choose a profile.
      if (workerProfiles !== undefined && !validNativeWorkerProfiles(workerProfiles))
        return reject(failure('NATIVE_PROFILE_CONTRACT_REQUIRED', 'compatibility', 'Install the matching runtime and native worker profiles.'));
      const input = { agentName: workerProfiles?.[handoff.agentName] ?? handoff.agentName, prompt: handoff.prompt, description: handoff.description };
      if (preparedProfile?.profile) {
        if (preparedProfile.role !== handoff.agentName || profileAuthority?.isPrepared?.(preparedProfile) !== true)
          return reject(failure('NATIVE_MCP_BINDING_CHANGED', 'capability', 'The host-prepared optional MCP profile is no longer current. No native call was started.'));
        input.agentName = preparedProfile.profile.name;
      }
      if (workerProfiles !== undefined) metadata.native_agent_name = input.agentName;
      if (handoff.model !== undefined) {
        const preference = handoff.model;
        if (!object(preference) || !text(preference.id, 1000) || !text(preference.vendor, 160) ||
            Object.keys(preference).some(key => !['id', 'vendor'].includes(key)))
          return reject(failure('INVALID_HANDOFF', 'contract', 'An explicit model preference must contain only its observed id and vendor.'));
        const { id, vendor } = preference;
        metadata.requested_model = { selection: 'explicit', id, vendor };
        if (typeof vscode.lm.selectChatModels !== 'function')
          return reject(failure('MODEL_INVENTORY_UNAVAILABLE', 'compatibility', 'The native model inventory is unavailable.'));
        let inventory;
        try { inventory = await vscode.lm.selectChatModels({}); }
        catch (error) {
          const known = nativeFailure(error, cancellationToken?.isCancellationRequested);
          return reject(known.category === 'unknown' ? failure('MODEL_INVENTORY_UNAVAILABLE', 'environment', 'The native model inventory could not be read.') : known);
        }
        const matches = (Array.isArray(inventory) ? inventory : []).filter(model => model.id === id && model.vendor === vendor);
        if (matches.length !== 1 || !text(matches[0].name, 1000))
          return reject(failure('MODEL_UNAVAILABLE', 'configuration', 'The explicitly requested model is not unique in the current native inventory.'));
        if (matches[0].capabilities?.toolCalling === false)
          return reject(failure('MODEL_TOOL_CALLING_UNAVAILABLE', 'configuration', 'The explicitly requested model no longer supports tool calls in the current native inventory.'));
        metadata.requested_model.name = matches[0].name;
        input.model = `${matches[0].name} (${matches[0].vendor})`;
        metadata.requested_model.native_argument = input.model;
      }
      if (!compatible(tools[0].inputSchema, input))
        return reject(failure('NATIVE_SCHEMA_INCOMPATIBLE', 'compatibility', 'The observed native tool schema does not support this exact handoff.'));
      if (cancellationToken?.isCancellationRequested) return reject(nativeFailure(undefined, true));
      try {
        metadata.host_call_id = randomUUID();
        metadata.invoked = true;
        // Invoke first; an observation is not permission to invent a running
        // native call before the actual host API has been called.
        const pending = vscode.lm.invokeTool('runSubagent', { input, toolInvocationToken }, cancellationToken);
        let close;
        try { close = observe?.(structuredClone(metadata)); } catch { /* A view cannot interrupt model execution. */ }
        let raw_result;
        try { raw_result = await pending; }
        finally { try { close?.(); } catch { /* Read-only observation is best effort. */ } }
        const returnedError = returnedNativeFailure(raw_result, cancellationToken?.isCancellationRequested);
        if (returnedError) return reject(returnedError);
        metadata.outcome = 'unverified';
        return { status: 'returned', raw_result, metadata };
      } catch (error) {
        return reject(nativeFailure(error, cancellationToken?.isCancellationRequested));
      }
    },
  };
}

module.exports = { createLocalDelegator, nativeProfessionalRoles, validNativeWorkerProfiles };
