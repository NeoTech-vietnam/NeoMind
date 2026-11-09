import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('./vscode-client-driver/native-local/extension.cjs', import.meta.url), 'utf8');
const hookSource = fs.readFileSync(new URL('./vscode-client-driver/native-local/hook.cjs', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { open, details, response } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'workforce-driver-')));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const fixture = { evidence: join(root, 'evidence'), workspace: join(root, 'workspace'), coordinator: 'WF.PM Native Proof',
    worker: 'WF.Tester Native Proof', marker: 'WORKFORCE_M2_NATIVE_CHECK_PASSED' };
  for (const path of [fixture.evidence, fixture.workspace]) fs.mkdirSync(path);
  const prompt = `Delegate once to ${fixture.worker}. Ask it to read m2-fixture.test.cjs, run node --test m2-fixture.test.cjs in this workspace, and report its observed result. Keep all files unchanged.`;
  const models = ['model-a', 'model-b'].map(id => ({ id, name: id, vendor: 'customendpoint' }));
  const calls = [], registered = new Map();
  let watcher, current, currentQuery = prompt, currentMode = fixture.coordinator;
  const local = 'workbench.action.chat.newLocalChat', chat = 'workbench.action.chat.open', exported = 'workbench.action.chat.export';
  const uri = path => ({ scheme: 'file', fsPath: path });
  const vscode = {
    version: '1.143.0', ExtensionMode: { Test: 3 }, Uri: { file: uri },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(fixture.workspace) }],
      getConfiguration: () => ({ get: () => true }), onDidGrantWorkspaceTrust: () => ({ dispose() {} }) },
    extensions: { getExtension: () => ({ packageJSON: { version: 'test' } }) },
    lm: { selectChatModels: async () => models, tools: [{ name: 'runSubagent', inputSchema: { properties: { model: {} } } }] },
    commands: {
      getCommands: async () => [local, chat, exported],
      registerCommand: (name, callback) => { registered.set(name, callback); return { dispose() {} }; },
      async executeCommand(name, input) {
        if (name === local) return;
        if (name === chat) {
          current = input.modelSelector.id;
          currentQuery = input.query; currentMode = input.mode;
          calls.push({ model: current, query: input.query, mode: input.mode, wait_for_response: input.blockOnResponse,
            policy: JSON.parse(fs.readFileSync(join(fixture.evidence, 'model-policy.json'), 'utf8')),
            attachments: input.attachFiles?.map(uri => uri.fsPath) });
          await open?.(current);
          return { type: 'complete' };
        }
        if (name === exported) {
          fs.writeFileSync(input.fsPath, JSON.stringify({ requests: [{ message: { text: currentQuery }, modelId: current,
            modeInfo: { modeInstructions: { name: currentMode } }, response: response ?? [{ text: fixture.marker }],
            responseErrorDetails: typeof details === 'function' ? details(current) : details }] }));
          return;
        }
        assert.fail(`Unexpected native command: ${name}`);
      },
    },
    window: { showQuickPick() { assert.fail('No model picker should open in an authorized test'); },
      showTextDocument() { assert.fail('No document window should open in this test'); } },
  };
  const load = () => {
    const module = { exports: {} };
    runInNewContext(source, { module, process, require(name) {
      if (name === 'vscode') return vscode;
      if (name === './fixture.json') return fixture;
      if (name === 'node:fs') return { ...fs, watch(path, callback) {
        assert.equal(path, fixture.evidence);
        watcher = callback;
        return { close() {} };
      } };
      return require(name);
    } });
    return module.exports;
  };
  const driver = load();
  const authorization = (id, model = 'model-a') => ({ allow_chat_dispatch: true, run_id: basename(dirname(fixture.evidence)),
    prompt_sha256: hash(prompt), attempt_id: id, parent: { vendor: 'customendpoint', id: model },
    worker: { vendor: 'customendpoint', id: model } });
  const read = (id, name) => JSON.parse(fs.readFileSync(join(fixture.evidence, 'attempts', id, name), 'utf8'));
  const bytes = id => Object.fromEntries(fs.readdirSync(join(fixture.evidence, 'attempts', id))
    .map(name => [name, fs.readFileSync(join(fixture.evidence, 'attempts', id, name), 'utf8')]));
  return { ...driver, fixture, calls, read, bytes, authorization, reload: load,
    activate: () => driver.activate({ extensionMode: 1, subscriptions: [] }),
    command: name => registered.get(name)?.(),
    authorize(input) { fs.writeFileSync(join(fixture.evidence, 'authorize.json'), JSON.stringify(input)); watcher('change', 'authorize.json'); } };
}

