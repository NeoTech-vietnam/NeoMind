// Real LocalRun and journal with three fake factories; no real runner or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRun } from '../../../dist/src/runtime/local-run.js';
import { WorkspaceCoordinator } from '../../../dist/src/storage/coordination.js';
import { RunnerRegistry } from '../../../dist/src/runners/registry.js';
import { templates, defaultProject } from '../../../dist/src/domain/templates.js';
import { materializeRun } from '../../../dist/src/domain/materialize.js';
import { builtinProfile } from '../../../dist/src/runtime/project.js';
import { FakeRunner } from '../../../dist/test/helpers/fake-runner.js';

const source = process.env.SYNTHETIC_BASE_REPO;
const ids = ['codex', 'claude-code', 'opencode'];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

class FixtureFactory {
  instances = [];
  constructor(runner, fault, observe) { this.runner = runner; this.fault = fault; this.observe = observe; }
  async models() { return [{ runner: this.runner, provider: 'fixture', model: 'fake-readonly', reasoning: ['high'] }]; }
  async verifyCapabilities() { return { sandboxVerified: false, stopVerified: true }; }
  async start() {
    const id = randomUUID(), trace = [], fault = this.fault;
    let active = true;
    const scope = { identity: { unit: `neomind-run-${id}.scope`, controlGroup: `/user.slice/fake-${id}.scope` },
      isActive: async () => active,
      stop: async () => { trace.push('stop'); if (fault === 'stop') return false; active = false; return true; } };
    const observe = this.observe;
    const runner = new class extends FakeRunner {
      async openSession(request) {
        trace.push('open');
        const session = await super.openSession(request);
        return fault === 'binding' ? { ...session, model: 'wrong' } : session;
      }
      async verifyNoDelegation(session) {
        trace.push('verify');
        if (fault === 'delegation') throw Error('fixture delegation denied');
        return super.verifyNoDelegation(session);
      }
    }(this.runner, scope, {
      startTurn: async (session, request) => {
        trace.push('start');
        await observe(session, request, scope);
        if (fault === 'dispatch') throw Error('fixture uncertain dispatch');
        return randomUUID();
      },
      respond: () => 'Synthetic fixture response',
    });
    this.instances.push({ runner, trace });
    return runner;
  }
}

