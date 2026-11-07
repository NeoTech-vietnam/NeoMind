import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface EspIdfToolchain {
  sdk: string; tools: string; python: string; version: string;
  /** A task-local patch only. Never copy unrelated inherited credentials. */
  env: Record<string, string>;
}
type ObjectValue = Record<string, unknown>;
interface ToolExport { name: string; version: string; paths: string[][] }
interface Sdk { path: string; version: string; pythonPrefix: string; exports: ToolExport[] }
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const component = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value);
const within = (root: string, path: string) => { const value = relative(root, path); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const directory = (path: string) => { const actual = realpathSync.native(path); return statSync(actual).isDirectory() ? actual : undefined; };
function ordinaryText(root: string, path: string, maximum: number): string {
  const info = lstatSync(path), actual = realpathSync.native(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || !within(root, actual)) throw new Error();
  return readFileSync(actual, 'utf8');
}
function exportPaths(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length > 32) throw new Error();
  return value.map(parts => {
    if (!Array.isArray(parts) || parts.length > 16 || parts.some(part => part !== '' && !component(part))) throw new Error();
    return parts as string[];
  });
}
function readSdk(path: string): Sdk | undefined {
  try {
    const root = directory(path); if (!root) return;
    ordinaryText(root, join(root, 'tools/idf.py'), 2 * 1024 * 1024);
    const version = ordinaryText(root, join(root, 'tools/cmake/version.cmake'), 65536);
    const numbers = ['MAJOR', 'MINOR', 'PATCH'].map(part => {
      const matches = [...version.matchAll(new RegExp(`^\\s*set\\(\\s*IDF_VERSION_${part}\\s+(\\d+)\\s*\\)`, 'gm'))];
      if (matches.length !== 1 || Number(matches[0]![1]) > 9999) throw new Error();
      return Number(matches[0]![1]);
    });
    const manifest: unknown = JSON.parse(ordinaryText(root, join(root, 'tools/tools.json'), 4 * 1024 * 1024));
    if (!object(manifest) || !Array.isArray(manifest.tools) || manifest.tools.length > 128) throw new Error();
    const names = new Set<string>();
    const exports = manifest.tools.map((tool: unknown): ToolExport => {
      if (!object(tool) || !component(tool.name) || names.has(tool.name) || !Array.isArray(tool.versions) || tool.versions.length > 256) throw new Error();
      names.add(tool.name);
      const recommended = tool.versions.filter(version => object(version) && version.status === 'recommended');
      if (recommended.length !== 1 || !object(recommended[0]) || !component(recommended[0].name)) throw new Error();
      return { name: tool.name, version: recommended[0].name, paths: exportPaths(tool.export_paths) };
    });
    return { path: root, version: numbers.join('.'), pythonPrefix: `idf${numbers[0]}.${numbers[1]}_`, exports };
  } catch { return undefined; }
}
function pythonEnvironment(path: string, prefix: string, platform: string): { directory: string; python: string } | undefined {
  try {
    const root = directory(path);
    if (!root || !basename(root).startsWith(prefix) || !/^idf\d+\.\d+_py\d+\.\d+_env$/.test(basename(root))) return;
    ordinaryText(root, join(root, 'pyvenv.cfg'), 65536);
    const python = join(root, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    // Unix venv interpreters normally link to the base Python. Preserve the venv
    // launch path instead of resolving it into the global interpreter.
    if (!statSync(python).isFile()) return;
    return { directory: root, python };
  } catch { return undefined; }
}
function envValue(environment: NodeJS.ProcessEnv, key: string, platform: string): string | undefined {
  return environment[key] ?? (platform === 'win32' ? Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : undefined);
}

/** Recognize only the existing ESP-IDF CLI, never arbitrary Python scripts. */
export function espIdfCommand(command: readonly string[] | string): boolean {
  const executable = typeof command === 'string' ? command : command[0];
  return typeof executable === 'string' && executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() === 'idf.py';
}

/** Discover already installed, explicitly selected tools; execute/install nothing. */
export function espIdfToolchain(inherited: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): EspIdfToolchain | undefined {
  try {
    const selectedTools = envValue(inherited, 'IDF_TOOLS_PATH', platform);
    if (!selectedTools || !isAbsolute(selectedTools)) return;
    const tools = directory(selectedTools); if (!tools) return;
    const explicitSdk = envValue(inherited, 'IDF_PATH', platform);
    let sdk = explicitSdk && isAbsolute(explicitSdk) ? readSdk(explicitSdk) : undefined;
    if (!sdk) {
      const frameworks = directory(join(tools, 'frameworks'));
      if (!frameworks || !within(tools, frameworks)) return;
      const entries = readdirSync(frameworks, { withFileTypes: true });
      if (entries.length > 64) return;
      const candidates = new Map<string, Sdk>();
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const candidate = readSdk(join(frameworks, entry.name));
        if (candidate && within(frameworks, candidate.path)) candidates.set(platform === 'win32' ? candidate.path.toLowerCase() : candidate.path, candidate);
      }
      if (candidates.size !== 1) return;
      sdk = [...candidates.values()][0]!;
    }
    const explicitPython = envValue(inherited, 'IDF_PYTHON_ENV_PATH', platform);
    let python = explicitPython && isAbsolute(explicitPython) ? pythonEnvironment(explicitPython, sdk.pythonPrefix, platform) : undefined;
    if (explicitPython && !python) return;
    if (!python) {
      const root = directory(join(tools, 'python_env')); if (!root || !within(tools, root)) return;
      const entries = readdirSync(root, { withFileTypes: true }); if (entries.length > 64) return;
      const candidates = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(sdk!.pythonPrefix))
        .map(entry => pythonEnvironment(join(root, entry.name), sdk!.pythonPrefix, platform))
        .filter((entry): entry is NonNullable<typeof entry> => !!entry && within(root, entry.directory));
      if (candidates.length !== 1) return;
      python = candidates[0]!;
    }
    const paths = [dirname(python.python), join(sdk.path, 'tools')];
    for (const tool of sdk.exports) {
      const installed = join(tools, 'tools', tool.name, tool.version);
      if (!existsSync(installed)) continue; // Optional/unselected target tools need not be installed.
      const actual = directory(installed); if (!actual || !within(tools, actual)) return;
      for (const parts of tool.paths) {
        const target = directory(join(actual, ...parts));
        if (!target || !within(actual, target)) return;
        paths.push(target);
      }
    }
    const unique = [...new Map(paths.map(path => [platform === 'win32' ? path.toLowerCase() : path, path])).values()];
    const separator = platform === 'win32' ? ';' : ':';
    const previousPath = envValue(inherited, 'PATH', platform);
    return { sdk: sdk.path, tools, python: python.python, version: sdk.version,
      env: { IDF_PATH: sdk.path, IDF_TOOLS_PATH: tools, IDF_PYTHON_ENV_PATH: python.directory,
        PATH: [...unique, ...(previousPath ? [previousPath] : [])].join(separator) } };
  } catch { return undefined; }
}
