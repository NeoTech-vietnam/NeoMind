import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallReport } from './installer.js';
import { readConfig, resolveManagedRoot, safePath, withOperationLock } from './storage.js';

export interface UpgradeOptions {
  /** Absolute npm CLI JavaScript file; also permits a fake npm CLI in isolated tests. */
  npm_cli?: string;
}

export type UpgradePhase =
  | 'preflight'
  | 'backup'
  | 'stage-target'
  | 'stage-old'
  | 'uninstall'
  | 'install'
  | 'verify'
  | 'update'
  | 'complete';

export interface UpgradeResult {
  schema_version: 1;
  status: 'upgraded';
  root: string;
  target: { name: 'neomind'; version: string };
  previous: { name: 'neomind' | 'taskforces' | 'verythinker'; version: string }[];
  dependency_section: 'dependencies' | 'devDependencies';
  /** Saved package.json spec: an exact registry version or a project-relative file: archive. */
  dependency_spec: string;
  /** Diagnostic backups only; may be deleted after success, but retain on failure. */
  recovery_path: string;
  /** Diagnostic staging archive inside recovery_path, not the saved dependency target. */
  staged_target: string;
  /** Local targets only. Preserve this archive when moving/copying the project: file: depends on it. */
  durable_target?: string;
  backups: { path: string; backup: string | null }[];
  update: InstallReport;
  conflicts: InstallReport['conflicts'];
}

export class UpgradeError extends Error {
  constructor(
    public readonly phase: UpgradePhase,
    public readonly recovery_path: string | null,
    detail: string,
  ) {
    super(
      `Package upgrade failed during ${phase}; recovery: ${recovery_path ?? 'not created'}. ${detail}`,
    );
    this.name = 'UpgradeError';
  }
}

function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Validate the explicit npm root before even acquiring a project operation lock. */
function projectRoot(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('An explicit project root is required.');
  const root = realpathSync(resolve(input));
  if (!lstatSync(root).isDirectory()) throw new Error('Project root must be a directory.');
  if (root.split(/[\\/]/).some((part) => part.toLowerCase() === 'node_modules'))
    throw new Error('A package inside node_modules is not a supported project root.');
  const manifest = join(root, 'package.json');
  if (!lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink())
    throw new Error('The explicit project root must contain a regular package.json.');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Invalid package.json.');
  if (['neomind', 'taskforces', 'verythinker'].includes(pkg.name))
    throw new Error('Refusing to replace the tool source checkout or a package named neomind/verythinker.');
  for (let directory = root; ; directory = dirname(directory)) {
    const path = join(directory, 'package.json');
    if (existsSync(path)) {
      const ancestor = JSON.parse(readFileSync(path, 'utf8'));
      if (ancestor && Object.hasOwn(ancestor, 'workspaces'))
        throw new Error('Workspace roots and projects beneath workspace roots are unsupported.');
    }
    if (directory === dirname(directory)) break;
  }
  if (/"workspace:[^"]*"/.test(JSON.stringify(pkg)))
    throw new Error('The workspace: protocol is unsupported.');
  if (typeof pkg.packageManager === 'string' && !pkg.packageManager.startsWith('npm@'))
    throw new Error('Package upgrade supports npm projects only.');
  if (/^(true|1)$/i.test(process.env.npm_config_global ?? '') ||
      process.env.npm_config_location === 'global')
    throw new Error('Global npm installations are unsupported; use an explicit local project.');
  // Never initialize or migrate a project as an upgrade side effect.
  readConfig(root);
  const managed = join(root, resolveManagedRoot(root));
  if (lstatSync(managed).isSymbolicLink() || !lstatSync(managed).isDirectory())
    throw new Error('Managed storage must be a real local directory.');
  if (['write.lock', '.write.lock'].some((name) => existsSync(join(managed, name))))
    throw new Error('A project write lock is present; stop all clients before upgrading.');
  return root;
}

