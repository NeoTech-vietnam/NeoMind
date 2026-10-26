import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CONTROLLED_PAYLOAD_MAX_BYTES = 1024 * 1024;
export class ControlledPayloadError extends Error {
  constructor(public readonly code: 'INVALID_PAYLOAD' | 'INVALID_PATH' | 'PRIVATE_PATH' | 'SCOPE_DENIED' | 'INVALID_FILE' | 'STALE_READ', message: string) {
    super(message);
    this.name = 'ControlledPayloadError';
  }
}
export interface ControlledPayloadSource { path: string; sha256: string; size_bytes: number }
export interface ControlledPayloadOptions<T> {
  /** The same authoritative readable-scope check used by the session's project_read. */
  sourceAllowed(path: string): boolean;
  /** A missing previous observation is undefined; a previously missing file is null. */
  readHash?(path: string): string | null | undefined;
  /** Record only a successfully validated read in the backend-owned journal. */
  recordRead?(path: string, sha256: string): void;
  parse(input: Record<string, unknown>): T;
}

type JsonSchema = boolean | Record<string, unknown>;
const schemaObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Input presence/constraints win at every depth. Output fills type information
 * only where a preprocessor makes its input schema opaque. */
function payloadAdvertisement(input: unknown, output: unknown): JsonSchema {
  if (input === false) return false;
  if (input === true) return true;
  if (!schemaObject(input)) return schemaObject(output) ? payloadAdvertisement({}, output) : output === false ? false : {};
  if (!schemaObject(output)) return structuredClone(input);
  const represented = ['type', '$ref', 'anyOf', 'oneOf', 'allOf', 'properties', 'items', 'enum', 'const'].some(key => Object.hasOwn(input, key));
  const merged: Record<string, unknown> = structuredClone(represented ? input : { ...output, ...input });
  for (const name of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
    const incoming = schemaObject(input[name]) ? input[name] : undefined;
    const outgoing = schemaObject(output[name]) ? output[name] : undefined;
    if (!incoming && !outgoing) continue;
    const keys = name === 'definitions' || name === '$defs' ? [...new Set([...Object.keys(incoming ?? {}), ...Object.keys(outgoing ?? {})])]
      : Object.keys(incoming ?? outgoing!);
    merged[name] = Object.fromEntries(keys.map(key => [key, payloadAdvertisement(incoming?.[key], outgoing?.[key])]));
  }
  if (schemaObject(input.properties)) {
    // Output marks defaulted properties as present. The input contract decides
    // which fields the caller must actually provide, including nested objects.
    if (Object.hasOwn(input, 'required')) merged.required = structuredClone(input.required);
    else delete merged.required;
  } else if (!represented && schemaObject(output.properties) && Array.isArray(output.required)) {
    const required = output.required.filter(name => typeof name === 'string' &&
      !(schemaObject(output.properties) && schemaObject(output.properties[name]) && Object.hasOwn(output.properties[name], 'default')));
    if (required.length) merged.required = required;
    else delete merged.required;
  }
  for (const name of ['items', 'additionalItems', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) {
    const incoming = input[name], outgoing = output[name];
    if (incoming === undefined && (represented || outgoing === undefined)) continue;
    if (Array.isArray(incoming) || Array.isArray(outgoing)) {
      const values = Array.isArray(incoming) ? incoming : outgoing as unknown[];
      merged[name] = values.map((value, index) => payloadAdvertisement(Array.isArray(incoming) ? value : undefined,
        Array.isArray(outgoing) ? outgoing[index] : undefined));
    } else merged[name] = payloadAdvertisement(incoming, outgoing);
  }
  for (const name of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const incoming = Array.isArray(input[name]) ? input[name] : undefined;
    const outgoing = Array.isArray(output[name]) ? output[name] : undefined;
    if (!incoming && (represented || !outgoing)) continue;
    merged[name] = (incoming ?? outgoing!).map((value, index) => payloadAdvertisement(incoming ? value : undefined, outgoing?.[index]));
  }
  return merged;
}

/** Actual root object for the MCP SDK: legacy semantic fields OR a prepared-file path, never an SDK-incompatible root union. */
export function controlledPayloadSchema<T extends z.ZodRawShape>(semantic: z.ZodObject<T>) {
  if ('input_path' in semantic.shape) throw new Error('Semantic schemas cannot reserve input_path.');
  const semanticInput = z.toJSONSchema(semantic, { io: 'input', target: 'draft-7' });
  const semanticOutput = z.toJSONSchema(semantic, { io: 'output', target: 'draft-7' });
  const advertisement = payloadAdvertisement(semanticInput, semanticOutput) as Record<string, unknown>;
  const optional = Object.fromEntries(Object.entries(semantic.shape).map(([name, field]) =>
    // A direct .optional() around a default still inserts that default in Zod 4.
    // Identity preprocess keeps absent fields absent in the prepared-file arm.
    [name, z.preprocess(value => value, field).optional()]));
  const inputPath = z.string().min(1).max(1024)
    .describe('Existing readable project-relative JSON file containing the complete semantic request. The backend parses the file directly; supply only input_path when reusing prepared data. Do not copy JSON-escaped tool text or add override fields.').optional();
  const { $schema: _schema, ...sourceProperty } = z.toJSONSchema(inputPath, { io: 'input', target: 'draft-7' });
  const fields = Object.keys(semantic.shape);
  return z.strictObject({ ...optional, input_path: inputPath })
    .superRefine((value, context) => {
      if (Object.hasOwn(value, 'input_path')) {
        if (Object.keys(value).some(name => name !== 'input_path'))
          context.addIssue({ code: 'custom', message: 'Use input_path alone or the complete semantic fields; prepared data cannot be merged with model overrides.' });
        return;
      }
      const parsed = semantic.safeParse(value);
      if (!parsed.success) for (const issue of parsed.error.issues)
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }).meta({
      // The MCP SDK converts preprocessors with io=input. Advertise the typed
      // semantic values rather than erasing every field to an unknown schema.
      properties: { ...(advertisement.properties as Record<string, unknown>), input_path: sourceProperty },
      ...(advertisement.definitions ? { definitions: advertisement.definitions } : {}),
      anyOf: [
        { required: ['input_path'], ...(fields.length ? { not: { anyOf: fields.map(name => ({ required: [name] })) } } : {}) },
        { required: semanticInput.required ?? [], not: { required: ['input_path'] } },
      ],
    });
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function assertPayloadPath(path: string): void {
  if (typeof path !== 'string' || !path || path.length > 1024 || !/\.json$/i.test(path) || path.startsWith('/') || /[\\:*?\x00-\x1f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new ControlledPayloadError('INVALID_PATH', 'input_path must name a canonical project-relative JSON file with forward slashes.');
  if (path.toLowerCase().split('/').some(part =>
    ['.git', '.neomind', '.verythinker', '.taskforces', '.codex', '.claude', '.vscode', '.agents', '.cursor', 'node_modules'].includes(part) ||
    /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|pfx|p12))$/.test(part)))
    throw new ControlledPayloadError('PRIVATE_PATH', 'Prepared payloads cannot read private runtime, client, credential or dependency files.');
}
function payloadPath(root: string, path: string): string {
  assertPayloadPath(path);
  let current = resolve(root);
  for (const component of path.split('/')) {
    current = resolve(current, component);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new ControlledPayloadError('INVALID_FILE', 'Prepared payloads cannot follow linked files or directories.');
    } catch (error) {
      if (error instanceof ControlledPayloadError) throw error;
      throw new ControlledPayloadError('INVALID_FILE', 'input_path must name an existing ordinary JSON file.');
    }
  }
  return current;
}

/** Bounded descriptor read; reject links and replacement while reading rather than trusting a prior pathname stat. */
function sourceBytes(root: string, path: string): Buffer {
  const target = payloadPath(root, path);
  let descriptor: number | undefined;
  try {
    const named = lstatSync(target);
    if (!named.isFile() || named.nlink !== 1 || named.size > CONTROLLED_PAYLOAD_MAX_BYTES)
      throw new ControlledPayloadError('INVALID_FILE', 'Prepared payloads require an ordinary unlinked JSON file up to 1 MiB.');
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > CONTROLLED_PAYLOAD_MAX_BYTES || opened.dev !== named.dev || opened.ino !== named.ino)
      throw new ControlledPayloadError('INVALID_FILE', 'Prepared payload file identity changed while opening it.');
    const buffer = Buffer.alloc(CONTROLLED_PAYLOAD_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const final = fstatSync(descriptor), current = lstatSync(target);
    if (length > CONTROLLED_PAYLOAD_MAX_BYTES || final.size !== length || final.nlink !== 1 || current.isSymbolicLink() || current.nlink !== 1 ||
        final.dev !== current.dev || final.ino !== current.ino || final.size !== current.size || opened.mtimeMs !== final.mtimeMs || opened.ctimeMs !== final.ctimeMs)
      throw new ControlledPayloadError('STALE_READ', 'Prepared payload changed while being read. Read the current source and retry; no operation was submitted.');
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof ControlledPayloadError) throw error;
    throw new ControlledPayloadError('INVALID_FILE', 'input_path could not be read as an ordinary unlinked JSON file.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Recheck the exact source immediately before the caller performs a durable side effect. */
export function assertControlledPayloadCurrent(root: string, source: ControlledPayloadSource): void {
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isInteger(source.size_bytes) || source.size_bytes < 0 ||
      source.size_bytes > CONTROLLED_PAYLOAD_MAX_BYTES)
    throw new ControlledPayloadError('INVALID_PAYLOAD', 'The backend payload observation is invalid.');
  const bytes = sourceBytes(root, source.path);
  if (bytes.length !== source.size_bytes || digest(bytes) !== source.sha256)
    throw new ControlledPayloadError('STALE_READ', 'Prepared payload changed after it was validated. Read the current source and retry; no operation was submitted.');
}

/** One semantic object OR one readable prepared JSON source. JSON is parsed exactly once; string contents are never unescaped heuristically. */
export function resolveControlledPayload<T>(root: string, request: { input?: unknown; input_path?: string }, options: ControlledPayloadOptions<T>):
  { input: T; source?: ControlledPayloadSource } {
  if (!object(request) || Object.keys(request).some(key => key !== 'input' && key !== 'input_path'))
    throw new ControlledPayloadError('INVALID_PAYLOAD', 'Use exactly one semantic input object or input_path, without envelope overrides.');
  const direct = Object.hasOwn(request, 'input'), file = Object.hasOwn(request, 'input_path');
  if (direct === file)
    throw new ControlledPayloadError('INVALID_PAYLOAD', 'Use exactly one semantic input object or input_path; do not merge a prepared file with model overrides.');
  let value: unknown, source: ControlledPayloadSource | undefined;
  if (file) {
    const path = request.input_path;
    if (typeof path !== 'string') throw new ControlledPayloadError('INVALID_PATH', 'input_path must be a project-relative JSON file path.');
    // Enforce syntax/privacy before the policy callback, without probing private filesystem entries.
    assertPayloadPath(path);
    if (!options.sourceAllowed(path)) throw new ControlledPayloadError('SCOPE_DENIED', 'input_path is outside this session\'s assigned readable files.');
    const bytes = sourceBytes(root, path), sha256 = digest(bytes), previous = options.readHash?.(path);
    if (previous !== undefined && previous !== sha256)
      throw new ControlledPayloadError('STALE_READ', 'Prepared payload differs from the session\'s saved read. Read the current source and retry; no operation was submitted.');
    source = { path, sha256, size_bytes: bytes.length };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('binary');
      value = JSON.parse(text);
    } catch { throw new ControlledPayloadError('INVALID_PAYLOAD', 'input_path must contain valid UTF-8 JSON object content, not serialized JSON text or binary data.'); }
  } else {
    value = request.input;
    try {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > CONTROLLED_PAYLOAD_MAX_BYTES)
        throw new Error('too large');
    } catch { throw new ControlledPayloadError('INVALID_PAYLOAD', 'Semantic input must be JSON object content up to 1 MiB.'); }
  }
  if (!object(value))
    throw new ControlledPayloadError('INVALID_PAYLOAD', 'Semantic input must be a JSON object, not an array, scalar or serialized JSON string.');
  const input = options.parse(structuredClone(value));
  if (source) {
    assertControlledPayloadCurrent(root, source);
    options.recordRead?.(source.path, source.sha256);
  }
  return { input, ...(source ? { source } : {}) };
}
