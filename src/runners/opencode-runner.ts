import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { OpenCodeServer } from '../adapters/opencode-server.js';
import { allocateProcessScope, type ProcessScope } from '../adapters/worker-scope.js';
import { workerEnvironment } from '../adapters/worker-environment.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { openCodePartDone, openCodePartEvents, type TranscriptEvent } from '../core/transcript.js';
import { stateBase } from '../platform/state-dir.js';
import { OpenCodeSessionMap } from './opencode-session-map.js';
import { readOpenCodeProviderConfig, openCodeModels } from './opencode-config.js';
import type { AgentRunner, AgentRunnerFactory, AvailableRunnerModel, RunnerScope, RunnerSessionRequest, RunnerTurnRequest, VerifiedRunnerSession } from './agent-runner.js';

// Allowed releases only: another version may resolve permissions or project configuration differently.
// 1.18.25 was probed on 2026-11-08; 1.19.5 was allowed by the user on 2026-11-11 without that adversarial probe.
const versions = ['1.18.25', '1.19.5'] as const;
const object = z.record(z.string(), z.unknown());
// StructuredOutput is how OpenCode returns a json_schema answer; with `*` denied the model can never finish and, because a
// json_schema turn requires a tool call every step, keeps reading files until it is stopped.
const expectedConfigPermission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', edit: 'allow', StructuredOutput: 'allow' };
/** Model steps one turn may take; a turn that keeps calling tools without answering is stopped instead of using quota. */
export const OPENCODE_MAX_STEPS = 60;
const nativeSession = z.object({ id: z.string().regex(/^ses_[A-Za-z0-9]+$/), directory: z.string(), parentID: z.string().nullish(),
  metadata: z.object({ neomindSession: z.string() }), permission: z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.string() })) });
type NativeRule = { permission: string; pattern: string; action: string };

const openCodeMessages = z.array(z.object({ info: z.object({ id: z.string(), role: z.string() }).passthrough(), parts: z.array(z.record(z.string(), z.unknown())) }));
// The no-reply message NeoMind sends to make the server resolve the agent and model; it is not part of any step's turn.
const verificationText = 'NeoMind session verification.';

