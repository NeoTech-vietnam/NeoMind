// Test-owned stdio host. Its fixed grant permits only one synthetic read-only LocalRun.
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRun } from '../../../dist/src/runtime/local-run.js';
import { WorkspaceCoordinator } from '../../../dist/src/storage/coordination.js';
import { RunnerRegistry } from '../../../dist/src/runners/registry.js';
import { templates, defaultProject } from '../../../dist/src/domain/templates.js';
import { materializeRun } from '../../../dist/src/domain/materialize.js';
import { builtinProfile } from '../../../dist/src/runtime/project.js';
import { FakeRunner, fakeScope } from '../../../dist/test/helpers/fake-runner.js';

const runnerId = process.argv[2];
const source = process.argv[3];
if (process.argv.length !== 4 || !['codex', 'claude-code', 'opencode'].includes(runnerId) || !source || !path.isAbsolute(source)) throw Error('invalid host fixture configuration');
const grant = Object.freeze({ version: 1, taskId: 'fixture-task', runner: runnerId, provider: 'fixture', model: 'fake-readonly', reasoning: 'high', prompt: 'synthetic fixture only' });
const exact = (obj, keys) => obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));
function admitted(request) {
  return exact(request, ['version', 'taskId', 'binding', 'prompt']) && request.version === grant.version && request.taskId === grant.taskId && request.prompt === grant.prompt &&
    exact(request.binding, ['runner', 'provider', 'model', 'reasoning']) && ['runner', 'provider', 'model', 'reasoning'].every(k => request.binding[k] === grant[k]);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function runFixture() {
  const base = await realpath(source);
  const expected = new Map([
    ['docs/brief.md', 'Retention: 90 days. Publication requires no approval.\n'],
    ['source/facts.txt', 'Product: Alder\nRetention: 30 days\nApproval: required before publication\n'],
    ['task.txt', 'Read facts, repair both incorrect statements, cite the local source, review again and report.\n'],
  ]);
  if (git('-C', base, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').join('\n') !== [...expected.keys()].join('\n')) throw Error('fixture tree rejected');
  for (const [file, content] of expected) if (git('-C', base, 'show', `HEAD:${file}`) !== content) throw Error('fixture content rejected');
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-broker-host-'));
  const project = path.join(root, 'project'), state = path.join(root, 'state');
  let run, coordinator;
  try {
    git('clone', '--no-local', '--no-hardlinks', '--no-tags', '--', base, project);
    await mkdir(path.join(state, 'runs'), { recursive: true });
    await mkdir(path.join(state, 'workspaces'));
    const binding = { runner: grant.runner, provider: grant.provider, model: grant.model, reasoning: grant.reasoning };
    const config = { ...structuredClone(defaultProject), projectId: 'broker-host-fixture',
      policy: { ...structuredClone(defaultProject.policy), allowGitCommit: false, codexSandbox: 'disabled', keepRunWorktrees: true },
      roleDefaults: { implementer: binding, verifier: binding } };
    await mkdir(path.join(project, 'neomind'));
    await writeFile(path.join(project, 'neomind/project.json'), JSON.stringify(config));
    const flow = structuredClone(templates.research);
    flow.flowId = 'broker-host-fixture';
    flow.definition.nodes = flow.definition.nodes.filter(node => ['start', 'research', 'finish'].includes(node.id));
    flow.definition.edges = [{ from: 'start', to: 'research', outcome: 'completed' }, { from: 'research', to: 'finish', outcome: 'completed' }];
    flow.definition.sessionGroups = flow.definition.sessionGroups.filter(group => group.id === 'research-session');
    flow.definition.limits = { maxConcurrency: 1, maxRepairRounds: 0, activeTimeSeconds: 60 };
    flow.definition.workspacePolicy = 'isolated';
    const node = flow.definition.nodes.find(item => item.id === 'research');
    node.permissions = { read: true, write: false, checks: false, gitCommit: false };
    node.writeScopes = [];
    const snapshot = await materializeRun(flow, config, { 'implementer@1': builtinProfile('implementer') }, project);
    let starts = 0, stops = 0, before, runner;
    class Factory {
      constructor(id) { this.runner = id; }
      async models() { return [{ runner: this.runner, provider: 'fixture', model: 'fake-readonly', reasoning: ['high'] }]; }
      async verifyCapabilities() { return { sandboxVerified: false, stopVerified: true }; }
      async start() {
        if (this.runner !== grant.runner || runner) throw Error('fixture runner rejected');
        const scope = fakeScope(async () => { stops++; return true; });
        runner = new FakeRunner(this.runner, scope, {
          startTurn: async (session, request) => {
            starts++;
            if (session.runner !== grant.runner || session.provider !== grant.provider || session.model !== grant.model || session.workspace !== run.context.workspace || session.access.kind !== 'read' || request.effort !== grant.reasoning) throw Error('fixture session rejected');
            before = await run.durable.journal.read();
            if (!before.some(event => event.type === 'dispatch_intent') || !before.some(event => event.type === 'worker_scope_bound' && event.payload.unit === scope.identity.unit)) throw Error('fixture intent missing');
            // Test-owned hook only: never configured by graph input or by the default client.
            if (process.env.FIXTURE_TEST_COUNTER) await appendFile(process.env.FIXTURE_TEST_COUNTER, 'dispatch\n', { mode: 0o600 });
            if (process.env.FIXTURE_TEST_HOLD === '1') await new Promise(() => {});
            return randomUUID();
          },
          respond: () => `fixture:${grant.runner}`,
        });
        return runner;
      }
    }
    coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
    run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: grant.prompt, snapshot, coordinator,
      runners: new RunnerRegistry(['codex', 'claude-code', 'opencode'].map(id => new Factory(id))) });
    run.launch();
    let timer;
    const settled = await Promise.race([run.settled().then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 45000); })]);
    clearTimeout(timer);
    if (!settled) { await run.stop('pause'); throw Error('fixture timeout'); }
    const report = await run.report(), events = await run.durable.journal.read();
    const attempt = report.attempts[0];
    if (report.runtimeState.phase !== 'completed' || report.attempts.length !== 1 || attempt.status !== 'completed' || starts !== 1 || stops !== 1 || !before || await runner.scope.isActive()) throw Error('fixture lifecycle rejected');
    const order = ['dispatch_intent', 'worker_scope_bound', 'codex_turn_bound', 'dispatch_receipt', 'attempt_finished'].map(type => events.find(event => event.type === type && event.payload.attemptId === attempt.attemptId));
    if (order.some(event => !event) || order.some((event, i) => i && event.sequence <= order[i - 1].sequence) || order[3].payload.status !== 'accepted') throw Error('fixture receipt rejected');
    return { ok: true, runner: grant.runner, message: `fixture:${grant.runner}`, proof: { intentBeforeDispatch: true, receipt: 'accepted', fakeStop: true, dispatches: starts } };
  } finally {
    if (run) await run.close();
    if (coordinator) coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
}

let result;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let response;
  try {
    if (Buffer.byteLength(line) > 8192) throw Error('oversize');
    const request = JSON.parse(line);
    if (!admitted(request)) response = { ok: false, error: 'grant_rejected' };
    else {
      result ??= runFixture().catch(() => ({ ok: false, error: 'fixture_run_failed' }));
      response = await result;
    }
  } catch { response = { ok: false, error: 'invalid_request' }; }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
