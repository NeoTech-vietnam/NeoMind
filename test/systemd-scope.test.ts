import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemdScope } from '../src/adapters/systemd-scope.js';

test('scope recovery refuses malformed and foreign identities before invoking systemctl', async () => {
  assert.equal(await SystemdScope.stopExisting({ unit: 'other.service', controlGroup: '/user.slice/other.service' }), false);
  assert.equal(await SystemdScope.stopExisting({ unit: 'neomind-run-abcd.scope', controlGroup: '/user.slice/../../other/neomind-run-abcd.scope' }), false);
});
