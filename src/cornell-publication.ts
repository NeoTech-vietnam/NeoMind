import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { cornellCanonical, readCornellExportPlan, verifiedCornellExport, type CornellExportPlan } from './cornell-workflow.js';
import { readAutomationPolicy } from './manager.js';
import { atomicWrite, hash, now, safePath, withOperationLock } from './storage.js';

export interface CornellPublicationInput { plan_hash: string; remote: string; base_branch: string }
export interface CornellPublicationPlan {
  schema_version: 1; publication_hash: string; export_plan_hash: string; repository_root: string; notes_root: string;
  remote: string; remote_url: string; base_branch: string; base_commit: string; branch: string;
  author: { name: string; email: string }; commit_date: string; message: string; tree: string; commit: string;
  files: { path: string; sha256: string; bytes: number }[]; diff_stat: string; compare_url?: string;
}
export interface CornellPublicationReceipt { schema_version: 1; publication_hash: string; export_plan_hash: string;
  status: 'branch-published'; branch: string; commit: string; remote: string; compare_url?: string; published_at: string }
const digest = /^[a-f0-9]{64}$/, gitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const planPath = (value: string) => `.neomind/cornell-publications/plans/${value}.json`;
const receiptPath = (value: string) => `.neomind/cornell-publications/receipts/${value}.json`;
function assertRemotePolicy(root: string): void {
  if (readAutomationPolicy(root).network_policy !== 'remote-enabled')
    throw new Error('Local-only policy disables Cornell Git publication. Explicitly opt in to remote-enabled before preparing a remote publication.');
}
function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_|$)|AUTHOR_|COMMITTER_)/.test(key)) delete env[key];
  return env;
}
function git(cwd: string, args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; absent?: boolean } = {}): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', '--literal-pathspecs', '-C', cwd, ...args],
    { shell: false, windowsHide: true, timeout: 60_000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8', input: options.input,
      env: { ...environment(), ...options.env } });
  if (options.absent && result.status === 2) return '';
  if (result.error || result.status !== 0) throw new Error(`Cornell Git ${args[0]} failed. Check the selected repository, remote access and Git identity; no unrelated files were staged.`);
  return result.stdout.trim();
}
function remoteUrl(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Publication remote must resolve to one explicit supported URL.');
  if (isAbsolute(value)) return value;
  if (/\s/.test(value)) throw new Error('Publication remote must resolve to one explicit supported URL.');
  if (/^https:\/\//.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) throw new Error('Publication remote URL must not contain credentials or URL parameters.');
    return value;
  }
  if (/^ssh:\/\//.test(value)) {
    const url = new URL(value);
    if (url.password || url.search || url.hash) throw new Error('Publication SSH URL must not contain passwords or URL parameters.');
    return value;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value)) return value;
  throw new Error('Use a configured HTTPS/SSH remote or an explicit local repository path. Remote helper commands are unsupported.');
}
function context(plan: CornellExportPlan, remote: string): { repository_root: string; remote_url: string; author: { name: string; email: string }; prefix: string } {
  const repository = realpathSync.native(git(plan.notes_root, ['rev-parse', '--show-toplevel']));
  const prefix = relative(repository, plan.notes_root).replaceAll('\\', '/');
  if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) throw new Error('Notes destination is outside its Git repository.');
  const urls = git(repository, ['remote', 'get-url', '--push', '--all', remote]).split(/\r?\n/);
  if (urls.length !== 1) throw new Error('Select a Git remote with exactly one publication URL.');
  const name = git(repository, ['config', '--get', 'user.name']), email = git(repository, ['config', '--get', 'user.email']);
  if (!name || !email || /[\r\n<>\x00-\x1f]/.test(name + email)) throw new Error('Configure a valid Git author name and email before publication.');
  return { repository_root: repository, remote_url: remoteUrl(urls[0]!), author: { name, email }, prefix };
}
function branchHead(cwd: string, remote: string, branch: string): string | null {
  const output = git(cwd, ['ls-remote', '--exit-code', remote, `refs/heads/${branch}`], { absent: true });
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  if (lines.length !== 1) throw new Error('Remote returned an ambiguous branch identity.');
  const [commit, ref] = lines[0]!.split(/\s+/);
  if (!gitHash.test(commit!) || ref !== `refs/heads/${branch}`) throw new Error('Remote returned an invalid branch identity.');
  return commit!;
}
function temporary<T>(action: (path: string) => T): T {
  const path = mkdtempSync(join(tmpdir(), 'neomind-cornell-git-'));
  try { return action(path); }
  finally {
    if (dirname(resolve(path)) !== resolve(tmpdir())) throw new Error('Unexpected publication temporary path.');
    rmSync(path, { recursive: true, force: true });
  }
}
function compareUrl(remote: string, base: string, branch: string): string | undefined {
  const matched = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  return matched ? `https://github.com/${matched[1]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}` : undefined;
}
function buildCommit(path: string, plan: Pick<CornellPublicationPlan, 'remote_url' | 'base_commit' | 'author' | 'commit_date' | 'message' | 'files'>,
  exported: CornellExportPlan): { tree: string; commit: string; diff_stat: string } {
  const empty = join(path, 'empty-template'); mkdirSync(empty);
  git(path, ['-c', `init.templateDir=${empty}`, 'init', '--bare', '--quiet', `--object-format=${plan.base_commit.length === 64 ? 'sha256' : 'sha1'}`]);
  git(path, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', plan.remote_url, plan.base_commit]);
  const resolved = git(path, ['rev-parse', `${plan.base_commit}^{commit}`]);
  if (resolved !== plan.base_commit) throw new Error('Fetched base commit differs from its preview.');
  const index = { GIT_INDEX_FILE: join(path, 'publication.index') };
  git(path, ['read-tree', plan.base_commit], { env: index });
  for (let position = 0; position < plan.files.length; position++) {
    const file = plan.files[position]!, source = exported.files[position]!;
    if (source.sha256 !== file.sha256 || source.bytes !== file.bytes) throw new Error('Export file identity changed.');
    if (git(path, ['ls-tree', '-r', '--name-only', plan.base_commit, '--', file.path])) throw new Error('Publication would replace an existing committed note. Prepare a new immutable revision.');
    const content = Buffer.from(source.content_base64, 'base64');
    if (hash(content) !== file.sha256) throw new Error('Export bytes differ from their manifest.');
    const blob = git(path, ['hash-object', '-w', '--stdin'], { input: content });
    if (!gitHash.test(blob)) throw new Error('Git returned an invalid blob identity.');
    git(path, ['update-index', '--add', '--cacheinfo', '100644', blob, file.path], { env: index });
  }
  const tree = git(path, ['write-tree'], { env: index });
  const identity = { GIT_AUTHOR_NAME: plan.author.name, GIT_AUTHOR_EMAIL: plan.author.email, GIT_COMMITTER_NAME: plan.author.name,
    GIT_COMMITTER_EMAIL: plan.author.email, GIT_AUTHOR_DATE: plan.commit_date, GIT_COMMITTER_DATE: plan.commit_date };
  const commit = git(path, ['commit-tree', tree, '-p', plan.base_commit, '-m', plan.message], { env: identity });
  const changed = git(path, ['diff', '--name-only', '-z', plan.base_commit, commit]).split('\0').filter(Boolean).sort();
  if (cornellCanonical(changed) !== cornellCanonical(plan.files.map(file => file.path).sort())) throw new Error('Publication includes unexpected changed files.');
  return { tree, commit, diff_stat: git(path, ['diff', '--stat', plan.base_commit, commit]) };
}

/** Freeze a concrete new-branch preview without changing the user's index, worktree or local branches. */
export function prepareCornellPublication(root: string, input: CornellPublicationInput): CornellPublicationPlan {
  const request = z.object({ plan_hash: z.string().regex(digest), remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), base_branch: z.string().min(1).max(200) }).strict().parse(input);
  assertRemotePolicy(root);
  const { plan: exported } = verifiedCornellExport(root, request.plan_hash), selected = context(exported, request.remote);
  if (request.base_branch.startsWith('-')) throw new Error('Base branch must be an explicit Git branch.');
  git(selected.repository_root, ['check-ref-format', '--branch', request.base_branch]);
  const base = branchHead(selected.repository_root, selected.remote_url, request.base_branch);
  if (!base) throw new Error('Selected remote base branch does not exist.');
  const identity = { export_plan_hash: request.plan_hash, ...selected, remote: request.remote, base_branch: request.base_branch, base_commit: base };
  const requestHash = hash(cornellCanonical(identity));
  const pointer = safePath(root, `.neomind/cornell-publications/requests/${requestHash}.json`);
  if (existsSync(pointer)) {
    const prior = JSON.parse(readFileSync(pointer, 'utf8'));
    const plan = readCornellPublicationPlan(root, prior.publication_hash);
    if (plan.export_plan_hash !== request.plan_hash || plan.remote !== request.remote || plan.base_branch !== request.base_branch ||
      plan.base_commit !== base || plan.remote_url !== selected.remote_url || plan.repository_root !== selected.repository_root ||
      cornellCanonical(plan.author) !== cornellCanonical(selected.author)) throw new Error('Publication request identity changed.');
    return plan;
  }
  const branch = `codex/neomind-notes/${requestHash.slice(0, 24)}`;
  if (branchHead(selected.repository_root, selected.remote_url, branch)) throw new Error('Publication branch already exists; use its recorded receipt or prepare a different reviewed revision.');
  const core = { schema_version: 1 as const, export_plan_hash: request.plan_hash, repository_root: selected.repository_root,
    notes_root: exported.notes_root, remote: request.remote, remote_url: selected.remote_url, base_branch: request.base_branch,
    base_commit: base, branch, author: selected.author, commit_date: now(), message: `Add reviewed Cornell note ${exported.input.note_id}\n\nNeoMind export ${exported.plan_hash}.`,
    files: exported.files.map(file => ({ path: selected.prefix ? `${selected.prefix}/${file.path}` : file.path, sha256: file.sha256, bytes: file.bytes })) };
  const built = temporary(path => buildCommit(path, core, exported));
  const url = compareUrl(selected.remote_url, request.base_branch, branch);
  const body = { ...core, ...built, ...(url ? { compare_url: url } : {}) };
  const plan: CornellPublicationPlan = { ...body, publication_hash: hash(cornellCanonical(body)) };
  atomicWrite(safePath(root, planPath(plan.publication_hash)), JSON.stringify(plan, null, 2) + '\n');
  atomicWrite(pointer, JSON.stringify({ publication_hash: plan.publication_hash }) + '\n');
  return plan;
}
export function readCornellPublicationPlan(root: string, publicationHash: string): CornellPublicationPlan {
  if (!digest.test(publicationHash)) throw new Error('Publication hash must be SHA-256.');
  const data = readFileSync(safePath(root, planPath(publicationHash)), 'utf8');
  if (Buffer.byteLength(data) > 256 * 1024) throw new Error('Publication plan is too large.');
  const plan = JSON.parse(data) as CornellPublicationPlan, { publication_hash, ...body } = plan;
  if (publication_hash !== publicationHash || hash(cornellCanonical(body)) !== publicationHash) throw new Error('Publication plan changed.');
  return plan;
}