function rules(write: boolean, webAccess: boolean): NativeRule[] {
  return ['*', 'read', 'glob', 'grep', ...(write ? ['edit'] : []), ...(webAccess ? ['webfetch', 'websearch'] : []), 'StructuredOutput'].map((permission, index) => ({ permission, pattern: '*', action: index === 0 ? 'deny' : 'allow' }));
}
function samePath(a: string, b: string) { const x = path.resolve(a), y = path.resolve(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; }
function executable(env: NodeJS.ProcessEnv): string {
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  // A copied Windows environment keeps the original key casing (`Path` when launched from Explorer), unlike process.env.
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const dirs = [path.join(homedir(), '.local', 'bin'), ...searchPath.split(path.delimiter)];
  const result = dirs.filter(Boolean).map(dir => path.join(dir, name)).find(file => path.isAbsolute(file) && existsSync(file));
  if (!result) throw new Error(`OpenCode native executable (${name}) not found`);
  return result;
}

class OpenCodeScope implements RunnerScope {
  private stopped = false;
  started = false;
  constructor(readonly process: ProcessScope) {}
  get identity() { return this.process.identity; }
  async isActive() { return !this.stopped && (!this.started || await this.process.isActive()); }
  async stop() { this.stopped = true; return this.process.stop(); }
  async start(launch: Parameters<ProcessScope['start']>[0]) {
    if (this.stopped) throw new Error('OpenCode scope was stopped');
    const child = await this.process.start(launch);
    if (this.stopped) {
      if (!await this.process.stop()) throw new Error('OpenCode worker stop unconfirmed');
      throw new Error('OpenCode scope was stopped');
    }
    return child;
  }
}

interface Options {
  command?: string; env?: NodeJS.ProcessEnv; stateDir?: string; dataHome?: string; workspace?: string;
  scopes?: () => Promise<ProcessScope>; config?: Record<string, unknown>; server?: typeof OpenCodeServer.start;
}
function stateDirectory(options: Options) { return options.stateDir ?? path.join(stateBase(), 'neomind', 'opencode'); }
function dataDirectory(options: Options) { return options.dataHome ?? options.env?.XDG_DATA_HOME ?? process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'); }

/** Start a server and refuse it unless its effective configuration matches what NeoMind requested. */
async function serverFor(scope: Pick<ProcessScope, 'identity' | 'start' | 'isActive' | 'stop'>, workspace: string, options: Options, webAccess = false): Promise<OpenCodeServer> {
  const base = stateDirectory(options), env = options.env ?? workerEnvironment();
  const provider = options.config ?? await readOpenCodeProviderConfig(env);
  const expectedPermission = { ...expectedConfigPermission, ...(webAccess ? { webfetch: 'allow', websearch: 'allow' } : {}) };
  const command = options.command ?? executable(env);
  await mkdir(base, { recursive: true });
  // A fresh config home per server keeps the user's agents, MCP servers and plugins out of the run.
  const instance = await mkdtemp(path.join(base, 'instance-'));
  const managed: ProcessScope = { identity: scope.identity, start: launch => scope.start(launch), isActive: () => scope.isActive(),
    stop: async () => { const stopped = await scope.stop(); if (stopped) await rm(instance, { recursive: true, force: true }); return stopped; } };
  let server: OpenCodeServer;
  try {
    server = await (options.server ?? OpenCodeServer.start)({ scope: managed, command, workspace,
      configHome: path.join(instance, 'config'), cacheHome: path.join(instance, 'cache'), dataHome: dataDirectory(options), env,
      config: { ...provider, permission: expectedPermission } });
  } catch (error) {
    if (!await managed.stop()) throw new Error('OpenCode worker stop unconfirmed');
    throw error;
  }
  try {
    z.object({ healthy: z.literal(true), version: z.enum(versions) }).parse(await server.request('GET', '/global/health'));
    const mcp = object.parse(await server.request('GET', '/mcp'));
    if (Object.keys(mcp).length) throw new Error('OpenCode exposes MCP servers');
    const config = object.parse(await server.request('GET', '/config'));
    if (config.plugin !== undefined && (!Array.isArray(config.plugin) || config.plugin.length)) throw new Error('OpenCode exposes plugins');
    const permissions = z.record(z.string(), z.string()).parse(config.permission);
    if (Object.keys(permissions).length !== Object.keys(expectedPermission).length || Object.entries(expectedPermission).some(([key, value]) => permissions[key] !== value)) throw new Error('OpenCode configuration permission mismatch');
    const agents = z.array(z.object({ name: z.string(), mode: z.string(), permission: z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(['allow', 'ask', 'deny']) })) })).parse(await server.request('GET', '/agent'));
    if (agents.filter(agent => agent.name === 'build' && agent.mode === 'primary').length !== 1) throw new Error('OpenCode primary agent is unavailable');
    return server;
  } catch (error) {
    if (!await server.close()) throw new Error('OpenCode worker stop unconfirmed');
    throw error;
  }
}

/**
 * Experimental OpenCode runner. Permissions are checked as OpenCode reports them, but they are not an OS boundary:
 * the 08/11 probe wrote outside the repository through a junction, so write scope is not enforced.
 */
export class OpenCodeRunner implements AgentRunner {
  readonly runner = 'opencode' as const;
  readonly scope: OpenCodeScope;
  private session?: VerifiedRunnerSession;
  private webAccess = false;
  private resume = false;
  private server?: OpenCodeServer;
  private turn?: { id: string; result: Promise<TurnResult> };
  private listener?: (event: TranscriptEvent) => void;
  /** Native session of the running turn and the messages it had before the prompt, for the activity feed. */
  // Built from the event stream: OpenCode 1.19.5 cannot list the messages of a session that asked for json_schema output.
  private activity?: { nativeId: string; prompt: string; userMessages: Set<string>; emitted: Set<string>; steps: number; stop: () => void };
  constructor(scope: ProcessScope, private readonly options: Options = {}) { this.scope = new OpenCodeScope(scope); }

  async openSession(request: RunnerSessionRequest): Promise<VerifiedRunnerSession> {
    if (request.binding.runner !== 'opencode') throw new Error('Binding does not use OpenCode');
    if (!request.binding.provider || !request.binding.model) throw new Error('OpenCode provider and model are required');
    if (this.session) throw new Error('OpenCode runner already owns a session');
    this.webAccess = request.webAccess === true;
    // NeoMind keeps its own logical id; the native ses_ id is only known once the server created the session.
    const sessionId = request.resumeSessionId ?? randomUUID();
    z.string().uuid().parse(sessionId);
    this.resume = !!request.resumeSessionId;
    this.session = Object.freeze({ runner: 'opencode' as const, sessionId, workspace: path.resolve(request.workspace), provider: request.binding.provider,
      model: request.binding.model, access: request.access.kind === 'read' ? { kind: 'read' as const } : { kind: 'write' as const, writableRoots: [...request.access.writableRoots] } });
    return this.session;
  }
  private owned(session: VerifiedRunnerSession) { if (session !== this.session) throw new Error('OpenCode session is not owned by this runner'); }
  async verifyNoDelegation(session: VerifiedRunnerSession): Promise<void> { this.owned(session); }

