import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parse as parseJsonc } from 'jsonc-parser';
import { createHash } from 'node:crypto';
import { readRoutingPolicy, roleModelPolicy, strongRoles } from './routing.js';
import { roleCapabilities, toolCatalog, readToolPolicy } from './tools.js';
import { safePath } from './storage.js';
import { resolveCatalogModel } from './model-catalog.js';
import { readRoleUpstreamInstructions } from './upstreams.js';
import { agentProfiles, agentDelegation, nativeActivityInstructions, nativeIdentityInstructions, type AgentProfile } from './agent-profiles.js';
import { readCodexRouting } from './codex-routing.js';
import { nativeHookOutputs } from './agent-hooks.js';
import { reaToolsForRole, readReaSkillBundle } from './rea.js';
import { pluginRegistration } from './plugin-control.js';
import { pluginClientConnectionEnabled, type PluginConnectionClient } from './plugin-connections.js';

export type Platform = 'copilot' | 'claude' | 'codex';
export type ModelTier = 'economy' | 'balanced' | 'strong';
export interface AdapterConfig {
  schema_version: number;
  project_id: string;
  name: string;
  profile: string;
  platforms: Platform[];
  copilot_integration?: 'local';
  codex_routing?: 'inherit' | '9router';
  models: Record<ModelTier, string | null | Record<string, string>>;
  max_workers: number;
  repair_attempts: number;
}
export interface ManagedOutput {
  path: string;
  content: string;
  kind: 'file' | 'block' | 'json';
  key?: string;
  jsonPath?: (string | number)[];
  value?: unknown;
  /** Root TOML keys must precede all table headers. Existing authored keys cause a candidate. */
  placement?: 'preamble';
  rootKeys?: string[];
}

export const resourcesDirectory = fileURLToPath(new URL('../resources/', import.meta.url));
export const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
export const platforms: Platform[] = ['copilot', 'claude', 'codex'];

/** Regeneration inside Electron must never turn a stdio Node server into Code.exe. */
export function adapterNodeCommand(root: string, host = {
  executable: process.execPath, electron: Boolean(process.versions.electron),
}): string {
  if (!host.electron) return host.executable;
  try {
    const manifest = JSON.parse(readFileSync(safePath(root, '.neomind/install-manifest.json'), 'utf8'));
    for (const [path, key] of [
      ['.neomind/mcp-server.json', ''], ['.vscode/mcp.json', 'servers.neomind'],
      ['.mcp.json', 'mcpServers.neomind'], ['.codex/config.toml', 'mcp'],
    ]) {
      const entry = manifest.files?.[`${path}${key ? `#${key}` : ''}`];
      if (!entry) continue;
      const source = readFileSync(safePath(root, path!), 'utf8');
      let candidate: unknown;
      let owned = '';
      if (path!.endsWith('.toml')) {
        owned = /# BEGIN (?:NEOMIND|TASKFORCES|VERYTHINKER) mcp\r?\n([\s\S]*?)\r?\n# END (?:NEOMIND|TASKFORCES|VERYTHINKER) mcp/.exec(source)?.[1] ?? '';
        const value = /^command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(owned)?.[1];
        if (value) candidate = JSON.parse(value);
      } else {
        const object = parseJsonc(source);
        const server = path === '.neomind/mcp-server.json' ? object?.servers?.neomind
          : key!.split('.').reduce((value, part) => value?.[part], object);
        owned = entry.kind === 'file' ? source : JSON.stringify(server);
        candidate = server?.command;
      }
      if (typeof owned !== 'string' || createHash('sha256').update(owned).digest('hex') !== entry.hash) continue;
      if (typeof candidate === 'string' && isAbsolute(candidate) && /^node(?:\.exe)?$/i.test(basename(candidate)) &&
          existsSync(candidate) && lstatSync(candidate).isFile()) return realpathSync.native(candidate);
    }
  } catch { /* Missing or edited inventory cannot establish an installed launcher. */ }
  return 'node';
}
export const codeGraphProvider = {
  id: 'codegraph',
  package: '@colbymchenry/codegraph',
  version: '1.6.2',
  enabled: false,
  status: 'unverified',
  required_checks: ['windows', 'cpp', 'freshness'],
  note: 'Legacy direct integration remains optional. The approved alpha.3 gateway installs this pinned provider when applicable and records freshness/availability.',
};

export const codeGraphConformanceChecks = [
  'version',
  'windows',
  'c-symbol',
  'cpp-symbol',
  'cross-file-caller',
  'modify-sync',
  'add-sync',
  'delete-sync',
  'mcp-tool',
  'reconnect-freshness',
  'watch-add',
  'watch-modify',
];
export interface CodeGraphConfiguration {
  schema_version: 1;
  package: string;
  version: string;
  enabled: true;
  status: 'supported-for-fixture';
  command: string;
  args: string[];
  report_path: '.neomind/optional/codegraph-conformance.json';
  report_hash: string;
  platform: string;
  architecture: string;
  limitations: string[];
}

export function validateCodeGraphReport(source: string): { limitations: string[] } {
  const report = JSON.parse(source) as Record<string, unknown>;
  const environment = report['environment'] as Record<string, unknown> | undefined;
  const checks = report['checks'];
  if (
    report['package'] !== codeGraphProvider.package ||
    report['version'] !== codeGraphProvider.version ||
    report['status'] !== 'supported-for-fixture'
  ) {
    throw new Error(
      'CodeGraph requires a supported-for-fixture report for the pinned package version 1.6.2.',
    );
  }
  if (
    process.platform !== 'win32' ||
    environment?.['platform'] !== process.platform ||
    environment?.['architecture'] !== process.arch
  ) {
    throw new Error(
      'CodeGraph conformance must match the current Windows platform and architecture.',
    );
  }
  if (
    !Array.isArray(checks) ||
    checks.length !== codeGraphConformanceChecks.length ||
    checks.some((check) => !check || typeof check !== 'object') ||
    new Set(checks.map((check) => check.id)).size !== checks.length ||
    codeGraphConformanceChecks.some(
      (id) => !checks.some((check) => check.id === id && check.status === 'passed'),
    )
  ) {
    throw new Error('CodeGraph requires all twelve unique conformance checks to pass.');
  }
  return {
    limitations: Array.isArray(report['limitations'])
      ? report['limitations'].filter((item): item is string => typeof item === 'string')
      : [],
  };
}

export function validateCodeGraphCommand(root: string, command: string, args: string[]): void {
  if (
    typeof command !== 'string' ||
    !isAbsolute(command) ||
    !existsSync(command) ||
    !lstatSync(command).isFile() ||
    /\.(cmd|bat)$/i.test(command)
  ) {
    throw new Error(
      'CodeGraph requires an existing absolute executable file; invoke a Node script with the Node executable and separate arguments.',
    );
  }
  if (
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== 'string') ||
    !args.includes('serve') ||
    !args.includes('--mcp')
  ) {
    throw new Error('Provide exact CodeGraph server arguments containing serve and --mcp.');
  }
  const pathIndex = args.indexOf('--path');
  if (
    pathIndex < 0 ||
    !args[pathIndex + 1] ||
    !isAbsolute(args[pathIndex + 1]!) ||
    realpathSync(args[pathIndex + 1]!) !== realpathSync(root) ||
    args.filter((argument) => argument === '--path').length !== 1
  ) {
    throw new Error(
      'CodeGraph server arguments must contain one --path followed by the absolute project root.',
    );
  }
}

