import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { OpenCodeEndpoint } from './opencode-engine.js';

export interface OpenCodeProviderProgress {
  request_id: string;
  sequence: number;
  kind: 'text' | 'reasoning' | 'tool-arguments';
  bytes: number;
}
export interface OpenCodeProviderStreamOptions {
  signal?: AbortSignal;
  onProgress(progress: OpenCodeProviderProgress): void;
  onObservation?(observation: OpenCodeProviderStreamObservation): void;
  onFailure?(failure: OpenCodeProviderStreamFailure): void;
  /** Opt-in diagnostic metadata only; never argument text, values or unknown names. */
  onArgumentDiagnostic?(diagnostic: OpenCodeArgumentDiagnostic): void;
}
export interface OpenCodeArgumentDiagnostic {
  event: 'provider-argument-shape'; request_id: string; tool: string;
  argument_bytes: number; argument_sha256: string; fragments: number; max_fragment_bytes: number;
  duplicate_fragments: number; previous_prefix_fragments: number; near_previous_prefix_fragments: number; assembled_prefix_fragments: number;
  sample_characters: number; sample_truncated: boolean; sample_last_field: string;
  sample_value_kind: 'string' | 'number' | 'literal' | 'object' | 'array' | 'unknown';
  sample_known_fields: string[]; sample_unknown_keys: number;
  sample_longest_digit_run: number; sample_longest_same_character_run: number;
  sample_longest_string_run: number; sample_longest_number_run: number;
}
export interface OpenCodeProviderStreamFailure {
  code: 'OPENCODE_PROVIDER_ARGUMENT_LIMIT';
  message: string;
  request_id: string;
  argument_bytes: number;
  limit_bytes: number;
}
export interface OpenCodeProviderStreamObservation {
  event: 'provider-request-started' | 'provider-response-started' | 'provider-transport-ended';
  request_id: string;
  elapsed_ms: number;
  request_bytes: number;
  response_bytes: number;
  status_code?: number;
  semantic_events: number;
  semantic_bytes: number;
  last_semantic_ms?: number;
  completed?: boolean;
  aborted?: boolean;
}

const requestLimit = 4 * 1024 * 1024;
const frameLimit = 2 * 1024 * 1024;
// These read selectors have finite schemas, including worst-case JSON escaping:
// one path/title, two search strings, or three 2,048-character executable paths.
// Content tools retain the provider request ceiling for escaped/multi-edit data.
const readArgumentLimit = 8 * 1024;
const defaultArgumentLimit = requestLimit;
const argumentLimit = (name: string) => {
  const tool = name.startsWith('wf_') ? name.slice(3) : name;
  if (['project_read', 'project_read_more', 'assignment_read', 'project_list', 'check_evidence', 'check_evidence_more'].includes(tool)) return readArgumentLimit;
  if (tool === 'project_search') return 16 * 1024;
  if (tool === 'runtime_context') return 64 * 1024;
  return defaultArgumentLimit;
};
const argumentLimitMessage = 'A streamed tool call exceeded its bounded argument size before completion. The owned upstream stream was stopped; retain actual messages and effects.';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const diagnosticTools = new Set(['project_read', 'project_read_more', 'assignment_read', 'project_list', 'check_evidence',
  'check_evidence_more', 'project_search', 'runtime_context']);
const diagnosticFields = new Set(['path', 'title', 'kind', 'cursor', 'query', 'glob', 'limit', 'start_line', 'start_char',
  'max_chars', 'max_results', 'node', 'python', 'compiler']);