function targetSpec(root: string, target: string): string {
  if (typeof target !== 'string' || !target || target !== target.trim() || target.includes('\0'))
    throw new Error('Specify a version, tag, or local .tgz file.');
  if (/\.tgz$/i.test(target) && !target.startsWith('@') &&
      !/^[a-z][a-z0-9+.-]*:/i.test(target.replace(/^[A-Za-z]:[\\/]/, ''))) {
    const path = resolve(root, target);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Target .tgz must be a regular local file.');
    return realpathSync(path);
  }
  if (target.startsWith('@')) throw new Error('Scoped target packages are unsupported; only neomind is allowed.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(target))
    throw new Error('Only a safe version/tag or a regular local .tgz is accepted; URLs, git, aliases and flags are unsupported.');
  return `neomind@${target}`;
}

/**
 * Replace a direct local npm installation, then run the NEW CLI's conflict-aware update.
 * Synchronous, like installProject/updateProject. Stop all clients before calling:
 * package-upgrade serializes upgrades, but existing writers do not honor that lock.
 * Registry targets save an exact version. Local targets save a project-relative file:
 * dependency in the resolved managed root's package-cache; it is portable only while
 * that archive is preserved. Never remove the durable cache while it is referenced.
 * OS recovery backups are diagnostic only and may be deleted after success.
 * Retain recovery on failure; no automatic rollback, deletion or migration is performed.
 */
export function upgradeProject(root: string, target: string, options: UpgradeOptions = {}): UpgradeResult {
  let recovery: string | null = null;
  try {
    root = projectRoot(root);
    const spec = targetSpec(root, target);
    if (options.npm_cli !== undefined &&
        (!isAbsolute(options.npm_cli) || !/\.[cm]?js$/i.test(options.npm_cli) ||
          !lstatSync(options.npm_cli).isFile()))
      throw new Error('npm_cli must be an absolute JavaScript CLI file.');
    return withOperationLock(root, 'package-upgrade', () => {
      const temporary = realpathSync(tmpdir());
      if (inside(join(root, 'node_modules'), temporary))
        throw new Error('The temporary directory must be outside project node_modules.');
      recovery = mkdtempSync(join(temporary, 'neomind-upgrade-'));
      const runner = join(recovery, 'upgrade-runner.mjs');
      copyFileSync(fileURLToPath(new URL('../scripts/upgrade-runner.mjs', import.meta.url)), runner);
      const lockPath = safePath(root, '.neomind/operations/package-upgrade.lock');
      const lease = JSON.parse(readFileSync(lockPath, 'utf8'));
      const configuration = join(recovery, 'config.json');
      const resultPath = join(recovery, 'result.json');
      writeFileSync(configuration, JSON.stringify({
        schema_version: 1,
        root,
        spec,
        managed_root: resolveManagedRoot(root),
        recovery_path: recovery,
        result_path: resultPath,
        supervisor_pid: process.pid,
        lock_token: lease.token,
        ...(options.npm_cli === undefined ? {} : { npm_cli: options.npm_cli }),
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      // All supervisor imports are already loaded; the child has only built-in imports.
      // No shell, in-place package code, or lazy imports survive across removal.
      const child = spawnSync(process.execPath, [runner, configuration], {
        cwd: recovery,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024,
      });
      if (existsSync(resultPath)) {
        const result = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (result.ok === false && result.error && typeof result.error.message === 'string')
          throw new UpgradeError(result.error.phase, recovery, result.error.message);
        if (!child.error && child.status === 0 && result.ok === true &&
            result.result?.schema_version === 1 && result.result?.status === 'upgraded' &&
            result.result?.root === root && result.result?.recovery_path === recovery)
          return result.result as UpgradeResult;
      }
      // Do not echo raw child output: npm diagnostics can contain credentials.
      let phase: UpgradePhase = 'preflight';
      try { phase = JSON.parse(readFileSync(join(recovery, 'recovery.json'), 'utf8')).phase; }
      catch { /* An early runner failure may not have written its journal. */ }
      throw new UpgradeError(phase, recovery,
        child.error ? `Runner could not complete (${child.error.name}).` :
          `Runner exited without a valid result (exit ${child.status}, signal ${child.signal}). Inspect recovery.json.`);
    }, 0);
  } catch (error) {
    if (error instanceof UpgradeError) throw error;
    throw new UpgradeError('preflight', recovery, error instanceof Error ? error.message : String(error));
  }
}
