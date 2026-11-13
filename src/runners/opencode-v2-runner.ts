import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { OpenCodeServer } from '../adapters/opencode-server.js';
import { allocateProcessScope, type ProcessScope } from '../adapters/worker-scope.js';
import { workerEnvironment } from '../adapters/worker-environment.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { stateBase } from '../platform/state-dir.js';
import type { AgentRunner, AgentRunnerFactory, AvailableRunnerModel, RunnerScope, RunnerSessionRequest, RunnerTurnRequest, VerifiedRunnerSession } from './agent-runner.js';
import { OpenCodeSessionMap } from './opencode-session-map.js';
import { openCodeV2Models, openCodeV2Rules, verifyOpenCodeV2ConfigSources } from './opencode-v2-contract.js';
import { createOpenCodeV2Session, verifyOpenCodeV2Session, type OpenCodeV2SessionSpec } from './opencode-v2-session.js';
import { dispatchOpenCodeV2Turn } from './opencode-v2-dispatch.js';

type Options = { workspace?: string; command?: string; env?: NodeJS.ProcessEnv; stateDir?: string; dataHome?: string;
  scopes?: () => Promise<ProcessScope>; server?: typeof OpenCodeServer.start };
const base = (options: Options) => options.stateDir ?? path.join(stateBase(), 'neomind', 'opencode-v2');
function command(env: NodeJS.ProcessEnv): string {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const found = [path.join(homedir(), '.local', 'bin'), ...value.split(path.delimiter)].filter(Boolean)
    .map(dir => path.join(dir, name)).find(file => path.isAbsolute(file) && existsSync(file));
  if (!found) throw new Error('OpenCode executable not found');
  return found;
}

class Scope implements RunnerScope {
  started = false;
  private stopped = false;
  constructor(readonly inner: ProcessScope) {}
  get identity() { return this.inner.identity; }
  async isActive() { return !this.stopped && (!this.started || await this.inner.isActive()); }
  async stop() { this.stopped = true; return this.inner.stop(); }
  async start(launch: Parameters<ProcessScope['start']>[0]) {
    if (this.stopped) throw new Error('OpenCode V2 scope was stopped');
    const child = await this.inner.start(launch);
    if (this.stopped) { if (!await this.inner.stop()) throw new Error('OpenCode worker stop unconfirmed'); throw new Error('OpenCode V2 scope was stopped'); }
    return child;
  }
}

async function serverFor(scope: Scope, workspace: string, options: Options): Promise<OpenCodeServer> {
  // System policy can override user policy, and must not be allowed to load plugins before inspection.
  if (process.platform !== 'linux' || existsSync('/etc/opencode')) throw new Error('OpenCode V2 system configuration isolation is not verified on this host');
  const env = options.env ?? workerEnvironment(), root = base(options);
  await mkdir(root, { recursive: true });
  const instance = await mkdtemp(path.join(root, 'instance-'));
  const configHome = path.join(instance, 'config'), configDir = path.join(configHome, 'opencode'), configFile = path.join(configDir, 'opencode.json');
  await mkdir(configDir, { recursive: true });
  await writeFile(configFile, JSON.stringify({ policies: [{ action: 'plugin.use', resource: '*', effect: 'deny' }, { action: 'mcp.use', resource: '*', effect: 'deny' }] }), { mode: 0o600 });
  const managed: ProcessScope = { identity: scope.identity, start: launch => scope.start(launch), isActive: () => scope.isActive(),
    stop: async () => { const stopped = await scope.stop(); if (stopped) await rm(instance, { recursive: true, force: true }); return stopped; } };
  let server: OpenCodeServer | undefined;
  try {
    server = await (options.server ?? OpenCodeServer.start)({ scope: managed, command: options.command ?? command(env), workspace, configHome,
      dataHome: options.dataHome ?? env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), cacheHome: path.join(instance, 'cache'), env, config: {}, protocol: 'v2' });
    const sources = await server.request('GET', '/api/config');
    verifyOpenCodeV2ConfigSources(sources, configFile);
    const entries = z.array(z.object({ type: z.string(), path: z.string().optional() })).parse(sources);
    if (!entries.some(entry => entry.type === 'document' && entry.path === configFile)) throw new Error('OpenCode V2 isolation policy is missing');
    if (entries.some(entry => entry.type === 'directory' && entry.path !== configDir)) throw new Error('OpenCode V2 found an external configuration directory');
    await server.request('GET', '/api/model');
    const mcp = z.object({ data: z.array(z.unknown()) }).parse(await server.request('GET', '/api/mcp'));
    if (mcp.data.length) throw new Error('OpenCode V2 exposes MCP servers');
    const plugins = z.object({ data: z.array(z.object({ source: z.object({ type: z.string() }) })) }).parse(await server.request('GET', '/api/plugin'));
    if (plugins.data.some(plugin => plugin.source.type !== 'builtin')) throw new Error('OpenCode V2 exposes external plugins');
    return server;
  } catch (error) {
    if (!(server ? await server.close() : await managed.stop())) throw new Error('OpenCode worker stop unconfirmed');
    throw error;
  }
}