  async startTurn(session: VerifiedRunnerSession, request: RunnerTurnRequest): Promise<string> {
    this.owned(session);
    if (this.scope.started || !await this.scope.isActive()) throw new Error('OpenCode scope is unavailable');
    this.scope.started = true;
    try {
      this.server = await serverFor(this.scope, session.workspace, this.options, this.webAccess);
      const providers = await this.server.request('GET', '/provider');
      const models = openCodeModels(providers);
      if (!models.some(item => item.provider === session.provider && item.model === session.model && item.reasoning.includes(request.effort))) throw new Error('OpenCode model or reasoning is unavailable');
      const catalog = z.object({ all: z.array(z.object({ id: z.string(), models: z.record(z.string(), z.object({ variants: z.record(z.string(), z.unknown()).optional() })) })) }).parse(providers);
      const variants = catalog.all.find(item => item.id === session.provider)?.models[session.model]?.variants;
      const wanted = rules(session.access.kind === 'write', this.webAccess), map = new OpenCodeSessionMap(path.join(stateDirectory(this.options), 'sessions'));
      const saved = await map.get(session.sessionId);
      if (this.resume && !saved) throw new Error('OpenCode session mapping is missing');
      if (!this.resume && saved) throw new Error('OpenCode session mapping already exists');
      if (saved && (!samePath(saved.workspace, session.workspace) || saved.provider !== session.provider || saved.model !== session.model)) throw new Error('OpenCode session binding changed');
      const native = nativeSession.parse(saved ? await this.server.request('GET', `/session/${encodeURIComponent(saved.sessionId)}`)
        : await this.server.request('POST', '/session', { metadata: { neomindSession: session.sessionId }, agent: 'build', permission: wanted }));
      if (!samePath(native.directory, session.workspace) || native.parentID || native.metadata.neomindSession !== session.sessionId) throw new Error('OpenCode session identity does not match');
      if (saved && native.id !== saved.sessionId) throw new Error('OpenCode resumed a different session');
      if (!saved) await map.create({ version: 1, logicalId: session.sessionId, sessionId: native.id, workspace: session.workspace, provider: session.provider, model: session.model });
      // A no-reply message makes the server resolve the agent and model; the reply is evidence, the request is not.
      const check = z.object({ info: z.object({ sessionID: z.string(), agent: z.string(), model: z.object({ providerID: z.string(), modelID: z.string() }) }) }).parse(await this.server.request('POST', `/session/${native.id}/message`, { noReply: true, agent: 'build', model: { providerID: session.provider, modelID: session.model },
        tools: Object.fromEntries(wanted.map(rule => [rule.permission, rule.action === 'allow'])), parts: [{ type: 'text', text: verificationText }] }));
      if (check.info.sessionID !== native.id || check.info.agent !== 'build' || check.info.model.providerID !== session.provider || check.info.model.modelID !== session.model) throw new Error('OpenCode session model mismatch');
      const current = nativeSession.parse(await this.server.request('GET', `/session/${native.id}`));
      if (current.id !== native.id || !samePath(current.directory, session.workspace) || current.parentID || current.metadata.neomindSession !== session.sessionId || JSON.stringify(current.permission) !== JSON.stringify(wanted)) throw new Error('OpenCode session policy changed before dispatch');
      if (Object.keys(object.parse(await this.server.request('GET', '/mcp'))).length) throw new Error('OpenCode exposes MCP servers');
      const activity = { nativeId: native.id, prompt: request.prompt.trim(), userMessages: new Set<string>(), emitted: new Set<string>(), steps: 0, stop: () => {} };
      activity.stop = this.server.subscribe(event => this.onServerEvent(activity, event));
      this.activity = activity;
      const id = randomUUID();
      const response = this.server.request('POST', `/session/${native.id}/message`, { agent: 'build', model: { providerID: session.provider, modelID: session.model }, ...(variants && Object.keys(variants).length ? { variant: request.effort } : {}),
        parts: [{ type: 'text', text: request.prompt }], ...(request.outputSchema === undefined ? {} : { format: { type: 'json_schema', schema: request.outputSchema } }) }, 24 * 60 * 60 * 1000)
        .then(value => this.result(value, session, native.id, id, request.outputSchema !== undefined));
      response.catch(() => undefined);
      this.turn = { id, result: response };
      return id;
    } catch (error) {
      if (this.server && !await this.server.close()) throw new Error('OpenCode worker stop unconfirmed');
      throw error;
    }
  }

