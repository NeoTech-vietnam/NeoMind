import { opendirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, sep, win32 } from 'node:path';
import { parse } from 'jsonc-parser';

const settingsLimit = 1024 * 1024;
const profileLimit = 64;
const directoryEntryLimit = 256;
const userDirectoryLimit = 16;
const setting = 'workforce.bridge.runtimePath';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, path) => {
  const part = relative(root, path);
  return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};
const failure = (state, code, summary) => ({ state, code, summary });

/** Known user configuration locations only. This function performs no I/O. */
export function vscodeUserDirectories({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  if (own(env, 'WORKFORCE_VSCODE_USER_DIR') && env.WORKFORCE_VSCODE_USER_DIR !== undefined)
    return [env.WORKFORCE_VSCODE_USER_DIR];
  if (typeof env.VSCODE_PORTABLE === 'string' && env.VSCODE_PORTABLE.length)
    return [paths.join(env.VSCODE_PORTABLE, 'user-data', 'User')];
  const base = platform === 'win32' ? env.APPDATA || paths.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || paths.join(home, '.config');
  return ['Code', 'Code - Insiders'].map(name => paths.join(base, name, 'User'));
}

function runtimeAt(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) return;
  try {
    const runtime = realpathSync.native(value);
    if (!statSync(runtime).isDirectory()) return;
    const metadata = realpathSync.native(join(runtime, 'package.json'));
    const cli = realpathSync.native(join(runtime, 'dist', 'cli.js'));
    if (!within(runtime, metadata) || !within(runtime, cli)) return;
    const metadataStat = statSync(metadata);
    if (!metadataStat.isFile() || metadataStat.size > settingsLimit || !statSync(cli).isFile()) return;
    if (JSON.parse(readFileSync(metadata, 'utf8').replace(/^\uFEFF/, '')).name !== 'workforce') return;
    return runtime;
  } catch { return; }
}

function settingsValue(user, path) {
  try {
    const actual = realpathSync.native(path);
    if (!within(user, actual)) return { skipped: true };
    const info = statSync(actual);
    if (!info.isFile() || info.size > settingsLimit) return { invalid: true };
    const errors = [];
    const value = parse(readFileSync(actual, 'utf8').replace(/^\uFEFF/, ''), errors,
      { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !object(value)) return { invalid: true };
    return own(value, setting) ? { value: value[setting], configured: true } : {};
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? {} : { invalid: true };
  }
}

function profileSettings(user) {
  let directory;
  try {
    const root = realpathSync.native(join(user, 'profiles'));
    if (!within(user, root) || !statSync(root).isDirectory()) return { files: [] };
    directory = opendirSync(root);
    const files = [];
    let scanned = 0, profiles = 0, entry;
    while ((entry = directory.readSync())) {
      if (++scanned > directoryEntryLimit) return { overflow: true };
      if (entry.name === 'builtin' || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.name)) continue;
      try {
        const actual = realpathSync.native(join(root, entry.name));
        if (!within(user, actual) || !statSync(actual).isDirectory()) continue;
        if (++profiles > profileLimit) return { overflow: true };
        files.push(join(actual, 'settings.json'));
      } catch { /* Invalid or escaping profile entries are not user authority. */ }
    }
    return { files: files.sort() };
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { files: [] } : { files: [], invalid: true };
  } finally {
    try { directory?.closeSync(); } catch { /* Discovery never changes configuration. */ }
  }
}

/** Resolve only explicit user runtime selections. Never inspect workspace settings,
 * catalogs, host bearer descriptors, package-manager globals or arbitrary drives.
 * Invalid explicit overrides remain invalid instead of falling back to another runtime.
 */
export function discoverRuntime(options = {}) {
  try {
    if (!object(options)) return failure('invalid', 'RUNTIME_DISCOVERY_OPTIONS', 'Runtime discovery options are invalid.');
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    if (!object(env)) return failure('invalid', 'RUNTIME_DISCOVERY_OPTIONS', 'Runtime discovery environment is invalid.');
    if (own(env, 'WORKFORCE_RUNTIME_PATH') && env.WORKFORCE_RUNTIME_PATH !== undefined) {
      const runtime = runtimeAt(env.WORKFORCE_RUNTIME_PATH);
      return runtime ? { state: 'ready', runtime }
        : failure('invalid', 'RUNTIME_OVERRIDE_INVALID', 'WORKFORCE_RUNTIME_PATH must identify an installed WorkForce package with dist/cli.js.');
    }
    const directories = options.userDirectories ?? vscodeUserDirectories({ platform, env, home: options.home ?? homedir() });
    if (!Array.isArray(directories) || directories.length > userDirectoryLimit ||
        directories.some(path => typeof path !== 'string' || !isAbsolute(path)))
      return failure('invalid', 'RUNTIME_USER_DIRECTORY_INVALID', 'Choose absolute VS Code User settings directories.');
    const candidates = new Map();
    const seenUsers = new Set();
    let invalid = false;
    const key = value => platform === 'win32' ? value.toLowerCase() : value;
    for (const directory of directories) {
      let user;
      try {
        user = realpathSync.native(directory);
        if (!statSync(user).isDirectory()) { invalid = true; continue; }
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') invalid = true;
        continue;
      }
      if (seenUsers.has(key(user))) continue;
      seenUsers.add(key(user));
      const profiles = profileSettings(user);
      if (profiles.overflow)
        return failure('invalid', 'RUNTIME_PROFILE_LIMIT', 'Too many VS Code profiles to select a runtime safely. Use WORKFORCE_RUNTIME_PATH or WORKFORCE_VSCODE_USER_DIR.');
      invalid ||= profiles.invalid === true;
      for (const path of [join(user, 'settings.json'), ...profiles.files]) {
        const result = settingsValue(user, path);
        invalid ||= result.invalid === true;
        if (!result.configured) continue;
        const runtime = runtimeAt(result.value);
        if (runtime) candidates.set(key(runtime), runtime);
        else invalid = true;
      }
    }
    const paths = [...candidates.values()].sort();
    if (paths.length === 1) return { state: 'ready', runtime: paths[0] };
    if (paths.length > 1)
      return { ...failure('ambiguous', 'RUNTIME_AMBIGUOUS', 'Different VS Code profiles select different WorkForce runtimes. Choose one with WORKFORCE_RUNTIME_PATH or WORKFORCE_VSCODE_USER_DIR.'), candidates: paths };
    return invalid ? failure('invalid', 'RUNTIME_SETTINGS_INVALID', 'WorkForce User runtime settings could not be validated. Correct workforce.bridge.runtimePath or choose an explicit runtime.')
      : failure('missing', 'RUNTIME_NOT_CONFIGURED', 'Set User setting workforce.bridge.runtimePath to the installed WorkForce package, then reconnect.');
  } catch {
    return failure('invalid', 'RUNTIME_DISCOVERY_FAILED', 'WorkForce runtime discovery could not complete. Check the User runtime setting or choose an explicit runtime.');
  }
}
