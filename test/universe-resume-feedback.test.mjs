import test from 'node:test';
import assert from 'node:assert/strict';
import { controller } from './helpers/workforce-ui.mjs';

const paused = { workflow_id: 'WF-BACKEND-0001', request_id: 'saved-request-uuid', request_key: 'WF-R0001',
  title: 'Saved engineering request', status: 'paused', phase: 'review', active_invocations: [],
  artifacts: [{ path: 'docs/current.md', exists: true }], current_action: 'Paused at the saved review checkpoint.' };
function fixture() {
  const ui = controller();
  ui.message({ type: 'snapshot', enabled: true, active_count: 0, controlled_model_changes: true, roles: [] });
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [paused] });
  return ui;
}
const buttons = ui => ui.elements.get('request-controls').querySelectorAll('button');

test('Resume immediately shows pending feedback and resists duplicate clicks and stale snapshots until its receipt', () => {
  const ui = fixture(), resume = buttons(ui)[1];
  ui.elements.get('compose').hidden = true;
  resume.click();
  assert.match(buttons(ui)[1].textContent, /Resuming/);
  assert.match(ui.elements.get('request-controls').textContent, /Resuming/);
  assert.match(ui.elements.get('notice').textContent, /Resuming/);
  assert.ok(buttons(ui).every(button => button.disabled));
  assert.equal(ui.elements.get('request-status').textContent, 'paused', 'Sending a control does not invent backend progress.');
  resume.click();
  ui.message({ type: 'controlled-busy', busy: false });
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [paused] });
  assert.ok(buttons(ui).every(button => button.disabled));
  assert.match(buttons(ui)[1].textContent, /Resuming/);
  assert.equal(ui.calls.messages.filter(message => message.action === 'resume').length, 1);
});

test('queued and running receipts reflect actual backend state rather than claiming an agent has already executed', () => {
  for (const status of ['queued', 'running']) {
    const ui = fixture(); buttons(ui)[1].click();
    ui.message({ type: 'controlled-busy', busy: true });
    ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, status, current_action: 'Saved backend transition.' }] });
    assert.equal(ui.elements.get('request-status').textContent, status);
    assert.match(ui.elements.get('notice').textContent, /Resume accepted/);
    assert.match(ui.elements.get('notice').textContent, new RegExp(status));
    assert.doesNotMatch(ui.elements.get('notice').textContent, /completed|Your action was recorded/);
    if (status === 'queued') assert.match(ui.elements.get('notice').textContent, /execution has not yet been reported/);
    ui.message({ type: 'controlled-busy', busy: false });
    assert.equal(buttons(ui)[1].textContent, 'Resume');
    assert.equal(buttons(ui)[1].disabled, false);
  }
});

test('an unchanged paused receipt visibly says that Resume did not start', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [paused] });
  assert.match(ui.elements.get('notice').textContent, /Resume did not start.*still paused/);
  assert.match(ui.elements.get('request-controls').textContent, /saved review checkpoint/);
  assert.doesNotMatch(ui.elements.get('notice').textContent, /Resume accepted|Your action was recorded/);
  assert.equal(ui.elements.get('request-status').textContent, 'paused');
  assert.equal(buttons(ui)[1].disabled, false);
});

test('waiting, uncertain and actual product questions provide honest next-state feedback without fake execution', () => {
  for (const update of [
    { status: 'waiting', current_action: 'Waiting for the installed compiler dependency.' },
    { status: 'uncertain', current_action: 'WorkForce must reconcile the retained process result.' },
    { status: 'needs_input', question: { id: 'actual-question', text: 'Which physical board revision?', status: 'pending' } },
  ]) {
    const ui = fixture(); buttons(ui)[1].click();
    ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, ...update }] });
    const notice = ui.elements.get('notice').textContent;
    assert.doesNotMatch(notice, /Resume accepted|Your action was recorded|Backend status: running/);
    if (update.status === 'waiting') assert.match(notice, /waiting.*compiler dependency/);
    if (update.status === 'uncertain') assert.match(notice, /not confirm execution.*uncertain.*reconcile/);
    if (update.question) assert.match(notice, /displayed product question/);
  }
});