  private result(value: unknown, session: VerifiedRunnerSession, nativeId: string, turnId: string, structured: boolean): TurnResult {
    const parsed = z.object({ info: z.object({ role: z.literal('assistant'), sessionID: z.string(), providerID: z.string(), modelID: z.string(), error: z.unknown().optional(), structured: z.unknown().optional() }), parts: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(value);
    if (parsed.info.sessionID !== nativeId || parsed.info.providerID !== session.provider || parsed.info.modelID !== session.model) throw new Error('OpenCode response identity mismatch');
    if (parsed.info.error) {
      // Do not expose provider messages: they can contain prompts, credentials or private data.
      const detail = z.object({ name: z.string().optional() }).safeParse(parsed.info.error);
      const name = detail.success ? detail.data.name : undefined;
      const reason = name === 'ContextOverflowError' ? 'OpenCode context limit exceeded' :
        name === 'MessageOutputLengthError' ? 'OpenCode output limit exceeded' : 'OpenCode returned a provider or model error';
      return { threadId: session.sessionId, turnId, status: 'failed', messages: [], error: reason };
    }
    const messages = structured ? parsed.info.structured === undefined ? [] : [JSON.stringify(parsed.info.structured)] : parsed.parts.filter(part => part.type === 'text' && part.text).map(part => part.text!);
    if (!messages.length) return { threadId: session.sessionId, turnId, status: 'failed', messages: [], error: 'OpenCode returned no output' };
    return { threadId: session.sessionId, turnId, status: 'completed', messages };
  }

  async waitForTurn(session: VerifiedRunnerSession, turnId: string, stopped: () => boolean): Promise<TurnResult> {
    this.owned(session);
    if (!this.turn || this.turn.id !== turnId) throw new Error('OpenCode turn does not belong to this session');
    let done = false, result: TurnResult | undefined, fault: unknown;
    this.turn.result.then(value => { result = value; done = true; }, error => { fault = error; done = true; });
    let polled = Date.now();
    while (!done && !stopped()) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (Date.now() - polled >= 1000) { polled = Date.now(); if ((this.activity?.steps ?? 0) > OPENCODE_MAX_STEPS) { done = true; result = { threadId: session.sessionId, turnId, status: 'failed', messages: [], error: `OpenCode stopped after ${OPENCODE_MAX_STEPS} model steps without a result` }; } }
    }
    // Let the last part updates arrive before the server stops.
    await new Promise(resolve => setTimeout(resolve, 300));
    this.activity?.stop();
    // One server per turn: stopping it is also how an interrupted turn is cancelled.
    if (!await this.server!.close()) throw new Error('OpenCode worker stop unconfirmed');
    if (stopped()) throw new Error('Run was interrupted');
    if (fault) throw fault;
    return result!;
  }
  close(): Promise<boolean> { return this.server ? this.server.close() : this.scope.stop(); }
  observe(listener: (event: TranscriptEvent) => void): void { this.listener = listener; }

  /** Forward parts of this turn's replies that reached their final form. Observation only: a failed read is skipped. */
  /** Count model steps and forward this session's parts once they reached their final form. */
  private onServerEvent(activity: NonNullable<OpenCodeRunner['activity']>, input: unknown): void {
    const event = input && typeof input === 'object' ? input as { type?: unknown; properties?: unknown; data?: unknown } : {};
    const body = (event.properties ?? event.data) as { info?: { id?: unknown; role?: unknown; sessionID?: unknown }; part?: Record<string, unknown> } | undefined;
    if (event.type === 'message.updated' && body?.info?.sessionID === activity.nativeId && body.info.role === 'user' && typeof body.info.id === 'string') activity.userMessages.add(body.info.id);
    if (event.type !== 'message.part.updated' || !body?.part || body.part.sessionID !== activity.nativeId) return;
    const part = body.part, id = typeof part.id === 'string' ? part.id : undefined;
    if (!id || activity.emitted.has(id) || activity.userMessages.has(String(part.messageID))) return;
    if (part.type === 'step-start') { activity.emitted.add(id); activity.steps++; return; }
    if (!openCodePartDone(part)) return;
    activity.emitted.add(id);
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() === activity.prompt) return;
    for (const item of openCodePartEvents(part)) this.listener?.(item);
  }
}

