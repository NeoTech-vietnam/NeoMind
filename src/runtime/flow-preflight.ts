import { CLAUDE_EFFORTS, CLAUDE_MODELS, CLAUDE_PROVIDER } from '../adapters/claude-policy.js';
import { bomInstruction, runsCommands, type Diagnostic } from '../domain/compiler.js';
import { agentSteps, resolveBinding, type BindingField, type BindingValues } from '../domain/resolve.js';
import type { Flow, Profile, ProjectConfig } from '../domain/schema.js';
import { codexModelAllowlist } from '../runners/codex-runner.js';
import { defaultRunnerRegistry } from '../runners/registry.js';
import { skillStatus } from '../storage/skill-catalog.js';
import { profileVersions, standaloneDiagnostics } from './project.js';

/** Provider, models and efforts a runner accepts whatever the host reports; OpenCode providers and Codex efforts are per host. */
const runnerCatalog: Record<string, { provider: string; models: readonly string[]; reasoning?: readonly string[] }> = {
  codex: { provider: 'openai', models: codexModelAllowlist },
  'claude-code': { provider: CLAUDE_PROVIDER, models: CLAUDE_MODELS, reasoning: CLAUDE_EFFORTS },
};
// Only Codex sessions get a shell; Claude Code and OpenCode sessions are limited to file tools.
const shellRunners = new Set(['codex']);
const fields: BindingField[] = ['runner', 'provider', 'model', 'reasoning'];

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}
/** The option a near-miss most likely meant: `claude` → `claude-code`, `gpt-6-lune` → `gpt-6-luna`. */
function suggestion(value: string, options: readonly string[]): string {
  const lower = value.toLowerCase(), match = options.find(option => option.startsWith(lower) || lower.startsWith(option)) ?? options.find(option => distance(lower, option) <= 2);
  return match ? ` Did you mean "${match}"?` : '';
}

/**
 * What a run preview would refuse, checked on a draft without creating a run, starting a runner or listing host models:
 * every agent step resolves runner, provider, model and reasoning to a registered runner and an allowed model, uses a
 * published profile version the step's permissions fit, and pins skills that still exist. Changed skills, and steps asked
 * to run commands on a runner without a shell, are warnings.
 */
