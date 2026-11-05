// Reproduces directory-creation failures of plan checks inside the Codex Windows sandbox.
// It only uses app-server `config/read` and `command/exec`; no thread or turn is started, so no model quota is used.
// Usage: npm run build && node scripts/probe-check-sandbox.mjs [--base temp,localappdata,home] [--keep] [--acl] [--python <exe>]
//   [--windows-sandbox elevated|unelevated]  (overrides [windows] sandbox from ~/.codex/config.toml; elevated needs a prior
//   one-time `codex sandbox setup --elevated` as administrator)
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startRuntimeWorker } from '../dist/src/runtime/worker.js';
import { startWorkerScope } from '../dist/src/adapters/worker-scope.js';
import { resolveHostCommand } from '../dist/src/adapters/worker-environment.js';

if (process.platform !== 'win32') throw new Error('This probe targets the Windows sandbox');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const keep = process.argv.includes('--keep'), showAcl = process.argv.includes('--acl'), sandboxMode = option('--windows-sandbox');
if (sandboxMode && !['elevated', 'unelevated'].includes(sandboxMode)) throw new Error('--windows-sandbox must be elevated or unelevated');
const baseDirs = { temp: os.tmpdir(), localappdata: process.env.LOCALAPPDATA, home: os.homedir() };
const bases = (option('--base') ?? 'temp').split(',');
for (const base of bases) if (!baseDirs[base]) throw new Error(`Unknown base ${base}`);

// Same policy as src/adapters/codex-check.ts; the second variant lets the sandbox also write TEMP/TMP.
const policies = {
  product: workspace => ({ type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }),
  'tmpdir-writable': workspace => ({ type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: false }),
};

// `python` resolves exactly like a real check. `--python <exe>` adds an interpreter to compare, e.g. one older than
// 3.12.4 that does not apply the owner-only ACL described below.
const pythons = [['python', resolveHostCommand(['python'])[0]]];
const extra = option('--python');
if (extra) pythons.push(['pyalt', extra]);
const node = resolveHostCommand(['node'])[0], cmd = resolveHostCommand(['cmd'])[0];

/** Each variant uses its own top-level name so results cannot leak between variants. `cwd` is relative to the worktree. */
function variants() {
  const list = [];
  for (const [label, exe] of pythons) {
    // `@` in the code becomes this interpreter's own name prefix.
    const code = text => text.replaceAll('@', label);
    const py = (id, text, cwd = '.') => list.push({ id: `${label}:${id}`, steps: [{ command: [exe, '-c', code(text)], cwd }] });
    py('mkdir-a-then-a/b', "import os; os.mkdir('@a'); os.mkdir('@a/b')");
    py('makedirs-a/b/c', "import os; os.makedirs('@m/b/c')");
    py('mkdir-then-file', "import os; os.mkdir('@f'); open('@f/x.txt','w').write('x')");
    py('file-at-root', "open('@root.txt','w').write('x')");
    py('makedirs-in-subdir-cwd', "import os; os.makedirs('@s/b/c')", 'sub');
    py('makedirs-in-host-dir', "import os; os.makedirs('pre/@/b')");
    py('file-in-host-dir', "open('pre/@.txt','w').write('x')");
    py('real-run-pattern', "import os; os.makedirs('@r', exist_ok=True); os.makedirs(os.path.join(os.path.abspath('@r'),'templates'), exist_ok=True)");
    // Python >= 3.12.4 on Windows gives mode-0o700 directories a protected owner-only DACL (CVE-2024-4030);
    // tempfile.mkdtemp always uses 0o700, and without a writable TEMP it falls back to the cwd.
    py('mkdir-0o700-then-child', "import os; os.mkdir('@7', 0o700); os.mkdir('@7/b')");
    py('mkdtemp-in-cwd-then-child', "import os, tempfile; d = tempfile.mkdtemp(prefix='@t-', dir='.'); os.makedirs(os.path.join(d, 'templates'))");
    py('mkdtemp-default-then-child', "import os, tempfile; d = tempfile.mkdtemp(prefix='nmp-mkdtemp-'); print(d); os.makedirs(os.path.join(d, 'templates')); print('child ok')");
    list.push({ id: `${label}:mkdir-in-two-execs`, steps: [{ command: [exe, '-c', code("import os; os.mkdir('@2')")], cwd: '.' }, { command: [exe, '-c', code("import os; os.mkdir('@2/b')")], cwd: '.' }] });
  }
  list.push({ id: 'cmd:mkdir-a\\b', steps: [{ command: [cmd, '/d', '/c', 'mkdir', 'ca\\b'], cwd: '.' }] });
  list.push({ id: 'cmd:mkdir-then-file', steps: [{ command: [cmd, '/d', '/c', 'mkdir cf && echo x> cf\\x.txt'], cwd: '.' }] });
  list.push({ id: 'node:mkdir-a-then-a/b', steps: [{ command: [node, '-e', "const fs=require('fs'); fs.mkdirSync('na'); fs.mkdirSync('na/b')"], cwd: '.' }] });
  list.push({ id: 'node:mkdir-recursive-a/b/c', steps: [{ command: [node, '-e', "require('fs').mkdirSync('nm/b/c',{recursive:true})"], cwd: '.' }] });
  list.push({ id: 'node:mkdir-then-file', steps: [{ command: [node, '-e', "const fs=require('fs'); fs.mkdirSync('nf'); fs.writeFileSync('nf/x.txt','x')"], cwd: '.' }] });
  return list;
}

