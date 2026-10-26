// Sample UI only: no scripts, MCP servers or project files are executed or changed.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { renderAutomationPanelHtml } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/automation-panel.cjs');
export function createAutomationPreviewServer() {
  const nonce = 'neomind-automation-preview';
  const sample = { type: 'automation-snapshot', procedures: [
    { id: 'cornell-artifact-inventory', version: '1.0.0', title: 'Cornell artifact inventory', status: 'eligible', script: 'scripts/automation/cornell-inventory.mjs', task_family: 'cornell-inventory', successful_runs: 3, reviews: 1, last_run: { status: 'succeeded' } },
    { id: 'exercise-scaffold', version: '1.0.0', title: 'Algorithm exercise scaffold', status: 'candidate', script: 'scripts/exercise.mjs', task_family: 'algorithm-exercise', successful_runs: 0, reviews: 0, last_run: null },
    { id: 'legacy-export', version: '1.0.0', title: 'Previous note exporter', status: 'suspended', reason: 'Script changed; review a new version.', script: 'scripts/export.mjs', successful_runs: 4, reviews: 1, last_run: { status: 'failed' } },
  ] };
  const stub = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:m=>{if(m.type!=='automation-action')return;window.postMessage(${JSON.stringify(sample)},'*');window.postMessage({type:'automation-busy',busy:false},'*');if(m.action==='match')window.postMessage({type:'automation-match',decision:'adapt',brief:'Sample result: compare requested output and typed parameters with the reviewed procedure.',next_action:'Preview only. No script was executed.'},'*');else if(m.action!=='refresh')window.postMessage({type:'automation-notice',message:'Sample preview only. No project configuration was changed.'},'*');}});</script>`;
  const html = renderAutomationPanelHtml({ cspSource: "'self'", script: '/automation.js', style: '/automation.css', nonce })
    .replace('<body>', '<body><p role="note">SAMPLE PREVIEW · These statuses are illustrative. No project files are changed.</p>')
    .replace('<script nonce=', stub + '<script nonce=');
  return createServer((request, response) => {
    if (request.method !== 'GET') return response.writeHead(405).end();
    if (request.url === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); }
    else if (['/automation.js', '/automation.css'].includes(request.url)) {
      response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(readFileSync(new URL(`../extensions/vscode-model-bridge/resources/monitor${request.url}`, import.meta.url)));
    } else response.writeHead(404).end();
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createAutomationPreviewServer();
  server.listen(0, '127.0.0.1', () => console.log(`NeoMind automation sample: http://127.0.0.1:${server.address().port}`));
}
