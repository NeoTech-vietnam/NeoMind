import { existsSync, readFileSync } from 'node:fs';
import { agentProfiles } from './agent-profiles.js';
import { readAgentMap } from './agent-map.js';
import { readCodexRouting } from './codex-routing.js';
import { readCornellDestination } from './cornell-workflow.js';
import { readAutomationPolicy } from './manager.js';
import { listRecipes } from './recipes.js';
import { reaStatus } from './rea.js';
import { strongRoles, workerRoles } from './routing.js';
import { readConfig, safePath } from './storage.js';

/** Local inspection only. Configuration, hook observations and provider execution stay separate. */
export function validatePlatform(root: string) {
  const config = readConfig(root), map = readAgentMap(root);
  const inspect = (read: () => unknown) => {
    try { return { status: 'inspected', value: read() }; }
    catch (error) { return { status: 'invalid', error: error instanceof Error ? error.message : String(error) }; }
  };
  const files = (paths: string[]) => paths.map(path => ({ path, present: existsSync(safePath(root, path)) }));
  const profiles = config.platforms.map(client => ({ client, files: files(client === 'claude'
    ? [...strongRoles, ...workerRoles].map(role => `.claude/agents/neomind-${role}.md`)
    : agentProfiles.map(profile => client === 'codex' ? `.codex/agents/neomind-${profile.id}.toml`
      : `.github/agents/neomind-${profile.id}.agent.md`)) }));
  return { schema_version: 1, project_id: config.project_id, inspected_at: new Date().toISOString(),
    runtime: { platform: process.platform, node: process.version, supported: Number(process.versions.node.split('.')[0]) === 24 || Number(process.versions.node.split('.')[0]) >= 26 },
    profiles, codex_routing: inspect(() => readCodexRouting(root)),
    activity: { hooks: files(['.codex/hooks.json', '.github/hooks/neomind.json']),
      running_hooks: map.nodes.filter(node => node.kind === 'agent' && node.source === 'native-hook' && node.state === 'running').length,
      reported_assignments: map.nodes.filter(node => node.kind === 'agent' && node.source === 'native-activity' && node.state === 'running').length,
      diagnostics: map.diagnostics, limitation: 'Hook registration and trust need native-client verification. Sources may describe the same agent; hook identity is never guessed.' },
    rea: inspect(() => reaStatus(root)), cornell_destination: inspect(() => readCornellDestination(root)),
    recipes: listRecipes().map(({ id, version, hash, applicability }) => ({ id, version, hash, applicability })),
    automation: inspect(() => ({ execution_mode: readAutomationPolicy(root).execution_mode,
      workflow_files: files(['.github/workflows/upstream-check.yml', '.github/workflows/self-hosted-linux.yml']),
      limitation: 'Scheduled GitHub workflows run from the default branch. Repository files do not establish enabled schedules or a registered self-hosted runner.' })),
    integration: inspect(() => JSON.parse(readFileSync(safePath(root, '.neomind/install-manifest.json'), 'utf8')).version ?? null),
    assurance: 'Read-only local inspection; no inference, analysis, publication, trust change, downloads or runner execution performed.' };
}
