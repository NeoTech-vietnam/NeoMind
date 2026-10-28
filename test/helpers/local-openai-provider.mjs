import { createServer } from 'node:http';

/** A loopback-only scripted protocol peer. It never forwards to a provider,
 * downloads a model or makes an inference request outside this process. */
export async function localOpenAIProvider(responseFor, maximum = 20) {
  const requests = [], failures = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('Fixture request limit.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      if (requests.length > maximum) { response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Fixture request circuit exceeded.', type: 'fixture_limit' } })); return; }
      const output = await responseFor(requests.length - 1, body), tools = output.toolCalls?.map((call, index) => ({
        index, id: `call_fixture_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      const metadata = { id: `chatcmpl_fixture_${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
      if (body.stream === false) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...metadata, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: output.text ?? null,
          ...(tools ? { tool_calls: tools.map(({ index: _index, ...call }) => call) } : {}) }, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: { role: 'assistant', ...(tools ? { tool_calls: tools } : { content: output.text ?? 'fixture complete' }) }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Local protocol fixture failed.' } })); }
  });
  await new Promise((fulfill, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); fulfill(); }); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, failures,
    close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
