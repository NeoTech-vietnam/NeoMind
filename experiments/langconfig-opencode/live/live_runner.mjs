// Experimental fixture-only AgentRunnerFactory, never the production runner.
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { requireDataRoot } from './runtime_paths.mjs';

const code = path.dirname(fileURLToPath(import.meta.url));
const root = requireDataRoot();
const neomind = path.resolve(process.env.NEOMIND_ROOT ?? path.join(code, '../../..'));
const { allocateProcessScope } = await import(pathToFileURL(path.join(neomind, 'dist/src/adapters/worker-scope.js')));
const Ajv = createRequire(path.join(neomind, 'package.json'))('ajv/dist/2020.js').default;
const reviewSchema = { type: 'object', properties: { verdict: { enum: ['pass', 'needs_changes'] }, findings: { type: 'array', items: { type: 'object', properties: { description: { type: 'string', minLength: 1, maxLength: 2000 }, path: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['description', 'path'], additionalProperties: false } }, summary: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['verdict', 'findings', 'summary'], additionalProperties: false };
const validateReview = new Ajv({ strict: true }).compile(reviewSchema);
const deadline = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture worker timed out')), ms); })]).finally(() => clearTimeout(timer)); };

class ExperimentalRunner {
  runner = 'opencode'; started = false; stopped = false; stopping = false;
  constructor(inner, options) {
    this.inner = inner; this.options = options;
    this.scope = { identity: inner.identity, isActive: async () => !this.stopped && (!this.started || await inner.isActive()),
      stop: async () => { this.stopping = true; if (this.stopped) return true; const stopped = await inner.stop(); if (stopped) this.stopped = true; return stopped; } };
  }
  async openSession(request) {
    const workspace = await realpath(request.workspace);
    const expected = this.options.mode === 'fake' ? ['fixture', 'fake-review'] : this.options.mode === 'fake-router' ? ['fixture', 'router-free'] : ['openrouter', 'openrouter/free'];
    if (!workspace.startsWith(root + path.sep) || this.session || request.resumeSessionId || request.access.kind !== 'read' || request.webAccess || request.binding.runner !== 'opencode' || request.binding.provider !== expected[0] || request.binding.model !== expected[1]) throw Error('unsupported experimental session');
    return this.session = Object.freeze({ runner: this.runner, sessionId: randomUUID(), workspace, provider: expected[0], model: expected[1], access: { kind: 'read' } });
  }
  async verifyNoDelegation(session) { if (session !== this.session) throw Error('unowned session'); }
  async startTurn(session, request) {
    await this.verifyNoDelegation(session);
    if (this.started || this.stopping || request.effort !== (this.options.mode === 'fake' ? 'high' : 'medium') || request.outputSchema !== undefined) throw Error('unsupported experimental turn');
    this.started = true;
    try {
      const env = { HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LIVE_GUARD_DATA: root,
        PYTHONDONTWRITEBYTECODE: '1', OPENCODE_BIN: process.env.OPENCODE_BIN,
        ...(this.options.mode === 'live' ? { LIVE_MODEL_ID: 'openrouter/openrouter/free', OPENCODE_ACCOUNT_DB: this.options.accountDb, LIVE_BUDGET_PATH: this.options.budget, NEOMIND_LIVE_AUTHORIZED: this.options.authorization } : {}),
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
      const hostArgs = ['/usr/bin/python3', '-u', path.join(code, 'live_runner_host.py'), this.options.mode, session.workspace, this.options.workflow, session.sessionId];
      const child = await this.inner.start({ command: this.options.mode !== 'live' ? '/usr/bin/unshare' : '/usr/bin/python3', args: this.options.mode !== 'live' ? ['-Urn', ...hostArgs] : hostArgs.slice(1), cwd: root, env });
      child.stderr.resume();
      const lines = readline.createInterface({ input: child.stdout });
      const iter = lines[Symbol.asyncIterator]();
      const ready = await deadline(iter.next(), 60000);
      if (ready.done) throw Error('worker exited before preflight');
      const details = JSON.parse(ready.value);
      if (details.ready !== true) throw Error('worker preflight failed');
      this.artifact = details.artifact;
      const id = randomUUID();
      const prompt = `${request.prompt}\n\nReturn exactly one JSON object with keys verdict, findings, summary. verdict is pass or needs_changes; findings is an array of objects with description and path. No Markdown or additional text.`;
      child.stdin.write(JSON.stringify({ operation: 'turn', id, prompt }) + '\n');
      const result = (async () => {
        const line = await deadline(iter.next(), 175000);
        if (line.done) throw Error('worker exited during turn');
        const value = JSON.parse(line.value);
        if (value.id !== id || value.error || !Array.isArray(value.messages) || value.messages.length !== 1) throw Error(`experimental turn failed: ${value.error ?? 'invalid response'}`);
        const parsed = JSON.parse(value.messages[0]);
        if (!validateReview(parsed) || (parsed.verdict === 'pass') !== (parsed.findings.length === 0)) throw Error('invalid review JSON');
        return { threadId: session.sessionId, turnId: id, status: 'completed', messages: value.messages };
      })();
      result.catch(() => {}); this.turn = { id, result }; return id;
    } catch (error) { if (!await this.scope.stop()) throw Error('worker stop unconfirmed'); throw error; }
  }
  async waitForTurn(session, id, stopped) {
    await this.verifyNoDelegation(session);
    if (!this.turn || this.turn.id !== id) throw Error('unowned turn');
    let done = false, result, failure;
    this.turn.result.then(value => { result = value; done = true; }, error => { failure = error; done = true; });
    while (!done && !stopped()) await new Promise(resolve => setTimeout(resolve, 40));
    if (!await this.scope.stop()) throw Error('worker stop unconfirmed');
    if (stopped()) throw Error('Run was interrupted');
    if (failure) throw failure;
    return result;
  }
  close() { return this.scope.stop(); }
}

export class ExperimentalRunnerFactory {
  runner = 'opencode';
  constructor(options) {
    if (!options || !['fake', 'fake-router', 'live'].includes(options.mode) || !/^(fake|neo)-[0-9a-f-]{36}$/.test(options.workflow)) throw Error('invalid experiment options');
    if (options.mode === 'live' && (!path.isAbsolute(options.budget ?? '') || !path.isAbsolute(options.accountDb ?? '') || options.authorization !== 'f21c6cfacd571ede17407ad839d5ada908f2ced3')) throw Error('live options not authorized');
    this.options = options; this.instances = [];
  }
  async start(_workspace, sandboxMode) { if (sandboxMode === 'enabled') throw Error('no OS sandbox'); const runner = new ExperimentalRunner(await allocateProcessScope(), this.options); this.instances.push(runner); return runner; }
  async models() { throw Error('model inventory requires private worker preflight'); }
  async verifyCapabilities() { throw Error('capability probe must be performed on the owned scope'); }
}
