const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');

// Desktop extension webviews cannot request geolocation. A user-opened, one-shot
// loopback page asks the browser instead; it never reads transcripts or IP location.
function requestBrowserLocation({ signal, open, onReady, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(24).toString('hex'), nonce = randomBytes(16).toString('hex');
    let origin, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      server.close(); server.closeIdleConnections?.();
      const cleanup = setTimeout(() => server.closeAllConnections?.(), 250); cleanup.unref?.();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error('Location request cancelled.'));
    const server = createServer((req, res) => {
      if (settled) { res.writeHead(410).end(); return; }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Permissions-Policy', 'geolocation=(self)');
      if (req.url !== `/${token}` || req.headers.host !== origin?.slice(7)) { res.writeHead(404).end(); return; }
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
        res.end(`<!doctype html><html><head><title>NeoMind weather location</title><style nonce="${nonce}">body{background:#08151d;color:#e0edf1;font:18px system-ui;max-width:620px;margin:12vh auto;padding:28px}h1{font-size:36px}p{line-height:1.7;color:#abc1c9}button{padding:14px 22px;border:0;border-radius:10px;background:#a1ddc8;color:#0c2522;font:inherit;cursor:pointer}#status{margin-top:22px}</style></head><body><p>NEOMIND · FOCUS SPACE</p><h1>Weather where you are.</h1><p>Your browser will ask for location permission. Approximate coordinates are sent back to NeoMind for an Open-Meteo forecast. They are not saved in your project.</p><button id="locate">Use my current location</button><p id="status" role="status">You can also close this page and search for a city in NeoMind.</p><script nonce="${nonce}">document.getElementById('locate').onclick=()=>{const s=document.getElementById('status');s.textContent='Waiting for location permission…';navigator.geolocation.getCurrentPosition(async p=>{try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({latitude:Math.round(p.coords.latitude*100)/100,longitude:Math.round(p.coords.longitude*100)/100})});s.textContent=r.ok?'Location sent. Return to NeoMind; you can close this page.':'Request expired. Return to NeoMind and try again.';}catch{s.textContent='Request expired. Return to NeoMind and try again.'}},()=>{s.textContent='Location unavailable. Return to NeoMind and search for a city.'},{enableHighAccuracy:false,timeout:30000,maximumAge:300000})};</script></body></html>`);
      } else if (req.method === 'POST' && req.headers.origin === origin && req.headers['content-type'] === 'application/json') {
        const chunks = []; let size = 0;
        req.on('data', bytes => { size += bytes.length; if (size > 1024) { res.writeHead(413).end(); req.destroy(); } else chunks.push(bytes); });
        req.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!Number.isFinite(data.latitude) || !Number.isFinite(data.longitude) || Math.abs(data.latitude) > 90 || Math.abs(data.longitude) > 180)
              throw new Error('Invalid location.');
            res.writeHead(200).end('Location received.'); finish(null, { latitude: data.latitude, longitude: data.longitude });
          } catch { res.writeHead(400).end('Invalid location.'); }
        });
      } else res.writeHead(405).end();
    });
    const timer = setTimeout(() => finish(new Error('Location request timed out. Search for a city or try again.')), timeoutMs);
    timer.unref?.(); server.once('error', () => finish(new Error('The browser location helper could not start. Search for a city.')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    server.listen(0, '127.0.0.1', async () => {
      if (settled) return;
      server.unref?.(); origin = `http://127.0.0.1:${server.address().port}`;
      const url = `${origin}/${token}`; onReady?.(url);
      try { if (await open(url) === false) finish(new Error('Browser could not open. Search for a city.')); }
      catch { finish(new Error('Browser could not open. Search for a city.')); }
    });
  });
}
module.exports = { requestBrowserLocation };
