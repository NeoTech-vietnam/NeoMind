import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeRouter } from '../dist/router-probe.js';

test('router probe records alias and backend separately without attesting effort or sandbox', async (t) => {
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, 'top-tier-model');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'resp-1', model: 'gpt-6-sol(medium)', choices: [{ finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.deepEqual(await probeRouter(`http://127.0.0.1:${port}/v1`, 'top-tier-model'), {
    requested_alias: 'top-tier-model',
    returned_model: 'gpt-6-sol(medium)',
    response_id: 'resp-1',
    completed: true,
    effort_confirmed: false,
    sandbox_confirmed: false,
  });
  await assert.rejects(probeRouter('https://external.example', 'top-tier-model'), /local HTTP/);
});