export function loadCodeGraphConfiguration(root: string): CodeGraphConfiguration | undefined {
  const path = safePath(root, '.neomind/optional/codegraph.json');
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, 'utf8')) as CodeGraphConfiguration;
  if (
    config.schema_version !== 1 ||
    config.enabled !== true ||
    config.package !== codeGraphProvider.package ||
    config.version !== codeGraphProvider.version ||
    config.report_path !== '.neomind/optional/codegraph-conformance.json' ||
    typeof config.report_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(config.report_hash) ||
    config.platform !== process.platform ||
    config.architecture !== process.arch ||
    !Array.isArray(config.limitations) ||
    config.limitations.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Invalid optional CodeGraph configuration.');
  }
  const source = readFileSync(safePath(root, config.report_path), 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== config.report_hash)
    throw new Error('CodeGraph conformance report has changed since approval.');
  validateCodeGraphReport(source);
  validateCodeGraphCommand(root, config.command, config.args);
  return config;
}

function jsonEntry(path: string, jsonPath: (string | number)[], value: unknown): ManagedOutput {
  return {
    path,
    kind: 'json',
    key: jsonPath.join('.'),
    jsonPath,
    value,
    content: JSON.stringify(value),
  };
}

function modelFor(config: AdapterConfig, tier: ModelTier, platform: Platform): string | undefined {
  const mapping = config.models?.[tier];
  const model = mapping && typeof mapping === 'object' ? mapping[platform] : mapping;
  return model && model !== 'auto' && model !== 'inherit' ? model : undefined;
}

function copilotModels(root: string, role: string): string[] | null {
  const policy = readRoutingPolicy(root);
  if (!policy) return null;
  const specification = roleModelPolicy(root, role);
  const models = specification.models;
  if (!policy.language_models_file) return models;
  const provider = specification.provider;
  if (provider === 'copilot') return models;
  const catalogPath = isAbsolute(policy.language_models_file)
    ? policy.language_models_file
    : resolve(root, policy.language_models_file);
  const catalog: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog))
    throw new Error('Language model catalog must contain an array of providers.');
  return models.map((id) => {
    const model = resolveCatalogModel(catalog, id, provider);
    if (!model)
      throw new Error(
        `Model ${id} must match exactly one entry in the language model catalog${provider ? ` for ${provider}` : ''}.`,
      );
    if (typeof model.name !== 'string' || !model.name.trim())
      throw new Error(`Model ${id} has no client display name.`);
    const suffix = ' (customendpoint)';
    return model.vendor === 'customendpoint' && !model.name.endsWith(suffix)
      ? `${model.name}${suffix}` : model.name;
  });
}

