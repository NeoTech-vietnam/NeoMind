import { readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
let text = ''; for await (const part of process.stdin) text += part;
const { parameters, outputs } = JSON.parse(text);
function local(path) {
  const root = process.cwd(), target = resolve(root, path), child = relative(root, target);
  if (typeof path !== 'string' || !child || isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) throw new Error('Project-relative artifact required.');
  let current = root;
  for (const part of child.split(/[\\/]/)) { current = resolve(current, part); try { if (lstatSync(current).isSymbolicLink()) throw new Error('Artifact links are unsupported.'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return target;
}
if (new Set([parameters.note, parameters.practice, parameters.answers]).size !== 3 || outputs[0] !== parameters.output) throw new Error('Separate learning artifacts and declared output required.');
const artifacts = ['note', 'practice', 'answers'].map(kind => {
  const bytes = readFileSync(local(parameters[kind]));
  if (!bytes.length) throw new Error('Learning artifact is empty.');
  return { kind, path: parameters[kind], ...(parameters.include_bytes ? { bytes: bytes.length } : {}), sha256: createHash('sha256').update(bytes).digest('hex') };
});
const output = local(parameters.output); mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ schema_version: 1, artifacts, assurance: 'Current artifact inventory; content correctness needs independent review.' }, null, 2) + '\n', { flag: 'wx' });