test('authorized proof observes later root authorization after completed attempt A', { timeout: 5000 }, async t => {
  const driver = setup(t);
  driver.activate();
  driver.authorize(driver.authorization('attempt-a'));
  await driver.queueAuthorizedProof(driver.authorization('attempt-a'));
  driver.authorize(driver.authorization('attempt-b', 'model-b'));
  await driver.queueAuthorizedProof(driver.authorization('attempt-b', 'model-b'));
  assert.deepEqual(driver.calls.map(call => call.model), ['model-a', 'model-b']);
  assert.equal(driver.read('attempt-a', 'dispatch.json').parent.id, 'model-a');
  assert.equal(driver.read('attempt-b', 'dispatch.json').parent.id, 'model-b');
  assert.equal(driver.read('attempt-a', 'chat-observation.json').parent_model, 'model-a');
  assert.equal(driver.read('attempt-b', 'chat-observation.json').parent_model, 'model-b');
});

test('capture recognizes actual professional workers after changing selectors without relying on the static fixture worker', async t => {
  const response = ['WF.P-RES Worker', 'WF.FnD Worker', 'Unknown Worker'].map(agentName => ({
    toolId: 'runSubagent', kind: 'toolInvocationSerialized', toolSpecificData: { agentName, modelId: 'customendpoint/worker-model' },
  }));
  response.push({ toolId: 'otherTool', toolSpecificData: { agentName: 'WF.Tester Worker' } });
  const driver = setup(t, { response }); driver.activate();
  await driver.queueAuthorizedProof(driver.authorization('actual-workers'));
  const calls = driver.read('actual-workers', 'chat-observation.json').calls;
  assert.deepEqual(calls.map(call => call.native_worker), [true, true, false, false]);
  assert.equal(calls[1].observed_child_model, 'customendpoint/worker-model');
});

test('the proof attaches the actual context folder through the native chat API', { timeout: 5000 }, async t => {
  const driver = setup(t);
  driver.fixture.attachments = ['chapter'];
  fs.mkdirSync(join(driver.fixture.workspace, 'chapter'));
  await driver.queueAuthorizedProof(driver.authorization('attached'));
  assert.deepEqual(driver.calls[0].attachments, [join(driver.fixture.workspace, 'chapter')]);
});

test('explicit hashed role requests preserve each prompt, native selector and attachment without reloading', { timeout: 5000 }, async t => {
  const driver = setup(t);
  fs.writeFileSync(join(driver.fixture.workspace, 'source.mjs'), 'export const value = 1;\n');
  for (const [id, coordinator, prompt] of [['role-swsd', 'WF.SWSD', 'Define observable acceptance criteria.'],
    ['role-review', 'WF.Reviewer', 'Review the existing source without edits.']]) {
    const request = { prompt, coordinator, attachments: ['source.mjs'] };
    const input = { ...driver.authorization(id), request, request_sha256: hash(JSON.stringify(request)), prompt_sha256: hash(prompt) };
    await driver.queueAuthorizedProof(input);
    assert.equal(driver.read(id, 'dispatch.json').prompt_sha256, hash(prompt));
    assert.equal(driver.read(id, 'chat-observation.json').mode, coordinator);
  }
  assert.deepEqual(driver.calls.map(call => call.mode), ['WF.SWSD', 'WF.Reviewer']);
  assert.deepEqual(driver.calls.map(call => call.query), ['Define observable acceptance criteria.', 'Review the existing source without edits.']);
  assert.deepEqual(Array.from(driver.calls[1].attachments), [join(driver.fixture.workspace, 'source.mjs')]);
});

test('request hashes, role names and owned attachment paths are checked before native dispatch', { timeout: 5000 }, async t => {
  const driver = setup(t);
  const request = { prompt: 'Inspect only', coordinator: 'WF.Tester', attachments: [] };
  const base = { ...driver.authorization('invalid-role'), request, request_sha256: hash(JSON.stringify(request)), prompt_sha256: hash(request.prompt) };
  await assert.rejects(driver.queueAuthorizedProof({ ...base, request_sha256: '0'.repeat(64) }), /authorization/i);
  for (const changed of [{ coordinator: 'Unknown external agent' }, { attachments: ['../outside.txt'] }, { workspace: 'outside' }]) {
    const invalid = { ...request, ...changed };
    await assert.rejects(driver.queueAuthorizedProof({ ...base, request: invalid, request_sha256: hash(JSON.stringify(invalid)) }), /request|attachment/i);
  }
  assert.deepEqual(driver.calls, []);
});

