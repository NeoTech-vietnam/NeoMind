import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { vscodeSelection } from './vscode-policy.js';
import { roleCapabilities } from './tools.js';
import { controlledToolNames, type ControlledStage } from './controlled-tools.js';
import { listUpstreams } from './upstreams.js';
import {
  atomicWrite,
  getRecord,
  hash,
  now,
  readConfig,
  safePath,
  withOperationLock,
} from './storage.js';

export const strongRoles = [
  'manager',
  'requirements',
  'architect',
  'component-owner',
  'verifier',
  'reviewer',
] as const;
export const workerRoles = [
  'researcher',
  'codebase-analyst',
  'curator',
  'developer',
  'check-executor',
  'release',
] as const;
export type NativeRole = (typeof strongRoles)[number] | (typeof workerRoles)[number];
export type NativeState =
  | 'starting'
  | 'running'
  | 'waiting-native-permission'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'blocked'
  | 'orphaned';
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n\x00]/.test(value));
const reasoningEffort = z.enum(['high', 'medium', 'low']);
const roleModelSchema = z.object({
  model: modelId,
  provider: modelId.optional(),
  effort: reasoningEffort.optional(),
}).strict();
const routingPolicySchema = z
  .object({
    schema_version: z.literal(1),
    enabled: z.literal(true),
    platform: z.literal('copilot'),
    runtime_version: z.literal('0.162.1'),
    strong_model: modelId,
    worker_models: z
      .array(modelId)
      .min(1)
      .refine((models) => new Set(models).size === models.length),
    strong_effort: reasoningEffort,
    worker_effort: reasoningEffort,
    strong_provider: modelId.optional(),
    worker_provider: modelId.optional(),
    language_models_file: z.string().min(1).optional(),
    vscode_effort_policy: z.enum(['require-verified', 'allow-unavailable']).optional(),
    role_models: z.partialRecord(z.enum([...strongRoles, ...workerRoles]), roleModelSchema).optional(),
  })
  .strict();
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
export interface NativeReceipt {
  controlled_execution?: { schema_version: 1; epoch_id: string; stage: ControlledStage; routing_policy: RoutingPolicy };
  schema_version: 1;
  issuer: 'neomind-codex-app-server' | 'neomind-vscode-lm' |
    'taskforces-codex-app-server' | 'taskforces-vscode-lm' |
    'verythinker-codex-app-server' | 'verythinker-vscode-lm';
  execution_mode: 'native' | 'protocol-fixture' | 'vscode-extension-host';
  host_instance?: string;
  identity_provenance?: 'local-vscode-extension-host';
  effort_support?: 'unavailable';
  id: string;
  receipt_path: string;
  project_id: string;
  role: NativeRole;
  workflow_id: string | null;
  task_id: string | null;
  request_id: string | null;
  prior_invocation_id: string | null;
  input_text: string;
  input_sha256: string;
  requested_model: string;
  confirmed_model: string | null;
  model_provider: string | null;
  native_sandbox: string | null;
  native_tool_scope: string[];
  gateway_policy_sha256: string | null;
  reasoning_effort: 'high' | 'medium' | 'low';
  confirmed_reasoning_effort: string | null;
  client_version: string;
  runtime_integrity: string;
  protocol_sha256: string;
  routing_sha256: string;
  configuration_hashes: Record<string, string>;
  effective_configuration_sha256: string | null;
  native_thread_id: string | null;
  native_turn_id: string | null;
  state: NativeState;
  inference_completed: boolean;
  output: string;
  error: string | null;
  fallback_evidence: { model: string; reason: string; at: string } | null;
  reroutes: { from: string; to: string; reason: string; at: string }[];
  permissions: { method: string; request_id: string | number; reason: string; at: string }[];
  owner_pid: number;
  server_pid: number | null;
  created_at: string;
  updated_at: string;
  key_id: string;
  signature: string;
}
export interface RoutingBinding {
  workflow_id?: string;
  task_id?: string;
  require_completed?: boolean;
}