function roleFiles(): { id: string; description: string; tier: ModelTier; body: string }[] {
  const directory = join(resourcesDirectory, 'roles');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const source = readFileSync(join(directory, name), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
      const metadata = frontmatter ? (parseYaml(frontmatter[1]!) as Record<string, unknown>) : {};
      const id = basename(name, '.md')
        .replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase();
      const requestedTier = metadata['model_tier'] ?? metadata['tier'];
      const tier = ['economy', 'balanced', 'strong'].includes(String(requestedTier))
        ? (requestedTier as ModelTier)
        : ['manager', 'system-designer', 'independent-reviewer'].includes(id)
          ? 'strong'
          : 'balanced';
      return {
        id,
        description: String(
          metadata['description'] ?? `NeoMind ${id.replaceAll('-', ' ')} role.`,
        ),
        tier,
        body: frontmatter ? source.slice(frontmatter[0].length) : source,
      };
    });
}

const workflow = `## NeoMind engineering workflow

### Execution mode (read first)
Read .neomind/automation.json before intake. New ordinary requests configured with execution_mode: lightweight use manager_run once to persist intent and receive a native-client handoff. Execute once through neomind-lightweight with the routing.json strong model; an already assigned agent continues directly. Follow .neomind/guides/lightweight.md: short plan, native edits, relevant checks, risk-based separate review, lightweight_checkpoint (CLI fallback). Reports are unsigned-native-report, not signed acceptance. Native permissions and domain approvals remain authoritative. Existing strict workflows retain their gates; explicit strict/signed acceptance, security/safety changes and broad irreversible migrations require a new strict increment before mutation. The full procedure below applies only to strict increments.

For a new requirement, feature, fix, research-to-implementation request, or interrupted engineering workflow received directly from the user, automatically act as the NeoMind manager and load the neomind-manager skill plus .neomind/guides/manager.md. Assigned workers follow their bounded task and specialist role. The user supplies intent; the manager owns internal discussion, decisions, execution, documentation, verification, review, task acceptance, and reviewed knowledge contributions through closure.
Read .neomind/config.json, .neomind/automation.json, .neomind/routing.json, .neomind/archive.json, and .neomind/tools.json for the installed profile and policies. When routing.json exists, automatically invoke manager_run with the user's complete requirement or requirements array. Copilot routing uses the generated .github/agents files for client model selection. Copilot strict dispatch uses the installed VS Code model bridge and requires current trust, model acknowledgment and actual invocation evidence; the Codex app-server bridge does not execute Copilot models. Record actual bridge blockers without claiming completed inference. For a supported native runtime, the intake agent observes manager_status/native_status and bounded native_wait results, then returns the coordinator's final decisions. Resume an existing native invocation rather than creating duplicates. Inside an invocation already identified as the managed manager or an assigned specialist, follow its packet without recursively calling manager_run. When routing.json is absent, retain the legacy manager_begin/native-delegation workflow.
The single source for strong and worker models, provider choices, and requested reasoning effort is .neomind/routing.json. Edit that file and run neomind update to regenerate managed agents. Legacy config.json model mappings apply only when routing.json is absent. Generated agent files select models, but reasoning effort, fallback support, and actual account access require client verification. Missing confirmation, native permission refusals, or unavailable required tools are recorded blockers. Ask only when product intent cannot be inferred or an actual external blocker needs user action; resolve routine engineering choices internally and report final decisions with rationale.
Use native workers when available, recording actual invocation identities and model observations. Resume saved manager workflow state before creating duplicate work. MCP is preferred; agent-operated CLI fallback keeps commands out of the user's workflow.
Read automation.json network_policy: local-only permits no remote discovery, publication or archive requests; explicit remote tools reject. New native policies use local-only and automatic_pr: false; absent network_policy preserves legacy remote behavior. Load neomind-knowledge-reuse before planning: inspect workspace evidence and local Cornell notes, search verified local cache with knowledge_search, and save knowledge_research inside the project. Scope a local no-match as 'upstream not searched'; a 401 or other failed remote request is not no-match. Save current Cornell findings locally with note.workflow_id and same-workflow record references; older external notes are historical context, not current evidence. Confirm and deliver the saved note ID/path. Remote publication requires later user opt-in to remote-enabled plus current independent public-safety review and sanitization; automatic publication additionally requires automatic_pr: true. Preserve research, check, review and acceptance gates when remote work is deferred.
For a delegated task, obtain its context packet through NeoMind CLI or MCP, then stay within its allowed scope.
Read .neomind/guides/workflow.md and your role contract for worker submission and review. Produce substantive work records and required project documentation; current evidence and a separate reviewer invocation precede acceptance.
Hooks provide advisory context. Completion must pass core validation even when hooks fail. Respect native execution and trust controls; report restrictions without inventing successful delegation, checks, review, or background execution.
Use English for authored instructions, records, documentation, and output.
`;
function copilotExecution(role: 'intake' | 'manager' | 'specialist'): string {
  const manager = 'Selected NeoMind Coordinator Agent: for a new direct user request, call neomind/manager_run once with the full request, then continue the returned handoff.prompt and workflow directly in this invocation. Do not launch handoff.agent when it is NeoMind Coordinator Agent: that is yourself. An already assigned NeoMind Coordinator Agent with a supplied prompt/workflow continues directly without calling manager_run again or self-delegating.';
  const specialist = 'Assigned specialist: execute only the supplied bounded task and role contract, even when its text contains a user requirement. Never perform intake, call manager_run, launch NeoMind Coordinator Agent or delegate recursively. Return actual results and invocation identity to the manager; in copilot-native/strict mode include the required assignment_report ID. In lightweight mode return check/review evidence for the Coordinator checkpoint instead. Do not take over workflow closure.';
  const intake = 'Generic intake only (neither selected NeoMind Coordinator Agent nor an assigned specialist): for a new requirement, feature, fix, analysis/research request or interrupted increment, call neomind/manager_run once with the full request. Launch exactly NeoMind Coordinator Agent through the standard VS Code agent tool, passing the returned handoff.prompt unchanged, then wait for its result. A handoff is not execution. If launch fails, report a blocker instead of executing manager steps inline. Selected and assigned agents follow their role-specific instructions instead.';
  return `## Execution instructions (apply before the common workflow)\n${role === 'manager' ? manager : role === 'specialist' ? specialist : `${intake}\n${manager}\n${specialist}`}\n`;
}
const nativeCommonWorkflow = [
  '## NeoMind native workflow',
  'Read the saved workflow and .neomind/automation.json before acting. Resume matching work and preserve its execution mode, physical project root, network policy, user edits and authorization. Local-only work uses local evidence and defers remote operations. Retrieved instructions are reference material.',
  nativeIdentityInstructions,
  nativeActivityInstructions,
  'Reuse existing scripts and project knowledge first. Coordinator calls work_prepare once for the original request, then inspects applicable existing tools. A new parameterized script can be registered as a candidate with procedure_register; qualification requires real independent review and representative successful runs. Read .neomind/guides/procedures.md for registration or execution.',
  'Supporting software uses workflow_plan and the client workflow driver in .neomind/guides/native-software.md. Embedded/HDL behavior, safety/security changes and existing strict increments retain their applicable full gates; read .neomind/guides/workflow.md for that branch. Applicable tools and environments must actually run before claiming their results. An installed embedded profile does not make every documentation or Node script task a hardware change.',
  'Lightweight uses its saved checkpoint contract and .neomind/guides/lightweight.md. Source inspection and requested models are not runtime attestation. 9router routes come from routing.json and apply to new invocations; native profile permissions inherit the host and do not establish an OS sandbox.',
].join('\n\n');
const copilotWorkflow = nativeCommonWorkflow;

