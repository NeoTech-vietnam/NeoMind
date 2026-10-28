import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { controller, universe } from './helpers/workforce-ui.mjs';
import { createPreviewServer, createPreviewSnapshot } from '../scripts/preview-monitor.mjs';

const fixture = (ui, name) => { const snapshot = createPreviewSnapshot(name); ui.message(snapshot); ui.message(snapshot.request_snapshot); return snapshot; };
const { publicStatus } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/controlled-workflows.cjs');

test('preview data is deterministic, keeps exactly six role aliases and makes no readiness claim', () => {
  const snapshot = createPreviewSnapshot();
  assert.equal(snapshot.roles.length, 6);
  assert.deepEqual(snapshot.roles.map(role => role.name), ['WF.PM', 'WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']);
  assert.ok(snapshot.roles.every(role => role.models.every(model => ['top-models', 'worker-models'].includes(model))));
  assert.equal(snapshot.setup.ready, false); assert.equal(snapshot.preview, true);
  assert.deepEqual(createPreviewSnapshot(), snapshot);
  assert.equal(createPreviewSnapshot('empty').request_snapshot.workflows.length, 0);
  assert.equal(universe.buildScene(snapshot.request_snapshot.workflows[0]).stages.find(stage => stage.id === 'unit').state, 'running');
});

