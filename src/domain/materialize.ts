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
    } else if (node.type === 'integration' && node.profileId && node.profileVersion) {
      await loadProfile(node.id, node.profileId, node.profileVersion, node.instructionsOverride, node.skillsOverride,
        { read: true, write: true, checks: true, gitCommit: false }, false);
    } else if (node.type === 'review_group') {
      for (const reviewer of node.reviewers) {
        await loadProfile(`${node.id}/${reviewer.id}`, reviewer.profileId, reviewer.profileVersion,
          reviewer.instructionsOverride, reviewer.skillsOverride, undefined, true);
      }
    }
  }
  return { configuration, policy: structuredClone(validProject.policy), profilesByStep };
}

import { z } from 'zod';
import { bindingSchema, permissionsSchema, projectPolicySchema, skillReferenceSchema } from './schema.js';
import { flowHashes, hashJson } from './resolve.js';

const valueSchema = z.strictObject({ runner: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), reasoning: z.string().min(1) });
const source = z.enum(['run', 'step', 'flow', 'project']);
const resolvedSchema = z.strictObject({ values: valueSchema, sources: z.strictObject({ runner: source, provider: source, model: source, reasoning: source }),
  fallback: bindingSchema.shape.fallback });
const materializedProfileSchema = z.strictObject({ profileId: z.string().min(1), version: z.number().int().min(1), instructions: z.string(),
  skills: z.array(skillReferenceSchema.extend({ content: z.string() })), requestedPermissions: permissionsSchema, outputDefaults: z.record(z.string(), z.json()) });
export const materializedRunSchema = z.strictObject({
  configuration: z.strictObject({ flow: flowSchema, projectId: z.string().min(1), policyVersion: z.number().int().min(1),
    bindings: z.record(z.string(), resolvedSchema), semanticHash: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  policy: projectPolicySchema, profilesByStep: z.record(z.string(), materializedProfileSchema),
});

/** Verify the detached snapshot before storing or replaying it. */
export function validateMaterializedRun(input: unknown): MaterializedRun {
  const snapshot = materializedRunSchema.parse(input), flow = snapshot.configuration.flow;
  const hashes = flowHashes(flow);
  if (hashes.contentHash !== snapshot.configuration.contentHash || hashes.semanticHash !== snapshot.configuration.semanticHash) throw new Error('Materialized flow hash mismatch');
  const compiled = compileFlow(flow, snapshot.policy);
  if (!compiled.ok) throw new Error('Materialized flow violates project policy');
  const expected = new Map<string, { profileId: string; version: number; reviewer: boolean; requested?: Profile['requestedPermissions'] }>();
  for (const node of flow.definition.nodes) {
    if (node.type === 'agent_task') expected.set(node.id, { profileId: node.profileId, version: node.profileVersion, reviewer: false, requested: node.permissions });
    if (node.type === 'integration' && node.profileId && node.profileVersion && node.bindingId) expected.set(node.id, { profileId: node.profileId, version: node.profileVersion, reviewer: false, requested: { read: true, write: true, checks: true, gitCommit: false } });
    if (node.type === 'review_group') for (const reviewer of node.reviewers) expected.set(`${node.id}/${reviewer.id}`, { profileId: reviewer.profileId, version: reviewer.profileVersion, reviewer: true });
  }
  if (Object.keys(snapshot.configuration.bindings).length !== expected.size || Object.keys(snapshot.profilesByStep).length !== expected.size) throw new Error('Materialized step coverage mismatch');
  for (const [key, spec] of expected) {
    const profile = snapshot.profilesByStep[key];
    if (!snapshot.configuration.bindings[key] || !profile || profile.profileId !== spec.profileId || profile.version !== spec.version) throw new Error(`Materialized profile or binding missing for ${key}`);
    if (spec.reviewer && (profile.requestedPermissions.write || profile.requestedPermissions.gitCommit)) throw new Error('Reviewer snapshot is overprivileged');
    if (spec.requested) for (const permission of ['read', 'write', 'checks', 'gitCommit'] as const) {
      if (spec.requested[permission] && !profile.requestedPermissions[permission]) throw new Error(`Materialized profile lacks ${permission} permission`);
    }
    if (new Set(profile.skills.map(skill => skill.id)).size !== profile.skills.length) throw new Error('Duplicate materialized skill ID');
    for (const skill of profile.skills) if (createHash('sha256').update(skill.content, 'utf8').digest('hex') !== skill.sha256) throw new Error(`Materialized skill hash mismatch: ${skill.id}`);
  }
  // Force canonical JSON validation; snapshots never depend on object identity.
  hashJson(snapshot);
  return snapshot;
}
