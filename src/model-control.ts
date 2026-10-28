import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { resolveCatalogModel } from './model-catalog.js';
import { agentProfiles, legacyAgentProfiles } from './agent-profiles.js';
import {
  hash, atomicWrite, readConfig, safePath, withOperationLock,
} from './storage.js';
import {
  canonicalJson, invocationIsActive, readInvocation, requireRoutingPolicy, roleModelPolicy,
  strongRoles, workerRoles, type NativeRole,
} from './routing.js';
import {
  routerBaseUrl, checkRouterHealth, listRouterModels, probeRouter,
} from './router-probe.js';
import { configuredOpenCodeEndpoint } from './opencode-engine.js';

const roles = [...strongRoles, ...workerRoles];
const text = z.string().trim().min(1).max(256).refine(value => !/[\r\n\0]/.test(value));
const selectionSchema = z.object({
  role: z.enum(roles), model: text, provider: text.optional(),
  effort: z.enum(['high', 'medium', 'low']).optional(),
}).strict();
const routerSchema = z.object({
  schema_version: z.literal(1),
  base_url: z.string().transform(value => routerBaseUrl(value)),
  api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).default('NEOMIND_ROUTER_API_KEY'),
  catalog_provider: text.default('9Router'),
}).strict();
export type RouterConfiguration = z.infer<typeof routerSchema>;

const workforceRoles: NativeRole[] = ['manager', 'requirements', 'architect', 'developer', 'reviewer', 'verifier'];
function checkedModelCatalog(root: string, path: string) {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('Choose an existing absolute VS Code model catalog file.');
  let actual: string;
  try { actual = realpathSync.native(path); const info = lstatSync(actual);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(); }
  catch { throw new Error('The selected VS Code model catalog is unavailable.'); }
  const policy = { ...requireRoutingPolicy(root), language_models_file: actual };
  const catalog: unknown = JSON.parse(readFileSync(actual, 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('The selected VS Code model catalog must be an array.');
  const candidates = new Set<string>();
  for (const value of catalog) {
    if (!value || typeof value !== 'object' || value.vendor !== 'customendpoint') continue;
    for (const model of Array.isArray(value.models) ? value.models : [])
      if (model && typeof model.id === 'string') candidates.add(model.id);
    if (value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings))
      Object.keys(value.settings).forEach(model => candidates.add(model));
  }
  const available = [...candidates].filter(model => {
    try {
      configuredOpenCodeEndpoint(root, 'manager', { ...policy, role_models: { ...policy.role_models,
        manager: { model, provider: 'customendpoint' } } }); return true;
    } catch { return false; }
  });
  if (!available.length) throw new Error('The selected catalog has no unambiguous supported custom endpoint. Existing routing was preserved.');
  const models: string[] = [], unresolved: { role: NativeRole; model: string }[] = [];
  for (const role of workforceRoles) {
    try { models.push(configuredOpenCodeEndpoint(root, role, policy).model); }
    catch { unresolved.push({ role, model: roleModelPolicy(root, role, policy).models[0]! }); }
  }
  return { path: actual, policy, models: [...new Set(models)], available_models: available,
    unresolved_roles: unresolved, selections_valid: !unresolved.length };
}
/** Store only the catalog pointer; credentials remain in the user's existing catalog. */
export function configureWorkForceModelCatalog(root: string, input: { path: string }) {
  return withOperationLock(root, 'native-dispatch', () => withOperationLock(root, 'routing-policy', () => {
    assertIdle(root);
    const value = checkedModelCatalog(root, input.path);
    atomicWrite(safePath(root, '.workforce/routing.json'), JSON.stringify(value.policy, null, 2) + '\n');
    return { path: value.path, models: value.models, available_models: value.available_models,
      unresolved_roles: value.unresolved_roles, selections_valid: value.selections_valid,
      credential_storage: 'existing-user-catalog' as const };
  }));
}
/** Discovery never overwrites an authored choice or prints catalog contents. */
export function discoverWorkForceModelCatalog(root: string): { path: string | null; candidates: string[] } {
  const policy = requireRoutingPolicy(root);
  if (policy.language_models_file) return { path: null, candidates: [] };
  const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const candidates = [...new Set(base ? ['Code', 'Code - Insiders'].flatMap(name => {
    try { return [checkedModelCatalog(root, join(base, name, 'User', 'chatLanguageModels.json')).path]; } catch { return []; }
  }) : [])];
  return { path: candidates.length === 1 ? candidates[0]! : null, candidates };
}

function activeInvocations(root: string): { id: string; role: NativeRole; state: string; controlled?: true }[] {
  const directory = safePath(root, '.neomind/native/receipts');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    const receipt = readInvocation(root, name.slice(0, -5));
    return invocationIsActive(receipt) ? [{ id: receipt.id, role: receipt.role, state: receipt.state, ...(receipt.controlled_execution ? { controlled: true as const } : {}) }] : [];
  });
}