test('preview serves the real renderer, controller and FocusSpace assets without production mutation', async t => {
  const server = createPreviewServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`, html = await (await fetch(base)).text();
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['/universe.js', '/focus-space.js', '/monitor.js']);
  assert.match(html, /FIXTURE PREVIEW/); assert.match(html, /no request, file or model change was made/i);
  for (const path of [...scripts, '/monitor.css', '/focus-space.css']) {
    const response = await fetch(base + path); assert.equal(response.status, 200);
    assert.equal(await response.text(), readFileSync(new URL(`../extensions/vscode-model-bridge/resources/monitor${path}`, import.meta.url), 'utf8'));
  }
  const question = await (await fetch(base + '/snapshot?fixture=question')).json();
  assert.ok(question.request_snapshot.workflows[0].question);
  assert.equal((await (await fetch(base + '/snapshot?fixture=error')).json()).type, 'error');
  assert.equal((await fetch(base + '/snapshot', { method: 'POST' })).status, 405);
});

test('controller renders per-request products, criteria and V-model state from the selected backend projection', () => {
  const ui = controller(), snapshot = fixture(ui);
  assert.match(ui.elements.get('request-title').textContent, /linked-list/);
  assert.equal(ui.elements.get('requests').children.length, 2);
  assert.match(ui.elements.get('criteria').textContent, /empty lists/);
  assert.equal(ui.elements.get('products').querySelectorAll('button').length, 2);
  assert.equal(ui.calls.data.at(-1).workflow_id, 'WF-R001');
  ui.elements.get('requests').children[1].click();
  assert.equal(ui.calls.data.at(-1).workflow_id, 'WF-R002');
  assert.match(ui.elements.get('handoff').textContent, /accepted the delivered revision/);
  assert.equal(ui.saved.selectedRequest, 'WF-R002');
  const isolated = { ...snapshot.request_snapshot, workflows: [snapshot.request_snapshot.workflows[0]] };
  ui.message(isolated); assert.equal(ui.calls.data.at(-1).workflow_id, 'WF-R001');
  assert.equal(ui.elements.get('requests').children.length, 1);
});

test('product, request folder, model and request controls carry the selected exact identity', () => {
  const ui = controller(); fixture(ui);
  ui.elements.get('products').querySelector('button').click();
  ui.elements.get('open-request-folder').click();
  ui.elements.get('roles').querySelector('button').click();
  ui.elements.get('request-controls').querySelectorAll('button')[0].click();
  assert.deepEqual(ui.calls.messages.slice(-4), [
    { type: 'open-product', workflow_id: 'WF-R001', path: 'examples/linked-list/Cornell.md' },
    { type: 'open-request-folder', workflow_id: 'WF-R001' }, { type: 'select-model', role: 'manager' },
    { type: 'controlled-action', action: 'pause', workflow_id: 'WF-R001' },
  ]);
});

test('model cards retain focus during polling, never label configuration as model observation, and keep six visible roles', () => {
  const ui = controller(), snapshot = fixture(ui), first = ui.elements.get('roles').querySelector('button');
  first.focus(); fixture(ui);
  assert.equal(ui.elements.get('roles').children.length, 6); assert.equal(ui.document.activeElement, first);
  assert.match(ui.elements.get('roles').textContent, /worker-models/);
  assert.doesNotMatch(ui.elements.get('roles').textContent, /confirmed|observed|actual upstream/i);
  ui.message({ ...snapshot, active_count: 1, controlled_model_changes: false }); assert.equal(first.disabled, true);
  ui.message({ ...snapshot, active_count: 1, controlled_model_changes: true }); assert.equal(first.disabled, false);
});

test('workspace connection has an explicit pending state and a matching disconnect action', () => {
  const ui = controller(), value = createPreviewSnapshot('empty');
  ui.message({ ...value, enabled: false }); ui.elements.get('setup-connect').click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'connect' });
  ui.message({ type: 'connection-busy', busy: true }); assert.equal(ui.elements.get('setup-connect').disabled, true);
  ui.message(value); assert.equal(ui.elements.get('setup-connect').disabled, true, 'A poll cannot re-enable a pending connection.');
  ui.message({ type: 'connection-busy', busy: false }); ui.elements.get('setup-connect').click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'disconnect' });
});

test('issued dependency schedules show the actual wait without inventing an agent or product question', () => {
  const ui = controller(), snapshot = fixture(ui, 'empty');
  const value = { workflow_id: 'saved-wait', status: 'waiting', phase: 'implementation', active_invocations: [],
    dependency_wait: { code: 'prerequisite', attempts: 2, next_condition_check_at: '2026-10-28T12:00:00Z' } };
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [publicStatus(value).workflows[0]] });
  assert.match(ui.elements.get('request-action').textContent, /Waiting for a required local tool.*Next scheduled condition check/);
  assert.match(ui.elements.get('pm-action').textContent, /Waiting for a required local tool/);
  assert.equal(ui.elements.get('question-panel').hidden, true);
  ui.message({ type: 'controlled-snapshot', enabled: false, workflows: [publicStatus(value).workflows[0]] });
  assert.match(ui.elements.get('request-action').textContent, /Saved wait.*Connect WorkForce/);
  assert.doesNotMatch(ui.elements.get('request-action').textContent, /Next scheduled/);
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [{ ...value, status: 'paused', current_action: 'Paused with its saved checkpoint' }] });
  assert.equal(ui.elements.get('request-action').textContent, 'Paused with its saved checkpoint');
  assert.doesNotMatch(ui.elements.get('request-controls').textContent, /Next scheduled condition check/);
  ui.message({ ...snapshot, enabled: false, active_count: 0, control_unavailable: false });
  assert.equal(ui.elements.get('roles').querySelector('button').disabled, false, 'Routing can be repaired before Bridge connection or a request.');
});

test('only a backend question asks for user input and answer resumes the same request', () => {
  const ui = controller(); fixture(ui);
  assert.equal(ui.elements.get('question-panel').hidden, true);
  fixture(ui, 'question'); assert.equal(ui.elements.get('question-panel').hidden, false);
  ui.elements.get('answer').value = 'docs/source.md'; ui.elements.get('answer-submit').click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'controlled-action', action: 'resume', workflow_id: 'WF-R001', answer: 'docs/source.md', question_id: 'fixture-question-1' });
  ui.elements.get('answer').value = 'An unfinished answer for Q1';
  const changed = createPreviewSnapshot('question').request_snapshot; changed.workflows[0].question.id = 'fixture-question-2';
  ui.message(changed); assert.equal(ui.elements.get('answer').value, '', 'A new backend question cannot inherit the earlier answer.');
});

test('a facade question survives the public host projection and enables the corresponding controller answer', () => {
  const ui = controller(); fixture(ui, 'empty');
  const status = publicStatus({ requests: [{ workflow_id: 'backend-request', status: 'waiting-input', question: {
    id: 'backend-question-id', text: 'Which source file?', reason: 'The source document is absent.', status: 'pending',
  } }] });
  ui.message({ type: 'controlled-snapshot', enabled: true, ...status });
  assert.equal(ui.elements.get('answer-submit').disabled, false);
  ui.elements.get('answer').value = 'docs/source.md'; ui.elements.get('answer-submit').click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'controlled-action', action: 'resume', workflow_id: 'backend-request', question_id: 'backend-question-id', answer: 'docs/source.md' });
});

test('own-word intake, durable receipt acknowledgement and fresh submissions preserve FocusSpace state', () => {
  const ui = controller({ saved: { focusSpace: { volume: .37 }, draft: 'My own request' } }); fixture(ui, 'empty');
  ui.elements.get('submit').click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'controlled-action', action: 'submit', requirement: 'My own request' });
  const accepted = createPreviewSnapshot().request_snapshot.workflows[0];
  ui.message({ type: 'controlled-receipt', action: 'submit', workflows: [accepted], intake: { state: 'accepted', generation: 'generation-1' } });
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'controlled-receipt-ack', generation: 'generation-1', workflow_id: accepted.workflow_id });
  assert.equal(ui.elements.get('submit').disabled, true);
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [accepted], intake: { state: 'acknowledged', generation: 'generation-1' } });
  ui.elements.get('requirement').value = 'Another result'; ui.elements.get('submit').click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'controlled-action', action: 'submit_new', requirement: 'Another result', generation: 'generation-1' });
  assert.equal(ui.saved.focusSpace.volume, .37);
});

test('backend and renderer failures preserve visible saved products, avoid fake completion and disable stale actions', () => {
  for (const options of [{ rendererError: new Error('render failed') }, { noRenderer: true }]) {
    const ui = controller(options); fixture(ui);
    assert.match(ui.elements.get('v-model').textContent, /diagram is unavailable/);
    ui.message({ type: 'error', message: 'Connection unavailable' });
    assert.equal(ui.elements.get('products').children.length, 2);
    assert.match(ui.elements.get('request-action').textContent, /not been marked complete/);
    assert.equal(ui.elements.get('submit').disabled, true); assert.equal(ui.elements.get('roles').querySelector('button').disabled, true);
  }
});

test('unsafe product text remains literal and draft artifacts are never presented as verified', () => {
  const ui = controller(), snapshot = createPreviewSnapshot('small'), request = snapshot.request_snapshot.workflows[0];
  request.title = '<img src=x onerror=attack()>'; request.artifacts = [{ path: 'draft.md', label: '<script>attack()</script>', exists: true }];
  ui.message(snapshot); ui.message(snapshot.request_snapshot);
  assert.equal(ui.elements.get('request-title').textContent, request.title);
  assert.match(ui.elements.get('products').textContent, /verification not established/);
  assert.equal(ui.elements.get('products').querySelectorAll('script').length, 0);
});

test('changed products after historical completion are not reaccepted or offered invalid lifecycle controls', () => {
  const ui = controller(), value = createPreviewSnapshot('small');
  Object.assign(value.request_snapshot.workflows[0], { status: 'changed', historical_status: 'completed', accepted: false });
  ui.message(value); ui.message(value.request_snapshot);
  assert.equal(ui.elements.get('request-status').textContent, 'changed');
  assert.match(ui.elements.get('handoff').textContent, /current files are not accepted/);
  assert.ok(ui.elements.get('request-controls').querySelectorAll('button').every(button => button.disabled));
});

test('reduced motion, visibility and disposal preserve FocusSpace lifetime without planet animation loops', () => {
  const ui = controller({ reduced: true }); fixture(ui);
  assert.equal(ui.calls.motion.at(-1), false); assert.equal(ui.elements.get('motion').disabled, true);
  ui.reduce(false); assert.equal(ui.calls.motion.at(-1), true);
  ui.visibility(true); assert.equal(ui.calls.motion.at(-1), false);
  ui.visibility(false); assert.equal(ui.calls.motion.at(-1), true);
  assert.equal(ui.calls.focusCreated, 1); ui.unload(); assert.equal(ui.calls.destroyed, 1); assert.equal(ui.calls.focusDestroyed, 1);
});
