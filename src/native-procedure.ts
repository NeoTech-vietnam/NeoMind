/** Host-only adapter over the existing qualified procedure runner. A retrieved
 * text match never grants execution authority, and scripts are not a sandbox. */
import { dirname } from 'node:path';
import { prepareNativeWork } from './native-work.js';
import { resolveProcedure, runProcedure, validateProcedureParameters } from './procedures.js';

export interface NativeProcedureOutcome {
  status: 'succeeded' | 'failed' | 'uncertain' | 'skipped';
  procedure: { id: string; version: string; contract_hash: string; script_sha256: string };
  run_id?: string;
  parameters_sha256?: string;
  output_paths?: string[];
}

/** All identity/effects arguments come from the saved backend plan. */
export async function executePreparedNativeProcedure(root: string, input: {
  request_ref: string; requirement: string; task_family?: string;
  parameters: Record<string, string | number | boolean>; outputs: string[];
  procedure: NativeProcedureOutcome['procedure'];
}, options: { signal?: AbortSignal } = {}): Promise<NativeProcedureOutcome> {
  const skipped: NativeProcedureOutcome = { status: 'skipped', procedure: input.procedure };
  try {
    const current = prepareNativeWork(root, { requirement: input.requirement, task_family: input.task_family,
      parameters: input.parameters, outputs: input.outputs });
    if (!['qualified-procedure', 'adapt'].includes(current.strategy) || !('procedure' in current) ||
        JSON.stringify(current.procedure) !== JSON.stringify(input.procedure)) return skipped;
    const manifest = resolveProcedure(root, input.procedure.id, input.procedure.version);
    const parameters = validateProcedureParameters(root, manifest, current.parameters);
    const outputs = manifest.outputs.map(output => output.path.replace(/\{([a-z][a-z0-9_]*)\}/g, (_token, key: string) => String(parameters[key])));
    const selectedOutputs = current.strategy === 'adapt' && 'procedure_outputs' in current ? current.procedure_outputs : input.outputs;
    if (!selectedOutputs || outputs.length !== selectedOutputs.length || outputs.some(path => !selectedOutputs.includes(path) || !input.outputs.includes(path))) return skipped;
    const write_roots = [...new Set(input.outputs.map(path => dirname(path).replaceAll('\\', '/') === '.' ? path : dirname(path).replaceAll('\\', '/')))];
    const run = await runProcedure(root, { procedure_id: manifest.id, version: manifest.version,
      parameters, request_id: input.request_ref, actor: 'workforce-native-host', client: 'copilot', mode: 'automatic',
      observation: 'local-process', workflow_mode: 'vscode-native', assurance: 'observed-native-local',
      authorized_effects: { write_roots, network: false, publication: false } },
    { signal: options.signal ?? new AbortController().signal });
    return { status: run.status === 'succeeded' ? 'succeeded' : run.status === 'failed' ? 'failed' : 'uncertain',
      procedure: input.procedure, run_id: run.id, parameters_sha256: run.parameters_hash,
      output_paths: run.outputs?.map(output => output.path) };
  } catch {
    // A lost result-write can follow a real process effect. Keep uncertainty;
    // ordinary implementation must inspect retained artifacts, never replay it.
    return { ...skipped, status: 'uncertain' };
  }
}
