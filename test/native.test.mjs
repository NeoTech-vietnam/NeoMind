import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRecord } from '../dist/storage.js';
import { initialize } from '../dist/storage.js';
import {
  createNativeBridge,
  ensureNativeRuntime,
  startNative,
  shutdownNative,
} from '../dist/native.js';
import {
  ensureRoutingPolicy,
  readInvocation,
  roleModelPolicy,
  routingProblems,
} from '../dist/routing.js';
const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-native-'));
  initialize(root, { project_id: 'NATIVE-TEST', name: 'Native protocol fixture' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function bridge(scenario = 'success') {
  return createNativeBridge({
    rpc_timeout_ms: scenario === 'initialize-timeout' ? 200 : 5000,
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [fixture, scenario],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
}
test('Copilot routing never installs Codex, including mixed-platform projects', async (t) => {
  for (const platforms of [['copilot'], ['codex', 'claude', 'copilot']]) {
    const root = project(t);
    const path = join(root, '.neomind/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.platforms = platforms;
    writeFileSync(path, JSON.stringify(config));
    await assert.rejects(ensureNativeRuntime(root), /VS Code bridge.*disabled|descriptor.*stale/);
    const receipt = await startNative(root, {
      role: 'manager',
      prompt: 'Inspect a bounded requirement.',
    });
    assert.equal(receipt.state, 'blocked');
    assert.equal(receipt.inference_completed, false);
    assert.equal(receipt.native_thread_id, null);
    assert.match(receipt.error, /VS Code bridge.*disabled|descriptor.*stale/);
    assert.equal(existsSync(join(root, '.neomind/tools/codex')), false);
  }
});
test('native receipts bind acknowledged model, completion and invocation identity', async (t) => {
  const root = project(t),
    native = bridge();
  const running = await native.start(root, {
    role: 'manager',
    prompt: 'Inspect a bounded requirement.',
    workflow_id: 'WF-1',
    request_id: 'intake-1',
  });
  assert.equal(running.confirmed_model, 'claude-opus-4.6');
  assert.equal(running.state, 'running');
  assert.match(
    routingProblems(root, 'manager', running.id, {
      workflow_id: 'WF-1',
      require_completed: false,
    }).join(' '),
    /Protocol fixture/,
  );
  assert.match(routingProblems(root, 'manager', running.id).join(' '), /not completed/);
  const completed = await native.wait(root, running.id, 1000);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.inference_completed, true);
  assert.match(
    routingProblems(root, 'manager', running.id, { workflow_id: 'WF-1' }).join(' '),
    /Protocol fixture/,
  );
  assert.equal(completed.execution_mode, 'protocol-fixture');
  assert.equal(
    (
      await native.start(root, {
        role: 'manager',
        prompt: 'Inspect a bounded requirement.',
        workflow_id: 'WF-1',
        request_id: 'intake-1',
      })
    ).id,
    running.id,
  );
  assert.match(
    routingProblems(root, 'reviewer', running.id).join(' '),
    /different engineering role/,
  );
  assert.match(
    routingProblems(root, 'manager', running.id, { workflow_id: 'WF-2' }).join(' '),
    /different workflow/,
  );
});
test('native acknowledgment mismatch or missing model prevents turn execution', async (t) => {
  const root = project(t);
  for (const scenario of ['wrong-model', 'missing-model', 'wrong-effort']) {
    const receipt = await bridge(scenario).start(root, {
      role: 'architect',
      prompt: 'Design a bounded component.',
    });
    assert.equal(receipt.state, 'blocked');
    assert.equal(receipt.native_turn_id, null);
    assert.equal(receipt.inference_completed, false);
  }
});
test('unavailable worker model blocks rather than retrying the same model as fallback', async (t) => {
  const root = project(t);
  for (const scenario of ['unavailable', 'turn-unavailable']) {
    const native = bridge(scenario);
    const started = await native.start(root, {
      role: 'developer',
      prompt: 'Implement a prescribed bounded edit.',
    });
    const completed = await native.wait(root, started.id, 1000);
    assert.equal(completed.state, scenario === 'unavailable' ? 'blocked' : 'failed');
    assert.equal(completed.inference_completed, false);
    assert.equal(completed.requested_model, 'gpt-5.4');
    assert.equal(completed.fallback_evidence, null);
    assert.match(completed.error, /gpt-5\.4.*(?:not supported|unavailable)/);
  }
  const blocked = await bridge('auth-missing').start(root, {
    role: 'developer',
    prompt: 'Run a prescribed check.',
  });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.requested_model, 'gpt-5.4');
  assert.equal(blocked.fallback_evidence, null);
});
test('worker fallback follows dynamically configured alternatives only after native unavailability', async (t) => {
  for (const scenario of ['unavailable', 'turn-unavailable']) {
    const root = project(t);
    const policy = ensureRoutingPolicy(root);
    policy.worker_models = ['gpt-5.4', 'gemini-2.5-flash-lite'];
    writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
    const native = bridge(scenario);
    const started = await native.start(root, {
      role: 'developer',
      prompt: 'Implement a bounded change.',
    });
    const completed = await native.wait(root, started.id, 1000);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.confirmed_model, 'gemini-2.5-flash-lite');
    assert.equal(completed.fallback_evidence.model, 'gpt-5.4');
    assert.deepEqual(roleModelPolicy(root, 'developer').models, policy.worker_models);
  }
});
test('native rerouting and configuration mutation invalidate completion', async (t) => {
  const root = project(t);
  for (const scenario of ['reroute', 'changed-config']) {
    const native = bridge(scenario);
    const started = await native.start(root, {
      role: 'reviewer',
      prompt: 'Review the bounded result.',
    });
    const completed = await native.wait(root, started.id, 5000);
    assert.equal(completed.state, 'blocked');
    assert.equal(completed.inference_completed, false);
    assert.ok(routingProblems(root, 'reviewer', completed.id).length);
  }
});
test('native permission callbacks remain blocked and are never automatically approved', async (t) => {
  const root = project(t),
    native = bridge('permission');
  const started = await native.start(root, {
    role: 'check-executor',
    prompt: 'Run a prescribed check.',
  });
  const deadline = Date.now() + 5000;
  let waiting = native.status(root, started.id);
  while (waiting.state === 'running' && Date.now() < deadline)
    waiting = await native.wait(root, started.id, 100);
  assert.equal(waiting.state, 'waiting-native-permission');
  assert.equal(waiting.permissions.length, 1);
  assert.match(
    routingProblems(root, 'check-executor', waiting.id, { require_completed: false }).join(' '),
    /blocked/,
  );
  const interrupted = await native.interrupt(root, started.id);
  assert.equal(interrupted.state, 'interrupted');
});
test('bounded waits leave live work persisted and enforce worker concurrency', async (t) => {
  const root = project(t),
    native = bridge('hang');
  const receipts = [];
  for (let index = 0; index < 3; index++) {
    const task = createRecord(root, {
      type: 'task',
      title: `Protocol fixture task ${index}`,
      owner: 'developer',
    });
    receipts.push(
      await native.start(root, {
        role: 'developer',
        prompt: 'Implement a prescribed change.',
        task_id: task.meta.id,
      }),
    );
  }
  assert.equal((await native.wait(root, receipts[0].id, 0)).state, 'running');
  await assert.rejects(native.wait(root, receipts[0].id, 60001), /between 0 and 60000/);
  await assert.rejects(
    native.start(root, { role: 'developer', prompt: 'Fourth concurrent change.' }),
    /maximum concurrent/,
  );
  await assert.rejects(
    native.start(root, {
      role: 'developer',
      prompt: 'Duplicate task change.',
      task_id: receipts[0].task_id,
    }),
    /already has a live/,
  );
});
test('signed receipt tampering and post-completion configuration changes are rejected', async (t) => {
  const root = project(t),
    native = bridge();
  const started = await native.start(root, {
    role: 'reviewer',
    prompt: 'Inspect independent review evidence.',
  });
  const completed = await native.wait(root, started.id, 1000);
  const path = join(root, completed.receipt_path),
    source = readFileSync(path, 'utf8');
  const forged = JSON.parse(source);
  forged.confirmed_model = 'gpt-6-luna';
  writeFileSync(path, JSON.stringify(forged));
  assert.throws(() => readInvocation(root, completed.id), /signature/);
  writeFileSync(path, source);
  writeFileSync(join(root, '.neomind/tools.json'), '{}');
  assert.match(routingProblems(root, 'reviewer', completed.id).join(' '), /configuration changed/);
  assert.ok(existsSync(join(root, '.neomind/native/trust.json')));
});
test('resume creates a new receipt and preserves the interrupted invocation', async (t) => {
  const root = project(t),
    native = bridge();
  const task = createRecord(root, {
    type: 'task',
    title: 'Resumed protocol fixture task',
    owner: 'developer',
  });
  const first = await native.start(root, {
    role: 'developer',
    prompt: 'Implement a prescribed change.',
    task_id: task.meta.id,
  });
  await native.wait(root, first.id, 1000);
  await new Promise((done) => setTimeout(done, 50));
  const second = await native.resume(root, first.id, {
    prompt: 'Continue with fresh task evidence.',
    request_id: 'resume-1',
  });
  assert.notEqual(first.id, second.id);
  assert.equal(second.prior_invocation_id, first.id);
  assert.equal(second.native_thread_id, first.native_thread_id);
  assert.equal((await native.wait(root, second.id, 1000)).state, 'completed');
  assert.equal(readInvocation(root, first.id).state, 'completed');
});
test('protocol timeout records a resumable blocker without claiming inference', async (t) => {
  const root = project(t);
  const receipt = await bridge('initialize-timeout').start(root, {
    role: 'requirements',
    prompt: 'Describe measurable requirements.',
  });
  assert.equal(receipt.state, 'blocked');
  assert.match(receipt.error, /timed out/);
  assert.equal(receipt.inference_completed, false);
});
test('native tool preapproval is scoped to the approved role gateway and preserves authored conflicts', async (t) => {
  const root = project(t),
    native = bridge('approval-scope');
  const started = await native.start(root, {
    role: 'reviewer',
    prompt: 'Inspect source and submit independent review.',
  });
  const completed = await native.wait(root, started.id, 1000),
    observed = JSON.parse(completed.output);
  assert.equal(observed.approvalPolicy, null);
  assert.equal(observed.sandbox, 'read-only');
  assert.deepEqual(Object.keys(observed.config).sort(), [
    'mcp_servers.neomind',
    'model_reasoning_effort',
  ]);
  const gateway = observed.config['mcp_servers.neomind'];
  assert.ok(gateway.enabled_tools.includes('record_review'));
  assert.ok(!gateway.enabled_tools.includes('record_update'));
  assert.ok(!gateway.enabled_tools.includes('task_file_write'));
  assert.ok(!gateway.enabled_tools.includes('check_inspect'));
  assert.ok(Object.values(gateway.tools).every((tool) => tool.approval_mode === 'approve'));
  const rejected = await bridge('explicit-tool-policy').start(root, {
    role: 'reviewer',
    prompt: 'Inspect source only.',
  });
  assert.equal(rejected.state, 'blocked');
  assert.match(rejected.error, /Authored NeoMind tool approval policy/);
  assert.equal(rejected.native_turn_id, null);
});

test('native scoped editing capability is exposed only to a new Developer invocation', async (t) => {
  const root = project(t),
    native = bridge('approval-scope');
  const started = await native.start(root, {
    role: 'developer',
    prompt: 'Observe task editing scope mechanics only.',
  });
  const completed = await native.wait(root, started.id, 5000);
  assert.equal(completed.state, 'completed');
  const observed = JSON.parse(completed.output),
    gateway = observed.config['mcp_servers.neomind'];
  assert.equal(observed.approvalPolicy, null);
  assert.equal(observed.sandbox, null);
  assert.ok(gateway.enabled_tools.includes('task_file_write'));
  assert.equal(gateway.tools.task_file_write.approval_mode, 'approve');
  assert.ok(completed.native_tool_scope.includes('task_file_write'));
  assert.match(routingProblems(root, 'developer', completed.id).join(' '), /Protocol fixture/);
  const inspecting = await native.start(root, {
    role: 'check-executor',
    prompt: 'Observe only the scoped inspection gateway mechanics.',
  });
  const inspected = await native.wait(root, inspecting.id, 5000);
  assert.equal(inspected.state, 'completed');
  const inspectionGateway = JSON.parse(inspected.output).config['mcp_servers.neomind'];
  assert.ok(inspectionGateway.enabled_tools.includes('check_inspect'));
  assert.ok(!inspectionGateway.enabled_tools.includes('task_file_write'));
  assert.equal(inspectionGateway.tools.check_inspect.approval_mode, 'approve');
  assert.ok(inspected.native_tool_scope.includes('check_inspect'));
});
