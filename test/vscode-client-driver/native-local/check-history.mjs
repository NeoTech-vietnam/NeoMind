// Verify migration against the actual owned desktop fixture, without rewriting
// historical records or treating configured profiles as execution evidence.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const base = realpathSync.native(join(repository, 'artifacts/workforce-native-local-proof'));
const extension = realpathSync.native(resolve(process.argv[2] ?? ''));
const child = relative(base, extension);
if (!/^[a-f0-9]{8}[\\/]extension$/.test(child) || isAbsolute(child)) throw new Error('Select an owned native proof fixture.');
const fixture = JSON.parse(readFileSync(join(extension, 'fixture.json'), 'utf8'));
const identity = path => { const value = realpathSync.native(path); return process.platform === 'win32' ? value.toLowerCase() : value; };
if (identity(fixture.workspace) !== identity(join(extension, '../workspace')) || identity(fixture.evidence) !== identity(join(extension, '../evidence')))
  throw new Error('Fixture workspace/evidence ownership does not match.');
const mode = process.argv[3], name = process.argv[4];
if (!['snapshot', 'verify'].includes(mode) || !/^[a-z0-9-]+\.json$/.test(name ?? '')) throw new Error('Use snapshot|verify and an evidence JSON filename.');
const baselinePath = join(fixture.evidence, name);
async function digest(path) {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error('Historical evidence must be an ordinary file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function paths(directory) {
  if (!existsSync(directory)) return [];
  const state = lstatSync(directory);
  if (state.isSymbolicLink()) throw new Error('A history directory cannot be a symbolic link.');
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('History traversal cannot follow a symbolic link.');
    return entry.isDirectory() ? paths(path) : [path];
  });
}
if (mode === 'snapshot') {
  const files = {};
  for (const path of paths(join(fixture.workspace, '.workforce/requests')).sort()) {
    if (Object.keys(files).length >= 20000) throw new Error('History snapshot exceeds the bounded fixture inventory.');
    files[relative(fixture.workspace, path).replaceAll('\\', '/')] = await digest(path);
  }
  if (!Object.keys(files).length) throw new Error('No actual saved request history was found.');
  writeFileSync(baselinePath, JSON.stringify({ at: new Date().toISOString(), workspace: fixture.workspace, files }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ baseline: name, saved_files: Object.keys(files).length }));
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (identity(baseline.workspace) !== identity(fixture.workspace) || !baseline.files || !Object.keys(baseline.files).length)
    throw new Error('Select the baseline captured from this actual fixture.');
  const changed = [];
  for (const [path, expected] of Object.entries(baseline.files)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || !path.startsWith('.workforce/requests/') || path.split('/').includes('..'))
      throw new Error('Invalid historical snapshot entry.');
    try { if (await digest(join(fixture.workspace, path)) !== expected) changed.push(path); }
    catch { changed.push(path); }
  }
  console.log(JSON.stringify({ baseline: name, checked_files: Object.keys(baseline.files).length, changed }));
  if (changed.length) process.exitCode = 1;
}