function assertIdle(root: string, permitControlled = false): void {
  const active = activeInvocations(root);
  if (active.length && !(permitControlled && active.every(item => !!readInvocation(root, item.id).controlled_execution)))
    throw new Error('Model configuration cannot change while an invocation is active. Interrupt or reconcile it, then start a new invocation.');
}

export function readRouterConfiguration(root: string): RouterConfiguration | null {
  const path = safePath(root, '.neomind/router.json');
  if (!existsSync(path)) return null;
  const parsed = routerSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error('Invalid local router configuration in .neomind/router.json.');
  return parsed.data;
}

export function configureRouter(root: string, input: {
  base_url: string; api_key_env?: string; catalog_provider?: string;
}): RouterConfiguration {
  readConfig(root);
  const parsed = routerSchema.parse({ schema_version: 1, ...input });
  return withOperationLock(root, 'native-dispatch', () => withOperationLock(root, 'routing-policy', () => {
    assertIdle(root);
    atomicWrite(safePath(root, '.neomind/router.json'), JSON.stringify(parsed, null, 2) + '\n');
    return parsed;
  }));
}

/** Policy edits affect new invocations and never rewrite a receipt or running conversation. */
export function setRoleModel(root: string, input: {
  role: string; model: string; provider?: string; effort?: 'high' | 'medium' | 'low';
}): {
  role: NativeRole; model: string; provider?: string; reasoning_effort: 'high' | 'medium' | 'low';
  applies_to: 'next-invocation'; routing_sha256: string;
} {
  const selection = selectionSchema.parse(input);
  return withOperationLock(root, 'native-dispatch', () => withOperationLock(root, 'routing-policy', () => {
    assertIdle(root, true);
    const policy = requireRoutingPolicy(root);
    const previous = roleModelPolicy(root, selection.role);
    const provider = selection.provider ?? previous.provider;
    let model = selection.model;
    if (policy.language_models_file && provider !== 'copilot') {
      const path = isAbsolute(policy.language_models_file) ? policy.language_models_file
        : resolve(root, policy.language_models_file);
      if (!existsSync(path)) throw new Error('VS Code language model catalog is unavailable.');
      const catalog: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(catalog)) throw new Error('VS Code language model catalog must be an array.');
      const resolved = resolveCatalogModel(catalog, model, provider);
      if (!resolved?.id?.trim() || !resolved.vendor)
        throw new Error('Selected model must resolve to exactly one catalog vendor and ID.');
      model = resolved.id;
    } else if (provider && provider !== 'copilot') {
      throw new Error('Custom model selection requires a configured VS Code language model catalog.');
    }
    const effort = selection.effort ?? previous.reasoning_effort;
    policy.role_models = { ...policy.role_models, [selection.role]: {
      model, ...(provider ? { provider } : {}), effort,
    } };
    if (readConfig(root).execution_engine === 'opencode') configuredOpenCodeEndpoint(root, selection.role, policy);
    atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify(policy, null, 2) + '\n');
    return { role: selection.role, model, ...(provider ? { provider } : {}),
      reasoning_effort: effort, applies_to: 'next-invocation', routing_sha256: hash(canonicalJson(policy)) };
  }));
}

export function modelControlStatus(root: string) {
  const config = readConfig(root);
  const profiles = config.execution_engine === 'opencode' ? agentProfiles : legacyAgentProfiles;
  const visibleRoles = config.execution_engine === 'opencode' ? profiles.map(profile => profile.modelRole) : roles;
  return {
    native_routing: { platforms: config.platforms, codex: config.codex_routing ?? 'inherit' },
    roles: [...new Set(visibleRoles)].map(role => ({ ...roleModelPolicy(root, role) })),
    agent_profiles: profiles.map(profile => ({ id: profile.id, name: profile.name,
      roles: [...profile.roles], model_role: profile.modelRole, description: profile.duty,
      native_tools: [...profile.nativeTools] })),
    active_invocations: activeInvocations(root),
    router: readRouterConfiguration(root),
  };
}

function routerRequestOptions(root: string, signal?: AbortSignal) {
  const configuration = readRouterConfiguration(root);
  if (!configuration) throw new Error('Configure the local 9router endpoint first.');
  const api_key = process.env[configuration.api_key_env];
  return { configuration, options: { ...(api_key === undefined ? {} : { api_key }), signal } };
}
export async function routerHealth(root: string, signal?: AbortSignal) {
  const { configuration, options } = routerRequestOptions(root, signal);
  return checkRouterHealth(configuration.base_url, options);
}
export async function routerModels(root: string, signal?: AbortSignal) {
  const { configuration, options } = routerRequestOptions(root, signal);
  return listRouterModels(configuration.base_url, options);
}
export async function routerProbe(root: string, model: string, signal?: AbortSignal) {
  const { configuration, options } = routerRequestOptions(root, signal);
  return probeRouter(configuration.base_url, model, signal, { api_key: options.api_key });
}