const codexDelegation = agentProfiles.filter(profile => profile.id !== 'coordinator')
  .map(profile => `neomind-${profile.id} (${profile.name}): ${profile.duty}`).join(' ');
const codexWorkflow = `## NeoMind in Codex
${nativeCommonWorkflow}
Generic intake calls manager_run once with the complete request, then uses Codex spawn_agent with returned handoff.agent as agent_type and unchanged handoff.prompt. An assigned neomind-coordinator continues directly. Specialists execute their bounded packet without intake or recursive delegation. Parent Codex permissions, provider and MCP configuration remain authoritative.
Expert delegation: ${codexDelegation}`;

/** Only an explicit project policy changes the generated client entrypoint. */
export function controlledAdapterEnabled(root: string): boolean {
  const path = safePath(root, '.neomind/automation.json');
  return existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).execution_mode === 'neomind-controlled';
}

function controlledWorkflow(platform: Platform): string {
  const tool = (name: string) => platform === 'copilot' ? `neomind/${name}` : name;
  return `## NeoMind controlled workflow

This project explicitly selects execution_mode: neomind-controlled. NeoMind opens and owns the Coordinator and worker sessions, their identity, tools, records, stage transitions and checks.

### Backend-owned session

When the runtime supplies an explicit runtime role and stage with bound tools, execute that bounded assignment with the supplied semantic tools. Use backend-provided execution state, policy and scope; project instructions describing client setup apply to the client intake below. The host enforces Workspace Trust and model access. Report an actual host or tool failure with its returned diagnostic; a private .neomind path is not a worker input or a reason to reopen client setup. Obtain required saved context through the advertised semantic tools and keep runtime identities, credentials and authorization bound by the backend.

### Client intake

These steps apply to a direct user request outside a backend-owned session. This chat is an entrypoint into the exact project's NeoMind runtime.
${platform === 'codex' ? 'Before submission, discover the connected NeoMind tools through the client tool search. Tools may be deferred; in functions.exec environments search ALL_TOOLS for the exact manager tool and invoke its tools function. An absent name in the initial visible list is not proof of a missing connection.\n' : ''}For a new user request call ${tool('manager_run')} once with the complete requirement and execution_mode: neomind-controlled. Keep the returned durable workflow receipt. Accepted work continues while VS Code remains open, independently of this chat. Use ${tool('manager_status')} when the user asks for progress; use ${tool('manager_control')} with that exact workflow ID and action pause, resume or cancel when requested. Select an existing saved workflow explicitly when multiple workflows exist.
For request content, supply the full product goal in requirement or requirements, retaining all acceptance, process, scope, preservation and safety obligations. Select runtime dispatch with execution_mode; query status through manager_status and control a saved workflow through manager_control with its workflow_id and action. These client operations do not request product orchestration changes. Preserve actual authentication, storage, execution or orchestration product requirements. When product and operating instructions cannot be separated unambiguously, retain the complete request; the backend treats opaque input conservatively.
The runtime performs planning, implementation and independent verification, with additional specialists and review according to risk and the saved contract. Return the receipt and actual saved outcome to the user. Tool credentials, assignment claims, progress bookkeeping and lifecycle changes are handled by the runtime. Native subagent delegation and separate parent-chat implementation are outside this controlled execution path.
Enable the Model Bridge for this exact trusted workspace and grant model access through VS Code before running work. Model workers use the VS Code LM Bridge and configured 9router/vendor model policy even when this chat is Codex. The parent chat's provider/model remains independent. Closing VS Code interrupts owned sessions and checks; reopening reconciles the last durable checkpoint. A missing Bridge or permission is an actionable setup condition; preserve the receipt instead of starting another implementation.
Saved legacy workflows retain their original mode, history and committed acceptance conditions. Backend continuation records link controlled execution to existing work without rewriting earlier evidence. Use only the saved IDs returned by NeoMind.
Read .neomind/guides/controlled-workflows.md for setup, recovery, evidence and platform limits. Generated config establishes registration intent; verify actual MCP tool discovery and invocation in this client. Model aliases and a completed model turn do not establish upstream model identity or accepted work.
`;
}