// This opt-in observer is deliberately not a JSON repairer or protocol parser.
// Its bounded in-memory sample is discarded after deriving fixed shape fields;
// no string value, unknown key, endpoint or caller credential can leave it.
function argumentDiagnostic() {
  const digest = createHash('sha256');
  let sample = '', sampleTruncated = false, fragments = 0, maxFragmentBytes = 0, previous = '', previousHash = '',
    duplicates = 0, previousPrefixes = 0, nearPreviousPrefixes = 0, assembledPrefixes = 0;
  return {
    add(value: string) {
      fragments++; maxFragmentBytes = Math.max(maxFragmentBytes, Buffer.byteLength(value)); digest.update(value);
      const fingerprint = createHash('sha256').update(value).digest('hex');
      if (previousHash && fingerprint === previousHash) duplicates++;
      if (previous && value.length > previous.length && value.startsWith(previous)) previousPrefixes++;
      if (previous.length >= 32 && value.length >= previous.length) {
        let common = 0;
        while (common < previous.length && previous[common] === value[common]) common++;
        if (common >= previous.length - 2 && common >= previous.length * 0.9) nearPreviousPrefixes++;
      }
      if (sample && !sampleTruncated && value.length >= sample.length && value.startsWith(sample)) assembledPrefixes++;
      previous = value.length <= 8192 ? value : ''; previousHash = fingerprint;
      const room = 8192 - sample.length;
      if (value.length > room) sampleTruncated = true;
      if (room > 0) sample += value.slice(0, room);
    },
    snapshot(requestId: string, tool: string, bytes: number): OpenCodeArgumentDiagnostic {
      let inString = false, escaped = false, keyString = false, key = '', pendingKey = 'other', lastField = 'none',
        valueKind: OpenCodeArgumentDiagnostic['sample_value_kind'] = 'unknown', expectingValue = false,
        lastStructural = '', stringRun = 0, numberRun = 0, digitRun = 0, sameRun = 0, previousCharacter = '',
        longestString = 0, longestNumber = 0, longestDigits = 0, longestSame = 0, unknownKeys = 0;
      const containers: string[] = [], fields = new Set<string>();
      for (const character of sample) {
        digitRun = /[0-9]/.test(character) ? digitRun + 1 : 0; longestDigits = Math.max(longestDigits, digitRun);
        sameRun = character === previousCharacter ? sameRun + 1 : 1; previousCharacter = character; longestSame = Math.max(longestSame, sameRun);
        if (inString) {
          if (escaped) { if (keyString && key.length <= 96) key += character; escaped = false; }
          else if (character === '\\') { if (keyString && key.length <= 96) key += character; escaped = true; }
          else if (character === '"') {
            inString = false; lastStructural = 'value';
            if (keyString) {
              let decoded: unknown;
              try { decoded = JSON.parse(`"${key}"`); } catch { /* Unknown malformed keys stay hidden. */ }
              pendingKey = typeof decoded === 'string' && diagnosticFields.has(decoded) ? decoded : 'other';
              if (pendingKey === 'other') unknownKeys++; else fields.add(pendingKey);
            }
          } else if (keyString && key.length <= 96) key += character;
          if (!keyString && inString) { stringRun++; longestString = Math.max(longestString, stringRun); }
          continue;
        }
        if (/\s/.test(character)) continue;
        if (character === '"') {
          inString = true; escaped = false; key = ''; stringRun = 0; numberRun = 0;
          keyString = containers.at(-1) === '{' && ['{', ','].includes(lastStructural);
          if (!keyString) { valueKind = 'string'; expectingValue = false; }
          continue;
        }
        if (character === ':') { lastField = pendingKey; expectingValue = true; valueKind = 'unknown'; numberRun = 0; }
        else if (character === '{' || character === '[') { containers.push(character); valueKind = character === '{' ? 'object' : 'array'; expectingValue = false; }
        else if (character === '}' || character === ']') { containers.pop(); expectingValue = false; numberRun = 0; }
        else if (character === ',') { expectingValue = false; numberRun = 0; }
        else if (expectingValue || valueKind === 'number') {
          if (/[0-9eE.+-]/.test(character)) { valueKind = 'number'; numberRun++; longestNumber = Math.max(longestNumber, numberRun); }
          else { valueKind = 'literal'; numberRun = 0; }
        }
        lastStructural = character;
      }
      return { event: 'provider-argument-shape', request_id: requestId, tool, argument_bytes: bytes,
        argument_sha256: digest.copy().digest('hex'), fragments, max_fragment_bytes: maxFragmentBytes,
        duplicate_fragments: duplicates, previous_prefix_fragments: previousPrefixes,
        near_previous_prefix_fragments: nearPreviousPrefixes, assembled_prefix_fragments: assembledPrefixes,
        sample_characters: sample.length, sample_truncated: sampleTruncated, sample_last_field: lastField, sample_value_kind: valueKind,
        sample_known_fields: [...fields].sort(), sample_unknown_keys: unknownKeys, sample_longest_digit_run: longestDigits,
        sample_longest_same_character_run: longestSame, sample_longest_string_run: longestString, sample_longest_number_run: longestNumber };
    },
  };
}

/** The pinned engine's ordinary processor does not publish tool-input deltas.
 * Observe semantic SSE at the owned provider boundary without changing the
 * model loop, healthy request/response bytes, tools or result authority. Neither
 * a tool name nor an SSE/network heartbeat constitutes model progress. Growing
 * arguments remain progress only within the bound of that individual call. */