export async function flowPreflight(projectRoot: string, flow: Flow, project: ProjectConfig, runners: readonly string[] = defaultRunnerRegistry().runners()): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [], seen = new Set<string>();
  const add = (severity: 'error' | 'warning', code: string, message: string, nodeId?: string) => {
    const key = `${code}\u0000${nodeId ?? ''}\u0000${message}`;
    if (seen.has(key)) return; seen.add(key);
    diagnostics.push({ code, message, ...(nodeId === undefined ? {} : { nodeId }), ...(severity === 'warning' ? { severity } : {}) });
  };
  const nodes = new Map(flow.definition.nodes.map(node => [node.id, node])), profiles = await profileVersions(projectRoot);

  const checkValues = (values: BindingValues, who: string, nodeId: string, fallback: boolean) => {
    const where = fallback ? `${who} (fallback)` : who;
    if (!runners.includes(values.runner)) { add('error', 'unknown_runner', `${where} uses runner "${values.runner}", which this NeoMind does not support (supported: ${runners.join(', ')}).${suggestion(values.runner, runners)}`, nodeId); return; }
    const catalog = runnerCatalog[values.runner];
    if (!catalog) return;
    // A fallback that does not fit is never selected, so it only warns; the primary choice must fit.
    const severity = fallback ? 'warning' : 'error';
    if (values.provider !== catalog.provider) add(severity, 'provider_mismatch', `${where} pairs runner "${values.runner}" with provider "${values.provider}"; ${values.runner} uses provider "${catalog.provider}".`, nodeId);
    if (!catalog.models.includes(values.model)) add(severity, 'model_not_allowed', `${where} uses model "${values.model}", which runner ${values.runner} may not use (allowed: ${catalog.models.join(', ')}).${suggestion(values.model, catalog.models)}`, nodeId);
    if (catalog.reasoning && !catalog.reasoning.includes(values.reasoning)) add(severity, 'reasoning_not_supported', `${where} uses reasoning "${values.reasoning}"; runner ${values.runner} supports ${catalog.reasoning.join(', ')}.`, nodeId);
  };

  for (const step of agentSteps(flow)) {
    const node = nodes.get(step.nodeId), who = step.reviewerId ? `Reviewer ${step.reviewerId}` : `Step ${step.nodeId}`;
    const reviewer = node?.type === 'review_group' ? node.reviewers.find(item => item.id === step.reviewerId) : undefined;
    const binding = step.bindingId === undefined ? undefined : flow.definition.bindings[step.bindingId];
    let runner: string | undefined;
    // A missing binding is a compiler error already (invalid_binding / missing_binding).
    if (binding) {
      const flowDefault = flow.definition.bindingDefaults[step.bindingId!], role = project.roleDefaults[step.profileId];
      const missing = fields.filter(field => binding[field].mode !== 'pinned' && flowDefault?.[field].mode !== 'pinned' && !role?.[field]);
      if (missing.length) add('error', 'binding_unresolved', `${who} has no ${missing.join(', ')}: binding "${step.bindingId}" inherits, and profile "${step.profileId}" has no project role default (custom profiles do not inherit the project's runner and model). Pin each field in binding "${step.bindingId}", e.g. "runner": {"mode": "pinned", "value": "codex"}.`, step.nodeId);
      else {
        const resolved = resolveBinding(binding, flowDefault, role);
        runner = resolved.values.runner;
        checkValues(resolved.values, who, step.nodeId, false);
        for (const item of resolved.fallback) checkValues(item, who, step.nodeId, true);
      }
    }

    const published = await profiles.published(step.profileId);
    if (!published.includes(step.profileVersion)) {
      add('error', 'missing_profile_version', published.length ? `${who} uses profile "${step.profileId}" version ${step.profileVersion}, which is not published (published: ${published.join(', ')}).`
        : `${who} uses profile "${step.profileId}", which does not exist or has no published version. Publish it or use a built-in profile (implementer, verifier).`, step.nodeId);
      continue;
    }
    let profile: Profile;
    try { profile = await profiles.read(step.profileId, step.profileVersion); }
    catch (error) { add('error', 'missing_profile_version', `${who}: profile "${step.profileId}" version ${step.profileVersion} cannot be read: ${error instanceof Error ? error.message : String(error)}`, step.nodeId); continue; }
    const granted = profile.requestedPermissions;
    if (!granted.read) add('error', 'profile_permission', `Profile "${step.profileId}" must request read: every step reads the workspace.`, step.nodeId);
    const requested = node?.type === 'agent_task' ? node.permissions : node?.type === 'integration' ? { read: true, write: true, checks: true, gitCommit: false } : undefined;
    for (const permission of ['write', 'checks', 'gitCommit'] as const) {
      if (requested?.[permission] && !granted[permission]) add('error', 'profile_permission', `${who} needs permission "${permission}", which profile "${step.profileId}" version ${step.profileVersion} does not request.`, step.nodeId);
    }
    if (reviewer && (granted.write || granted.gitCommit)) add('error', 'reviewer_overprivileged', `${who} uses profile "${step.profileId}", which requests write or commit; reviewers must be read-only.`, step.nodeId);

    const override = node?.type === 'agent_task' || node?.type === 'integration' ? node.skillsOverride : reviewer?.skillsOverride;
    try {
      for (const skill of await skillStatus(projectRoot, override ?? profile.skills)) {
        if (skill.status === 'missing') add('error', 'skill_missing', `${who} pins skill "${skill.id}" at ${skill.path}, which no longer exists.`, step.nodeId);
        if (skill.status === 'changed') add('warning', 'skill_changed', `Skill "${skill.id}" (${skill.path}) changed after it was pinned; a run refuses to start until it is re-pinned${override ? ` in step ${step.nodeId}` : ` in profile "${step.profileId}" and the profile is published again`}.`, step.nodeId);
      }
    } catch (error) { add('error', 'skill_missing', `${who}: pinned skills cannot be read: ${error instanceof Error ? error.message : String(error)}`, step.nodeId); }

    const instructions = (node?.type === 'agent_task' || node?.type === 'integration' ? node.instructionsOverride : reviewer?.instructionsOverride) ?? profile.instructions;
    if (bomInstruction.test(profile.instructions) && instructions === profile.instructions) add('warning', 'bom_instruction', `Profile "${step.profileId}" asks for "UTF-8 without BOM", which made an agent write the system code page on Windows. Say "keep non-ASCII characters intact (UTF-8)" instead.`, step.nodeId);
    const noShell = runner !== undefined && !shellRunners.has(runner);
    if (node?.type === 'review_group' && reviewer && runsCommands.test(`${node.criteria.join('\n')}\n${instructions}`) && (noShell || !granted.checks)) {
      add('warning', 'review_needs_commands', `Review asks reviewers to run commands, but ${who} ${noShell ? `runs on ${runner}, which has no shell` : `uses profile "${step.profileId}" without checks permission`}. Let reviewers verify by reading the code and quoted check output instead of making "run the tests" a pass condition.`, step.nodeId);
    }
    if (node?.type === 'agent_task' && node.outputContract !== 'plan' && runsCommands.test(`${node.goal}\n${instructions}`) && (noShell || !node.permissions.checks)) {
      add('warning', 'step_cannot_run_commands', `${who} is asked to run commands, but it ${noShell ? `runs on ${runner}, which has no shell` : 'has no checks permission'}. Give it a Codex binding with checks, or accept trace-based evidence marked UNVERIFIED.`, step.nodeId);
    }
  }

  let unsupported: string[];
  // A graph the compiler rejects (a cycle, a missing node) may not lay out; its errors are reported already.
  try { unsupported = standaloneDiagnostics(flow); } catch { unsupported = []; }
  for (const reason of unsupported) {
    const nodeId = flow.definition.nodes.find(node => reason.startsWith(`${node.id}: `))?.id;
    add('error', 'runtime_unsupported', reason, nodeId);
  }
  return diagnostics;
}
