'use strict';
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');

function selection(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Choose a valid HTTPS YouTube video or playlist link.');
  let url;
  try { url = new URL(input); } catch { throw new Error('Choose a valid HTTPS YouTube video or playlist link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(url.hostname))
    throw new Error('Choose a valid HTTPS YouTube video or playlist link.');
  let video = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
  if (/^\/(?:embed|shorts|live)\//.test(url.pathname)) video = url.pathname.split('/')[2];
  const list = url.searchParams.get('list');
  if (url.pathname === '/embed/videoseries' && list) video = null;
  if ((video && !/^[A-Za-z0-9_-]{11}$/.test(video)) || (list && !/^[A-Za-z0-9_-]{10,128}$/.test(list)) || (!video && !list))
    throw new Error('Choose a valid HTTPS YouTube video or playlist link.');
  return { ...(video ? { video } : {}), ...(list ? { list } : {}) };
}

function playerDocument(chosen, nonce) {
  const data = JSON.stringify(chosen).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NeoMind YouTube player</title><style>html,body{margin:0;background:#08111c;color:#d8e9f8;font:14px system-ui;height:100%}#player{width:100%;height:calc(100% - 32px);min-height:200px}#status{height:24px;margin:4px 8px}</style></head><body><div id="player"></div><p id="status" role="status">Loading YouTube. Playback starts only when you press Play.</p><script nonce="${nonce}">
const chosen=${data};let player,terminal=false;const status=document.getElementById('status');
function report(event,code){parent.postMessage({type:'neomind-youtube',event,code},'*')}
// The official API also includes the embedding document URL in its own player
// parameters. Remove the capability path before loading that API, in addition
// to the origin-only HTTP referrer policy. This keeps the real origin unchanged.
history.replaceState(null,'','/neomind-youtube/player');
function fail(message,code){if(terminal)return;terminal=true;clearTimeout(readyDeadline);try{player?.destroy()}catch{}status.textContent=message;report('error',code)}
const readyDeadline=setTimeout(function(){fail('YouTube did not become ready. Reload the link or choose Open on YouTube.',0)},30000);
window.onYouTubeIframeAPIReady=function(){if(terminal)return;const vars={autoplay:0,playsinline:1,origin:window.location.origin};if(chosen.list){vars.list=chosen.list;vars.listType='playlist'}player=new YT.Player('player',{host:'https://www.youtube.com',...(chosen.video?{videoId:chosen.video}:{}),playerVars:vars,events:{onReady:function(){if(terminal){try{player?.destroy()}catch{}return}clearTimeout(readyDeadline);status.textContent='Press Play to listen.';report('ready',0)},onStateChange:function(e){if(!terminal&&[-1,0,1,2,3,5].includes(e.data))report('state',e.data)},onError:function(e){fail(Number(e.data)===153?'YouTube could not identify this player. Use Open on YouTube.':'This video cannot play here. Try another video or Open on YouTube.',Number.isSafeInteger(e.data)?e.data:0)},onAutoplayBlocked:function(){if(!terminal)status.textContent='Press Play in the visible player.'}}});};
const api=document.createElement('script');api.nonce=${JSON.stringify(nonce)};api.src='https://www.youtube.com/iframe_api';api.onerror=function(){fail('The YouTube player could not load. Reload the link or choose Open on YouTube.',0)};document.head.appendChild(api);
setTimeout(function(){fail('This player session expired. Load the link again.',0)},7200000);
</script></body></html>`;
}

/** A real loopback HTML origin lets the browser identify this embed honestly.
 * No Referer headers are forged, and no YouTube requests or media are proxied.
 */
async function createYouTubePlayer({ url, signal, asExternalUri } = {}) {
  const chosen = selection(url);
  if (signal?.aborted) throw new Error('YouTube loading was cancelled.');
  const route = `/neomind-youtube/${randomBytes(32).toString('base64url')}`;
  const nonce = randomBytes(24).toString('base64');
  const document = playerDocument(chosen, nonce);
  let local, expiry, closing, ended = false;
  const acceptedHosts = new Set();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/plain; charset=utf-8' };
    if (!acceptedHosts.has(request.headers.host)) { response.writeHead(421, headers); response.end('Unrecognized player host.'); return; }
    if (request.method !== 'GET') { response.writeHead(405, { ...headers, Allow: 'GET' }); response.end('Method not allowed.'); return; }
    if (request.url !== route) { response.writeHead(404, headers); response.end('Player not found.'); return; }
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://www.youtube.com https://s.ytimg.com; style-src 'unsafe-inline'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src https://www.youtube.com https://www.youtube-nocookie.com; img-src data: https://i.ytimg.com; base-uri 'none'; form-action 'none'; object-src 'none'` });
    response.end(document);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 20;
  const close = () => {
    if (closing) return closing;
    ended = true; clearTimeout(expiry); signal?.removeEventListener('abort', onAbort);
    closing = new Promise(resolve => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve()); server.closeAllConnections?.();
    });
    return closing;
  };
  const onAbort = () => { void close(); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    local = new URL(`http://127.0.0.1:${address.port}${route}`);
    acceptedHosts.add(local.host);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted || ended) throw new Error('YouTube loading was cancelled.');
    let exposed = local;
    if (asExternalUri) {
      const value = new URL(await asExternalUri(local.href));
      // Keep the panel CSP narrow. Remote forwarded HTTPS origins require a
      // separately designed trust policy; the normal browser remains available.
      if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || value.username || value.password ||
          value.pathname !== route || value.search || value.hash)
        throw new Error('Embedded YouTube is unavailable through this remote connection. Choose Open on YouTube.');
      exposed = value; acceptedHosts.add(exposed.host);
    }
    if (signal?.aborted || ended) throw new Error('YouTube loading was cancelled.');
    expiry = setTimeout(() => { void close(); }, 2 * 60 * 60 * 1000); expiry.unref();
    return { url: exposed.href, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { createYouTubePlayer };
