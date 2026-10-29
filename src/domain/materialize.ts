import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { flowSchema, profileSchema, projectSchema, type Flow, type Profile, type ProjectConfig } from './schema.js';
import { snapshotConfiguration, type BindingOverride, type RunConfiguration } from './resolve.js';
import { compileFlow } from './compiler.js';

export interface MaterializedSkill { id: string; path: string; sha256: string; content: string }
export interface MaterializedProfile {
  profileId: string; version: number; instructions: string; skills: MaterializedSkill[];
  requestedPermissions: Profile['requestedPermissions']; outputDefaults: Profile['outputDefaults'];
}
export interface MaterializedRun { configuration: RunConfiguration; policy: ProjectConfig['policy']; profilesByStep: Record<string, MaterializedProfile> }

/**
 * Snapshots exact profiles and skill bytes for one run. Project root and profile
 * versions must come from trusted project/library resolution; this function does
 * not grant capabilities or authenticate a runtime.
 */
export async function materializeRun(
  flow: Flow, project: ProjectConfig, profileVersions: Record<string, unknown>, projectRoot: string,
  overrides: Record<string, BindingOverride> = {},
): Promise<MaterializedRun> {
  const root = await realpath(projectRoot);
  const validFlow = flowSchema.parse(flow), validProject = projectSchema.parse(project);
  const compiled = compileFlow(validFlow, validProject.policy);
  if (!compiled.ok) throw new Error(`Invalid flow: ${compiled.diagnostics.map(d => d.code).join(', ')}`);
  const configuration = snapshotConfiguration(compiled.flow, validProject, overrides);
  const profilesByStep: Record<string, MaterializedProfile> = {};

  async function loadProfile(key: string, profileId: string, version: number, instructionsOverride: string | undefined,
    skillsOverride: Profile['skills'] | undefined, requested: Profile['requestedPermissions'] | undefined, reviewer: boolean) {
    const profile = profileSchema.parse(profileVersions[`${profileId}@${version}`]);
    if (profile.profileId !== profileId || profile.version !== version) throw new Error(`Profile identity mismatch for ${key}`);
    if (reviewer && (profile.requestedPermissions.write || profile.requestedPermissions.gitCommit)) throw new Error(`Reviewer profile ${profileId} cannot request code write or commit`);
    if (requested) {
      for (const permission of ['read', 'write', 'checks', 'gitCommit'] as const) {
        if (requested[permission] && !profile.requestedPermissions[permission]) throw new Error(`Step ${key} exceeds profile permission ${permission}`);
      }
    }
    const skills: MaterializedSkill[] = [];
    const ids = new Set<string>();
    for (const skill of skillsOverride ?? profile.skills) {
      if (ids.has(skill.id)) throw new Error(`Duplicate skill ID ${skill.id} in ${key}`);
      ids.add(skill.id);
      const resolved = await realpath(path.resolve(root, skill.path));
      const relative = path.relative(root, resolved);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Skill path escapes project root: ${skill.path}`);
      }
      const bytes = await readFile(resolved);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== skill.sha256) throw new Error(`Skill hash mismatch: ${skill.path}`);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`Skill is not valid UTF-8: ${skill.path}`); }
      skills.push({ id: skill.id, path: skill.path, sha256: digest, content });
    }
    profilesByStep[key] = { profileId, version, instructions: instructionsOverride ?? profile.instructions,
      skills, requestedPermissions: structuredClone(profile.requestedPermissions), outputDefaults: structuredClone(profile.outputDefaults) };
  }

  for (const node of compiled.flow.definition.nodes) {
    if (node.type === 'agent_task') {
      await loadProfile(node.id, node.profileId, node.profileVersion, node.instructionsOverride, node.skillsOverride, node.permissions, false);
    } else if (node.type === 'review_group') {
      for (const reviewer of node.reviewers) {
        await loadProfile(`${node.id}/${reviewer.id}`, reviewer.profileId, reviewer.profileVersion,
          reviewer.instructionsOverride, reviewer.skillsOverride, undefined, true);
      }
    }
  }
  return { configuration, policy: structuredClone(validProject.policy), profilesByStep };
}
