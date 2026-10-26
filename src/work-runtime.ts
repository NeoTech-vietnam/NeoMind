import { prepareWork, type WorkPrepareInput } from './procedure-reuse.js';
import { runProcedure, type ProcedureEffects } from './procedures.js';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite, hash, safePath, withOperationLock } from './storage.js';
import type { WorkPreparation } from './procedure-reuse.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/** Explicit local mechanical work. This never closes or downgrades an engineering workflow. */
export async function runPreparedWork(root: string, input: WorkPrepareInput & {
  actor: string; authorized_effects: ProcedureEffects;
}) {
  const { actor, authorized_effects, ...request } = input;
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('An execution actor is required.');
  if (!authorized_effects) throw new Error('Explicit authorized_effects are required before procedure execution.');
  if (!request.intent_id && !request.procedure_id)
    throw new Error('Automatic execution requires an explicit Coordinator-selected intent_id or procedure_id and its typed parameters. Text retrieval alone is advisory.');
  const payloadHash = hash(canonical(input));
  const requestPath = request.request_id ? safePath(root, `.neomind/procedure-requests/${hash(request.request_id)}.json`) : undefined;
  let preparation: WorkPreparation;
  if (requestPath && existsSync(requestPath)) {
    const stored = JSON.parse(readFileSync(requestPath, 'utf8')) as { payload_hash: string; preparation: WorkPreparation };
    if (stored.payload_hash !== payloadHash) throw new Error('Work request ID already belongs to a different request or payload. Use a fresh request ID for new intent.');
    preparation = stored.preparation;
  } else preparation = prepareWork(root, { ...request, scope: {
    ...request.scope, allowed_paths: authorized_effects.write_roots,
    network: authorized_effects.network, publication: authorized_effects.publication,
  } });
  const client = request.environment?.client ?? 'cli';
  if (client !== 'cli' && client !== 'codex' && client !== 'copilot') throw new Error('Unsupported procedure client.');
  const path = requestPath ?? safePath(root, `.neomind/procedure-requests/${hash(preparation.request_id)}.json`);
  preparation = withOperationLock(root, `work-request-${hash(preparation.request_id)}`, () => {
    if (existsSync(path)) {
      const current = JSON.parse(readFileSync(path, 'utf8')) as { payload_hash: string; preparation: WorkPreparation };
      if (current.payload_hash !== payloadHash) throw new Error('Work request payload changed during preparation.');
      return current.preparation;
    }
    if (preparation.decision === 'exact' && preparation.selected_procedure)
      atomicWrite(path, JSON.stringify({ schema_version: 1, payload_hash: payloadHash, preparation }, null, 2) + '\n');
    return preparation;
  });
  if (preparation.decision !== 'exact' || !preparation.selected_procedure)
    return { status: 'needs-specialist' as const, preparation, executed: false as const };
  const selected = preparation.selected_procedure;
  const run = await runProcedure(root, {
    procedure_id: selected.id, version: selected.version, parameters: preparation.parameters,
    request_id: preparation.request_id, actor, client,
    mode: 'automatic', authorized_effects, workflow_mode: request.scope?.mode,
    assurance: request.scope?.assurance, tool_versions: request.environment?.tools,
  });
  return { status: run.status, preparation, executed: !run.replayed, replayed: Boolean(run.replayed), run,
    assurance: 'Unsigned local script execution with current checks; no engineering workflow acceptance or native-agent attestation.' };
}
