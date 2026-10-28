import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { secureHostPrivateDirectory } from './vscode-wire.js';
import { controlledPublicReferencePath } from './controlled-tools.js';

export interface WorkForceCodeGraphProjection {
  root: string; source_root: string; baseline: string; scopes: string[];
  files: { path: string; sha256: string }[];
}
export type CodeGraphProjectionResult = { available: true; projection: WorkForceCodeGraphProjection } |
  { available: false; reason: string; next_action: string };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const extensions = new Set('.c .h .cc .cpp .cxx .hpp .hxx .hh .m .mm .js .jsx .mjs .cjs .ts .tsx .mts .cts .py .pyi .java .cs .go .rs .rb .php .swift .kt .kts .scala .sh .bash .zsh .sql .lua .r .vue .svelte .html .css .scss .sass .less .json .jsonc .yaml .yml .toml .xml .md .mdx .txt .cmake .mk .sv .svh .v .vh'.split(' '));
const unavailable = (reason: string): CodeGraphProjectionResult => ({ available: false, reason,
  next_action: 'Continue with project_search, project_list and project_read inside the assigned scope. CodeGraph is optional and no unscoped connection was opened.' });
function privateBase(root: string): string {
  const identity = `${userInfo().username}\0${process.platform === 'win32' ? root.toLowerCase() : root}`;
  return join(dirname(root), '.workforce-private', digest(identity));
}
function canonical(value: string): string {
  if (value === '.') return value;
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)))
    throw new Error('CodeGraph needs canonical public project read scopes.');
  return value;
}
function publicPath(path: string): boolean {
  return controlledPublicReferencePath(path) && !path.split('/').some(part => ['.workforce-private', '.codegraph', '.opencode'].includes(part.toLowerCase()));
}
function samePath(left: string, right: string): boolean { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function within(path: string, root: string): boolean { const local = relative(root, path); return local === '' || !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`); }
interface Source { files: { path: string; sha256: string; bytes: Buffer }[]; baseline: string; scopes: string[] }
function capture(root: string, requested: string[]): Source {
  if (!Array.isArray(requested) || !requested.length || requested.length > 100) throw new Error('CodeGraph needs a bounded backend read scope.');
  const scopes = [...new Set(requested.map(canonical))].sort(), files = new Map<string, { path: string; sha256: string; bytes: Buffer }>();
  let entries = 0, bytes = 0;
  const walk = (path: string, explicit = false, depth = 0): void => {
    if (++entries > 8192 || depth > 32) throw new Error('The public source tree exceeds CodeGraph projection bounds.');
    try { canonical(path); } catch (error) { if (explicit) throw error; return; }
    if (!publicPath(path)) { if (explicit) throw new Error('Private paths cannot enter a CodeGraph source projection.'); return; }
    const absolute = path === '.' ? root : join(root, ...path.split('/'));
    if (!within(absolute, root)) throw new Error('CodeGraph source scope escapes its project.');
    if (!existsSync(absolute)) return;
    // Inspect all selected ancestors; an exact file scope must not traverse a
    // junction/symlink or import a hard-linked external file.
    for (let current = absolute; !samePath(current, root); current = dirname(current))
      if (lstatSync(current).isSymbolicLink()) { if (explicit) throw new Error('CodeGraph sources cannot follow links.'); return; }
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) { if (explicit) throw new Error('CodeGraph sources cannot follow links.'); return; }
    if (info.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) walk(path === '.' ? entry : `${path}/${entry}`, false, depth + 1);
      return;
    }
    if (!info.isFile() || info.nlink !== 1) { if (explicit) throw new Error('CodeGraph sources must be ordinary unlinked files.'); return; }
    // Copy source/document text supported by the index, never large binary
    // coursework/media/dependency artifacts simply because the scope is '.'.
    if (!extensions.has(extname(path).toLowerCase()) && !/(?:^|\/)(?:Makefile|CMakeLists\.txt|Dockerfile)$/i.test(path)) return;
    if (files.has(path)) return;
    if (info.size > 8 * 1024 * 1024 || files.size >= 512 || bytes + info.size > 32 * 1024 * 1024) throw new Error('Public CodeGraph source bytes exceed projection bounds.');
    const content = readFileSync(absolute);
    if (content.includes(0)) return;
    // Recheck the opened source identity rather than accepting a moved link or
    // a changed file while capturing a supposedly fresh projection.
    const after = lstatSync(absolute);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.ino !== info.ino || after.size !== content.length)
      throw new Error('A public CodeGraph source changed during capture.');
    bytes += content.length; files.set(path, { path, sha256: digest(content), bytes: content });
  };
  for (const scope of scopes) walk(scope, true);
  const selected = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (!selected.length) throw new Error('No ordinary supported public source files exist in this read scope.');
  return { files: selected, scopes, baseline: digest(JSON.stringify({ root, scopes, files: selected.map(({ path, sha256 }) => ({ path, sha256 })) })) };
}
function snapshotCurrent(projection: WorkForceCodeGraphProjection): boolean {
  try {
    const parent = join(privateBase(projection.source_root), 'codegraph');
    if (dirname(projection.root) !== parent || !/^[a-f0-9-]{36}$/.test(relative(parent, projection.root))) return false;
    for (const path of [dirname(parent), parent, projection.root]) if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return false;
    return projection.files.every(file => {
      const absolute = join(projection.root, ...file.path.split('/'));
      for (let current = absolute; current !== projection.root; current = dirname(current)) if (lstatSync(current).isSymbolicLink()) return false;
      const info = lstatSync(absolute);
      return info.isFile() && info.nlink === 1 && digest(readFileSync(absolute)) === file.sha256;
    });
  } catch { return false; }
}
/** Freshness is checked from current authoritative public source bytes. */
export function workForceCodeGraphProjectionCurrent(projection: WorkForceCodeGraphProjection): boolean {
  try { return capture(projection.source_root, projection.scopes).baseline === projection.baseline && snapshotCurrent(projection); }
  catch { return false; }
}
/** Creates a source projection, not an OS filesystem or network sandbox for a provider. */
export function prepareWorkForceCodeGraphProjection(root: string, scopes: string[], previous?: WorkForceCodeGraphProjection): CodeGraphProjectionResult {
  let projection: WorkForceCodeGraphProjection | undefined;
  try {
    root = realpathSync.native(resolve(root));
    const source = capture(root, scopes);
    if (previous && previous.source_root === root && previous.baseline === source.baseline && snapshotCurrent(previous)) return { available: true, projection: previous };
    const base = privateBase(root), parent = join(base, 'codegraph');
    for (const path of [dirname(base), base, parent]) secureHostPrivateDirectory(path);
    const target = join(parent, randomUUID()); secureHostPrivateDirectory(target);
    projection = { root: target, source_root: root, baseline: source.baseline, scopes: source.scopes,
      files: source.files.map(({ path, sha256 }) => ({ path, sha256 })) };
    for (const file of source.files) {
      const destination = join(target, ...file.path.split('/')); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    if (!workForceCodeGraphProjectionCurrent(projection)) throw new Error('Public sources changed while CodeGraph was preparing its snapshot.');
    return { available: true, projection };
  } catch (error) {
    if (projection) closeWorkForceCodeGraphProjection(projection);
    return unavailable(error instanceof Error ? error.message : 'The bounded public CodeGraph projection is unavailable.');
  }
}
export function closeWorkForceCodeGraphProjection(projection: WorkForceCodeGraphProjection): void {
  const parent = join(privateBase(projection.source_root), 'codegraph');
  if (dirname(projection.root) !== parent || !/^[a-f0-9-]{36}$/.test(relative(parent, projection.root))) throw new Error('Invalid CodeGraph projection cleanup target.');
  rmSync(projection.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
/** Only the conformed direct-server suffix is supported; never leave a second
 * original project-root argument or silently connect an unsupported launcher. */
export function codeGraphProjectionServer<T extends { command: string; args: string[] }>(root: string, server: T, projection: WorkForceCodeGraphProjection): T | undefined {
  const args = server.args;
  if (!isAbsolute(server.command) || !Array.isArray(args) || args.length < 4 || args.some(value => typeof value !== 'string') ||
      args.filter(value => value === '--path').length !== 1 || args.at(-4) !== 'serve' || args.at(-3) !== '--mcp' || args.at(-2) !== '--path') return undefined;
  try { if (realpathSync.native(args.at(-1)!) !== realpathSync.native(root)) return undefined; } catch { return undefined; }
  return { ...server, args: [...args.slice(0, -1), projection.root] };
}
/** Exact captured-file mappings provide display provenance. The source scope is
 * enforced by the projection, never by treating string replacement as redaction. */
export function mapWorkForceCodeGraphResult(projection: WorkForceCodeGraphProjection, value: unknown): unknown {
  const replace = (text: string): string => {
    for (const file of projection.files) {
      const absolute = join(projection.root, ...file.path.split('/'));
      for (const spelling of [...new Set([absolute, absolute.replaceAll('\\', '/'), pathToFileURL(absolute).href])].sort((a, b) => b.length - a.length)) text = text.split(spelling).join(file.path);
    }
    for (const spelling of [...new Set([projection.root, projection.root.replaceAll('\\', '/'), pathToFileURL(projection.root).href])].sort((a, b) => b.length - a.length)) text = text.split(spelling).join('<project source snapshot>');
    return text;
  };
  const visit = (item: unknown): unknown => typeof item === 'string' ? replace(item) : Array.isArray(item) ? item.map(visit) :
    item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)])) : item;
  return { result: visit(value), source_projection: { baseline: projection.baseline, files: projection.files.slice(0, 64), total_files: projection.files.length, scope: projection.scopes,
    limitation: 'CodeGraph receives a public source snapshot. The plug-in process is not an OS sandbox.' } };
}
