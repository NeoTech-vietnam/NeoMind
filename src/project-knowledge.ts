import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  atomicWrite, getRecord, hash, loadRecords, readConfig, safePath, withOperationLock,
} from './storage.js';
import { recordFingerprint } from './engineering.js';
import { prepareContribution } from './packs.js';
import { validateCornellNote } from './notes.js';
import { readAutomationPolicy } from './manager.js';
import { projectKnowledgeArtifactPath } from './knowledge-reuse.js';

export type ProjectKnowledgeRequest = (method: string, endpoint: string, body?: unknown) => any;
interface CatalogEntry {
  schema_version: 1;
  schema: 'taskforces-project-knowledge-note';
  title: string;
  platforms: string[];
  frameworks: string[];
  applicability: string[];
  provenance: string[];
  artifact_path: string;
  sha256: string;
}
export interface PreparedProjectKnowledge {
  project_hash: string;
  branch: string;
  path: string;
  manifest_path: string;
  pack: { id: string; version: string };
  entry: CatalogEntry;
  files: { path: string; content: string }[];
  content_hash: string;
  /** Local-only identity of the candidate, review and validated Cornell sources. */
  validation_hash: string;
}
export interface ProjectKnowledgePublication {
  status: 'branch-published';
  branch: string;
  commit: string;
  repository: string;
  path: string;
  url: string;
}
interface PublicationState {
  schema_version: 1;
  candidate_id: string;
  project_hash: string;
  repository: string;
  branch: string;
  path: string;
  content_hash: string;
  validation_hash: string;
  status: 'planned' | 'base-frozen' | 'tree-created' | 'commit-created' | 'branch-published';
  files: PreparedProjectKnowledge['files'];
  files_hash: string;
  branch_existed?: boolean;
  base_commit?: string;
  base_tree?: string;
  tree?: string;
  commit?: string;
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = /^[a-f0-9]{64}$/;
function missing(error: unknown): boolean {
  const typed = error as { status?: number; statusCode?: number } | null;
  return typed?.status === 404 || typed?.statusCode === 404 || /\bHTTP\s*404\b/i.test(String(error));
}
function githubRequest(method: string, endpoint: string, body?: unknown): any {
  const result = spawnSync('gh', [
    'api', '--method', method, endpoint, ...(body === undefined ? [] : ['--input', '-']),
  ], {
    shell: false, encoding: 'utf8', windowsHide: true, timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  if (result.error || result.status !== 0)
    throw new Error(`GitHub request failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
function publicText(value: unknown, label: string, minimum = 1): string {
  if (typeof value !== 'string') throw new Error(`${label} must be public text.`);
  const text = value.trim().replaceAll('\r\n', '\n');
  if (
    text.length < minimum || /[\x00-\x08\x0b-\x1f\x7f]/.test(text) ||
    /\b(?:TODO|TBD|insert here|fill in|placeholder|lorem ipsum)\b/i.test(text) ||
    (minimum >= 40 && ((text.match(/\p{L}/gu) ?? []).length < 25 ||
      new Set(text.toLowerCase().match(/\p{L}/gu)).size < 6))
  ) throw new Error(`${label} needs meaningful public content (minimum ${minimum} characters).`);
  return text;
}
function publicList(value: unknown, label: string, nonempty = false): string[] {
  if (!Array.isArray(value) || (nonempty && !value.length))
    throw new Error(`${label} must be a public string array.`);
  return [...new Set(value.map((item) => publicText(item, label)))];
}
function catalog(entries: CatalogEntry[]): string {
  return json({
    schema_version: 1,
    schema: 'taskforces-project-knowledge-catalog',
    notes: [...entries].sort((a, b) => a.artifact_path.localeCompare(b.artifact_path)),
  });
}

/**
 * Gate through the existing independent generalization review, then render an
 * allowlist only. Source fingerprints must have been captured BEFORE that review
 * in data.cornell_note_fingerprints, keyed by data.cornell_note_ids.
 * The generated contribution staging files are local only and are never uploaded.
 */
export function prepareProjectKnowledge(root: string, id: string): PreparedProjectKnowledge {
  const candidate = getRecord(root, id);
  const canonicalId = candidate.meta.id;
  const contribution = prepareContribution(root, canonicalId) as { path: string };
  const records = loadRecords(root);
  // Deliberately match prepareContribution's authoritative latest-review selection.
  const reviewer = records.filter((record) =>
    record.meta.type === 'review' && record.meta.data.generalization_review === true &&
    record.meta.links.some((link) => link.type === 'reviews' && link.target === canonicalId),
  ).sort((a, b) => b.meta.created_at.localeCompare(a.meta.created_at) ||
    b.meta.id.localeCompare(a.meta.id))[0];
  const data = candidate.meta.data;
  if (data.public_safe !== true || reviewer?.meta.data.public_safe !== true)
    throw new Error('Candidate and current independent reviewer must both explicitly set public_safe=true.');
  if (
    reviewer.meta.owner === candidate.meta.owner || reviewer.meta.data.decision !== 'pass' ||
    reviewer.meta.data.target_fingerprint !== recordFingerprint(candidate) ||
    typeof reviewer.meta.data.invocation_id !== 'string' || !reviewer.meta.data.invocation_id.trim() ||
    reviewer.meta.data.invocation_id === data.invocation_id
  ) throw new Error('A current independent generalization review is required.');
  const workflow = data.workflow_id;
  if (typeof workflow !== 'string' || !workflow.trim())
    throw new Error('Public knowledge requires the source workflow_id.');
  const ids = data.cornell_note_ids;
  const fingerprints = data.cornell_note_fingerprints;
  if (
    !Array.isArray(ids) || !ids.length || ids.some((value) => typeof value !== 'string' || !value) ||
    new Set(ids).size !== ids.length || !fingerprints || typeof fingerprints !== 'object' ||
    Array.isArray(fingerprints)
  ) throw new Error('Source Cornell IDs and current cornell_note_fingerprints are required.');
  const sources = ids.map((sourceId: string) => {
    const note = getRecord(root, sourceId);
    const fingerprint = recordFingerprint(note);
    if (
      note.meta.id !== sourceId || note.meta.data.workflow_id !== workflow ||
      note.meta.status === 'superseded' ||
      (fingerprints as Record<string, unknown>)[sourceId] !== fingerprint
    ) throw new Error('Source Cornell notes must belong to the same workflow with current fingerprints.');
    if (!validateCornellNote(root, sourceId).ok)
      throw new Error('Source Cornell note validation failed; repair and review a new candidate.');
    return { id: sourceId, fingerprint };
  });
  if (!data.public_cornell || typeof data.public_cornell !== 'object' || Array.isArray(data.public_cornell))
    throw new Error('public_cornell must contain cues, notes, summary and application.');
  const cornell = data.public_cornell as Record<string, unknown>;
  const title = publicText(candidate.meta.title, 'Public title');
  if (title.includes('\n')) throw new Error('Public title must be a single line.');
  const cues = publicText(cornell.cues, 'Public Cornell cues', 40);
  const notes = publicText(cornell.notes, 'Public Cornell notes', 120);
  const summary = publicText(cornell.summary, 'Public Cornell summary', 40);
  const application = publicText(cornell.application, 'Public Cornell application', 40);
  const platforms = publicList(data.platforms, 'platforms', true);
  const frameworks = publicList(data.frameworks, 'frameworks');
  const applicability = publicList(data.applicability, 'applicability', true);
  const provenance = publicList(data.provenance, 'provenance', true);
  const config = readConfig(root);
  const projectHash = hash(config.project_id);
  const pack = JSON.parse(readFileSync(safePath(root, `${contribution.path}/pack.json`), 'utf8'));
  const path = projectKnowledgeArtifactPath(`knowledge/projects/${projectHash}/notes/${pack.id}/${pack.version}.md`);
  const manifestPath = `knowledge/projects/${projectHash}/manifest.json`;
  const narrative = `# ${title}\n\n## Cue Column\n\n${cues}\n\n## Main Notes\n\n${notes}\n\n## Summary\n\n${summary}\n\n## Application\n\n${application}\n\n## Applicability\n\n${applicability.map((item) => `- ${item}`).join('\n')}\n\n## Provenance\n\n${provenance.map((item) => `- ${item}`).join('\n')}\n`;
  const entry: CatalogEntry = {
    schema_version: 1, schema: 'taskforces-project-knowledge-note', title,
    platforms, frameworks, applicability, provenance, artifact_path: path, sha256: hash(narrative),
  };
  // Public-safe approval is not a secret scanner. Still reject known local IDs and
  // artifact paths accidentally copied into explicitly public fields.
  const publicContent = [path, manifestPath, pack.id, pack.version, title, narrative, ...platforms, ...frameworks,
    ...applicability, ...provenance].join('\n').replaceAll('\\', '/').toLowerCase();
  const privateValues = [config.project_id, root.replaceAll('\\', '/'),
    ...records.map((record) => record.meta.id),
    ...ids.flatMap((sourceId: string) => {
      const note = getRecord(root, sourceId);
      return Object.keys((note.meta.data.artifact_hashes ?? {}) as object);
    }),
  ];
  if (privateValues.some((value) => value && publicContent.includes(value.toLowerCase())) ||
    /(?:\b[a-z]:\/|file:\/\/|\.taskforces\/)/i.test(publicContent))
    throw new Error('Public fields contain a private project identity or source artifact path.');
  const files = [
    { path, content: narrative },
    { path: path.replace(/\.md$/, '.json'), content: json(entry) },
    { path: manifestPath, content: catalog([entry]) },
  ];
  return {
    project_hash: projectHash, branch: `taskforces/knowledge/${projectHash.slice(0, 16)}`,
    path, manifest_path: manifestPath, pack: { id: pack.id, version: pack.version }, entry, files,
    content_hash: hash(JSON.stringify(files)),
    validation_hash: hash(JSON.stringify({
      candidate: [canonicalId, recordFingerprint(candidate)],
      review: [reviewer.meta.id, recordFingerprint(reviewer)], sources,
    })),
  };
}
function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]+$/.test(value))
    throw new Error(`GitHub did not return a valid ${label} identity.`);
  return value;
}
function refHead(repository: string, branch: string, request: ProjectKnowledgeRequest): string | null {
  try {
    return identity(request('GET', `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`)?.object?.sha, 'ref');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function mergeCatalog(prepared: PreparedProjectKnowledge, base: string, repository: string,
  request: ProjectKnowledgeRequest): PreparedProjectKnowledge['files'] {
  let entries: CatalogEntry[] = [];
  try {
    const response = request('GET', `repos/${repository}/contents/${prepared.manifest_path}?ref=${encodeURIComponent(base)}`);
    if (response?.encoding !== 'base64' || typeof response.content !== 'string')
      throw new Error('Remote project catalog is not a base64 file.');
    const existing = JSON.parse(Buffer.from(response.content, 'base64').toString('utf8'));
    if (existing.schema_version !== 1 || existing.schema !== 'taskforces-project-knowledge-catalog' ||
      !Array.isArray(existing.notes)) throw new Error('Remote project catalog is malformed.');
    entries = existing.notes.map((item: CatalogEntry) => {
      const prefix = `knowledge/projects/${prepared.project_hash}/notes/`;
      if (!item || item.schema_version !== 1 || item.schema !== 'taskforces-project-knowledge-note' ||
        typeof item.artifact_path !== 'string' || !item.artifact_path.startsWith(prefix) ||
        !/^[a-z][a-z0-9-]{0,63}\/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.md$/.test(item.artifact_path.slice(prefix.length)) ||
        typeof item.sha256 !== 'string' || !digest.test(item.sha256))
        throw new Error('Remote project catalog entry is malformed.');
      // Preserve only the public schema, never arbitrary fields in a remote file.
      return {
        schema_version: 1, schema: 'taskforces-project-knowledge-note',
        title: publicText(item.title, 'Catalog title'),
        platforms: publicList(item.platforms, 'Catalog platforms'),
        frameworks: publicList(item.frameworks, 'Catalog frameworks'),
        applicability: publicList(item.applicability, 'Catalog applicability', true),
        provenance: publicList(item.provenance, 'Catalog provenance', true),
        artifact_path: item.artifact_path, sha256: item.sha256,
      };
    });
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (new Set(entries.map((item) => item.artifact_path)).size !== entries.length)
    throw new Error('Remote project catalog contains duplicate artifacts.');
  const previous = entries.find((item) => item.artifact_path === prepared.path);
  if (previous && json(previous) !== json(prepared.entry))
    throw new Error('Published pack version has different content; use a new reviewed version.');
  return prepared.files.map((file) => file.path === prepared.manifest_path ? {
    path: file.path,
    content: catalog(entries.filter((item) => item.artifact_path !== prepared.path).concat(prepared.entry)),
  } : file);
}

/** Explicit branch publication only: never opens a PR, merges, or force pushes. */
export function publishProjectKnowledge(root: string, id: string, repository: string,
  request: ProjectKnowledgeRequest = githubRequest): ProjectKnowledgePublication {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..'))
    throw new Error('Upstream must be a safe explicit owner/repository name.');
  const projectHash = hash(readConfig(root).project_id);
  return withOperationLock(root, `project-knowledge-${projectHash}`, () => {
    const assertRepository = () => {
      const policy = readAutomationPolicy(root);
      if (policy.network_policy === 'local-only')
        throw new Error('Local-only policy disables remote knowledge publication. Set network_policy to "remote-enabled" in .taskforces/automation.json to opt in.');
      if (policy.upstream !== repository)
        throw new Error('Publication repository must exactly match the configured TaskForces upstream.');
    };
    assertRepository();
    const candidateId = getRecord(root, id).meta.id;
    const prepared = prepareProjectKnowledge(root, candidateId);
    if (prepared.project_hash !== projectHash) throw new Error('Project identity changed during publication.');
    const output = safePath(root, `.taskforces/project-knowledge/${candidateId}.json`);
    const prior: PublicationState | null = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null;
    if (prior && (prior.schema_version !== 1 || prior.candidate_id !== candidateId ||
      prior.project_hash !== projectHash || prior.repository !== repository ||
      prior.branch !== prepared.branch || prior.path !== prepared.path ||
      prior.content_hash !== prepared.content_hash || prior.validation_hash !== prepared.validation_hash))
      throw new Error('Frozen publication identity, review, content or repository changed; create a new reviewed candidate.');
    if (prior && (!['planned', 'base-frozen', 'tree-created', 'commit-created', 'branch-published'].includes(prior.status) ||
      !Array.isArray(prior.files) || prior.files_hash !== hash(JSON.stringify(prior.files)) ||
      (prior.status !== 'planned' && (!prior.base_commit || !prior.base_tree || typeof prior.branch_existed !== 'boolean')) ||
      (['tree-created', 'commit-created', 'branch-published'].includes(prior.status) && !prior.tree) ||
      (['commit-created', 'branch-published'].includes(prior.status) && !prior.commit)))
      throw new Error('Malformed publication state; inspect it before recovery.');
    const state: PublicationState = prior ?? {
      schema_version: 1, candidate_id: candidateId, project_hash: projectHash, repository,
      branch: prepared.branch, path: prepared.path, content_hash: prepared.content_hash,
      validation_hash: prepared.validation_hash, files: prepared.files,
      files_hash: hash(JSON.stringify(prepared.files)), status: 'planned',
    };
    const persist = () => atomicWrite(output, json(state));
    const result = (): ProjectKnowledgePublication => ({
      status: 'branch-published', branch: state.branch, commit: state.commit!, repository,
      path: state.path,
      url: `https://github.com/${repository}/blob/${state.commit}/${state.path}`,
    });
    const revalidate = () => {
      assertRepository();
      const current = prepareProjectKnowledge(root, candidateId);
      if (current.content_hash !== state.content_hash || current.validation_hash !== state.validation_hash ||
        current.branch !== state.branch)
        throw new Error('Candidate, review or source fingerprints changed during publication.');
    };
    // Even completed receipts are gated by all current safety/review/source checks.
    if (state.status === 'branch-published') { revalidate(); return result(); }
    persist();
    const prefix = `repos/${repository}`;
    if (!state.base_commit) {
      const projectHead = refHead(repository, state.branch, request);
      let base = projectHead;
      if (!base) {
        const repo = request('GET', prefix);
        if (typeof repo?.default_branch !== 'string' || !repo.default_branch)
          throw new Error('Upstream has no default branch.');
        base = refHead(repository, repo.default_branch, request);
      }
      if (!base) throw new Error('Upstream has no initial commit.');
      const commit = request('GET', `${prefix}/git/commits/${encodeURIComponent(base)}`);
      if (identity(commit?.sha, 'base commit') !== base) throw new Error('Base commit does not match its ref.');
      const baseTree = identity(commit?.tree?.sha, 'base tree');
      const files = mergeCatalog(prepared, base, repository, request);
      state.base_commit = base;
      state.base_tree = baseTree;
      state.branch_existed = projectHead !== null;
      state.files = files;
      state.files_hash = hash(JSON.stringify(files));
      state.status = 'base-frozen';
      persist();
    }
    // Freeze and validate the exact bytes used to construct the remote tree.
    const frozenNote = state.files.filter((file) => file.path !== prepared.manifest_path);
    if (json(frozenNote) !== json(prepared.files.filter((file) => file.path !== prepared.manifest_path)) ||
      state.files.length !== 3 || state.files[2]?.path !== prepared.manifest_path)
      throw new Error('Frozen publication files changed; inspect the local receipt.');
    if (!state.tree) {
      revalidate();
      state.tree = identity(request('POST', `${prefix}/git/trees`, {
        base_tree: state.base_tree,
        tree: state.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
      })?.sha, 'tree');
      state.status = 'tree-created';
      persist();
    }
    if (!state.commit) {
      revalidate();
      state.commit = identity(request('POST', `${prefix}/git/commits`, {
        message: `Publish reviewed Cornell knowledge ${prepared.pack.id}@${prepared.pack.version}`,
        tree: state.tree, parents: [state.base_commit],
      })?.sha, 'commit');
      state.status = 'commit-created';
      persist();
    }
    const head = refHead(repository, state.branch, request);
    if ((head === null && state.branch_existed) ||
      (head !== state.commit && head !== null && head !== state.base_commit))
      throw new Error('Project branch diverged from the frozen base; refusing to update its ref.');
    // No remote work between this fresh gate and the only visibility mutation.
    revalidate();
    if (head !== state.commit) {
      if (head === null) request('POST', `${prefix}/git/refs`, { ref: `refs/heads/${state.branch}`, sha: state.commit });
      else request('PATCH', `${prefix}/git/refs/heads/${encodeURIComponent(state.branch)}`, { sha: state.commit, force: false });
      if (refHead(repository, state.branch, request) !== state.commit)
        throw new Error('Project branch did not confirm the frozen publication commit.');
    }
    state.status = 'branch-published';
    persist();
    return result();
  });
}
