import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { compileFlow } from '../domain/compiler.js';
import { projectSchema } from '../domain/schema.js';
import { defaultProject, templates } from '../domain/templates.js';
import { FlowLibrary } from '../storage/flow-library.js';

export interface EditorServer { url: string; token: string; close(): Promise<void> }
const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
};
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length; if (size > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function policyFor(projectRoot: string) {
  try { return projectSchema.parse(JSON.parse(await readFile(path.join(projectRoot, '.neomind', 'project.json'), 'utf8'))).policy; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultProject.policy; throw error; }
}

/** Local single-user editor server; actual agent execution is intentionally unavailable. */
export async function startEditorServer(projectDirectory: string, port = 0, assetsDirectory?: string): Promise<EditorServer> {
  const projectRoot = await realpath(projectDirectory);
  if (!(await stat(projectRoot)).isDirectory()) throw new Error('Project path must be a directory');
  const staticRoot = assetsDirectory ?? fileURLToPath(new URL('../../../dist-ui/', import.meta.url));
  const library = new FlowLibrary(path.join(projectRoot, '.neomind', 'flows'));
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server: Server = createServer((request, response) => {
    void (async () => {
      const expectedHost = new URL(origin).host;
      if (request.headers.host !== expectedHost) { json(response, 403, { error: 'Invalid host' }); return; }
      const url = new URL(request.url ?? '/', origin);
      const method = request.method ?? 'GET';
      if (method !== 'GET' && (request.headers.origin !== origin || request.headers['x-neomind-token'] !== token)) {
        json(response, 403, { error: 'Invalid origin or session token' }); return;
      }
      if (url.pathname === '/api/bootstrap' && method === 'GET') {
        json(response, 200, { projectName: path.basename(projectRoot), projectRoot, flows: await library.list(), templates: Object.keys(templates), runtimeAvailable: false }); return;
      }
      if (url.pathname === '/api/flows' && method === 'POST') {
        const input = z.strictObject({ id: z.string().min(1), name: z.string().min(1), template: z.enum(['fast', 'dev', 'research']) }).parse(await body(request));
        const metadata = await library.create(input.id, input.name);
        const draft = { ...structuredClone(templates[input.template]), flowId: input.id, name: input.name, version: 1 };
        await library.saveDraft(input.id, draft); json(response, 201, { metadata, draft }); return;
      }
      const match = /^\/api\/flows\/([^/]+)\/(draft|validate|publish|archive|restore|rename|delete|clone)$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!), action = match[2]!;
        if (action === 'draft' && method === 'GET') { json(response, 200, { draft: await library.readDraft(id) }); return; }
        if (action === 'draft' && method === 'PUT') {
          const input = z.strictObject({ draft: z.json() }).parse(await body(request));
          if (!input.draft || typeof input.draft !== 'object' || Array.isArray(input.draft) || input.draft.flowId !== id) throw new Error('Draft flowId must match its library ID');
          await library.saveDraft(id, input.draft); json(response, 200, { saved: true }); return;
        }
        if (action === 'validate' && method === 'POST') {
          const input = z.strictObject({ draft: z.json() }).parse(await body(request));
          const result = compileFlow(input.draft, await policyFor(projectRoot));
          json(response, 200, result.ok ? { valid: true, order: result.order } : { valid: false, diagnostics: result.diagnostics }); return;
        }
        if (action === 'publish' && method === 'POST') { json(response, 200, { version: await library.publish(id, await policyFor(projectRoot)) }); return; }
        if ((action === 'archive' || action === 'restore') && method === 'POST') {
          await library.setArchived(id, action === 'archive'); json(response, 200, { archived: action === 'archive' }); return;
        }
        if (action === 'rename' && method === 'POST') {
          const input = z.strictObject({ name: z.string().min(1) }).parse(await body(request));
          await library.rename(id, input.name); json(response, 200, { renamed: true }); return;
        }
        if (action === 'clone' && method === 'POST') {
          const input = z.strictObject({ targetId: z.string().min(1), name: z.string().min(1) }).parse(await body(request));
          const metadata = await library.cloneDraft(id, input.targetId, input.name);
          json(response, 201, { metadata, draft: await library.readDraft(input.targetId) }); return;
        }
        if (action === 'delete' && method === 'POST') {
          const input = z.strictObject({ confirmedName: z.string().min(1) }).parse(await body(request));
          await library.deletePermanently(id, input.confirmedName); json(response, 200, { deleted: true }); return;
        }
        json(response, 405, { error: 'Method not allowed' }); return;
      }
      if (url.pathname.startsWith('/api/')) { json(response, 404, { error: 'Unknown API' }); return; }
      if (method !== 'GET') { json(response, 405, { error: 'Method not allowed' }); return; }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const target = path.resolve(staticRoot, relative), relativeTarget = path.relative(staticRoot, target);
      if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) { json(response, 403, { error: 'Invalid asset path' }); return; }
      let data = await readFile(target);
      if (relative === 'index.html') {
        const html = data.toString('utf8');
        if (!html.includes('<!-- NEOMIND_CONFIG -->')) throw new Error('Editor build is missing configuration placeholder');
        data = Buffer.from(html.replace('<!-- NEOMIND_CONFIG -->', `<meta name="neomind-token" content="${token}">`));
      }
      const type = target.endsWith('.html') ? 'text/html; charset=utf-8' : target.endsWith('.js') ? 'text/javascript; charset=utf-8' :
        target.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
      response.end(data);
    })().catch(error => {
      if (!response.headersSent) json(response, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400,
        { error: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Cannot obtain editor address'); }
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, token, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