test('nonblocking submission is explicitly authorized and never masquerades as response completion', { timeout: 5000 }, async t => {
  const driver = setup(t);
  driver.activate();
  const request = { prompt: 'Inspect the current implementation.', coordinator: 'WF.Reviewer', attachments: [], wait_for_response: false };
  const input = { ...driver.authorization('submit-without-wait'), request, request_sha256: hash(JSON.stringify(request)),
    prompt_sha256: hash(request.prompt) };
  assert.equal((await driver.queueAuthorizedProof(input)).status, 'submitted');
  assert.equal(driver.calls[0].wait_for_response, false);
  assert.equal(driver.read(input.attempt_id, 'attempt.json').wait_for_response, false);
  assert.equal(driver.read(input.attempt_id, 'attempt.json').request_sha256, hash(JSON.stringify(request)));
  assert.equal(driver.read(input.attempt_id, 'dispatch.json').wait_for_response, false);
  assert.equal(driver.read(input.attempt_id, 'command-outcome.json').status, 'submitted');
  const observation = join(driver.fixture.evidence, 'attempts', input.attempt_id, 'chat-observation.json');
  assert.equal(fs.existsSync(observation), false, 'Submission alone never exports a completion observation');
  await driver.command('workforceM2.capture');
  assert.equal(driver.read(input.attempt_id, 'chat-observation.json').mode, 'WF.Reviewer', 'A separate later capture remains available');
});

test('wait mode is a strict boolean in the immutable request authorization; old proofs still await responses', { timeout: 5000 }, async t => {
  const driver = setup(t), request = { prompt: 'Inspect only.', coordinator: 'WF.SWSD', attachments: [], wait_for_response: false };
  const input = { ...driver.authorization('wait-contract'), request, request_sha256: hash(JSON.stringify(request)), prompt_sha256: hash(request.prompt) };
  await assert.rejects(driver.queueAuthorizedProof({ ...input, request: { ...request, wait_for_response: true } }), /authorization/i);
  for (const flag of ['false', 0, null, {}]) {
    const invalid = { ...request, wait_for_response: flag };
    await assert.rejects(driver.queueAuthorizedProof({ ...input, request: invalid, request_sha256: hash(JSON.stringify(invalid)) }), /request/i);
  }
  assert.equal(driver.calls.length, 0);
  const legacy = driver.authorization('legacy-default');
  assert.equal((await driver.queueAuthorizedProof(legacy)).status, 'returned');
  assert.equal(driver.calls[0].wait_for_response, true);
  assert.equal(driver.read(legacy.attempt_id, 'command-outcome.json').status, 'returned');
  assert.equal(driver.read(legacy.attempt_id, 'attempt.json').wait_for_response, true);
});

test('duplicate authorization neither redispatches nor overwrites durable evidence, including after reload', { timeout: 5000 }, async t => {
  const driver = setup(t);
  const input = driver.authorization('attempt-a');
  await driver.queueAuthorizedProof(input);
  const before = driver.bytes('attempt-a');
  assert.equal((await driver.queueAuthorizedProof({ ...input, parent: { id: 'model-b', vendor: 'customendpoint' } })).status, 'already-recorded');
  assert.equal(driver.calls.length, 1);
  assert.deepEqual(driver.bytes('attempt-a'), before);
  assert.equal((await driver.reload().queueAuthorizedProof(input)).status, 'already-recorded');
  assert.deepEqual(driver.bytes('attempt-a'), before);
  // A durable older ledger from before attempt.json was added also blocks replay.
  fs.unlinkSync(join(driver.fixture.evidence, 'attempts', 'attempt-a', 'attempt.json'));
  const oldLedger = driver.bytes('attempt-a');
  assert.equal((await driver.queueAuthorizedProof(input)).status, 'already-recorded');
  assert.deepEqual(driver.bytes('attempt-a'), oldLedger);
});

