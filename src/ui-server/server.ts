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
import { RunManager } from '../runtime/run-manager.js';
import type { BindingOverride } from '../domain/resolve.js';
import { ProfileLibrary } from '../storage/profile-library.js';
import { builtinProfile } from '../runtime/project.js';

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

/** Local single-user editor and standalone runtime server. */
export async function startEditorServer(projectDirectory: string, port = 0, assetsDirectory?: string): Promise<EditorServer> {
  const projectRoot = await realpath(projectDirectory);
  if (!(await stat(projectRoot)).isDirectory()) throw new Error('Project path must be a directory');
  const staticRoot = assetsDirectory ?? fileURLToPath(new URL('../../../dist-ui/', import.meta.url));
  const library = new FlowLibrary(path.join(projectRoot, '.neomind', 'flows'));
  const profiles = new ProfileLibrary(path.join(projectRoot, '.neomind', 'profiles'));
  const token = randomBytes(32).toString('hex');
  let runtime: Promise<RunManager> | undefined;
  const runs = () => runtime ??= RunManager.open(projectRoot).catch(error => { runtime = undefined; throw error; });
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
        json(response, 200, { projectName: path.basename(projectRoot), projectRoot, flows: await library.list(), templates: Object.keys(templates), runtimeAvailable: process.platform === 'linux' }); return;
      }
      if (url.pathname === '/api/runtime/models' && method === 'GET') { json(response, 200, { models: await (await runs()).models() }); return; }
      if (url.pathname === '/api/memory' && method === 'GET') { json(response, 200, (await runs()).readMemory(url.searchParams.get('q') ?? undefined)); return; }
      if (url.pathname === '/api/memory/configure' && method === 'POST') {
        const input = z.strictObject({ root: z.string().min(1).optional(), initializeDefault: z.boolean(), expectedPrevious: z.string().nullable() }).parse(await body(request));
        json(response, 200, await (await runs()).configureMemory({ initializeDefault: input.initializeDefault, expectedPrevious: input.expectedPrevious, ...(input.root ? { root: input.root } : {}) })); return;
      }
      if (url.pathname === '/api/memory' && method === 'POST') {
        const input = z.strictObject({ record: z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), type: z.enum(['context', 'decision']), scope: z.string().min(1), sources: z.array(z.string().min(1)).min(1), tags: z.array(z.string()), body: z.string().min(1) }), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).parse(await body(request));
        json(response, 200, await (await runs()).writeMemory(input.record, input.expectedRevision, 'ui')); return;
      }
      if (url.pathname === '/api/profiles' && method === 'GET') { json(response, 200, { profiles: await profiles.list(), builtins: ['implementer', 'verifier'].map(id => builtinProfile(id)) }); return; }
      if (url.pathname === '/api/profiles' && method === 'POST') {
        const input = z.strictObject({ id: z.string().min(1), name: z.string().min(1), template: z.enum(['implementer', 'verifier']) }).parse(await body(request));
        const metadata = await profiles.create(input.id, input.name);
        const draft = { ...builtinProfile(input.template), profileId: input.id, name: input.name };
        await profiles.saveDraft(input.id, draft); json(response, 201, { metadata, draft }); return;
      }
      const profileMatch = /^\/api\/profiles\/([^/]+)\/(draft|publish|rename|clone|archive|restore|delete|versions)$/.exec(url.pathname);
      if (profileMatch) {
        const id = decodeURIComponent(profileMatch[1]!), action = profileMatch[2]!;
        if (action === 'draft' && method === 'GET') { json(response, 200, { draft: await profiles.readDraft(id) }); return; }
        if (action === 'draft' && method === 'PUT') {
          const input = z.strictObject({ draft: z.json() }).parse(await body(request));
          if (!input.draft || typeof input.draft !== 'object' || Array.isArray(input.draft) || input.draft.profileId !== id) throw new Error('Draft profileId must match its library ID');
          await profiles.saveDraft(id, input.draft); json(response, 200, { saved: true }); return;
        }
        if (action === 'versions' && method === 'GET') { json(response, 200, { versions: await profiles.versions(id) }); return; }
        if (action === 'publish' && method === 'POST') { json(response, 200, { version: await profiles.publish(id) }); return; }
        if (action === 'rename' && method === 'POST') { const input = z.strictObject({ name: z.string().min(1) }).parse(await body(request)); await profiles.rename(id, input.name); json(response, 200, { renamed: true }); return; }
        if (action === 'clone' && method === 'POST') { const input = z.strictObject({ targetId: z.string().min(1), name: z.string().min(1) }).parse(await body(request)); json(response, 201, { metadata: await profiles.cloneDraft(id, input.targetId, input.name) }); return; }
        if ((action === 'archive' || action === 'restore') && method === 'POST') { await profiles.setArchived(id, action === 'archive'); json(response, 200, { archived: action === 'archive' }); return; }
        if (action === 'delete' && method === 'POST') { const input = z.strictObject({ confirmedName: z.string().min(1) }).parse(await body(request)); await profiles.deletePermanently(id, input.confirmedName); json(response, 200, { deleted: true }); return; }
        json(response, 405, { error: 'Method not allowed' }); return;
      }
      if (url.pathname === '/api/runs' && method === 'GET') { json(response, 200, { runs: await (await runs()).list() }); return; }
      const runInput = z.strictObject({ flowId: z.string().min(1), version: z.number().int().positive().optional(), task: z.string().min(1).optional(), configurationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        limits: z.strictObject({ activeTimeSeconds: z.number().int().positive().optional(), maxConcurrency: z.number().int().positive().optional(), maxRepairRounds: z.number().int().nonnegative().optional() }).transform(value => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))).optional(),
        overrides: z.record(z.string(), z.strictObject({ runner: z.string().min(1).optional(), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional() }).transform(value => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as BindingOverride)).optional() });
      if (url.pathname === '/api/runs/preview' && method === 'POST') {
        const input = runInput.parse(await body(request));
        json(response, 200, await (await runs()).preview(input.flowId, input.version, input.overrides, input.limits)); return;
      }
      if (url.pathname === '/api/runs' && method === 'POST') {
        const input = runInput.parse(await body(request));
        if (!input.task?.trim()) throw new Error('Task is required');
        if (!input.configurationHash) throw new Error('Preview the effective configuration before starting');
        json(response, 201, await (await runs()).create(input.flowId, input.task, input.version, input.overrides, input.configurationHash, input.limits)); return;
      }
      const lessonMatch = /^\/api\/runs\/([a-z0-9-]+)\/lessons(?:\/(approve))?$/.exec(url.pathname);
      if (lessonMatch) {
        if (!lessonMatch[2] && method === 'GET') { json(response, 200, await (await runs()).lessons(lessonMatch[1]!)); return; }
        if (lessonMatch[2] === 'approve' && method === 'POST') {
          const input = z.strictObject({ proposalId: z.string().min(1), proposalHash: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), memoryRoot: z.string().min(1) }).parse(await body(request));
          json(response, 200, await (await runs()).approveLesson(lessonMatch[1]!, input)); return;
        }
        json(response, 405, { error: 'Method not allowed' }); return;
      }
      const runMatch = /^\/api\/runs\/([a-z0-9-]+)(?:\/(approve|resume|pause|cancel|changes|retry_git|extend_time))?$/.exec(url.pathname);
      if (runMatch) {
        if (!runMatch[2] && method === 'GET') { json(response, 200, await (await runs()).get(runMatch[1]!)); return; }
        if (runMatch[2] && method === 'POST') {
          if (runMatch[2] === 'extend_time') {
            const input = z.strictObject({ seconds: z.number().int().positive().max(86400) }).parse(await body(request));
            json(response, 200, await (await runs()).extendTime(runMatch[1]!, input.seconds)); return;
          }
          if (runMatch[2] === 'changes') {
            const input = z.strictObject({ feedback: z.string().min(1).max(10000), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await body(request));
            json(response, 200, await (await runs()).revisePlan(runMatch[1]!, input.feedback, input.planHash)); return;
          }
          const planHash = runMatch[2] === 'approve' ? z.strictObject({ planHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await body(request)).planHash : undefined;
          json(response, 200, await (await runs()).action(runMatch[1]!, runMatch[2] as 'approve' | 'resume' | 'pause' | 'cancel' | 'retry_git', 'ui', planHash)); return;
        }
        json(response, 405, { error: 'Method not allowed' }); return;
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
  return { url: origin, token, close: async () => {
    if (runtime) await (await runtime).close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
