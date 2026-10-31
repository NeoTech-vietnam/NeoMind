import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { atomicWrite, safePath, hash } from './storage.js';
import { canonicalJson, routingConfigurationHashes, type NativeRole } from './routing.js';
import { createRuntimeInfo } from './runtime-info.js';
import { configuredOpenCodeEndpoint, createOpenCodeGateway, openCodeBinary, openCodeBootstrap, openCodeConfiguration,
  startOpenCodeEngine, opencodeProviderId, opencodeRuntimeVersion, type OpenCodeEndpoint } from './opencode-engine.js';
import { readHost } from './vscode-wire.js';

const proofPath = '.workforce/setup/model-capabilities.json';
/** Share preparation only within one private probe and identical credentials. */
export function groupWorkForceConnectionEndpoints(endpoints: readonly OpenCodeEndpoint[]): OpenCodeEndpoint[][] {
  const groups: OpenCodeEndpoint[][] = [];
  for (const endpoint of endpoints) {
    const group = groups.find(([first]) => first!.provider === endpoint.provider && first!.baseURL === endpoint.baseURL && first!.apiKey === endpoint.apiKey);
    if (group) group.push(endpoint); else groups.push([endpoint]);
  }
  return groups;
}
function configuration(root: string) {
  const runtime = createRuntimeInfo(root), binary = openCodeBinary(), bootstrap = openCodeBootstrap();
  const endpoints = (['manager', 'requirements', 'architect', 'developer', 'reviewer', 'verifier'] as NativeRole[]).map(role => configuredOpenCodeEndpoint(root, role));
  return { key: hash(canonicalJson({ build: runtime.build_fingerprint, configuration: routingConfigurationHashes(root),
    binary: binary.sha256, bootstrap: bootstrap.lock_sha256, platform: process.platform, arch: process.arch })),
    endpoints: [...new Map(endpoints.map(endpoint => [hash(canonicalJson({ provider: endpoint.provider, model: endpoint.model,
      baseURL: endpoint.baseURL, apiKey: endpoint.apiKey ?? null })), endpoint])).values()] };
}
export function workForceConnectionProof(root: string): { valid: boolean; checked_at?: string; models?: string[] } {
  try {
    const bound = configuration(root), file = safePath(root, proofPath);
    if (!existsSync(file)) return { valid: false };
    const proof = JSON.parse(readFileSync(file, 'utf8'));
    const models = bound.endpoints.map(endpoint => endpoint.model).sort();
    if (proof.schema_version !== 1 || proof.key !== bound.key || proof.engine_version !== opencodeRuntimeVersion ||
        !Array.isArray(proof.models) || canonicalJson(proof.models.map((item: any) => item.model).sort()) !== canonicalJson(models) ||
        proof.models.some((item: any) => item.provider !== opencodeProviderId || item.tool_calls !== 1 ||
          !/^ses_/.test(item.session_id) || !/^msg_/.test(item.message_id))) return { valid: false };
    return { valid: true, checked_at: proof.checked_at, models };
  } catch { return { valid: false }; }
}

export interface WorkForceConnectionProbeOptions {
  /** Backend incident timestamp. A previous success cannot establish recovery. */
  not_before?: string;
}
export function workForceConnectionProofSatisfies(proof: ReturnType<typeof workForceConnectionProof>, options: WorkForceConnectionProbeOptions = {}): boolean {
  if (!proof.valid) return false;
  if (!options.not_before) return true;
  const threshold = Date.parse(options.not_before), observed = Date.parse(proof.checked_at ?? '');
  if (!Number.isFinite(threshold)) throw new Error('The connection recovery checkpoint must be an actual incident timestamp.');
  return Number.isFinite(observed) && observed > threshold;
}
/** One real bound tool-call per distinct configured route; never a product task.
 * Normal setup reuses its proof. Incident recovery requires new actual evidence. */
export async function probeWorkForceConnection(root: string, signal?: AbortSignal, options: WorkForceConnectionProbeOptions = {}) {
  const cached = workForceConnectionProof(root); if (workForceConnectionProofSatisfies(cached, options)) return cached;
  const bound = configuration(root), owner = readHost(root), observed = [];
  for (const group of groupWorkForceConnectionEndpoints(bound.endpoints)) {
    const deadline = AbortSignal.timeout(120000), stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let current: { nonce: string; calls: number } | undefined;
    const active = () => { stop.throwIfAborted(); const current = readHost(root);
      if (current.instance !== owner.instance || current.pid !== owner.pid) throw new Error('WorkForce connection owner changed.'); };
    const gateway = await createOpenCodeGateway(() => {
      const server = new McpServer({ name: 'workforce-connection-check', version: '1' });
      server.registerTool('capability_ping', { description: 'Verify this connection by echoing its current session nonce once.', inputSchema: { nonce: z.uuid() } }, ({ nonce }) => {
        active();
        if (!current || nonce !== current.nonce) throw new Error('Connection check nonce is stale.');
        current.calls++;
        if (current.calls > 1) throw new Error('Connection check already recorded.');
        return { content: [{ type: 'text', text: JSON.stringify({ connected: true, nonce }) }] };
      });
      return server;
    }, active);
    let engine;
    try {
      const config = openCodeConfiguration(group[0]!, gateway, ['capability_ping']);
      for (const endpoint of group.slice(1)) Object.assign(config.provider![opencodeProviderId]!.models!,
        openCodeConfiguration(endpoint, gateway, ['capability_ping']).provider![opencodeProviderId]!.models);
      engine = await startOpenCodeEngine(root, randomUUID(), config, stop);
      const listed = await engine.client.tool.ids({ directory: engine.directory });
      const tools = { ...Object.fromEntries((listed.data ?? []).map(name => [name, false])), wf_capability_ping: true };
      for (const endpoint of group) {
        active(); current = { nonce: randomUUID(), calls: 0 };
        const session = await engine.client.session.create({ directory: engine.directory, agent: 'workforce', title: 'WorkForce connection check',
          permission: [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'wf_capability_ping', pattern: '*', action: 'allow' }] });
        if (!session.data?.id) throw new Error('Connection check has no engine session.');
        const sessionID = session.data.id, messageID = `msg_${randomUUID().replaceAll('-', '')}`;
        const response = await engine.client.session.prompt({ sessionID, messageID, directory: engine.directory, agent: 'workforce',
          model: { providerID: opencodeProviderId, modelID: endpoint.model }, tools,
          parts: [{ type: 'text', text: `Call wf_capability_ping exactly once with nonce ${current.nonce}. Then reply connected. Do not call any other tools.` }] }, { signal: stop });
        active();
        if (current.calls !== 1 || response.data?.info.error || response.data?.info.modelID !== endpoint.model ||
            response.data.info.providerID !== opencodeProviderId || response.data.info.sessionID !== sessionID || response.data.info.parentID !== messageID)
          throw new Error('Configured model did not complete its bound tool-call check.');
        observed.push({ model: endpoint.model, provider: opencodeProviderId, session_id: sessionID,
          message_id: response.data.info.id, tool_calls: current.calls });
        current = undefined;
      }
    } finally { try { await engine?.close(); } finally { await gateway.close(); } }
    active();
  }
  if (configuration(root).key !== bound.key) throw new Error('WorkForce configuration changed during the connection check.');
  atomicWrite(safePath(root, proofPath), JSON.stringify({ schema_version: 1, key: bound.key, engine_version: opencodeRuntimeVersion,
    checked_at: new Date().toISOString(), models: observed }, null, 2) + '\n');
  return workForceConnectionProof(root);
}
