import { readFile, realpath, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { hashJson, type BindingOverride } from '../domain/resolve.js';
import { materializeRun } from '../domain/materialize.js';
import { defaultProject, templates } from '../domain/templates.js';
import { projectSchema, type Flow, type Profile, type ProjectConfig } from '../domain/schema.js';
import { FlowLibrary } from '../storage/flow-library.js';
import { ProfileLibrary } from '../storage/profile-library.js';
import { projectIdentity } from '../workspace/worktree.js';

export const defaultRoles: ProjectConfig['roleDefaults'] = Object.fromEntries(['implementer', 'verifier'].map(role => [role,
  { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' }]));
export function standaloneDiagnostics(flow: Flow): string[] {
  const reasons: string[] = [];
  if (flow.definition.workspacePolicy !== 'isolated') reasons.push('Đường chạy hiện cần worktree riêng; checkout hiện tại chưa được hỗ trợ.');
  if (flow.definition.nodes.some(node => node.type === 'integration')) reasons.push('Chưa thực thi bước tích hợp nhánh hoặc xử lý conflict.');
  if (flow.definition.nodes.filter(node => node.type === 'agent_task' && node.permissions.write).length > 1) reasons.push('Flow có nhiều bước ghi cần quản lý workspace/tích hợp trước khi thực thi.');
  if (flow.definition.nodes.filter(node => node.type === 'agent_task' && node.outputContract === 'plan').length > 1) reasons.push('Chưa gộp nhiều kế hoạch trong cùng một run.');
  for (const node of flow.definition.nodes) {
    if (node.type === 'agent_task' && (!node.permissions.read || node.permissions.gitCommit)) reasons.push(`${node.id}: executor hiện cần quyền đọc; commit dùng bước Git riêng.`);
    if (node.type === 'condition' && !['result', 'checks.passed', 'checks.results', 'review.accepted', 'repair.rounds'].includes(node.field) && !/^node\..+\.(?:status|outcome)$/.test(node.field)) reasons.push(`${node.id}: trường điều kiện chưa được hỗ trợ: ${node.field}`);
  }
  return reasons;
}
export function builtinProfile(profileId: string): Profile | undefined {
  if (!['implementer', 'verifier'].includes(profileId)) return undefined;
  return { schemaVersion: 1, profileId, version: 1, name: profileId === 'verifier' ? 'Independent reviewer' : 'Implementer',
    instructions: profileId === 'verifier' ? 'Evaluate the original task and approved plan independently. Read source and checks before forming a verdict. Cite exact evidence. Report uncertainty.' : 'Survey the project, propose a concise plan, and implement only approved changes. Preserve existing work. Use the specified checks.',
    skills: [], requestedPermissions: { read: true, write: profileId !== 'verifier', checks: true, gitCommit: false }, outputDefaults: {} };
}
export async function readProject(projectRoot: string): Promise<ProjectConfig> {
  try { return projectSchema.parse(JSON.parse(await readFile(path.join(projectRoot, '.neomind/project.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { ...structuredClone(defaultProject), projectId: `project-${hashJson(projectIdentity(projectRoot)).slice(0, 16)}`, roleDefaults: structuredClone(defaultRoles) };
  }
}
export async function projectRuntimeRoot(projectRoot: string, base?: string): Promise<string> {
  const key = hashJson(projectIdentity(await realpath(projectRoot)));
  const root = path.join(base ?? process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'neomind', key);
  await mkdir(path.join(root, 'runs'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'workspaces'), { recursive: true, mode: 0o700 });
  return root;
}
export async function snapshotProjectFlow(projectRoot: string, flowId: string, version?: number, overrides: Record<string, BindingOverride> = {}, limits: Partial<Flow['definition']['limits']> = {}) {
  const library = new FlowLibrary(path.join(projectRoot, '.neomind/flows'));
  let flow;
  const metadata = (await library.list()).find(item => item.flowId === flowId);
  if (metadata) {
    if (metadata.archived) throw new Error('Archived flow cannot start a new run');
    const selected = version ?? (await library.versions(flowId)).at(-1);
    if (!selected) throw new Error('Publish the flow before starting a run');
    const { semanticHash: _s, contentHash: _h, createdAt: _c, ...stored } = await library.readVersion(flowId, selected); flow = stored;
  } else {
    if (!Object.hasOwn(templates, flowId)) throw new Error('Unknown flow');
    flow = structuredClone(templates[flowId as keyof typeof templates]);
    if (version !== undefined && version !== flow.version) throw new Error('Unknown template version');
  }
  const profiles = new ProfileLibrary(path.join(projectRoot, '.neomind/profiles'));
  if ((limits.maxConcurrency ?? 0) > flow.definition.limits.maxConcurrency || (limits.maxRepairRounds ?? 0) > flow.definition.limits.maxRepairRounds) throw new Error('Run limits cannot exceed the saved flow concurrency or repair limits');
  flow.definition.limits = { ...flow.definition.limits, ...limits };
  const metadataProfiles = await profiles.list(), versions: Record<string, Profile> = {};
  const refs = flow.definition.nodes.flatMap(node => node.type === 'agent_task' ? [{ profileId: node.profileId, version: node.profileVersion }] : node.type === 'review_group' ? node.reviewers.map(reviewer => ({ profileId: reviewer.profileId, version: reviewer.profileVersion })) : []);
  for (const ref of refs) {
    const key = `${ref.profileId}@${ref.version}`;
    if (versions[key]) continue;
    if (metadataProfiles.some(item => item.profileId === ref.profileId)) {
      const { contentHash: _h, createdAt: _c, ...profile } = await profiles.readVersion(ref.profileId, ref.version); versions[key] = profile;
    } else {
      const profile = builtinProfile(ref.profileId);
      if (!profile || ref.version !== 1) throw new Error(`Missing profile version ${key}`);
      versions[key] = profile;
    }
  }
  return materializeRun(flow, await readProject(projectRoot), versions, projectRoot, overrides);
}
