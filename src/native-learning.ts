/** Optional learning after verified delivery. Manifest metadata never authorizes
 * execution; the existing registry retains its review and qualification rules. */
import { lstatSync, readFileSync } from 'node:fs';
import { normalizeNativeProjectPaths } from './native-project-paths.js';
import { registerProcedure, registerProcedureSchema } from './procedures.js';
import { hash, safePath } from './storage.js';

const definitionSchema = registerProcedureSchema.omit({ id: true, version: true, author: true });
type ProcedureReference = { id: string; version: string; contract_hash: string; script_sha256: string };
export interface NativeLearningResult { candidates: ProcedureReference[]; issues: string[] }

/** The caller supplies current accepted outputs and actual independent inspected
 * fingerprints. Only explicitly delivered *.procedure.json files are considered;
 * this is not a workspace scan or a model-facing registration/authentication tool. */
export function captureNativeTools(root: string, input: {
  outputs: string[]; inspected: Record<string, string | null>;
}): NativeLearningResult {
  const result: NativeLearningResult = { candidates: [], issues: [] };
  for (const path of input.outputs.filter(path => path.endsWith('.procedure.json'))) {
    try {
      normalizeNativeProjectPaths(root, [path]);
      const info = lstatSync(safePath(root, path));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
      const manifest = readFileSync(safePath(root, path));
      if (manifest.length > 1024 * 1024 || input.inspected[path] !== hash(manifest)) throw new Error();
      // Registration identity belongs to the backend, including on manifests
      // copied from an older script. Future output templates remain unchanged.
      const { id: _id, version: _version, author: _author, ...professional } = JSON.parse(manifest.toString('utf8'));
      // A generator may legitimately support an older Node. The procedure host
      // still runs on WorkForce's minimum; tighten that environment requirement
      // mechanically instead of asking a model to rewrite working scripts.
      const minimum = professional.environment?.node_major_min;
      if (Number.isInteger(minimum) && minimum > 0 && minimum < 24)
        professional.environment = { ...professional.environment, node_major_min: 24 };
      const definition = definitionSchema.parse(professional);
      const paths = [path, definition.script, definition.verification_script, ...definition.dependencies];
      const normalized = normalizeNativeProjectPaths(root, paths);
      if (paths.length !== normalized.length || paths.some((path, index) => path !== normalized[index])) throw new Error();
      const fingerprints = Object.fromEntries(paths.map(path => {
        const current = hash(readFileSync(safePath(root, path)));
        if (input.inspected[path] !== current) throw new Error();
        return [path, current];
      }));
      const identity = hash(JSON.stringify({ definition, fingerprints }));
      const candidate = registerProcedure(root, { ...definition, id: `native-${identity.slice(0, 24)}`, version: '1.0.0',
        author: 'workforce-native-implementation' });
      result.candidates.push({ id: candidate.id, version: candidate.version, contract_hash: candidate.contract_hash,
        script_sha256: candidate.script_sha256 });
    } catch {
      result.issues.push(`Optional tool candidate was not registered: ${path}. Its manifest and script inputs must be valid, unchanged and independently inspected. Verified product delivery is retained.`);
    }
  }
  return result;
}
