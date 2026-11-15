// Full NeoMind LocalRun integration using only a previously committed synthetic Git fixture and fake OpenCode upstream.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = path.dirname(fileURLToPath(import.meta.url));
const neomind = path.resolve(process.env.NEOMIND_ROOT ?? path.join(code, '../../..'));
const baseInput = process.env.LOCALRUN_LAB_BASE;
const sourceInput = process.env.SYNTHETIC_BASE_REPO;
if (!baseInput || !sourceInput || !path.isAbsolute(baseInput) || !path.isAbsolute(sourceInput) || !process.env.OPENCODE_BIN || !path.isAbsolute(process.env.OPENCODE_BIN)) {
  throw Error('Set absolute LOCALRUN_LAB_BASE, SYNTHETIC_BASE_REPO, and OPENCODE_BIN');
}
const base = await realpath(baseInput);
const source = await realpath(sourceInput);
const checkout = await realpath(neomind);
if (base === checkout || base.startsWith(checkout + path.sep) || source === checkout || source.startsWith(checkout + path.sep)) throw Error('Fixture and state must be outside the checkout');
const root = await mkdtemp(path.join(base, 'localrun-'));
const project = path.join(root, 'fixture'), state = path.join(root, 'state');
await mkdir(path.join(root, 'tmp'), { recursive: true });
await mkdir(path.join(root, 'home'), { recursive: true });
await mkdir(path.join(state, 'runs'), { recursive: true });
await mkdir(path.join(state, 'workspaces'), { recursive: true });

