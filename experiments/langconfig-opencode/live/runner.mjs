// Experimental AgentRunnerFactory: fixture-only, never the production OpenCode runner.
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
const require = createRequire(path.join(neomind, 'package.json'));
const Ajv = require('ajv/dist/2020.js').default;
const scopeEnv = () => ({ HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
  LIVE_GUARD_DATA: root, PYTHONDONTWRITEBYTECODE: '1',
  ...(process.env.OPENCODE_BIN ? { OPENCODE_BIN: process.env.OPENCODE_BIN } : {}),
  ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) });

class FixtureRunner {
  runner = 'opencode';
  started = false;
  stopped = false;
  stopping = false;
  session = undefined;
  turn = undefined;
  constructor(inner) {
    this.inner = inner;
    this.scope = { identity: inner.identity,
      isActive: async () => !this.stopped && (!this.started || await inner.isActive()),
      stop: async () => {
        this.stopping = true;
        const stopped = await inner.stop();
        if (stopped) this.stopped = true;
        return stopped;
      } };
  }
  async openSession(request) {
    const workspace = await realpath(request.workspace);
    if (workspace !== root && !workspace.startsWith(root + path.sep)) throw Error('workspace outside fixture root');
    if (this.session || request.resumeSessionId || request.access.kind !== 'read' || request.webAccess || request.binding.runner !== 'opencode' || request.binding.provider !== 'fixture' || request.binding.model !== 'fake-review') throw Error('unsupported fixture binding');
    this.session = Object.freeze({ runner: this.runner, sessionId: randomUUID(), workspace, provider: 'fixture', model: 'fake-review', access: {kind: 'read'} });
    return this.session;
  }
  async verifyNoDelegation(session) { if (session !== this.session) throw Error('unowned fixture session'); }
  async startTurn(session, request) {
    await this.verifyNoDelegation(session);
    if (this.started || this.stopping || this.stopped || request.effort !== 'high') throw Error('invalid fixture turn');
    let validate;
    if (request.outputSchema !== undefined) validate = new Ajv({ strict: true }).compile(request.outputSchema);
    this.started = true;
    try {
    const env = scopeEnv();
    const child = await this.inner.start({ command: '/usr/bin/unshare', args: ['-Urn', '/usr/bin/python3', '-u', path.join(code, 'runner_host.py'), session.workspace], cwd: root, env });
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const ready = await iterator.next();
    if (ready.done || JSON.parse(ready.value).ready !== true) throw Error('fixture host not ready');
    const id = randomUUID();
    const prompt = request.outputSchema === undefined ? request.prompt : `${request.prompt}\n\nReturn JSON matching schema: ${JSON.stringify(request.outputSchema)}`;
    child.stdin.write(JSON.stringify({ operation: 'turn', id, prompt }) + '\n');
    const result = (async () => {
      const line = await iterator.next();
      if (line.done) throw Error('fixture host exited');
      const value = JSON.parse(line.value);
      if (value.id !== id || value.error || !Array.isArray(value.messages)) throw Error('fixture response invalid');
      if (validate && !validate(JSON.parse(value.messages.join('\n')))) return { threadId: session.sessionId, turnId: id, status: 'failed', messages: [], error: 'JSON schema mismatch' };
      return { threadId: session.sessionId, turnId: id, status: 'completed', messages: value.messages };
    })();
    result.catch(() => {});
    this.turn = { id, result };
    return id;
    } catch (error) {
      if (!await this.scope.stop()) throw Error('fixture worker stop unconfirmed');
      throw error;
    }
  }
  async waitForTurn(session, id, stopped) {
    await this.verifyNoDelegation(session);
    if (!this.turn || id !== this.turn.id) throw Error('unowned turn');
    let done = false, result, error;
    this.turn.result.then(x => { result = x; done = true; }, e => { error = e; done = true; });
    while (!done && !stopped()) await new Promise(resolve => setTimeout(resolve, 30));
    if (!await this.scope.stop()) throw Error('fixture worker stop unconfirmed');
    if (stopped()) throw Error('Run was interrupted');
    if (error) throw error;
    return result;
  }
  async close() { return this.scope.stop(); }
}

export class FixtureRunnerFactory {
  runner = 'opencode';
  async start(workspace, sandboxMode) {
    if (sandboxMode === 'enabled') throw Error('fixture runner has no OS sandbox');
    return new FixtureRunner(await allocateProcessScope());
  }
  async models() { return [{ runner: 'opencode', provider: 'fixture', model: 'fake-review', reasoning: ['high'] }]; }
  async verifyCapabilities(sandboxMode) {
    if (sandboxMode === 'enabled') throw Error('fixture runner has no OS sandbox');
    const scope = await allocateProcessScope();
    try {
      await scope.start({ command: '/usr/bin/sleep', args: ['120'], cwd: root, env: scopeEnv() });
    } catch (error) {
      if (!await scope.stop()) throw Error('fixture scope stop unconfirmed');
      throw error;
    }
    if (!await scope.stop()) throw Error('fixture scope stop unconfirmed');
    return { sandboxVerified: false, stopVerified: true };
  }
}
