import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressWaitError, waitForProgress } from './helpers/progress-wait.mjs';

function clockFixture(snapshot, authoritative = snapshot) {
  let time = 0, probes = 0, inspections = 0;
  return {
    options: { idleMs: 90, totalMs: 270, pollMs: 10, inspectMs: 25,
      now: () => time, pause: async ms => { time += ms; },
      probe: () => { probes++; return snapshot(time); },
      inspect: () => { inspections++; return authoritative(time); },
      accept: state => state.status === 'completed', reject: state => ['blocked', 'uncertain'].includes(state.status),
      progress: state => JSON.stringify([state.stage, state.steps]),
    },
    current: () => ({ time, probes, inspections }),
  };
}

test('distinct work may continue past the initial waiting deadline and still requires authoritative completion', async () => {
  const fixture = clockFixture(time => ({ status: time >= 210 ? 'completed' : 'running', stage: 'implementation', steps: Math.floor(time / 70) }));
  const result = await waitForProgress(fixture.options);
  assert.equal(result.status, 'completed');
  assert.equal(fixture.current().time, 210, 'Meaningful work continued beyond the original 90-unit total deadline');
  assert.ok(fixture.current().inspections < fixture.current().probes / 2, 'Receipt validation is not repeated for every cheap probe');
});

test('revision and timestamp churn do not extend a stalled run', async () => {
  const fixture = clockFixture(time => ({ status: 'running', stage: 'implementation', steps: 1, revision: time, updated_at: time }));
  await assert.rejects(waitForProgress(fixture.options), error => error instanceof ProgressWaitError && error.code === 'INACTIVITY_TIMEOUT');
  assert.equal(fixture.current().time, 90);
});

test('endless distinct progress still stops at the absolute cap', async () => {
  const fixture = clockFixture(time => ({ status: 'running', stage: 'implementation', steps: time }));
  await assert.rejects(waitForProgress(fixture.options), error => error.code === 'TOTAL_TIMEOUT');
  assert.equal(fixture.current().time, 270);
});

test('a provisional completed journal cannot bypass the authoritative status read', async () => {
  const fixture = clockFixture(() => ({ status: 'completed', stage: 'acceptance', steps: 1 }), time =>
    ({ status: time >= 40 ? 'completed' : 'running', stage: 'acceptance', steps: 1 }));
  const result = await waitForProgress(fixture.options);
  assert.equal(result.status, 'completed');
  assert.equal(fixture.current().time, 40);
  assert.equal(fixture.current().inspections, 5);
});

test('authoritative owner loss is detected without waiting for the whole inactivity budget', async () => {
  const fixture = clockFixture(() => ({ status: 'running', stage: 'verification', steps: 1 }), time =>
    ({ status: time >= 30 ? 'uncertain' : 'running', stage: 'verification', steps: 1 }));
  await assert.rejects(waitForProgress(fixture.options), error => error.code === 'UNEXPECTED_STATE' && error.snapshot.status === 'uncertain');
  assert.equal(fixture.current().time, 30);
});

test('an expected blocked result is returned but an unexpected one still fails', async () => {
  const fixture = clockFixture(() => ({ status: 'blocked', stage: 'implementation', steps: 1 }));
  const accepted = await waitForProgress({ ...fixture.options, accept: state => state.status === 'blocked' });
  assert.equal(accepted.status, 'blocked');
  await assert.rejects(waitForProgress(fixture.options), error => error.code === 'UNEXPECTED_STATE');
});
