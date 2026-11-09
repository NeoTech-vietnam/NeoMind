import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePath } from './storage.js';
import { existsSync, lstatSync, readdirSync } from 'node:fs';

/** Editor references are ordinary content. Resolve them once at the backend,
 * rather than requiring models to convert local paths into protocol syntax. */
export function normalizeNativeProjectPaths(root: string, inputs: string[], allowRoot = false): string[] {
  const paths = new Map<string, string>();
  for (const input of inputs) {
    if (/[\x00-\x1f]/.test(input)) throw new Error('Project paths cannot contain control characters.');
    let value = input;
    if (/^file:/i.test(value)) {
      try { value = fileURLToPath(value); }
      catch { throw new Error('The project file reference is not a valid local file URI.'); }
    }
    const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value.replaceAll('\\', '/'));
    let path = relative(resolve(root), absolute).replaceAll('\\', '/');
    if (!path && allowRoot) path = '.';
    if (!path || isAbsolute(path) || path === '..' || path.startsWith('../')) throw new Error('Project file references must stay inside this workspace.');
    safePath(root, path);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (!paths.has(key)) paths.set(key, path);
  }
  return [...paths.values()];
}

/** Existing ordinary source inputs for revision/preservation baselines.
 * Enumerate the stated context; do not walk unrelated workspace directories. */
export function nativeContextFiles(root: string, context: string[], topLevel = false, excluded: string[] = []): string[] {
  const paths = new Set<string>();
  const directories = new Set<string>();
  const excludedKeys = new Set(excluded.map(path => process.platform === 'win32' ? path.toLowerCase() : path));
  function collect(path: string, explicit = false) {
    if (path.split('/').some(part => /^(?:\.git|\.workforce|\.neomind|\.taskforces|\.verythinker)$/i.test(part))) return;
    if (!explicit && /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path.split('/').at(-1)!)) return;
    if (excludedKeys.has(process.platform === 'win32' ? path.toLowerCase() : path)) return;
    const file = safePath(root, path);
    if (!existsSync(file)) return;
    const info = lstatSync(file);
    if (info.isSymbolicLink()) return;
    if (info.isFile() && info.nlink === 1 && info.size <= 20 * 1024 * 1024) paths.add(path);
    else if (info.isDirectory()) {
      if (!explicit && /^(?:node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|coverage|build|dist|out|\.next)$/i.test(path.split('/').at(-1)!)) return;
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (directories.has(key)) return;
      directories.add(key);
      for (const item of readdirSync(file, { withFileTypes: true })) collect(path === '.' ? item.name : `${path}/${item.name}`);
    }
  }
  if (topLevel) for (const item of readdirSync(root, { withFileTypes: true })) if (item.isFile()) collect(item.name);
  for (const path of context) collect(path, true);
  return [...paths].sort();
}