test('a refused Resume displays its diagnostic and preserves actual saved status and products', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-error', code: 'BRIDGE_REFUSED', message: 'The workspace runtime refused this control request.' });
  assert.match(ui.elements.get('request-controls').textContent, /Resume was not confirmed.*BRIDGE_REFUSED.*refused/);
  assert.match(ui.elements.get('notice').textContent, /Refresh.*actual saved state/);
  assert.equal(ui.elements.get('request-status').textContent, 'paused');
  assert.equal(ui.elements.get('products').querySelectorAll('button').length, 1);
  assert.equal(buttons(ui)[1].textContent, 'Resume');
  assert.equal(buttons(ui)[1].disabled, false);
});

test('an out-of-order control receipt for another request cannot clear this pending Resume', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, workflow_id: 'other-workflow', status: 'running' }] });
  assert.equal(ui.calls.data.at(-1).workflow_id, paused.workflow_id);
  assert.match(buttons(ui)[1].textContent, /Resuming/);
  assert.ok(buttons(ui).every(button => button.disabled));
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, status: 'queued' }] });
  assert.match(ui.elements.get('notice').textContent, /Resume accepted.*queued/);
  assert.equal(buttons(ui)[1].textContent, 'Resume');
});

test('a completed control response does not invent acceptance of a changed revision', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, status: 'completed', accepted: false }] });
  assert.match(ui.elements.get('notice').textContent, /acceptance.*not confirmed.*findings/);
  assert.doesNotMatch(ui.elements.get('notice').textContent, /completed and accepted/);
  assert.ok(buttons(ui).every(button => button.disabled));
});

test('a receipt without a request state explicitly leaves execution unconfirmed', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [] });
  assert.match(ui.elements.get('notice').textContent, /did not confirm execution.*unavailable.*reconcile/);
  assert.equal(ui.elements.get('request-status').textContent, 'paused');
  assert.equal(buttons(ui)[1].textContent, 'Resume');
});

test('authoritative snapshots advance an accepted queued receipt to the actual running and completed outcome', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, status: 'queued' }] });
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [{ ...paused, status: 'running',
    phase: 'design', current_action: 'WF.P-RES is starting the saved design stage.' }] });
  assert.match(ui.elements.get('request-controls').textContent, /Resume was accepted.*running/);
  assert.doesNotMatch(ui.elements.get('notice').textContent, /is queued|execution has not yet been reported/);
  assert.equal(ui.elements.get('request-status').textContent, 'running');
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [{ ...paused, status: 'completed',
    accepted: true, current_action: 'All required checks and acceptance completed.' }] });
  assert.match(ui.elements.get('notice').textContent, /completed.*accepted/);
  assert.doesNotMatch(ui.elements.get('request-controls').textContent, /is queued|Backend status: running/);
});

test('snapshots after an accepted Resume distinguish blocked work and unaccepted completed revisions', () => {
  for (const update of [
    { status: 'blocked', current_action: 'Saved checker result requires WorkForce repair.' },
    { status: 'completed', accepted: false, current_action: 'Changed revision has no current acceptance proof.' },
    { status: 'completed', accepted: undefined, current_action: 'Acceptance was not supplied in this snapshot.' },
  ]) {
    const ui = fixture(); buttons(ui)[1].click();
    ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, status: 'queued' }] });
    ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [{ ...paused, ...update }] });
    const message = ui.elements.get('notice').textContent;
    assert.match(message, /Resume was accepted/);
    assert.doesNotMatch(message, /is queued|execution has not yet been reported/);
    if (update.status === 'blocked') assert.match(message, /blocked.*not completed.*repair/);
    else if (update.accepted === false) assert.match(message, /current revision.*not accepted/);
    else assert.match(message, /acceptance.*not confirmed/);
  }
});

test('a snapshot cannot acknowledge a pending Resume or apply another request progress to its feedback', () => {
  const ui = fixture(); buttons(ui)[1].click();
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [{ ...paused, status: 'running' }] });
  assert.match(buttons(ui)[1].textContent, /Resuming/);
  assert.ok(buttons(ui).every(button => button.disabled));
  ui.message({ type: 'controlled-receipt', action: 'resume', workflows: [{ ...paused, status: 'queued' }] });
  ui.message({ type: 'controlled-snapshot', enabled: true, workflows: [{ ...paused, status: 'queued' },
    { ...paused, workflow_id: 'other-workflow', status: 'completed', accepted: true }] });
  assert.match(ui.elements.get('notice').textContent, /queued/);
  assert.doesNotMatch(ui.elements.get('notice').textContent, /completed/);
});