/** Explicit push of one create-only branch. No user files, existing refs, PRs or merge state are modified. */
export function publishCornellExport(root: string, input: { publication_hash: string }): CornellPublicationReceipt {
  const request = z.object({ publication_hash: z.string().regex(digest) }).strict().parse(input);
  return withOperationLock(root, `cornell-publish-${request.publication_hash.slice(0, 40)}`, () => {
    assertRemotePolicy(root);
    const plan = readCornellPublicationPlan(root, request.publication_hash);
    function validateContext(exported: CornellExportPlan): void {
      assertRemotePolicy(root);
      const selected = context(exported, plan.remote);
      if (exported.notes_root !== plan.notes_root || selected.repository_root !== plan.repository_root ||
          selected.remote_url !== plan.remote_url || cornellCanonical(selected.author) !== cornellCanonical(plan.author))
        throw new Error('Selected repository, remote or author changed; prepare a fresh publication preview.');
      const files = exported.files.map(file => ({ path: selected.prefix ? `${selected.prefix}/${file.path}` : file.path,
        sha256: file.sha256, bytes: file.bytes }));
      if (cornellCanonical(files) !== cornellCanonical(plan.files)) throw new Error('Publication differs from its frozen export identity.');
    }
    function revalidate(): CornellExportPlan {
      const { plan: exported } = verifiedCornellExport(root, plan.export_plan_hash);
      validateContext(exported);
      return exported;
    }
    // A matching remote commit is historical evidence, even after the mutable
    // source moves on. Only creation of a new branch requires current source.
    const frozen = readCornellExportPlan(root, plan.export_plan_hash);
    validateContext(frozen);
    const existing = branchHead(plan.repository_root, plan.remote_url, plan.branch);
    if (existing && existing !== plan.commit) throw new Error('Publication branch diverged; existing remote work will not be overwritten.');
    const save = (): CornellPublicationReceipt => {
      const output = safePath(root, receiptPath(plan.publication_hash));
      if (existsSync(output)) {
        const prior = JSON.parse(readFileSync(output, 'utf8')) as CornellPublicationReceipt;
        if (prior.commit !== plan.commit || prior.publication_hash !== plan.publication_hash) throw new Error('Publication receipt changed.');
        return prior;
      }
      const receipt: CornellPublicationReceipt = { schema_version: 1, publication_hash: plan.publication_hash, export_plan_hash: plan.export_plan_hash,
        status: 'branch-published', branch: plan.branch, commit: plan.commit, remote: plan.remote,
        ...(plan.compare_url ? { compare_url: plan.compare_url } : {}), published_at: now() };
      atomicWrite(output, JSON.stringify(receipt, null, 2) + '\n'); return receipt;
    };
    if (existing === plan.commit) return save();
    const exported = revalidate();
    if (branchHead(plan.repository_root, plan.remote_url, plan.base_branch) !== plan.base_commit) throw new Error('Remote base branch advanced; prepare a fresh publication preview.');
    temporary(path => {
      const built = buildCommit(path, plan, exported);
      if (built.tree !== plan.tree || built.commit !== plan.commit) throw new Error('Rebuilt publication differs from its exact preview.');
      revalidate();
      if (branchHead(plan.repository_root, plan.remote_url, plan.base_branch) !== plan.base_commit) throw new Error('Remote base branch advanced; prepare a fresh publication preview.');
      // Expected-empty lease is compare-and-swap creation, never an overwrite.
      git(path, ['push', '--no-verify', '--porcelain', `--force-with-lease=refs/heads/${plan.branch}:`, plan.remote_url, `${plan.commit}:refs/heads/${plan.branch}`]);
    });
    validateContext(frozen);
    if (branchHead(plan.repository_root, plan.remote_url, plan.branch) !== plan.commit) throw new Error('Published branch could not be verified; retry the recorded publication without changing its plan.');
    return save();
  });
}