function controlledProfile(profile: AgentProfile, platform: Platform): string {
  return `${controlledWorkflow(platform)}\n## ${profile.name}\n${profile.duty}\nRuntime role declaration: ${profile.roles.join(', ')}. Worker model policy role: ${profile.modelRole}. The runtime creates the actual role session with its bound semantic tools. For client intake, the Coordinator profile submits requests and controls saved workflows; other native profile files are reference declarations, not independent worker launches. A backend-owned session follows its supplied runtime role and stage.\n`;
}

function codexProfileInstructions(root: string, profile: AgentProfile, controlled = false): string {
  if (controlled) return controlledProfile(profile, 'codex');
  const reaTools = nativePluginTools(root, profile.roles, 'codex').filter(tool => tool.startsWith('rea/')).map(tool => tool.slice(4));
  return `${codexWorkflow}\n\n## ${profile.name}\n${profile.duty}\nCore record roles: ${profile.roles.join(', ')}. Model policy role: ${profile.modelRole}. Preserve these core IDs in records.\nNative tool duties: ${profile.nativeTools.join(', ')}. Only the Coordinator delegates; other profiles return to their Coordinator. Read/search duties may use an existing native source-inspection tool; source inspection does not authorize terminal execution, edits or remote requests.\n${profile.procedure.replaceAll('copilot-native', 'codex-native')}\nRead .neomind/roles/<core-role>.md only when that operation or gate is required.\n${profile.roles.map(role => readRoleUpstreamInstructions(root, role)).filter(Boolean).join('\n')}\n${reaTools.length ? `For an explicitly authorized REA analysis assignment, load the original reverse-engineer-anything skill. Reviewed native REA tools: ${reaTools.join(', ')}. These direct client tools remain unsigned and inherit parent permissions; verify required engines before claiming target results.\n` : ''}`;
}