export async function createOpenCodeProviderStream(endpoint: OpenCodeEndpoint, options: OpenCodeProviderStreamOptions): Promise<{
  endpoint: OpenCodeEndpoint;
  readonly failure?: OpenCodeProviderStreamFailure;
  close(): Promise<void>;
}> {
  options.signal?.throwIfAborted();
  const base = new URL(endpoint.baseURL);
  if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol) ||
      base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new Error('The owned model transport requires a configured supported endpoint.');
  const target = new URL(`${endpoint.baseURL.replace(/\/$/, '')}/chat/completions`);
  const token = randomBytes(32).toString('hex'), authorization = Buffer.from(`Bearer ${token}`);
  const active = new Set<AbortController>();
  let closed = false, closing: Promise<void> | undefined;
  let failure: OpenCodeProviderStreamFailure | undefined;
  const exceeded = (requestId: string, bytes: number, limit: number) => {
    if (failure) return;
    failure = { code: 'OPENCODE_PROVIDER_ARGUMENT_LIMIT', message: argumentLimitMessage,
      request_id: requestId, argument_bytes: bytes, limit_bytes: limit };
    try { options.onFailure?.({ ...failure }); }
    catch { /* An advisory callback cannot suppress the owned refusal. */ }
  };

  function observe(requestId: string, counted: (bytes: number) => void) {
    const decoder = new TextDecoder();
    let pending = '', sequence = 0, enabled = true;
    // Tool-call identities are scoped to an SSE response and choice. Argument
    // fragments without an established call cannot prove useful model progress.
    const calls = new Map<string, { id: boolean; name: boolean; toolName: string; bytes: number; limit: number;
      diagnosticTool?: string; diagnostic?: ReturnType<typeof argumentDiagnostic> }>();
    const semantic = (kind: OpenCodeProviderProgress['kind'], value: unknown) => {
      if (typeof value !== 'string' || !value.length) return;
      const bytes = Buffer.byteLength(value); counted(bytes);
      try { options.onProgress({ request_id: requestId, sequence: ++sequence, kind, bytes }); }
      catch { /* Diagnostics do not alter inference or authorize replay. */ }
    };
    const frame = (text: string) => {
      const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      if (!object(parsed) || !Array.isArray(parsed.choices)) return;
      for (const choice of parsed.choices) {
        if (!object(choice) || !Number.isInteger(choice.index) || Number(choice.index) < 0 || !object(choice.delta)) continue;
        const delta = choice.delta;
        semantic('text', delta.content);
        semantic('reasoning', delta.reasoning_content);
        semantic('reasoning', delta.reasoning);
        if (!Array.isArray(delta.tool_calls)) continue;
        for (const call of delta.tool_calls) {
          if (!object(call) || !Number.isInteger(call.index) || Number(call.index) < 0) continue;
          const key = `${choice.index}:${call.index}`;
          let current = calls.get(key);
          const hasId = typeof call.id === 'string' && call.id.length > 0;
          const hasName = object(call.function) && typeof call.function.name === 'string' && call.function.name.length > 0;
          const value = object(call.function) ? call.function.arguments : undefined;
          const bytes = typeof value === 'string' ? Buffer.byteLength(value) : 0;
          if (!current && (hasId || hasName || bytes) && calls.size < 4096) {
            current = { id: false, name: false, toolName: '', bytes: 0, limit: defaultArgumentLimit,
              ...(options.onArgumentDiagnostic && calls.size < 16 ? { diagnostic: argumentDiagnostic() } : {}) }; calls.set(key, current);
          }
          if (!current) continue;
          current.id ||= hasId; current.name ||= hasName;
          if (hasName && object(call.function)) {
            // Names may arrive in fragments. Once a narrow identity is known,
            // repeating or changing its name cannot enlarge its remaining bound.
            current.toolName = (current.toolName + String(call.function.name)).slice(0, 256);
            current.limit = Math.min(current.limit, argumentLimit(current.toolName));
            const tool = current.toolName.startsWith('wf_') ? current.toolName.slice(3) : current.toolName;
            if (!current.diagnosticTool && diagnosticTools.has(tool)) current.diagnosticTool = tool;
          }
          current.bytes += bytes;
          if (typeof value === 'string' && value.length) current.diagnostic?.add(value);
          if (current.bytes > current.limit) {
            if (current.diagnostic && current.diagnosticTool) {
              try { options.onArgumentDiagnostic?.(current.diagnostic.snapshot(requestId, current.diagnosticTool, current.bytes)); }
              catch { /* Optional shape diagnostics cannot suppress or change refusal. */ }
            }
            exceeded(requestId, current.bytes, current.limit); return;
          }
          if (current.id && current.name) semantic('tool-arguments', value);
        }
      }
    };
    return (bytes: Buffer) => {
      if (!enabled || failure) return;
      pending += decoder.decode(bytes, { stream: true });
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        if (separator.index <= frameLimit) frame(pending.slice(0, separator.index));
        if (failure) { pending = ''; return; }
        pending = pending.slice(separator.index + separator[0].length);
      }
      // An unbounded malformed frame must not grow owner memory or masquerade
      // as progress. Its original bytes still reach the actual engine parser.
      if (pending.length > frameLimit) { enabled = false; pending = ''; }
    };
  }

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const supplied = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
    if (closed || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      response.writeHead(401); response.end(); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    if (failure) {
      // The engine may automatically retry a broken HTTP stream. A fresh request
      // cannot reset an already-refused invocation's counters and spend again.
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: failure.code, message: failure.message } })); return;
    }
    const controller = new AbortController(); active.add(controller);
    const requestId = randomUUID(), startedAt = performance.now();
    let requestBytes = 0, responseBytes = 0, forwardedAt: number | undefined, statusCode: number | undefined, semanticEvents = 0, semanticBytes = 0,
      lastSemantic: number | undefined, completed = false, finished = false;
    const observation = (event: OpenCodeProviderStreamObservation['event']) => {
      if (forwardedAt === undefined) return;
      try { options.onObservation?.({ event, request_id: requestId, elapsed_ms: Math.round(performance.now() - startedAt),
        request_bytes: requestBytes, response_bytes: responseBytes, ...(statusCode === undefined ? {} : { status_code: statusCode }),
        semantic_events: semanticEvents, semantic_bytes: semanticBytes,
        ...(lastSemantic === undefined ? {} : { last_semantic_ms: lastSemantic }),
        ...(event === 'provider-transport-ended' ? { completed, aborted: controller.signal.aborted } : {}) }); }
      catch { /* Fixed metadata is diagnostic, never execution authority. */ }
    };
    const abort = () => controller.abort();
    request.once('aborted', abort);
    const disconnect = () => { if (!response.writableEnded) abort(); };
    response.once('close', disconnect);
    const finish = () => {
      if (finished) return; finished = true;
      observation('provider-transport-ended');
      active.delete(controller); request.off('aborted', abort); response.off('close', disconnect);
    };
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > requestLimit) { response.writeHead(413); response.end(); finish(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { response.writeHead(400); response.end(); finish(); return; }
      if (!object(parsed) || parsed.model !== endpoint.model || parsed.stream !== true || !Array.isArray(parsed.messages)) {
        response.writeHead(400); response.end(); finish(); return;
      }
      if (controller.signal.aborted || closed) { response.destroy(); finish(); return; }
      requestBytes = body.length; forwardedAt = performance.now(); observation('provider-request-started');
      const forwarded: Record<string, string | string[]> = {};
      const hop = new Set(['host', 'authorization', 'cookie', 'connection', 'keep-alive', 'transfer-encoding',
        'content-length', 'accept-encoding', 'upgrade', 'trailer', 'te', 'proxy-authorization', 'proxy-authenticate',
        ...String(request.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined && !hop.has(name)) forwarded[name] = value;
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'POST', signal: controller.signal,
        headers: { ...forwarded, 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity',
          'content-length': String(body.length), ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      }, incoming => {
        statusCode = incoming.statusCode; observation('provider-response-started');
        const headers: Record<string, string> = {};
        // Never forward upstream auth, cookies, arbitrary redirects or stale
        // framing. Node owns downstream chunk framing; payload bytes are intact.
        for (const key of ['content-type', 'content-encoding', 'cache-control', 'retry-after', 'retry-after-ms']) {
          const value = incoming.headers[key]; if (typeof value === 'string') headers[key] = value;
        }
        response.writeHead(incoming.statusCode ?? 502, headers);
        const encoding = incoming.headers['content-encoding'];
        const inspect = incoming.statusCode === 200 && incoming.headers['content-type']?.includes('text/event-stream') &&
          (!encoding || encoding === 'identity') ? observe(requestId, bytes => {
            semanticEvents++; semanticBytes += bytes; lastSemantic = Math.round(performance.now() - startedAt);
          }) : undefined;
        incoming.on('data', chunk => {
          responseBytes += chunk.length; inspect?.(Buffer.from(chunk));
          if (failure) {
            // Destroy without an Error before aborting the signal. In Node's
            // final-response-chunk path, aborting first can surface ABORT_ERR
            // on an already-released socket after its HTTP listeners detach.
            incoming.unpipe(response); upstream.destroy(); controller.abort(); response.destroy(); finish();
          }
        });
        incoming.on('error', () => { response.destroy(); finish(); });
        incoming.once('aborted', () => { response.destroy(); finish(); });
        incoming.once('end', () => { completed = incoming.complete; finish(); });
        incoming.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) { response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Owned model transport did not complete."}}'); }
        else response.destroy();
        finish();
      });
      upstream.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end(); finish();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  const close = () => closing ??= (async () => {
    closed = true; options.signal?.removeEventListener('abort', stop);
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  })();
  const stop = () => { void close(); };
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); }); });
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) { await close(); options.signal.throwIfAborted(); }
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Owned model transport did not bind loopback.'); }
  return { endpoint: { ...endpoint, baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: token },
    get failure() { return failure ? { ...failure } : undefined; }, close };
}