export class OpenCodeV2Runner implements AgentRunner {
  readonly runner = 'opencode' as const;
  readonly scope: Scope;
  private session?: VerifiedRunnerSession;
  private resume = false;
  private webAccess = false;
  private server?: OpenCodeServer;
  private turn?: { id: string; result: Promise<TurnResult> };
  private activity?: { steps: number; stop: () => void };
  constructor(scope: ProcessScope, private readonly options: Options = {}) { this.scope = new Scope(scope); }
  async openSession(request: RunnerSessionRequest): Promise<VerifiedRunnerSession> {
    if (request.binding.runner !== 'opencode' || !request.binding.provider || !request.binding.model || this.session) throw new Error('Invalid OpenCode V2 session binding');
    const sessionId = request.resumeSessionId ?? randomUUID(); z.string().uuid().parse(sessionId);
    this.resume = !!request.resumeSessionId; this.webAccess = request.webAccess === true;
    return this.session = Object.freeze({ runner: 'opencode', sessionId, workspace: path.resolve(request.workspace), provider: request.binding.provider, model: request.binding.model,
      access: request.access.kind === 'read' ? { kind: 'read' as const } : { kind: 'write' as const, writableRoots: [...request.access.writableRoots] } });
  }
  private owned(session: VerifiedRunnerSession) { if (session !== this.session) throw new Error('OpenCode V2 session is not owned'); }
  async verifyNoDelegation(session: VerifiedRunnerSession) { this.owned(session); }
  async startTurn(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string> {
    this.owned(session);
    if (this.scope.started || !await this.scope.isActive()) throw new Error('OpenCode V2 scope unavailable');
    this.scope.started = true;
    try {
      this.server = await serverFor(this.scope, session.workspace, this.options);
      const models = openCodeV2Models(await this.server.request('GET', '/api/model'));
      const selected = models.find(model => model.provider === session.provider && model.model === session.model && model.reasoning.includes(request.effort));
      if (!selected) throw new Error('OpenCode V2 model or reasoning unavailable');
      const spec: OpenCodeV2SessionSpec = { logicalId: session.sessionId, workspace: session.workspace, provider: session.provider, model: session.model,
        ...(selected.reasoning.length === 1 && selected.reasoning[0] === 'medium' ? {} : { variant: request.effort }), permissions: openCodeV2Rules(session.access.kind === 'write', this.webAccess) };
      const map = new OpenCodeSessionMap(path.join(base(this.options), 'sessions')), saved = await map.get(session.sessionId);
      if (this.resume !== !!saved) throw new Error('OpenCode V2 session mapping mismatch');
      if (saved && (path.resolve(saved.workspace) !== session.workspace || saved.provider !== session.provider || saved.model !== session.model)) throw new Error('OpenCode V2 session binding changed');
      let nativeId: string;
      if (saved) {
        const endpoint = `/api/session/${encodeURIComponent(saved.sessionId)}`;
        const previous = await this.server.request('GET', endpoint);
        const permissions = z.object({ data: z.object({ permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'deny']) })) }) }).parse(previous).data.permissions;
        verifyOpenCodeV2Session(previous, { ...spec, permissions }, saved.sessionId);
        await this.server.request('PATCH', endpoint, { permissions: spec.permissions });
        nativeId = verifyOpenCodeV2Session(await this.server.request('GET', endpoint), spec, saved.sessionId);
      } else nativeId = await createOpenCodeV2Session(this.server, spec);
      if (!saved) await map.create({ version: 1, logicalId: session.sessionId, sessionId: nativeId, workspace: session.workspace, provider: session.provider, model: session.model });
      const activity = { steps: 0, stop: () => {} };
      activity.stop = this.server.subscribe(event => {
        const parsed = z.object({ type: z.string(), data: z.object({ sessionID: z.string() }).passthrough() }).safeParse(event);
        if (parsed.success && parsed.data.type === 'session.step.started' && parsed.data.data.sessionID === nativeId) activity.steps++;
      }, '/api/event');
      this.activity = activity;
      const id = randomUUID();
      const result = dispatchOpenCodeV2Turn(this.server, { nativeId, spec, prompt: request.prompt, turnId: id, ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }) });
      result.catch(() => undefined); this.turn = { id, result }; return id;
    } catch (error) { if (this.server && !await this.server.close()) throw new Error('OpenCode worker stop unconfirmed'); throw error; }
  }
  async waitForTurn(session: VerifiedRunnerSession, turnId: string, stopped: () => boolean): Promise<TurnResult> {
    this.owned(session); if (!this.turn || this.turn.id !== turnId) throw new Error('OpenCode V2 turn is not owned');
    let done = false, result: TurnResult | undefined, fault: unknown;
    this.turn.result.then(value => { result = value; done = true; }, error => { fault = error; done = true; });
    while (!done && !stopped()) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if ((this.activity?.steps ?? 0) > 60) { done = true; result = { threadId: session.sessionId, turnId, status: 'failed', messages: [], error: 'OpenCode V2 stopped after 60 model steps without a result' }; }
    }
    this.activity?.stop();
    if (!await this.server!.close()) throw new Error('OpenCode worker stop unconfirmed');
    if (stopped()) throw new Error('Run was interrupted');
    if (fault) throw fault;
    return result!;
  }
  close(): Promise<boolean> { return this.server ? this.server.close() : this.scope.stop(); }
}

export class OpenCodeV2RunnerFactory implements AgentRunnerFactory {
  readonly runner = 'opencode' as const;
  constructor(private readonly options: Options = {}) {}
  async start(): Promise<OpenCodeV2Runner> { return new OpenCodeV2Runner(await (this.options.scopes ?? allocateProcessScope)(), this.options); }
  async models(): Promise<AvailableRunnerModel[]> {
    const scope = new Scope(await (this.options.scopes ?? allocateProcessScope)()); scope.started = true;
    const server = await serverFor(scope, this.options.workspace ?? process.cwd(), this.options);
    try { return openCodeV2Models(await server.request('GET', '/api/model')); }
    finally { if (!await server.close()) throw new Error('OpenCode worker stop unconfirmed'); }
  }
  async verifyCapabilities(): Promise<{ sandboxVerified: false; stopVerified: true }> {
    const scope = new Scope(await (this.options.scopes ?? allocateProcessScope)()); scope.started = true;
    const server = await serverFor(scope, this.options.workspace ?? process.cwd(), this.options);
    if (!await server.close()) throw new Error('OpenCode worker stop unconfirmed');
    return { sandboxVerified: false, stopVerified: true };
  }
}
