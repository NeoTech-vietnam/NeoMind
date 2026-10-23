import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCopilotCli } from '../dist/copilot-adapter.js';

test('Copilot CLI probe detects availability without invoking inference', async (t) => {
  const probe = await probeCopilotCli();
  // Probe result depends on whether Copilot CLI is installed.
  // If available, version is non-empty. If not, available is false.
  assert.equal(typeof probe.available, 'boolean');
  assert.equal(typeof probe.version, probe.available ? 'string' : 'object');
  assert.equal(typeof probe.error, probe.available ? 'object' : 'string');
  if (probe.available) {
    assert.ok(probe.version && probe.version.length > 0);
    assert.equal(probe.error, null);
  } else {
    assert.equal(probe.version, null);
    assert.ok(probe.error);
  }
});
