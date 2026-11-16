import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { recordApproval } from '../src/domain/approval.js';
import { defaultProject } from '../src/domain/templates.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import { CodexWorkspaceWriteAdapter } from '../src/adapters/codex-workspace-write.js';
import { admitIsolatedWorkspaceWrite } from '../src/workspace/write-admission.js';
import { fakeBinding, fakeRunnerSession, fakeScope } from './helpers/fake-runner.js';

test('write admission requires live approval, full scope, verified runtime, current lease and matching baseline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-admission-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree'); await mkdir(primary);
  const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(path.join(primary, 'a'), 'before'); git('add', 'a');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  git('worktree', 'add', '--detach', workspace, 'HEAD');
  await mkdir(path.join(workspace, 'src'));
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), lease = coordinator.acquire(workspace, 'run', 'host');
  const plan = { planId: 'p', version: 1, goal: 'test', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
  const approval = recordApproval(plan, defaultProject.policy, { approvalId: 'a', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  const expectedBaselineHash = (await captureBaseline(workspace)).baselineHash;
  const args = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy, expectedBaselineHash, sandboxVerified: true, stopVerified: true };
  assert.equal((await admitIsolatedWorkspaceWrite(args)).runId, 'run');
  assert.equal((await admitIsolatedWorkspaceWrite({ ...args, sandboxVerified: false, codexSandbox: 'disabled' })).runId, 'run');
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, sandboxVerified: false, codexSandbox: 'enabled' }), /Verified sandbox/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, sandboxVerified: false, stopVerified: false, codexSandbox: 'disabled' }), /Verified sandbox/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, codexSandbox: 'disabled', livePolicy: { ...args.livePolicy, codexSandbox: 'enabled' } }), /Project policy requires Codex sandbox/);
  assert.equal((await admitIsolatedWorkspaceWrite({ ...args, runner: 'opencode', sandboxVerified: false })).runId, 'run');
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, runner: 'opencode', sandboxVerified: false, stopVerified: false }), /Verified sandbox/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, runner: 'claude-code', sandboxVerified: false }), /Verified sandbox/);
  const scopedPlan = { ...plan, scope: ['src'] };
  const scopedApproval = recordApproval(scopedPlan, defaultProject.policy, { approvalId: 'b', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  const scopedGrant = await admitIsolatedWorkspaceWrite({ ...args, plan: scopedPlan, approval: scopedApproval });
  assert.deepEqual(scopedGrant.writableRoots, [path.join(workspace, 'src')]);
  const filePlan = { ...plan, scope: ['a'] };
  const fileApproval = recordApproval(filePlan, defaultProject.policy, { approvalId: 'c', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, plan: filePlan, approval: fileApproval }), /real directories/);

  const calls: Array<{ method: string; params: unknown }> = [];
  const adapter = new CodexWorkspaceWriteAdapter({ request: async (method, params) => {
    calls.push({ method, params }); return method === 'thread/resume' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } };
  } });
  await adapter.resumeThread('thread', 'gpt-6-luna', args);
  assert.equal(await adapter.startTurn('thread', 'implement', 'low', args), 'turn');
  const turn = calls[1]?.params as { cwd: string; sandboxPolicy: { type: string; writableRoots: string[]; networkAccess: boolean } };
  assert.equal(turn.cwd, workspace); assert.equal(turn.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [workspace]); assert.equal(turn.sandboxPolicy.networkAccess, false);
  let selectedModel = 'gpt-6-luna';
  const verifiedAdapter = new CodexWorkspaceWriteAdapter({ request: async () => ({ thread: { id: 'thread' }, model: selectedModel,
    modelProvider: 'openai', cwd: workspace, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } }) });
  const binding = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  assert.throws(() => verifiedAdapter.assertBound('thread', binding, workspace), /not been verified/);
  await verifiedAdapter.resumeVerifiedThread('thread', binding.model, binding.provider, args);
  verifiedAdapter.assertBound('thread', binding, workspace);
  selectedModel = 'other';
  await assert.rejects(verifiedAdapter.resumeVerifiedThread('thread', binding.model, binding.provider, args), /does not match/);
  assert.throws(() => verifiedAdapter.assertBound('thread', binding, workspace), /not been verified/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, sandboxVerified: false }), /Verified sandbox/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, plan: { ...plan, scope: ['src'] } }), /Approval does not match/);
  await writeFile(path.join(workspace, 'a'), 'changed');
  await assert.rejects(admitIsolatedWorkspaceWrite(args), /baseline changed/);
  coordinator.release(lease, true); coordinator.close();
});