// No commits, pushes, external remotes, global Git config, or source checkout modifications.
const gitEnv = { ...process.env, HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[key];
const git = (...args) => execFileSync('git', args, { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const paths = git('-C', source, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n');
assert.deepEqual(paths, ['docs/brief.md', 'source/facts.txt', 'task.txt']);
assert.equal(git('-C', source, 'show', 'HEAD:source/facts.txt'), 'Product: Alder\nRetention: 30 days\nApproval: required before publication\n');
assert.equal(git('-C', source, 'show', 'HEAD:docs/brief.md'), 'Retention: 90 days. Publication requires no approval.\n');
assert.equal(git('-C', source, 'show', 'HEAD:task.txt'), 'Read facts, repair both incorrect statements, cite the local source, review again and report.\n');
assert.equal(git('-C', source, 'rev-list', '--count', 'HEAD').trim(), '1');
const sourceHead = git('-C', source, 'rev-parse', 'HEAD').trim();
git('clone', '--no-local', '--no-hardlinks', '--single-branch', '--no-tags', '--', source, project);
assert.equal(git('-C', project, 'rev-parse', 'HEAD').trim(), sourceHead);
assert.equal(git('-C', project, 'status', '--porcelain'), '');

// Only this new fixture and state are visible to the experimental runner.
process.env.LIVE_GUARD_DATA = root;
process.env.TMPDIR = path.join(root, 'tmp');
process.env.NEOMIND_ROOT = neomind;
process.env.PYTHONDONTWRITEBYTECODE = '1';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_ALLOW_PROTOCOL = 'file';
const moduleAt = p => import(pathToFileURL(path.join(neomind, 'dist/src', p)));
const [{ LocalRun }, { WorkspaceCoordinator }, { RunnerRegistry }, { templates, defaultProject }, { materializeRun }, { builtinProfile }, { FixtureRunnerFactory }] = await Promise.all([
  moduleAt('runtime/local-run.js'), moduleAt('storage/coordination.js'), moduleAt('runners/registry.js'),
  moduleAt('domain/templates.js'), moduleAt('domain/materialize.js'), moduleAt('runtime/project.js'), import('./runner.mjs'),
]);

const role = { runner: 'opencode', provider: 'fixture', model: 'fake-review', reasoning: 'high' };
const projectConfig = { ...structuredClone(defaultProject), projectId: 'localrun-fake-fixture',
  policy: { ...structuredClone(defaultProject.policy), allowGitCommit: false, codexSandbox: 'disabled', keepRunWorktrees: true },
  roleDefaults: { implementer: role, verifier: role } };
await mkdir(path.join(project, 'neomind'));
await writeFile(path.join(project, 'neomind/project.json'), JSON.stringify(projectConfig));
const flow = structuredClone(templates.research);
flow.flowId = 'fixture-readonly';
flow.name = 'Fixture read-only';
flow.description = 'Synthetic read-only experiment derived from research.';
flow.definition.nodes = flow.definition.nodes.filter(node => ['start', 'research', 'finish'].includes(node.id));
flow.definition.edges = [{ from: 'start', to: 'research', outcome: 'completed' }, { from: 'research', to: 'finish', outcome: 'completed' }];
flow.definition.sessionGroups = flow.definition.sessionGroups.filter(group => group.id === 'research-session');
flow.definition.limits = { maxConcurrency: 1, maxRepairRounds: 0, activeTimeSeconds: 90 };
flow.definition.workspacePolicy = 'isolated';
const research = flow.definition.nodes.find(node => node.id === 'research');
research.goal = 'Compare the supplied synthetic source and draft, and return a concise review.';
research.permissions = { read: true, write: false, checks: false, gitCommit: false };
research.writeScopes = [];
const profile = builtinProfile('implementer');
const snapshot = await materializeRun(flow, projectConfig, { 'implementer@1': profile }, project);
const factory = new FixtureRunnerFactory();
const runners = new RunnerRegistry([factory]);
const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
const task = `Compare these synthetic source and draft documents.\nSOURCE:\n${await readFile(path.join(project, 'source/facts.txt'), 'utf8')}\nDRAFT:\n${await readFile(path.join(project, 'docs/brief.md'), 'utf8')}`;
let run;
try {
  run = await LocalRun.create({ projectRoot: project, stateRoot: state, task, snapshot, coordinator, runners });
  console.log(JSON.stringify({ runId: run.runId, journal: run.durable.journal.file, fixtureHead: sourceHead, root }));
  run.launch();
  let timer;
  const outcome = await Promise.race([run.settled().then(() => 'settled'), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 80000); })]);
  clearTimeout(timer);
  if (outcome === 'timeout') { await run.stop('pause'); throw Error('LocalRun timed out and was stopped'); }
  const report = await run.report();
  const events = await run.durable.journal.read();
  const scopeEvents = events.filter(event => event.type === 'worker_scope_bound');
  const data = report.nodeData.find(item => item.nodeId === 'research');
  const actual = data?.output?.messages?.[0];
  console.log(JSON.stringify({ phase: report.runtimeState.phase, reason: report.runtimeState.reason,
    attempts: report.attempts.map(item => ({ nodeId: item.nodeId, status: item.status, sessionId: item.sessionId, runnerTurnId: item.runnerTurnId })),
    actualMessage: actual ?? null, journalTypes: events.map(event => event.type), boundScopes: scopeEvents.map(event => event.payload) }));
  assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].status, 'completed');
  assert.equal(scopeEvents.length, 1);
  assert.equal(JSON.parse(actual).verdict, 'needs_changes');
  assert.equal(JSON.parse(actual).summary, 'Synthetic fake review');
  for (const type of ['readonly_baseline_bound', 'worker_scope_bound', 'codex_turn_bound', 'dispatch_receipt', 'node_output', 'attempt_finished', 'node_completed']) {
    assert.ok(events.some(event => event.type === type), `missing journal event ${type}`);
  }
  const attemptId = report.attempts[0].attemptId;
  const sequence = ['dispatch_intent', 'readonly_baseline_bound', 'worker_scope_bound', 'codex_turn_bound', 'dispatch_receipt', 'node_output', 'attempt_finished'].map(type => {
    const event = events.find(item => item.type === type && item.payload?.attemptId === attemptId);
    assert.ok(event, `missing ${type} for owned attempt`);
    return event.sequence;
  });
  assert.ok(sequence.every((value, index) => index === 0 || value > sequence[index - 1]), 'journal event order mismatch');
  const { unit, controlGroup } = scopeEvents[0].payload;
  const properties = execFileSync('systemctl', ['--user', 'show', unit, '--property=ActiveState,ControlGroup'], { encoding: 'utf8', timeout: 10000 });
  assert.match(properties, /^ActiveState=inactive$/m);
  const cgEvents = path.join('/sys/fs/cgroup', controlGroup, 'cgroup.events');
  try { assert.match(await readFile(cgEvents, 'utf8'), /^populated 0$/m); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ownedRuns = (await readdir(path.join(root, 'runs'))).filter(name => name.startsWith('runner-'));
  assert.equal(ownedRuns.length, 1);
  const worker = path.join(root, 'runs', ownedRuns[0]);
  const posts = (await readFile(path.join(worker, 'upstream.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
  const trace = (await readFile(path.join(worker, 'worker/trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const admitted = trace.filter(event => event.event === 'reserved');
  assert.equal(admitted.length, 1);
  assert.deepEqual([admitted[0].provider, admitted[0].model, admitted[0].variant, admitted[0].kind], ['fixture', 'fake-review', 'high', 'primary']);
  const db = new DatabaseSync(path.join(worker, 'worker/quota.sqlite'), { readOnly: true });
  const reservations = db.prepare('SELECT count(*) AS n FROM reservations').get().n;
  db.close();
  assert.equal(posts.length, 1);
  assert.equal(reservations, 1);
  assert.equal(await access(path.join(root, 'live-budget.sqlite')).then(() => true, () => false), false);
  console.log(JSON.stringify({ status: 'PASS', fakePhysicalPosts: posts.length, fakeReservations: reservations, liveRequests: 0,
    scopeStoppedVerified: true, sandboxVerified: false, journal: run.durable.journal.file }));
} finally {
  if (run) await run.close();
  coordinator.close();
}