/**
 * One turn of a stored OpenCode session, read through a short-lived server for the session viewer. `sessionId` is
 * NeoMind's logical id; the native id comes from the session map. A turn starts at a user prompt (the verification
 * message is skipped); it is the one whose prompt matches NeoMind's, or else the `turnIndex`-th turn.
 */
export async function openCodeHistory(request: { sessionId: string; workspace?: string; prompt?: string; turnIndex?: number }, options: Options = {}): Promise<{ events: TranscriptEvent[]; note?: string }> {
  const saved = await new OpenCodeSessionMap(path.join(stateDirectory(options), 'sessions')).get(request.sessionId).catch(() => undefined);
  if (!saved) return { events: [], note: 'Không tìm thấy session OpenCode của bước này trên máy' };
  const server = await serverFor(await (options.scopes ?? allocateProcessScope)(), request.workspace ?? saved.workspace, options);
  let messages: z.infer<typeof openCodeMessages>;
  try { messages = openCodeMessages.parse(await server.request('GET', `/session/${encodeURIComponent(saved.sessionId)}/message`)); }
  // OpenCode 1.19.5 rejects listing a session whose prompt asked for json_schema output (plan and review steps).
  catch { return { events: [], note: 'OpenCode không đọc lại được session này (lỗi của OpenCode khi lượt có yêu cầu kết quả JSON); xem hoạt động NeoMind đã ghi' }; }
  finally { if (!await server.close()) throw new Error('OpenCode worker stop unconfirmed'); }
  const turns: TranscriptEvent[][] = [];
  for (const message of messages) {
    const role = message.info.role === 'user' ? 'user' : 'assistant';
    const time = (message.info as { time?: { created?: unknown } }).time?.created;
    const events = message.parts.flatMap(part => openCodePartEvents(part, role)).map(event => typeof time === 'number' ? { ...event, t: time } : event);
    if (role === 'user') {
      if (events.length === 1 && events[0]!.text?.trim() === verificationText) continue;
      if (events.length) turns.push(events);
    } else if (turns.length) turns.at(-1)!.push(...events);
  }
  const prompt = request.prompt?.trim();
  let index = prompt ? turns.findIndex(turn => turn[0]?.kind === 'prompt' && turn[0].text?.trim() === prompt) : -1;
  let note: string | undefined;
  if (index < 0 && request.turnIndex !== undefined && request.turnIndex < turns.length) { index = request.turnIndex; if (prompt) note = 'Không khớp được prompt; đang hiện lượt theo thứ tự trong session'; }
  if (index < 0) return { events: [], note: `Session OpenCode có ${turns.length} lượt nhưng không tìm thấy lượt của bước này` };
  return { events: turns[index]!, ...(note ? { note } : {}) };
}

export class OpenCodeRunnerFactory implements AgentRunnerFactory {
  readonly runner = 'opencode' as const;
  constructor(private readonly options: Options = {}) {}
  async start(): Promise<OpenCodeRunner> { return new OpenCodeRunner(await (this.options.scopes ?? allocateProcessScope)(), this.options); }
  async models(): Promise<AvailableRunnerModel[]> {
    const scope = await (this.options.scopes ?? allocateProcessScope)();
    const server = await serverFor(scope, this.options.workspace ?? process.cwd(), this.options);
    try { return openCodeModels(await server.request('GET', '/provider')); }
    finally { if (!await server.close()) throw new Error('OpenCode worker stop unconfirmed'); }
  }
  /** Reports that write scope is not OS-enforced; only stop is proven. */
  async verifyCapabilities(): Promise<{ sandboxVerified: false; stopVerified: true }> {
    const scope = await (this.options.scopes ?? allocateProcessScope)();
    const server = await serverFor(scope, this.options.workspace ?? process.cwd(), this.options);
    if (!await server.close()) throw new Error('OpenCode worker stop unconfirmed');
    return { sandboxVerified: false, stopVerified: true };
  }
}