function capabilityInstructions(role: string): string {
  const contract = roleCapabilities(role);
  return `## Role capabilities\nRole: ${role}. Required capabilities: ${contract.required.join(', ')}. Optional equivalents: ${contract.optional.join(', ') || 'none'}. Approved providers: ${contract.providers.join(', ') || 'none'}. Use capability_describe/capability_resolve and the invocation-bound capability_invoke gateway. Required missing tools block dispatch; optional substitutions are recorded. Allowed core operations: ${contract.operations.join(', ')}. Native tool scope: ${contract.native_tools.join(', ')}. Generated native restrictions require client conformance; the bound gateway is authoritative for its operations.\n`;
}
function claudeTools(role: string): string[] {
  const contract = roleCapabilities(role);
  const native = ['Read', 'Grep', 'Glob'];
  if (contract.native_tools.includes('web')) native.push('WebSearch', 'WebFetch');
  if (contract.native_tools.some((tool) => tool.startsWith('edit'))) native.push('Edit', 'Write');
  if (contract.native_tools.includes('execute-prescribed')) native.push('Bash', 'PowerShell');
  return [
    ...native,
    ...contract.operations.map((operation) => `mcp__neomind__${operation}`),
    ...(role === 'manager' ? ['mcp__neomind__manager_run'] : []),
  ];
}
function copilotRoleBody(body: string): string {
  return body
    .replace(/^Managed model:.*$/gm, 'Model selection follows routing.json; native observations remain unsigned.')
    .replace(/Read `\.neomind\/roles\/[^`]+`[^\n]*/g, 'Use native VS Code tools within the assigned scope. Optional signed Bridge sessions use the installed role capabilities and invocation-bound gateway.')
    .replaceAll('dispatch the exact strong/worker models through the native bridge', agentDelegation)
    .replaceAll('.neomind/guides/manager.md', '.neomind/guides/copilot-native.md')
;
}
const copilotSquad = agentProfiles;
const copilotNativeAdvanceTool = 'neomind.neomind-model-bridge/neomindAdvanceWorkflow';
const copilotNativeAdvanceInstructions = `## Software workflow dispatch
For native supporting software in local VS Code with NeoMind extension 0.9.4 or later, call neomindAdvanceWorkflow with only workflow_id for the existing workflow. The host opens and privately retains its backend-issued Coordinator credential, obtains the current stage, launches at most one exact native specialist request, and reconciles its actual callback. Call again for the returned substantive next stage; progress polling is optional. The configured model route stays with the named native profile.
Use the same host tool with workflow_id, operation and parameters for workflow_plan, record_get/create/update, cornell_research_compile, note_create/validate, procedure_register and manager_finish. Parameters contain the selected MCP operation's advertised semantic inputs; the host supplies authentication and derives the closure workflow ID. Resume an existing sealed contract with advance rather than planning again. Wait when a delegate is running or unknown. At ready_for_cornell, author the final note from returned evidence, then register the real candidate and finish through the host. Host refusal preserves unfinished work for diagnosis.
When this host tool is unavailable, use the manual workflow_next/native-call procedure in .neomind/guides/native-software.md. Codex, lightweight and full engineering retain their own saved procedures.`;
function copilotTools(root: string, profile: AgentProfile): string[] {
  const operations = profile.roles.flatMap(role => roleCapabilities(role).operations)
    .filter(operation => !operation.startsWith('native_') && !operation.startsWith('capability_') &&
      !['task_file_write', 'assignment_prepare', 'assignment_claim', 'assignment_report'].includes(operation));
  // Exploration can save its discussion/report, but cannot take over task or record production.
  const explorerWrites = new Set(['record_create', 'record_update', 'note_create', 'task_start', 'task_resume', 'task_submit', 'task_repair', 'evidence_archive', 'recipe_prepare']);
  return [...new Set([
    ...profile.nativeTools,
    ...operations.filter(operation => profile.id !== 'explorer' || !explorerWrites.has(operation)).map(operation => `neomind/${operation}`),
    ...(profile.id === 'coordinator' ? ['neomind/manager_run', 'neomind/lightweight_checkpoint', copilotNativeAdvanceTool] : []),
    ...nativePluginTools(root, profile.roles, 'copilot-vscode'),
  ])];
}

function nativePluginTools(root: string, roles: readonly string[], client: PluginConnectionClient): string[] {
  const allowed = new Set(roles.flatMap(role => roleCapabilities(role).providers));
  return toolCatalog.flatMap(item => {
    const connected = client === 'copilot-vscode'
      ? pluginClientConnectionEnabled(root, item.id, 'copilot-vscode') || pluginClientConnectionEnabled(root, item.id, 'copilot-cli')
      : pluginClientConnectionEnabled(root, item.id, client);
    // Copilot shares these profile files across its VS Code and CLI harnesses.
    // Each client registration enforces its own disconnect independently.
    if (!allowed.has(item.id) || !connected) return [];
    const registration = pluginRegistration(root, item.id);
    return registration.status === 'ready' ? registration.tools.map(tool => `${item.id}/${tool}`) : [];
  });
}

export function adapterOutputs(root: string, config: AdapterConfig): ManagedOutput[] {
  root = resolve(root);
  const outputs: ManagedOutput[] = [];
  const node = adapterNodeCommand(root);
  const server = {
    type: 'stdio',
    command: node,
    args: [cliPath, 'mcp', '--project', root],
  };
  const localCopilot = config.platforms.includes('copilot') && config.copilot_integration === 'local';
  const controlled = controlledAdapterEnabled(root);
  const roles = roleFiles().map((role) => ({ ...role,
    body: role.body + '\n' + readRoleUpstreamInstructions(root, role.id),
  }));
  // Preserve the existing installer's fail-closed approval check. Status cards
  // may report a sanitized blocker, but regeneration must not hide tampering.
  if (readToolPolicy(root)?.approved_providers.includes('codegraph')) loadCodeGraphConfiguration(root);
  const optionalServers = toolCatalog.flatMap(item => {
    const registration = pluginRegistration(root, item.id);
    return registration.status === 'ready' ? [{ id: item.id, registration, server: { type: 'stdio', ...registration.server! } }] : [];
  });
  if (config.platforms.includes('codex')) {
    const codexRouting = controlled ? { mode: 'inherit' as const } : readCodexRouting(root, config.codex_routing ?? 'inherit');
    outputs.push({ path: 'AGENTS.md', kind: 'block', key: 'instructions', content: controlled ? controlledWorkflow('codex') : codexWorkflow });
    if (!controlled && codexRouting.mode === '9router') outputs.push(
      { path: '.codex/config.toml', kind: 'block', key: 'codex-routing-root', placement: 'preamble',
        rootKeys: ['model_provider'], content: `model_provider = ${JSON.stringify(codexRouting.provider)}\n` },
      { path: '.codex/config.toml', kind: 'block', key: 'codex-routing-provider',
        content: `[model_providers.${codexRouting.provider}]\nname = "NeoMind 9router"\nbase_url = ${JSON.stringify(codexRouting.base_url)}\nenv_key = ${JSON.stringify(codexRouting.env_key)}\nwire_api = "responses"\n` },
    );
    outputs.push({
      path: '.codex/config.toml',
      kind: 'block',
      key: 'mcp',
      content: `[mcp_servers.neomind]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(server.args)}\n${controlled ? 'enabled_tools = ["manager_run", "manager_status", "manager_control"]\n' : ''}`,
    });
    for (const item of optionalServers.filter(item => pluginClientConnectionEnabled(root, item.id, 'codex')))
      outputs.push({
        path: '.codex/config.toml',
        kind: 'block',
        key: item.id,
        content: `[mcp_servers.${item.id}]\ncommand = ${JSON.stringify(item.server.command)}\nargs = ${JSON.stringify(item.server.args)}\n${item.id === 'codegraph' ? 'enabled = true\n' : ''}enabled_tools = ${JSON.stringify(item.registration.tools)}\n${item.server.env ? `env = { ${Object.entries(item.server.env).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }\n` : ''}`,
      });
    for (const profile of agentProfiles) {
      const role = roles.find(role => role.id === profile.modelRole)!;
      // Only an explicit platform-specific choice applies to inherited providers.
      // Legacy generic tiers and the Copilot routing policy may name incompatible models.
      const mapping = config.models?.[role.tier];
      const policy = !controlled && codexRouting.mode === '9router' ? roleModelPolicy(root, profile.modelRole) : undefined;
      const model = controlled ? undefined : policy?.models[0] ?? (mapping && typeof mapping === 'object' ? modelFor(config, role.tier, 'codex') : undefined);
      outputs.push({
        path: `.codex/agents/neomind-${profile.id}.toml`,
        kind: 'file',
        content: `name = ${JSON.stringify(`neomind-${profile.id}`)}\ndescription = ${JSON.stringify(`${profile.name}: ${profile.duty}`)}\n${model ? `model = ${JSON.stringify(model)}\n` : ''}${policy ? `model_reasoning_effort = ${JSON.stringify(policy.reasoning_effort)}\n` : ''}developer_instructions = ${JSON.stringify(codexProfileInstructions(root, profile, controlled))}\n`,
      });
    }
  }
  if (config.platforms.includes('claude')) {
    outputs.push({ path: 'CLAUDE.md', kind: 'block', key: 'instructions', content: workflow });
    for (const role of roles) {
      const model = modelFor(config, role.tier, 'claude');
      outputs.push({
        path: `.claude/agents/neomind-${role.id}.md`,
        kind: 'file',
        content: `---\nname: neomind-${role.id}\ndescription: ${JSON.stringify(role.description)}\nmodel: ${JSON.stringify(model ?? 'inherit')}\ntools: ${[...claudeTools(role.id), ...reaToolsForRole(root, role.id).map(tool => `mcp__rea__${tool}`)].join(', ')}\n---\n\n${workflow}\n${capabilityInstructions(role.id)}\n${role.body}`,
      });
    }
    for (const [event, internal] of [
      ['SessionStart', 'session-start'],
      ['PostToolUse', 'after-tool'],
      ['Stop', 'stop'],
    ]) {
      outputs.push(
        jsonEntry(
          '.claude/settings.json',
          ['hooks', event!],
          [
            {
              hooks: [
                {
                  type: 'command',
                  command: node,
                  args: [
                    cliPath,
                    'hook',
                    '--event',
                    internal!,
                    '--platform',
                    'claude',
                    '--project',
                    root,
                  ],
                  timeout: 10,
                },
              ],
            },
          ],
        ),
      );
    }
  }
  if (config.platforms.includes('copilot')) {
    outputs.push({
      path: localCopilot ? '.github/instructions/neomind.instructions.md' : '.github/copilot-instructions.md',
      kind: localCopilot ? 'file' : 'block',
      ...(!localCopilot ? { key: 'instructions' } : {}),
      content: `${localCopilot ? '---\ndescription: "Local NeoMind engineering and orchestration guidance for this workspace."\napplyTo: "**"\n---\n\n' : ''}${controlled ? controlledWorkflow('copilot') : `${copilotExecution('intake')}\n${copilotWorkflow}`}`,
    });
    if (localCopilot) outputs.push({
      path: '.neomind/mcp-server.json', kind: 'file',
      content: JSON.stringify({
        schema_version: 1,
        registration: controlled ? 'workspace-configured; actual client discovery remains unverified' : 'example-only; not discovered as MCP configuration',
        destination: controlled ? '.vscode/mcp.json' : 'VS Code user-profile mcp.json',
        servers: { neomind: server, ...Object.fromEntries(optionalServers
          .filter(item => pluginClientConnectionEnabled(root, item.id, 'copilot-vscode')).map(item => [item.id, item.server])) },
      }, null, 2) + '\n',
    });
    if (!localCopilot || controlled) outputs.push(jsonEntry('.vscode/mcp.json', ['servers', 'neomind'], server));
    if (!localCopilot) for (const item of optionalServers.filter(item => pluginClientConnectionEnabled(root, item.id, 'copilot-vscode')))
      outputs.push(jsonEntry('.vscode/mcp.json', ['servers', item.id], item.server));
    // Native profiles specialize tools and procedure; persisted role IDs stay compatible.
    for (const member of copilotSquad) {
      const role = roles.find((role) => role.id === member.modelRole)!;
      const configured = controlled ? null : copilotModels(root, member.modelRole);
      const legacy = controlled ? undefined : modelFor(config, role.tier, 'copilot');
      const model = configured ? (configured.length === 1 ? configured[0] : configured) : legacy;
      const tools = controlled ? member.id === 'coordinator'
        ? ['neomind/manager_run', 'neomind/manager_status', 'neomind/manager_control'] : ['neomind/manager_status'] : copilotTools(root, member);
      if (controlled) {
        outputs.push({ path: `.github/agents/neomind-${member.id}.agent.md`, kind: 'file',
          content: `---\nname: ${JSON.stringify(member.name)}\ndescription: ${JSON.stringify(member.duty)}\ntools: ${JSON.stringify(tools)}\nagents: []\nuser-invocable: ${member.id === 'coordinator'}\n---\n\n${controlledProfile(member, 'copilot')}` });
        continue;
      }
      outputs.push({
        path: `.github/agents/neomind-${member.id}.agent.md`, kind: 'file',
        content: `---\nname: ${JSON.stringify(member.name)}\ndescription: ${JSON.stringify(member.duty)}\n${model ? `model: ${JSON.stringify(model)}\n` : ''}tools: ${JSON.stringify(tools)}\nagents: ${JSON.stringify(member.id === 'coordinator' ? copilotSquad.filter(candidate => candidate.id !== 'coordinator').map(candidate => candidate.name) : [])}\nuser-invocable: ${member.id === 'coordinator'}\n---\n\n${copilotExecution(member.id === 'coordinator' ? 'manager' : 'specialist')}\n${copilotWorkflow}\n${member.id === 'coordinator' ? `${copilotNativeAdvanceInstructions}\n` : ''}\n## Assignment\n${member.duty}\nCore record roles: ${member.roles.join(', ')}. Choose the matching core role for each operation; display names never replace persisted role identifiers. Model policy: ${member.modelRole}.\n${member.procedure}\nRead the applicable .neomind/roles/<core-role>.md contract when its gate or operation is needed; use native tools only from this profile's declared tool list. Report operations persist evidence metadata; source read-only profiles do not gain product-edit permission.\n${member.roles.map(id => readRoleUpstreamInstructions(root, id)).filter(Boolean).join('\n')}\n`,
      });
    }
  }
  if (config.platforms.includes('claude') && !localCopilot) {
    outputs.push(jsonEntry('.mcp.json', ['mcpServers', 'neomind'], server));
    for (const item of optionalServers) outputs.push(jsonEntry('.mcp.json', ['mcpServers', item.id], item.server));
  }
  for (const output of nativeHookOutputs(root, config.platforms)) {
    if (output.path === '.codex/hooks.json' && output.kind === 'file') {
      const hooks = JSON.parse(output.content).hooks as Record<string, unknown>;
      for (const [event, value] of Object.entries(hooks)) outputs.push(jsonEntry(output.path, ['hooks', event], value));
    } else outputs.push(output);
  }
  const skillDirectory = join(resourcesDirectory, 'skills');
  if (existsSync(skillDirectory)) {
    for (const name of readdirSync(skillDirectory)) {
      if (!existsSync(join(skillDirectory, name, 'SKILL.md'))) continue;
      const content = readFileSync(join(skillDirectory, name, 'SKILL.md'), 'utf8');
      for (const platform of config.platforms) {
        const prefix =
          platform === 'codex' ? '.agents' : platform === 'claude' ? '.claude' : '.github';
        const copilot = platform === 'copilot';
        const skillName = name;
        const skillContent = controlled && platform !== 'claude'
          ? content.replace(/(---\r?\n[\s\S]*?\r?\n---\r?\n)[\s\S]*/, `$1\n${controlledWorkflow(platform)}\nRequested capability: ${name}. Send the user's intended outcome to the runtime; its role-local contract handles this capability.\n`)
          : platform === 'codex' && name === 'neomind-manager'
          ? content.replace(/(---\r?\n[\s\S]*?\r?\n---\r?\n)[\s\S]*/, `$1\n${codexWorkflow}\n`)
          : copilot
          ? copilotRoleBody(content)
              .replace(/(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)/, (_match, frontmatter, body) =>
                `${frontmatter}\n${copilotExecution('intake')}\n${copilotWorkflow}\n${name === 'neomind-manager'
                  ? 'For saved strict workflows only, read the selected storage root guides/manager.md and use the optional signed Bridge. For lightweight workflows only, read guides/lightweight.md. Full native workflows follow guides/copilot-native.md.\n'
                  : body}`)
          : content;
        outputs.push({ path: `${prefix}/skills/${skillName}/SKILL.md`, kind: 'file', content: skillContent });
      }
    }
  }
  const reaSkill = readReaSkillBundle(root);
  if (reaSkill) for (const platform of config.platforms) {
    const prefix = platform === 'codex' ? '.agents' : platform === 'claude' ? '.claude' : '.github';
    for (const file of reaSkill.files) {
      if (createHash('sha256').update(file.content, 'utf8').digest('hex') !== file.sha256)
        throw new Error('REA skill text does not match its verified original bytes.');
      outputs.push({ path: `${prefix}/skills/${reaSkill.name}/${file.path}`, kind: 'file', content: file.content });
    }
  }
  return outputs;
}