test('journaled writer requires the recorded approval before dispatch and captures changed baseline', async () => {
  const { RunService } = await import('../src/core/run-service.js');
  const { CodexReadOnlyDispatch } = await import('../src/core/codex-readonly-dispatch.js');
  const { CodexWriteDispatch } = await import('../src/core/codex-write-dispatch.js');
  const { CodexReviewDispatch } = await import('../src/core/codex-review-dispatch.js');
  const { GitCommitDispatch } = await import('../src/core/git-commit-dispatch.js');
  const { CodexCheckDispatch } = await import('../src/core/codex-check-dispatch.js');
  const { CodexCheckExecutor } = await import('../src/adapters/codex-check.js');
  const { buildReviewTree } = await import('../src/workspace/review-tree.js');
  const { OwnedJournal } = await import('../src/storage/owned-journal.js');
  const { templates } = await import('../src/domain/templates.js');
  const { hashJson } = await import('../src/domain/resolve.js');
  const { prepareLangConfigWriterBinding } = await import('../src/core/langconfig-writer-binding.js');
  const { observeLangConfigWriterBinding } = await import('../src/core/langconfig-authority-observation.js');
  const { SignedLangConfigAuthorityReader } = await import('../src/core/langconfig-signed-authority.js');
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { LangConfigReservations } = await import('../src/storage/langconfig-reservations.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-write-dispatch-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree');
  await mkdir(primary); const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(primary, 'a'), 'before'); git('add', 'a');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  git('worktree', 'add', '--detach', workspace, 'HEAD');
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), owner = coordinator.acquireRun('run', 'host');
  const lease = coordinator.acquire(workspace, 'run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, owner);
  const service = await RunService.create(journal, templates.dev, defaultProject.policy); await service.completeControl('start');
  const planner = await fakeRunnerSession('thread', { startTurn: async () => 'plan-turn' });
  const reader = new CodexReadOnlyDispatch(journal, planner.runner, planner.session);
  await service.dispatchReadOnly(reader, 'plan', 'thread', 'plan', 'low', 'plan-attempt', 'plan-request');
  const plan = { planId: 'p', version: 1, goal: 'edit', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: ['make test'], riskChanges: [] };
  await service.recordReadOnlyPlan(reader, 'plan-attempt', { threadId: 'thread', turnId: 'plan-turn', status: 'completed', messages: [JSON.stringify(plan)] });
  await service.approveProposedPlan('approval', 'plan', 'user', 'ui');
  const report = await service.report(), approval = report.approvals[0]!.approval;
  const admission = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy,
    expectedBaselineHash: (await captureBaseline(workspace)).baselineHash, sandboxVerified: true, stopVerified: true };
  const external = { threadId: 'fixture-thread', checkpointId: 'fixture-checkpoint', interruptId: 'fixture-interrupt',
    taskHash: hashJson('synthetic task'), actionHash: hashJson('synthetic action'), receiptId: 'fixture-receipt', generation: 1 };
  const bindingInput = { journal, admission, nodeId: 'implement', attemptId: 'write-attempt', requestId: 'write-request', external };
  const fingerprint = await prepareLangConfigWriterBinding(bindingInput);
  assert.equal(fingerprint.binding.planHash, hashJson(plan));
  assert.equal(fingerprint.binding.approvalHash, hashJson(approval));
  assert.equal(fingerprint.binding.fence, lease.fence);
  assert.equal(fingerprint.binding.baselineHash, admission.expectedBaselineHash);
  assert.equal(fingerprint.bindingHash, (await prepareLangConfigWriterBinding(bindingInput)).bindingHash);
  assert.notEqual(fingerprint.bindingHash, (await prepareLangConfigWriterBinding({ ...bindingInput, external: { ...external, checkpointId: 'changed' } })).bindingHash);
  assert.notEqual(fingerprint.bindingHash, (await prepareLangConfigWriterBinding({ ...bindingInput, external: { ...external, generation: 2 } })).bindingHash);
  await assert.rejects(prepareLangConfigWriterBinding({ ...bindingInput, admission: { ...admission, lease: { ...lease, fence: lease.fence + 1 } } }), /lease/);
  await assert.rejects(prepareLangConfigWriterBinding({ ...bindingInput, admission: { ...admission, approval: { ...approval, approvalId: 'other' } } }), /journaled approval/);
  await assert.rejects(prepareLangConfigWriterBinding({ ...bindingInput, external: { ...external, actionHash: 'invalid' } }));
  const reservationPath = path.join(dir, 'langconfig-reservations.sqlite');
  let reservations = new LangConfigReservations(reservationPath);
  assert.equal(reservations.reserve(fingerprint), 'recorded');
  assert.equal(reservations.reserve(fingerprint), 'unknown');
  assert.throws(() => reservations.reserve({ ...fingerprint, bindingHash: '0'.repeat(64) }), /hash mismatch/);
  const alteredBinding = { ...fingerprint.binding, generation: fingerprint.binding.generation + 1 };
  assert.equal(reservations.reserve({ binding: alteredBinding, bindingHash: hashJson(alteredBinding) }), 'conflict');
  const reusedReceipt = { ...fingerprint.binding, attemptId: 'another-attempt', requestId: 'another-request' };
  assert.equal(reservations.reserve({ binding: reusedReceipt, bindingHash: hashJson(reusedReceipt) }), 'conflict');
  reservations.close();
  reservations = new LangConfigReservations(reservationPath);
  assert.equal(reservations.reserve(fingerprint), 'unknown');
  reservations.close();
  const crashPath = path.join(dir, 'langconfig-crash.sqlite');
  const moduleUrl = new URL('../src/storage/langconfig-reservations.js', import.meta.url).href;
  const worker = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { LangConfigReservations } from ${JSON.stringify(moduleUrl)};
    const store = new LangConfigReservations(process.argv[1]);
    if (store.reserve(JSON.parse(process.argv[2])) !== 'recorded') process.exit(74);
    process.exit(73);
  `, crashPath, JSON.stringify(fingerprint)], { encoding: 'utf8' });
  assert.equal(worker.status, 73, worker.stderr);
  reservations = new LangConfigReservations(crashPath);
  assert.equal(reservations.reserve(fingerprint), 'unknown');
  reservations.close();
  const racePath = path.join(dir, 'langconfig-race.sqlite');
  new LangConfigReservations(racePath).close();
  const raceProgram = `
    import { LangConfigReservations } from ${JSON.stringify(moduleUrl)};
    const store = new LangConfigReservations(process.argv[1]);
    console.log(store.reserve(JSON.parse(process.argv[2]))); store.close();
  `;
  const contenders = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', raceProgram, racePath, JSON.stringify(fingerprint)],
      { stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(30000) });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Reservation contender failed: ${stderr}`)));
  })));
  assert.deepEqual(contenders.sort(), ['recorded', 'unknown', 'unknown', 'unknown']);
  const observation = { status: 'approved' as const, bindingHash: fingerprint.bindingHash, external };
  const local = { journal, admission, nodeId: 'implement', attemptId: 'write-attempt', requestId: 'write-request' };
  const beforeObservation = await journal.read();
  let reads = 0;
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: { observe: async () => { reads++; return observation; } } }),
    { outcome: 'unknown', comparison: 'matched' });
  assert.equal(reads, 2);
  for (const second of [{ ...observation, status: 'revoked' }, { ...observation, external: { ...external, checkpointId: 'changed' } },
    { ...observation, bindingHash: '0'.repeat(64) }, null]) {
    let n = 0;
    assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: { observe: async () => ++n === 1 ? observation : second } }),
      { outcome: 'unknown', comparison: 'unavailable' });
  }
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: { observe: async () => { throw new Error('external secret'); } } }),
    { outcome: 'unknown', comparison: 'unavailable' });
  const keys = generateKeyPairSync('ed25519'), wrongKeys = generateKeyPairSync('ed25519'), now = Date.now();
  const pem = String(keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const claims = { issuer: 'fixture-issuer', keyId: 'fixture-key', issuedAtMs: now - 100, expiresAtMs: now + 10_000, challenge: '0'.repeat(64),
    ...observation, status: 'approved' as 'approved' | 'revoked' };
  const signed = (value: typeof claims, key = keys.privateKey) => ({ claims: value,
    signature: sign(null, Buffer.from(`neomind/langconfig-authority-observation/v2:${hashJson(value)}`), key).toString('base64url') });
  const signedReader = (fetch: (signal: AbortSignal, challenge: string) => Promise<unknown>, timeoutMs = 1000) => new SignedLangConfigAuthorityReader({
    publicKeyPem: pem, issuer: 'fixture-issuer', keyId: 'fixture-key', fetch, now: () => now, timeoutMs });
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: signedReader(async (_signal, challenge) => signed({ ...claims, challenge })) }),
    { outcome: 'unknown', comparison: 'matched' });
  let signedReads = 0;
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: signedReader(async (_signal, challenge) =>
    signed({ ...claims, challenge, status: ++signedReads === 1 ? 'approved' : 'revoked' })) }),
  { outcome: 'unknown', comparison: 'unavailable' });
  const invalid = [
    (challenge: string) => signed({ ...claims, challenge }, wrongKeys.privateKey),
    (challenge: string) => ({ ...signed({ ...claims, challenge }), claims: { ...claims, challenge, status: 'revoked' } }),
    (challenge: string) => signed({ ...claims, challenge, status: 'revoked' }),
    (challenge: string) => signed({ ...claims, challenge, issuer: 'other' }),
    (challenge: string) => signed({ ...claims, challenge, expiresAtMs: now - 1 }),
    (challenge: string) => signed({ ...claims, challenge, issuedAtMs: now + 1 }),
    (challenge: string) => signed({ ...claims, challenge, expiresAtMs: now + 40_000 }),
  ];
  for (const bad of invalid) {
    assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: signedReader(async (_signal, challenge) => bad(challenge)) }),
      { outcome: 'unknown', comparison: 'unavailable' });
  }
  let replayed: ReturnType<typeof signed> | undefined;
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: signedReader(async (_signal, challenge) =>
    replayed ??= signed({ ...claims, challenge })) }), { outcome: 'unknown', comparison: 'unavailable' });
  let aborted = false;
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: signedReader(async signal => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  }, 20) }), { outcome: 'unknown', comparison: 'unavailable' });
  assert.equal(aborted, true);
  const issuerScript = fileURLToPath(new URL('./helpers/langconfig-authority-issuer.js', import.meta.url));
  const issuer = spawn(process.execPath, [issuerScript, JSON.stringify({ bindingHash: fingerprint.bindingHash, external })], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/dev/null', LANG: 'C.UTF-8' },
  });
  let issuerError = '';
  issuer.stderr.on('data', chunk => { issuerError += String(chunk); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    issuer.once('error', reject); issuer.once('close', (code, signal) => resolve({ code, signal }));
  });
  const issuerLines = createInterface({ input: issuer.stdout, crlfDelay: Infinity });
  const lineIterator = issuerLines[Symbol.asyncIterator]();
  const nextIssuerEvent = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const item = await Promise.race([lineIterator.next(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Issuer fixture timed out: ${issuerError}`)), 10000);
      })]);
      if (item.done) throw new Error(`Issuer fixture exited: ${issuerError}`);
      return JSON.parse(item.value) as Record<string, unknown>;
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    const ready = await nextIssuerEvent();
    assert.equal(ready.event, 'ready');
    assert.ok(Number.isInteger(ready.port) && Number(ready.port) > 0 && Number(ready.port) < 65536);
    assert.equal(typeof ready.publicKey, 'string');
    let captured: unknown;
    const transport = async (signal: AbortSignal, challenge: string) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}/observation?challenge=${challenge}`, { signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('Fixture response unavailable');
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 16384) throw new Error('Fixture response exceeds limit');
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
      captured ??= body;
      return body;
    };
    const loopbackReader = new SignedLangConfigAuthorityReader({ publicKeyPem: String(ready.publicKey),
      issuer: 'fixture-issuer', keyId: 'fixture-key', fetch: transport });
    assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: loopbackReader }), { outcome: 'unknown', comparison: 'matched' });
    const transportPath = path.join(dir, 'langconfig-loopback.sqlite');
    const transportReservations = new LangConfigReservations(transportPath);
    try {
      assert.equal(transportReservations.reserve(fingerprint), 'recorded');
      issuer.stdin.write('revoke\n');
      assert.equal((await nextIssuerEvent()).event, 'revoked');
      assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: loopbackReader }), { outcome: 'unknown', comparison: 'unavailable' });
      const replayReader = new SignedLangConfigAuthorityReader({ publicKeyPem: String(ready.publicKey),
        issuer: 'fixture-issuer', keyId: 'fixture-key', fetch: async () => captured });
      assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: replayReader }), { outcome: 'unknown', comparison: 'unavailable' });
      assert.equal(transportReservations.reserve(fingerprint), 'unknown');
      issuer.kill('SIGKILL');
      assert.equal((await ended).signal, 'SIGKILL');
      assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: loopbackReader }), { outcome: 'unknown', comparison: 'unavailable' });
    } finally { transportReservations.close(); }
    const recoveredReservations = new LangConfigReservations(transportPath);
    try { assert.equal(recoveredReservations.reserve(fingerprint), 'unknown'); }
    finally { recoveredReservations.close(); }
  } finally {
    if (issuer.exitCode === null && issuer.signalCode === null) issuer.kill('SIGKILL');
    await ended;
    issuerLines.close(); issuer.stdin.destroy();
  }
  let leaseReads = 0;
  assert.deepEqual(await observeLangConfigWriterBinding({ local, authority: { observe: async () => {
    if (++leaseReads === 2) coordinator.quarantine(lease);
    return observation;
  } } }), { outcome: 'unknown', comparison: 'unavailable' });
  // No writer or worker has been started in this fixture yet.
  coordinator.clearQuarantine(lease, true);
  assert.deepEqual(await journal.read(), beforeObservation);
  await writeFile(path.join(workspace, 'a'), 'changed before binding');
  await assert.rejects(prepareLangConfigWriterBinding(bindingInput), /baseline changed/);
  await writeFile(path.join(workspace, 'a'), 'before');
  let calls = 0;
  const real = await realpath(workspace), implementer = await fakeRunnerSession('thread', { startTurn: async () => { calls++; return 'write-turn'; },
    workspace: real, access: { kind: 'write', writableRoots: [real] } });
  const scope = implementer.runner.scope, writer = new CodexWriteDispatch(journal, implementer.runner, implementer.session);
  await assert.rejects(service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', { ...admission, stopVerified: false }, scope), /Verified sandbox/);
  await assert.rejects(service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', { ...admission, runner: 'opencode', sandboxVerified: false }, scope), /Admission runner does not match/);
  assert.equal(calls, 0);
  await service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', admission, scope);
  await assert.rejects(prepareLangConfigWriterBinding(bindingInput), /not ready|already exists/);
  await writeFile(path.join(workspace, 'a'), 'after');
  await assert.rejects(service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'completed', { ...admission, workspace: primary }, scope), /does not match dispatch/);
  await service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'completed', admission, scope);
  const after = await service.report(); assert.equal(after.graph.nodes.repair?.status, 'ready');
  assert.equal(after.attempts.find(item => item.attemptId === 'write-attempt')?.baselineHash, (await captureBaseline(workspace)).baselineHash);
  const reviewedBaseline = after.attempts.find(item => item.attemptId === 'write-attempt')!.baselineHash!;
  await service.completeControl('repair');
  const reviewer = await fakeRunnerSession('review-thread', { startTurn: async () => 'review-turn', workspace: real });
  const review = new CodexReviewDispatch(journal, reviewer.runner, reviewer.session);
  // The implementer's own session must not review its work.
  const producerSession = await reviewer.runner.openSession({ workspace: real, binding: fakeBinding, access: { kind: 'read' }, resumeSessionId: 'thread' });
  await writeFile(path.join(workspace, 'a'), 'changed after implementation');
  await assert.rejects(service.dispatchReview(review, 'verify', 'required-reviewer', 'review-thread', 'review', 'low', 'review-attempt', 'review-request', reviewedBaseline, admission), /baseline changed/);
  await writeFile(path.join(workspace, 'a'), 'after');

  await assert.rejects(service.dispatchReview(new CodexReviewDispatch(journal, reviewer.runner, producerSession), 'verify', 'required-reviewer', 'thread', 'review', 'low', 'review-attempt', 'review-request', reviewedBaseline, admission), /independent session/);
  await service.dispatchReview(review, 'verify', 'required-reviewer', 'review-thread', 'review', 'low', 'review-attempt', 'review-request', reviewedBaseline, admission);
  const result = { threadId: 'review-thread', turnId: 'review-turn', status: 'completed' as const, messages: [JSON.stringify({ verdict: 'pass', findingIds: [], summary: 'Fixture checks pass' })] };
  await assert.rejects(service.recordReview(review, 'verify', 'wrong-reviewer', reviewedBaseline, 'review-attempt', result, admission), /does not match/);
  await service.recordReview(review, 'verify', 'required-reviewer', reviewedBaseline, 'review-attempt', result, admission);
  const assessments = { 'required-reviewer': { evidenceValidated: true, criteriaCovered: true, verifiedFindingIds: [], unresolvedDisagreement: false, mandatoryCriteriaFailed: false } };
  await assert.rejects(service.finishReview(review, 'verify', 'thread', reviewedBaseline, assessments, admission), /has not passed/);
  const checkTransport = { request: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
  const checkScope = { identity: { unit: 'neomind-run-efab.scope', controlGroup: '/user.slice/neomind-run-efab.scope' }, transport: checkTransport, isActive: async () => true, stop: async () => true };
  const check = new CodexCheckDispatch(journal, new CodexCheckExecutor(checkTransport));
  await service.runCheck(check, { id: 'tests', command: ['make', 'test'], cwd: workspace, timeoutMs: 10000 }, reviewedBaseline, admission, 'check-request', checkScope);
  const decision = await service.finishReview(review, 'verify', 'thread', reviewedBaseline, assessments, admission);
  assert.equal(decision.decision, 'pass'); assert.equal((await service.report()).graph.nodes.commit?.status, 'ready');
  const reviewed = await buildReviewTree(workspace, reviewedBaseline);
  const committed = await service.commit(new GitCommitDispatch(journal), { nodeId: 'commit', reviewNodeId: 'verify', workspace, lease, coordinator,
    livePolicy: defaultProject.policy, baselineHash: reviewedBaseline, parent: reviewed.head, tree: reviewed.tree, message: 'fixture', requestId: 'commit-request' });
  assert.equal(committed.tree, reviewed.tree);
  await service.completeControl('finish');
  assert.equal((await service.report()).graph.nodes.finish?.status, 'succeeded');


  await journal.close(); coordinator.release(lease, true); coordinator.releaseRun(owner, true); coordinator.close();
});