/** Canonical representation used for native receipt signatures. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function defaultRoutingPolicy(): RoutingPolicy {
  return {
    schema_version: 1,
    enabled: true,
    platform: 'copilot',
    runtime_version: '0.162.1',
    strong_model: 'claude-opus-4.6',
    worker_models: ['gpt-5.4'],
    strong_effort: 'high',
    worker_effort: 'low',
  };
}
export function readRoutingPolicy(root: string): RoutingPolicy | null {
  const path = safePath(root, '.neomind/routing.json');
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const result = routingPolicySchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid routing configuration in .neomind/routing.json: ${result.error.message}`,
    );
  return result.data;
}
export function ensureRoutingPolicy(root: string): RoutingPolicy {
  readConfig(root);
  return withOperationLock(root, 'routing-policy', () => {
    const existing = readRoutingPolicy(root);
    if (existing) return existing;
    const policy = defaultRoutingPolicy();
    atomicWrite(
      safePath(root, '.neomind/routing.json'),
      JSON.stringify(policy, null, 2) + '\n',
    );
    return policy;
  });
}
export function requireRoutingPolicy(root: string): RoutingPolicy {
  const policy = readRoutingPolicy(root);
  if (!policy)
    throw new Error(
      'Strict native routing policy is missing; restore it before native operations.',
    );
  return policy;
}
export function roleModelPolicy(
  root: string,
  role: string,
  savedPolicy?: RoutingPolicy,
): {
  role: NativeRole;
  models: string[];
  reasoning_effort: 'high' | 'medium' | 'low';
  strong: boolean;
  provider?: string;
} {
  const policy = savedPolicy ?? requireRoutingPolicy(root);
  if (
    !(strongRoles as readonly string[]).includes(role) &&
    !(workerRoles as readonly string[]).includes(role)
  )
    throw new Error(`Unsupported native role: ${role}.`);
  const strong = (strongRoles as readonly string[]).includes(role);
  const override = policy.role_models?.[role as NativeRole];
  return {
    role: role as NativeRole,
    strong,
    models: override ? [override.model] : strong ? [policy.strong_model] : [...policy.worker_models],
    reasoning_effort: override?.effort ?? (strong ? policy.strong_effort : policy.worker_effort),
    provider: override?.provider ?? (strong ? policy.strong_provider : policy.worker_provider),
  };
}
export function routingConfigurationHashes(root: string): Record<string, string> {
  const paths = [
    '.neomind/config.json',
    '.neomind/routing.json',
    '.neomind/native-runtime.lock.json',
    '.neomind/tools.json',
    '.codex/config.toml',
  ];
  const hashes = Object.fromEntries(
    paths.map((path) => [
      path,
      existsSync(safePath(root, path)) ? hash(readFileSync(safePath(root, path))) : 'absent',
    ]),
  );
  // Preserve old receipt hash maps when no router configuration exists.
  const routerPath = '.neomind/router.json';
  if (existsSync(safePath(root, routerPath))) hashes[routerPath] = hash(readFileSync(safePath(root, routerPath)));
  const reaPath = '.neomind/rea.json';
  if (existsSync(safePath(root, reaPath))) hashes[reaPath] = hash(readFileSync(safePath(root, reaPath)));
  if (existsSync(safePath(root, '.neomind/upstreams.json'))) {
    const registry = listUpstreams(root);
    hashes['upstream-instructions'] = hash(canonicalJson({
      schema_version: registry.schema_version,
      sources: registry.sources.map(({ id, repository, commit, role, instruction_paths, instructions }) =>
        ({ id, repository, commit, role, instruction_paths, instructions })),
    }));
  }
  const catalog = readRoutingPolicy(root)?.language_models_file;
  if (catalog) {
    const path = isAbsolute(catalog) ? catalog : resolve(root, catalog);
    // Hash only; never archive credentials or endpoint configuration.
    hashes['vscode-language-model-catalog'] = existsSync(path) ? hash(readFileSync(path)) : 'absent';
  }
  return hashes;
}
/** Controlled sessions retain their signed model selection while future role selections may change. */
export function invocationPolicy(root: string, receipt: NativeReceipt): RoutingPolicy {
  return receipt.controlled_execution ? routingPolicySchema.parse(receipt.controlled_execution.routing_policy) : requireRoutingPolicy(root);
}
export function invocationConfigurationHashes(root: string, receipt: NativeReceipt): Record<string, string> {
  const hashes = routingConfigurationHashes(root);
  if (receipt.controlled_execution) {
    const old = invocationPolicy(root, receipt), current = requireRoutingPolicy(root);
    const { role_models: _old, ...oldBase } = old, { role_models: _current, ...currentBase } = current;
    if (canonicalJson(oldBase) === canonicalJson(currentBase)) hashes['.neomind/routing.json'] = receipt.configuration_hashes['.neomind/routing.json']!;
  }
  return hashes;
}
export function nativeReceiptPath(root: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    throw new Error('Native invocation IDs must be bridge-issued UUIDs.');
  return safePath(root, `.neomind/native/receipts/${id}.json`);
}
export function readInvocation(root: string, id: string): NativeReceipt {
  const value = JSON.parse(readFileSync(nativeReceiptPath(root, id), 'utf8')) as NativeReceipt;
  const { signature, ...unsigned } = value;
  if (
    value.schema_version !== 1 ||
    !['neomind-codex-app-server', 'neomind-vscode-lm',
      'taskforces-codex-app-server', 'taskforces-vscode-lm',
      'verythinker-codex-app-server', 'verythinker-vscode-lm'].includes(value.issuer) ||
    value.id !== id ||
    value.project_id !== readConfig(root).project_id ||
    ![`.neomind/native/receipts/${id}.json`, `.taskforces/native/receipts/${id}.json`, `.verythinker/native/receipts/${id}.json`].includes(value.receipt_path) ||
    !/^[a-f0-9]{64}$/.test(value.key_id)
  )
    throw new Error('Native invocation receipt identity is invalid.');
  const trusted = JSON.parse(
    readFileSync(safePath(root, '.neomind/native/trust.json'), 'utf8'),
  ) as { keys: string[] };
  const key = readFileSync(safePath(root, `.neomind/native/keys/${value.key_id}.pem`), 'utf8');
  if (
    !Array.isArray(trusted.keys) ||
    !trusted.keys.includes(value.key_id) ||
    hash(key) !== value.key_id ||
    typeof signature !== 'string' ||
    !verify(
      null,
      Buffer.from(canonicalJson(unsigned)),
      createPublicKey(key),
      Buffer.from(signature, 'base64'),
    )
  )
    throw new Error('Native invocation receipt signature or trusted public key is invalid.');
  return value;
}
export function invocationIsActive(receipt: NativeReceipt): boolean {
  return ['starting', 'running', 'waiting-native-permission'].includes(receipt.state);
}
export function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function routingBindingProblems(
  root: string,
  receipt: NativeReceipt,
  binding: RoutingBinding,
): string[] {
  const problems: string[] = [];
  if (binding.workflow_id !== undefined && receipt.workflow_id !== binding.workflow_id)
    problems.push('Native invocation belongs to a different workflow.');
  if (binding.task_id !== undefined && receipt.task_id !== binding.task_id) {
    let workflowPlanning = false;
    if (
      receipt.task_id === null &&
      receipt.workflow_id &&
      binding.workflow_id === receipt.workflow_id &&
      (strongRoles as readonly string[]).includes(receipt.role)
    ) {
      try {
        const task = getRecord(root, binding.task_id);
        workflowPlanning =
          task.meta.type === 'task' && task.meta.data.workflow_id === receipt.workflow_id;
      } catch {
        /* An unknown task cannot establish planning scope. */
      }
    }
    if (!workflowPlanning) problems.push('Native invocation belongs to a different task.');
  }
  return problems;
}
export function routingProblems(
  root: string,
  role: string,
  invocationId: string | undefined,
  binding: RoutingBinding = {},
): string[] {
  if (!readRoutingPolicy(root)) return [];
  const errors: string[] = [];
  if (!invocationId) return ['Strict routing requires a bridge-issued native invocation receipt.'];
  let receipt: NativeReceipt;
  try {
    receipt = readInvocation(root, invocationId);
  } catch (error) {
    return [`Native routing receipt cannot be verified: ${String(error)}.`];
  }
  const frozenPolicy = invocationPolicy(root, receipt);
  const policy = roleModelPolicy(root, role, frozenPolicy);
  const historicalNamespace = receipt.issuer.startsWith('verythinker-') ? 'verythinker'
    : receipt.issuer.startsWith('taskforces-') ? 'taskforces' : 'neomind';
  const vscode = receipt.issuer.endsWith('-vscode-lm');
  let expectedModel: string | undefined = vscode ? undefined : receipt.requested_model;
  if (vscode) {
    if (receipt.execution_mode !== 'vscode-extension-host' ||
        receipt.identity_provenance !== 'local-vscode-extension-host' ||
        !/^[a-f0-9]{64}$/.test(receipt.host_instance ?? '') ||
        receipt.protocol_sha256 !== hash(`${historicalNamespace}-vscode-lm-v1`) ||
        receipt.runtime_integrity !== '' || receipt.native_sandbox !== null ||
        !receipt.native_thread_id?.startsWith('vscode-host:conversation:') ||
        !receipt.native_turn_id?.startsWith('vscode-host:turn:') || !receipt.client_version)
      errors.push('VS Code local host attestation or host-issued identity is invalid.');
    try {
      const selection = vscodeSelection(root, role, receipt.requested_model, frozenPolicy);
      expectedModel = selection.id;
      if (receipt.model_provider !== selection.vendor)
        errors.push('VS Code host selected a different provider.');
    } catch { errors.push('VS Code provider selection cannot be verified against routing policy.'); }
    if (frozenPolicy.vscode_effort_policy !== 'allow-unavailable' ||
        receipt.effort_support !== 'unavailable' || receipt.confirmed_reasoning_effort !== null)
      errors.push('VS Code reasoning effort is unavailable; explicit allow-unavailable compatibility policy required.');
    const operations = receipt.controlled_execution ? controlledToolNames({ role: receipt.role,
      stage: receipt.controlled_execution.stage, workflow_id: receipt.workflow_id!, implementation_paths: [], verification_paths: [] }) : roleCapabilities(role).operations;
    if (canonicalJson(receipt.native_tool_scope) !== canonicalJson(operations) ||
        receipt.gateway_policy_sha256 !== hash(canonicalJson(operations)))
      errors.push('VS Code invocation-bound gateway scope is invalid.');
  } else {
  if (receipt.execution_mode !== 'native')
    errors.push(
      'Protocol fixture receipts cannot establish authenticated native routing or strict acceptance.',
    );
  if (
    receipt.runtime_integrity !==
      'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==' ||
    !/^[a-f0-9]{64}$/.test(receipt.protocol_sha256)
  )
    errors.push(
      'Native runtime integrity or protocol provenance does not match the pinned runtime.',
    );
  try {
    const runtime = JSON.parse(
      readFileSync(safePath(root, '.neomind/native-runtime.lock.json'), 'utf8'),
    );
    if (
      runtime.version !== receipt.client_version ||
      runtime.integrity !== receipt.runtime_integrity ||
      runtime.protocol_sha256 !== receipt.protocol_sha256
    )
      errors.push('Native invocation differs from the pinned runtime lock.');
  } catch {
    errors.push('Pinned native runtime lock is unavailable.');
  }
  }
  if (receipt.role !== role)
    errors.push('Native invocation belongs to a different engineering role.');
  errors.push(...routingBindingProblems(root, receipt, binding));
  if (
    !policy.models.includes(receipt.requested_model) ||
    receipt.confirmed_model !== expectedModel
  )
    errors.push('The native client did not acknowledge the permitted requested model.');
  const modelIndex = policy.models.indexOf(receipt.requested_model);
  if (
    modelIndex > 0 &&
    (receipt.fallback_evidence?.model !== policy.models[modelIndex - 1] ||
      !receipt.fallback_evidence?.reason)
  )
    errors.push(
      'Worker fallback requires native evidence that the preceding configured model was unavailable.',
    );
  if (
    (!vscode && receipt.confirmed_reasoning_effort !== policy.reasoning_effort) ||
    receipt.reasoning_effort !== policy.reasoning_effort
  )
    errors.push('Native reasoning effort does not match the role policy.');
  if (!vscode && policy.strong && receipt.native_sandbox !== 'readOnly')
    errors.push('Strategic role lacks native acknowledgment of read-only shell access.');
  if (
    (!vscode && receipt.client_version !== '0.162.1') ||
    !receipt.model_provider ||
    !receipt.native_thread_id ||
    !receipt.native_turn_id
  )
    errors.push('The native acknowledgment lacks version, provider, thread, or turn provenance.');
  if (receipt.reroutes.length)
    errors.push(
      'The native client rerouted this invocation; reassessment with a fresh invocation is required.',
    );
  if (receipt.routing_sha256 !== hash(canonicalJson(frozenPolicy)))
    errors.push('Routing policy changed after this invocation started.');
  const currentHashes = invocationConfigurationHashes(root, receipt);
  const expectedHashes = historicalNamespace !== 'neomind'
    ? Object.fromEntries(Object.entries(currentHashes).map(([path, value]) =>
      [path.replace(/^\.neomind\//, `.${historicalNamespace}/`), value])) : currentHashes;
  if (
    canonicalJson(receipt.configuration_hashes) !== canonicalJson(expectedHashes)
  )
    errors.push('Relevant native configuration changed after this invocation started.');
  if (
    binding.require_completed !== false &&
    (receipt.state !== 'completed' || !receipt.inference_completed)
  )
    errors.push('Native inference has not completed successfully for this invocation.');
  if (binding.require_completed === false && !['running', 'completed'].includes(receipt.state))
    errors.push(`Native invocation is ${receipt.state}; work is blocked.`);
  if (invocationIsActive(receipt) && !ownerIsAlive(receipt.owner_pid))
    errors.push('Native invocation owner is absent; reconcile its transport before resuming.');
  return errors;
}
export function assertRouting(
  root: string,
  role: string,
  invocationId: string | undefined,
  binding: RoutingBinding = {},
): NativeReceipt | null {
  requireRoutingPolicy(root);
  const errors = routingProblems(root, role, invocationId, binding);
  if (errors.length) throw new Error(errors.join(' '));
  return invocationId && readRoutingPolicy(root) ? readInvocation(root, invocationId) : null;
}