async function runCase(id, fault) {
  if (!source || !path.isAbsolute(source)) throw Error('Set SYNTHETIC_BASE_REPO to the pre-existing synthetic fixture');
  const actualSource = await realpath(source);
  const expected = new Map([
    ['source/facts.txt', 'Product: Alder\nRetention: 30 days\nApproval: required before publication\n'],
    ['docs/brief.md', 'Retention: 90 days. Publication requires no approval.\n'],
    ['task.txt', 'Read facts, repair both incorrect statements, cite the local source, review again and report.\n'],
  ]);
  assert.deepEqual(git('-C', actualSource, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n'), [...expected.keys()].sort());
  for (const [file, content] of expected) assert.equal(git('-C', actualSource, 'show', `HEAD:${file}`), content);
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-broker-localrun-'));
  const project = path.join(root, 'project'), state = path.join(root, 'state');
  let coordinator, run;
  try {
    git('clone', '--no-local', '--no-hardlinks', '--no-tags', '--', actualSource, project);
    await mkdir(path.join(state, 'runs'), { recursive: true });
    await mkdir(path.join(state, 'workspaces'));
    const role = { runner: id, provider: 'fixture', model: 'fake-readonly', reasoning: 'high' };
    const projectConfig = { ...structuredClone(defaultProject), projectId: 'broker-localrun-fixture',
      policy: { ...structuredClone(defaultProject.policy), allowGitCommit: false, codexSandbox: 'disabled', keepRunWorktrees: true },
      roleDefaults: { implementer: role, verifier: role } };
    await mkdir(path.join(project, 'neomind'));
    await writeFile(path.join(project, 'neomind/project.json'), JSON.stringify(projectConfig));
    const flow = structuredClone(templates.research);
    flow.flowId = 'broker-localrun-fixture';
    flow.definition.nodes = flow.definition.nodes.filter(node => ['start', 'research', 'finish'].includes(node.id));
    flow.definition.edges = [{ from: 'start', to: 'research', outcome: 'completed' }, { from: 'research', to: 'finish', outcome: 'completed' }];
    flow.definition.sessionGroups = flow.definition.sessionGroups.filter(group => group.id === 'research-session');
    flow.definition.limits = { maxConcurrency: 1, maxRepairRounds: 0, activeTimeSeconds: 60 };
    flow.definition.workspacePolicy = 'isolated';
    const node = flow.definition.nodes.find(item => item.id === 'research');
    node.permissions = { read: true, write: false, checks: false, gitCommit: false };
    node.writeScopes = [];
    const snapshot = await materializeRun(flow, projectConfig, { 'implementer@1': builtinProfile('implementer') }, project);
    let beforeDispatch;
    const factories = ids.map(runner => new FixtureFactory(runner, runner === id ? fault : undefined, async (session, request, scope) => {
      const events = await run.durable.journal.read();
      beforeDispatch = events;
      assert.deepEqual([session.runner, session.provider, session.model, request.effort, session.access.kind], [id, 'fixture', 'fake-readonly', 'high', 'read']);
      assert.equal(session.workspace, run.context.workspace);
      assert.ok(events.some(event => event.type === 'dispatch_intent'));
      assert.ok(events.some(event => event.type === 'worker_scope_bound' && event.payload.unit === scope.identity.unit));
    }));
    coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
    run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: 'Review synthetic fixture', snapshot, coordinator, runners: new RunnerRegistry(factories) });
    run.launch();
    let timer;
    const settled = await Promise.race([run.settled().then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 45000); })]);
    clearTimeout(timer);
    if (!settled) { await run.stop('pause'); throw Error('fixture run timed out'); }
    const report = await run.report(), events = await run.durable.journal.read();
    const factory = factories.find(item => item.runner === id);
    assert.equal(factory.instances.length, 1);
    assert.ok(factories.filter(item => item.runner !== id).every(item => item.instances.length === 0));
    const trace = factory.instances[0].trace;
    assert.ok(trace.includes('stop'));
    if (!fault) {
      assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
      assert.deepEqual(trace, ['open', 'verify', 'start', 'stop']);
      assert.ok(beforeDispatch);
      const attempt = report.attempts[0];
      assert.equal(attempt.status, 'completed');
      const types = ['dispatch_intent', 'worker_scope_bound', 'codex_turn_bound', 'dispatch_receipt', 'attempt_finished'];
      const matching = types.map(type => events.find(e => e.type === type && e.payload.attemptId === attempt.attemptId));
      assert.ok(matching.every(Boolean));
      assert.ok(matching.every((event, i) => i === 0 || event.sequence > matching[i - 1].sequence));
      assert.equal(matching[3].payload.status, 'accepted');
      assert.equal(await factory.instances[0].runner.scope.isActive(), false);
    } else {
      assert.equal(report.runtimeState.phase, 'blocked', report.runtimeState.reason);
      assert.ok(!events.some(event => event.type === 'attempt_finished' && event.payload.status === 'completed'));
      if (fault === 'binding' || fault === 'delegation') {
        assert.ok(!trace.includes('start'));
        assert.ok(!events.some(event => event.type === 'dispatch_intent'));
      }
      if (fault === 'dispatch') {
        assert.ok(beforeDispatch);
        assert.ok(events.some(event => event.type === 'dispatch_receipt' && event.payload.status === 'unknown'));
        assert.equal(trace.filter(step => step === 'start').length, 1);
      }
      if (fault === 'stop') assert.ok(await factory.instances[0].runner.scope.isActive());
    }
  } finally {
    if (run) await run.close();
    if (coordinator) coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const id of ids) {
  for (const fault of [undefined, 'binding', 'delegation', 'dispatch', 'stop']) {
    test(`LocalRun fixture ${id}: ${fault ?? 'success'}`, { timeout: 60000 }, () => runCase(id, fault));
  }
}
