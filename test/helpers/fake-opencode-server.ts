import http from 'node:http';

// Stand-in for `opencode serve`: prints the listening line, checks Basic auth and echoes requests.
if (process.env.FAKE_MODE === 'exit') process.exit(1);
if (process.env.FAKE_MODE !== 'hang') {
  const server = http.createServer((request, response) => {
    const expected = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
    if (request.headers.authorization !== expected) { response.writeHead(401).end(); return; }
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://example.invalid/' }).end(); return; }
    if (request.url === '/error') { response.writeHead(500).end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ method: request.method, body: body ? JSON.parse(body) as unknown : null })); });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`opencode server listening on http://127.0.0.1:${address.port}\n`);
  });
} else setInterval(() => {}, 1000);
