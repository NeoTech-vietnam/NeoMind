import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Regression for nodejs/undici#5360: EOF under unread-body backpressure must
// not escape as an uncaught parser assertion. The peer is loopback only.
test('pinned HTTP client survives peer EOF with a paused unread response and retains the full body', { timeout: 15000 }, () => {
  const require = createRequire(import.meta.url);
  assert.equal(JSON.parse(readFileSync(require.resolve('undici/package.json'), 'utf8')).version, '8.12.3');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:net';
    import {Agent,fetch} from 'undici';
    const body=Buffer.alloc(128*1024,97), sockets=new Set();
    const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
      socket.once('data',()=>socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\\r\\nContent-Length: '+body.length+'\\r\\nConnection: close\\r\\n\\r\\n'),body])));});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const dispatcher=new Agent();
    try { const response=await fetch('http://127.0.0.1:'+server.address().port+'/',{dispatcher});
      await new Promise(done=>setTimeout(done,150));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);console.log('paused-response-complete');
    } finally {await dispatcher.destroy();for(const socket of sockets)socket.destroy();await new Promise(done=>server.close(done));}
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /paused-response-complete/);
});
