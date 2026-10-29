import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AppServerTransport, RpcOutcomeUnknown } from '../src/adapters/app-server-transport.js';

test('app server transport initializes, routes notifications and treats timeout as unknown without replay', async () => {
  const notifications: string[] = [], requests: string[] = [];
  const client = new AppServerTransport(process.execPath, [path.resolve('dist/test/helpers/fake-app-server.js')],
    method => notifications.push(method), (_id, method) => requests.push(method));
  try {
    assert.deepEqual(await client.initialize(), { userAgent: 'fixture' });
    assert.deepEqual(await client.request('echo', {}), { ok: true });
    client.notify('ask');
    await assert.rejects(client.request('no-reply', {}, 80), RpcOutcomeUnknown);
    assert.ok(notifications.includes('ready'));
    assert.ok(requests.includes('approval/request'));
  } finally { client.close(); }
});