test('terminal writer event without verified worker stop quarantines workspace', async () => {
  const { RunService } = await import('../src/core/run-service.js');
  const { CodexReadOnlyDispatch } = await import('../src/core/codex-readonly-dispatch.js');
  const { CodexWriteDispatch } = await import('../src/core/codex-write-dispatch.js');
  const { OwnedJournal } = await import('../src/storage/owned-journal.js');
  const { templates } = await import('../src/domain/templates.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-quarantine-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree'); await mkdir(primary);
  const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(path.join(primary, 'a'), 'before'); git('add', 'a');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial'); git('worktree', 'add', '--detach', workspace, 'HEAD');
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), owner = coordinator.acquireRun('run', 'host');
  const lease = coordinator.acquire(workspace, 'run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, owner);
  const service = await RunService.create(journal, templates.dev, defaultProject.policy); await service.completeControl('start');
  const planner = await fakeRunnerSession('thread', { startTurn: async () => 'plan-turn' });
  const reader = new CodexReadOnlyDispatch(journal, planner.runner, planner.session);
  await service.dispatchReadOnly(reader, 'plan', 'thread', 'plan', 'low', 'plan-attempt', 'plan-request');
  const plan = { planId: 'p', version: 1, goal: 'edit', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
  await service.recordReadOnlyPlan(reader, 'plan-attempt', { threadId: 'thread', turnId: 'plan-turn', status: 'completed', messages: [JSON.stringify(plan)] });
  await service.approveProposedPlan('approval', 'plan', 'user', 'ui');
  const approval = (await service.report()).approvals[0]!.approval;
  const admission = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy, expectedBaselineHash: (await captureBaseline(workspace)).baselineHash, sandboxVerified: true, stopVerified: true };
  const real = await realpath(workspace), scope = fakeScope(async () => false);
  const implementer = await fakeRunnerSession('thread', { startTurn: async () => 'write-turn', workspace: real, access: { kind: 'write', writableRoots: [real] }, scope });
  const writer = new CodexWriteDispatch(journal, implementer.runner, implementer.session);
  await service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', admission, scope);
  await assert.rejects(service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'stopped', admission, scope), /quarantined/);
  assert.equal(coordinator.isCurrent(lease), false); assert.deepEqual((await service.report()).unresolvedAttemptIds, ['write-attempt']);
  await journal.close(); coordinator.release(lease, true); coordinator.releaseRun(owner, true); coordinator.close();
});
