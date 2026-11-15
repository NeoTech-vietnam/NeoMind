import { realpathSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const code = path.dirname(fileURLToPath(import.meta.url));
const repo = realpathSync(path.resolve(code, '../../..'));
const contains = (parent, child) => child === parent || (!path.relative(parent, child).startsWith('..' + path.sep) && path.relative(parent, child) !== '..' && !path.isAbsolute(path.relative(parent, child)));

export function requireDataRoot(value = process.env.LIVE_GUARD_DATA) {
  if (!value || !path.isAbsolute(value)) throw Error('LIVE_GUARD_DATA must be an existing absolute directory');
  const root = realpathSync(value);
  if (!statSync(root).isDirectory() || contains(repo, root) || contains(root, repo)) throw Error('LIVE_GUARD_DATA must not overlap the checkout');
  for (const name of ['tmp', 'runs', 'live-attempts', 'runner-fixture']) {
    try {
      const entry = lstatSync(path.join(root, name));
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error(`unsafe experiment directory: ${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return root;
}
