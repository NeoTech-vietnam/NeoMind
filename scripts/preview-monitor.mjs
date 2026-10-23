// Browser preview uses explicitly labelled demo records, never a live agent session.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { initialize, createRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { readAgentMap } from '../dist/agent-map.js';
import { modelControlStatus } from '../dist/model-control.js';

const require = createRequire(import.meta.url);
const { _test: { renderMonitorHtml } } = require('../extensions/vscode-model-bridge/monitor.cjs');
const root = mkdtempSync(join(tmpdir(), 'neomind-monitor-demo-'));
initialize(root, { project_id: 'DEMO', name: 'NeoMind demo — fixture data' });
const workflow = createRecord(root, { type: 'knowledge', title: 'NeoMind feature update', owner: 'manager',
  status: 'in-progress', data: { kind: 'manager-workflow', execution_mode: 'copilot-native' } });
const jobs = [
  ['researcher', 'Explore upstream agents', 'accepted'], ['architect', 'Design model routing', 'accepted'],
  ['developer', 'Build agent monitor', 'in-progress'], ['reviewer', 'Review implementation', 'submitted'],
  ['check-executor', 'Validate model controls', 'in-progress'], ['manager', 'Coordinate delivery', 'in-progress'],
];
for (const [role, title, status] of jobs) {
  const task = createRecord(root, { type: 'task', title, owner: role, status,
    data: { workflow_id: workflow.meta.id, execution_mode: 'copilot-native' } });
  createRecord(root, { type: 'knowledge', title: `${role} contribution`, owner: role,
    data: { kind: 'work-record', workflow_id: workflow.meta.id, invocation_id: `demo-${role}`, execution_mode: 'copilot-native' },
    links: [{ type: 'documents', target: task.meta.id }] });
}
ensureRoutingPolicy(root);
const nonce = 'neomind-local-preview';
const stub = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:async m=>{if(m.type==='select-model'){document.getElementById('status').textContent='Demo preview: use NeoMind: Open Agent Map in VS Code to change real role models.';return;}const data=await(await fetch('/snapshot')).json();window.postMessage(data,'*');}});</script>`;
const html = renderMonitorHtml({ cspSource: "'self'", script: '/monitor.js', style: '/monitor.css', nonce })
  .replace("default-src 'none';", "default-src 'none'; connect-src 'self';")
  .replace('<script nonce=', stub + '<script nonce=');
const assets = new URL('../extensions/vscode-model-bridge/resources/monitor/', import.meta.url);
const server = createServer((request, response) => {
  if (request.url === '/snapshot') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ type: 'snapshot', map: readAgentMap(root), roles: modelControlStatus(root).roles,
      router_configured: false, active_count: 0 }));
  } else if (request.url === '/monitor.js' || request.url === '/monitor.css') {
    response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(readFileSync(new URL(request.url.slice(1), assets)));
  } else if (request.url === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
  } else { response.statusCode = 404; response.end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`NeoMind demo preview: http://127.0.0.1:${server.address().port}`));
