import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeAuthStatus, claudeExecutable, probeClaudeCapabilities } from '../src/runtime/claude-capabilities.js';

const executable = process.platform === 'win32' ? claudeExecutable() : undefined;
const skip = process.platform !== 'win32' ? 'Windows only until the generic process scope lands'
  : !executable ? 'Claude Code CLI not installed'
    : !(await claudeAuthStatus(executable)).loggedIn ? 'Claude Code not logged in' : false;

test('the real Claude Code CLI is contained by NeoMind policy and stops with its job', { skip, timeout: 360000 }, async t => {
  const report = await probeClaudeCapabilities(executable);
  assert.equal(report.sandboxVerified, true);
  assert.equal(report.stopVerified, true);
  assert.equal(report.model, 'claude-haiku-5-5');
  assert.ok(report.costUsd < 0.05, `probe cost ${report.costUsd}`);
  t.diagnostic(`claude capability probe cost ~$${report.costUsd.toFixed(4)} (estimate under a subscription)`);
});