test('concurrent authorizations keep captured inputs, hook policy and exports in their own attempts', { timeout: 5000 }, async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const driver = setup(t, { open: model => model === 'model-a' ? waiting : undefined });
  const inputA = driver.authorization('attempt-a');
  inputA.request = { prompt: 'Define the acceptance criteria.', coordinator: 'WF.SWSD', attachments: [] };
  inputA.prompt_sha256 = hash(inputA.request.prompt); inputA.request_sha256 = hash(JSON.stringify(inputA.request));
  const attemptA = driver.queueAuthorizedProof(inputA);
  await tick();
  assert.equal(driver.calls.length, 1);
  const inputB = driver.authorization('attempt-b', 'model-b');
  inputB.request = { prompt: 'Review the criteria independently.', coordinator: 'WF.Reviewer', attachments: [] };
  inputB.prompt_sha256 = hash(inputB.request.prompt); inputB.request_sha256 = hash(JSON.stringify(inputB.request));
  const attemptB = driver.queueAuthorizedProof(inputB);
  inputB.parent.id = 'model-a';
  inputB.worker.id = 'model-a';
  inputB.request.prompt = 'An unapproved mutation must never be dispatched.';
  inputB.request.attachments.push('../outside');
  const duplicateA = driver.queueAuthorizedProof(inputA);
  await tick();
  assert.equal(driver.calls.length, 1, 'The second chat must wait until the first export finishes');
  release();
  await Promise.all([attemptA, attemptB, duplicateA]);
  assert.deepEqual(driver.calls.map(call => [call.model, call.policy.override]), [
    ['model-a', 'model-a (customendpoint)'], ['model-b', 'model-b (customendpoint)'],
  ]);
  assert.deepEqual(driver.calls.map(call => [call.mode, call.query]), [
    ['WF.SWSD', 'Define the acceptance criteria.'], ['WF.Reviewer', 'Review the criteria independently.'],
  ]);
  for (const [id, model] of [['attempt-a', 'model-a'], ['attempt-b', 'model-b']]) {
    assert.equal(driver.read(id, 'dispatch.json').parent.id, model);
    assert.equal(driver.read(id, 'chat-observation.json').parent_model, model);
    assert.equal(fs.existsSync(join(driver.fixture.evidence, 'attempts', id, 'current-chat.raw.json')), false);
  }
});

test('successful response text is not classified as an error; actual native errors remain explicit', { timeout: 5000 }, async t => {
  const driver = setup(t, { details: model => model === 'model-b' ? { message: 'HTTP 429 provider quota exceeded' } : undefined });
  await driver.queueAuthorizedProof(driver.authorization('success'));
  const success = driver.read('success', 'chat-observation.json');
  assert.equal(success.failure, null);
  assert.equal(success.assistant_response_contains_fixture_marker, true);
  await driver.queueAuthorizedProof(driver.authorization('quota', 'model-b'));
  assert.equal(driver.read('quota', 'chat-observation.json').failure, 'provider-rate-limit');
});

test('unrecognized native error details stay unclassified rather than becoming success', { timeout: 5000 }, async t => {
  const driver = setup(t, { details: { message: 'A new native error shape' } });
  await driver.queueAuthorizedProof(driver.authorization('unknown'));
  assert.equal(driver.read('unknown', 'chat-observation.json').failure, 'unclassified-native-error');
});

test('native hook retains only sanitized target and requested model labels', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'runSubagent', tool_input: {
    agentName: 'Other Agent', model: 'top-models (customendpoint)', prompt: 'Do not retain this private prompt',
  } };
  let observation;
  runInNewContext(hookSource, { __dirname: '/fixture/workspace', process: { stdout: { write() { assert.fail('No override for an unrelated target'); } } },
    require(name) {
      if (name.endsWith('fixture.json')) return { evidence: '/fixture/evidence', worker: 'WF.Tester Native Proof', marker: 'MARKER' };
      if (name === 'node:fs') return { readFileSync: descriptor => { assert.equal(descriptor, 0); return JSON.stringify(input); },
        appendFileSync: (_path, value) => { observation = JSON.parse(value); } };
      return require(name);
    } });
  assert.equal(observation.target, null);
  assert.equal(observation.target_name, 'Other Agent');
  assert.equal(observation.requested_model, 'top-models (customendpoint)');
  assert.equal(JSON.stringify(observation).includes(input.tool_input.prompt), false);
});
