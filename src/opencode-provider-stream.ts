import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The pinned engine's ordinary processor does not publish tool-input deltas.
 * Observe semantic SSE at the owned provider boundary without changing the
 * model loop, request bytes, response bytes, tools or result authority. Neither
 * a tool name nor an SSE/network heartbeat constitutes model progress. */
export async function createOpenCodeProviderStream(endpoint: OpenCodeEndpoint, options: OpenCodeProviderStreamOptions): Promise<{
  endpoint: OpenCodeEndpoint;
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

  function observe(requestId: string, counted: (bytes: number) => void) {
    const decoder = new TextDecoder();
    let pending = '', sequence = 0, enabled = true;
    // Tool-call identities are scoped to an SSE response and choice. Argument
    // fragments without an established call cannot prove useful model progress.
    const calls = new Map<string, { id: boolean; name: boolean }>();
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
          if (!current && (hasId || hasName) && calls.size < 4096) { current = { id: false, name: false }; calls.set(key, current); }
          if (!current) continue;
          current.id ||= hasId; current.name ||= hasName;
          if (current.id && current.name && object(call.function)) semantic('tool-arguments', call.function.arguments);
        }
      }
    };
    return (bytes: Buffer) => {
      if (!enabled) return;
      pending += decoder.decode(bytes, { stream: true });
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        if (separator.index <= frameLimit) frame(pending.slice(0, separator.index));
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
        incoming.on('data', chunk => { responseBytes += chunk.length; inspect?.(Buffer.from(chunk)); });
        incoming.once('error', () => { response.destroy(); finish(); });
        incoming.once('aborted', () => { response.destroy(); finish(); });
        incoming.once('end', () => { completed = incoming.complete; finish(); });
        incoming.pipe(response);
      });
      upstream.once('error', () => {
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
  return { endpoint: { ...endpoint, baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: token }, close };
}