const lines = text => text.trim().split(/\r?\n/).filter(Boolean);
const firstLine = text => lines(text)[0] ?? '', lastLine = text => lines(text).at(-1) ?? '';
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }
function icacls(target) {
  try { return execFileSync('icacls', [target], { encoding: 'utf8' }).trim(); } catch (error) { return `icacls failed: ${error.message}`; }
}

async function setup(base) {
  const root = await mkdtemp(path.join(baseDirs[base], 'nmp-')), repo = path.join(root, 'r'), worktree = path.join(root, 'w');
  await mkdir(path.join(repo, 'sub'), { recursive: true });
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Probe'); git(repo, 'config', 'user.email', 'probe@localhost');
  await writeFile(path.join(repo, 'sub', '.keep'), ''); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'probe base');
  git(repo, 'worktree', 'add', '-q', '-b', 'probe', worktree);
  // Created by the host before the sandbox ever sees the worktree.
  await mkdir(path.join(worktree, 'pre'));
  return { root, repo, worktree };
}

async function probe(base, policyName) {
  const { root, repo, worktree } = await setup(base);
  const rows = [], acl = [];
  // command/exec never reaches plugins or MCP servers, so the bare scope is enough when the sandbox mode is overridden.
  const worker = sandboxMode ? { scope: await startWorkerScope(() => {}, () => {}, ['-c', `windows.sandbox="${sandboxMode}"`]) } : await startRuntimeWorker(worktree);
  try {
    for (const variant of variants()) {
      let result = 'ok', detail = '';
      for (const step of variant.steps) {
        try {
          const response = await worker.scope.transport.request('command/exec', { command: step.command, cwd: path.join(worktree, step.cwd), timeoutMs: 30000,
            outputBytesCap: 1024 * 1024, sandboxPolicy: policies[policyName](worktree) }, 35000);
          if (response.exitCode !== 0) { result = `exit ${response.exitCode}`; detail = [firstLine(response.stdout), lastLine(response.stderr)].filter(Boolean).join(' | '); break; }
          detail = lines(response.stdout).join(' | ');
        } catch (error) { result = 'exec error'; detail = error instanceof Error ? error.message : String(error); break; }
      }
      rows.push({ base, policy: policyName, variant: variant.id, result, detail: detail.slice(0, 140) });
    }
  } finally {
    if (!await worker.scope.stop()) console.error('warning: worker stop unconfirmed');
  }
  if (showAcl) for (const name of ['.', 'pre', 'pythona', 'pythonm/b', 'python7', 'pyalt7', 'ca', 'na']) {
    const target = path.join(worktree, name);
    acl.push(`--- ${target}\n${existsSync(target) ? icacls(target) : '(absent)'}`);
  }
  if (keep) console.log(`kept ${root}`);
  else {
    try { git(repo, 'worktree', 'remove', '--force', worktree); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(error => console.error(`cleanup failed for ${root}: ${error.message}`));
  }
  return { rows, acl };
}

const all = [];
for (const base of bases) for (const policy of Object.keys(policies)) {
  const { rows, acl } = await probe(base, policy);
  all.push(...rows);
  if (acl.length) console.log(`\n# ACLs (${base}, ${policy})\n${acl.join('\n')}`);
}
// mkdtemp-default writes to the real TEMP when the policy makes it writable.
if (!keep) for (const name of await readdir(os.tmpdir())) if (name.startsWith('nmp-mkdtemp-')) await rm(path.join(os.tmpdir(), name), { recursive: true, force: true }).catch(() => {});
const versions = pythons.map(([label, exe]) => `${label}=${exe} (${execFileSync(exe, ['-V'], { encoding: 'utf8' }).trim()})`);
console.log(`\nCodex: ${execFileSync(cmd, ['/d', '/c', 'codex', '--version'], { encoding: 'utf8' }).trim()}; ${versions.join(', ')}`);
const width = Math.max(...all.map(row => row.variant.length));
for (const row of all) console.log([row.base.padEnd(12), row.policy.padEnd(15), row.variant.padEnd(width), row.result.padEnd(10), row.detail].join(' ').trimEnd());
