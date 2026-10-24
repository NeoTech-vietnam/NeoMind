// Browser fixture only: no project files, plug-in installs, MCP servers or model requests.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { renderPluginPanelHtml } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/plugin-panel.cjs');
const catalog = [['rea', '6.7.0'], ['codegraph', '1.6.2'], ['context7', '4.3.0'], ['playwright', '0.0.83']];
export function createPluginPreviewServer() {
  const nonce = 'neomind-plugin-fixture';
  const fixture = { type: 'plugin-snapshot', vscode_selected: true, plugins: catalog.map(([id, version], index) => ({
    id, version, enabled: index < 2, installed: index < 3, availability: index < 2 ? 'ready' : index === 2 ? 'disabled' : 'missing',
    last_probe: index < 2 ? { ok: true, checked_at: '2026-10-24T00:00:00Z', tool_count: index ? 1 : 207 } : null,
    connections: ['codex', 'copilot-vscode', 'copilot-cli'].map((client, i) => ({ client, status: index === 0 || (index === 1 && i === 0) ? 'connected' : 'disconnected' })),
  })) };
  const stub = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:m=>{if(m.type!=='plugin-action')return;window.postMessage(${JSON.stringify(fixture)},'*');window.postMessage({type:'plugin-busy',busy:false},'*');if(m.action!=='refresh')window.postMessage({type:'plugin-notice',message:'Fixture preview only. No plug-in or client configuration was changed.'},'*');}});</script>`;
  const html = renderPluginPanelHtml({ cspSource: "'self'", script: '/plugins.js', style: '/plugins.css', nonce })
    .replace('<body>', '<body><p role="note">FIXTURE PREVIEW · Sample states only. No packages, accounts or client configuration are changed.</p>')
    .replace('<script nonce=', stub + '<script nonce=');
  return createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (request.url === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); }
    else if (['/plugins.js', '/plugins.css'].includes(request.url)) {
      response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(readFileSync(new URL(`../extensions/vscode-model-bridge/resources/monitor${request.url}`, import.meta.url)));
    } else response.writeHead(404).end();
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createPluginPreviewServer();
  server.listen(0, '127.0.0.1', () => console.log(`NeoMind plug-in fixture: http://127.0.0.1:${server.address().port}`));
}
