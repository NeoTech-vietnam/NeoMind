// Local browser preview: fixture records only; never contacts a project, router or model.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strongRoles, workerRoles } from '../dist/routing.js';
import { agentProfiles } from '../dist/agent-profiles.js';
import { focusCalendar } from '../dist/focus-services.js';

const require = createRequire(import.meta.url);
const { _test: { renderMonitorHtml } } = require('../extensions/vscode-model-bridge/monitor.cjs');
const assets = new URL('../extensions/vscode-model-bridge/resources/monitor/', import.meta.url);
const fixtureAt = index => new Date(Date.UTC(2026, 9, 23, 9, 0, index * 30)).toISOString();
const profiles = [
  ['manager', 'WF.PM', 'top-models'], ['requirements', 'WF.SWSD', 'top-models'],
  ['architect', 'WF.P-RES', 'top-models'], ['developer', 'WF.FnD', 'worker-models'],
  ['reviewer', 'WF.Reviewer', 'top-models'], ['verifier', 'WF.Tester', 'top-models'],
];
const stageIds = ['requirements', 'analysis', 'architecture', 'module-design', 'coding', 'unit', 'integration', 'system', 'acceptance'];
/** Deterministic sample data. It is never an execution receipt or an engine probe. */
export function createPreviewSnapshot(fixture = 'default') {
  const roles = profiles.map(([role, name, model]) => ({ role, name, models: [model], provider: '9router', reasoning_effort: role === 'developer' ? 'low' : 'high' }));
  const sample = (id, title, status, activeStage) => ({ workflow_id: id, request_id: id, request_key: id, title, status,
    phase: activeStage, current_action: 'Preview sample: independent checks of the generated C/C++ exercise.',
    folder: '.workforce/requests/' + id, created_at: fixtureAt(1), updated_at: fixtureAt(20),
    stages: stageIds.map((stage, index) => ({ id: stage, state: status === 'completed' || index < stageIds.indexOf(activeStage) ? 'completed' : stage === activeStage ? 'running' : 'pending', summary: 'Explicit fixture milestone; not live evidence.' })),
    review: { state: status === 'completed' ? 'completed' : 'pending', summary: 'Preview review milestone' },
    artifacts: [{ path: 'examples/linked-list/Cornell.md', label: 'Cornell research note', exists: true, state: status === 'completed' ? 'verified' : 'draft', summary: 'Fixture product only' }, { path: 'examples/linked-list/solution.cpp', label: 'C++ solution', exists: true, state: 'draft' }],
    criteria: [{ id: 'criterion-1', text: 'Handle empty lists and boundary cases', state: status === 'completed' ? 'passed' : 'running', summary: 'Fixture check result' }],
    findings: [], active_invocations: status === 'completed' ? [] : [{ role: 'verifier', state: 'running', requested_model: 'top-models' }],
  });
  const requests = fixture === 'empty' ? [] : [sample('WF-R001', 'Create the next linked-list exercise with a Cornell note', 'running', 'unit'),
    ...(fixture === 'small' ? [] : [sample('WF-R002', 'Repair the route parser and verify compatibility', 'completed', 'acceptance')])];
  if (fixture === 'question' && requests[0]) {
    requests[0].status = 'waiting-input'; requests[0].question = { id: 'fixture-question-1', text: 'Which repository contains the source document?', reason: 'The requested source was not supplied.', status: 'pending' };
  }
  return { type: 'snapshot', preview: true, project: { name: 'WorkForce UI preview · sample data', root: 'fixture' }, roles,
    setup: { ready: false, summary: 'Fixture preview. No engine or model capability has been tested.', checks: [{ label: 'Sample connection', state: 'configured', summary: 'Preview only' }] },
    enabled: true, router_configured: true, active_count: 0, controlled_model_changes: true, control_unavailable: false,
    request_snapshot: { type: 'controlled-snapshot', enabled: true, workflows: requests, intake: null } };
}

export function createFocusPreviewResponse(message) {
  const now = Date.now(), from = new Date(now + 45 * 60_000), end = new Date(now + 75 * 60_000);
  let data;
  switch (message.action) {
    case 'status': data = { calendarConfigured: false, youtubeConfigured: false }; break;
    case 'weather': case 'weather-location': data = {
      location: { latitude: 21.03, longitude: 105.85, timezone: 'Asia/Ho_Chi_Minh' },
      current: { temperature: 26, apparent: 27, weatherCode: 2, windSpeed: 8 },
      daily: Array.from({ length: 7 }, (_, index) => ({ date: new Date(now + index * 86_400_000).toISOString().slice(0, 10), minimum: 22 + index % 2, maximum: 27 + index % 3, rainProbability: 15 + index * 5, weatherCode: 2 })), attribution: 'Open-Meteo shape · fixture data, not a real forecast' }; break;
    case 'place-search': data = [{ name: String(message.query ?? 'Sample city').slice(0, 100), country: 'Fixture location', latitude: 21.03, longitude: 105.85 }]; break;
    case 'calendar-import': data = { ...focusCalendar(message.ics, message), configured: false }; break;
    case 'calendar-connect': case 'calendar-refresh': data = { configured: true, warnings: ['Preview calendar: sample events only. No account was accessed.'],
      events: [{ id: 'fixture-calendar-event', title: 'Design a little, learn a little', start: from.toISOString(), end: end.toISOString(), allDay: false, busy: true }],
      slots: [{ start: new Date(now).toISOString(), end: new Date(now + 25 * 60_000).toISOString(), durationMinutes: 25 }] }; break;
    case 'calendar-disconnect': data = { configured: false, events: [], warnings: [], slots: [] }; break;
    case 'youtube-configure': data = { calendarConfigured: false, youtubeConfigured: true, preview: true }; break;
    case 'youtube-search': data = []; break;
    case 'youtube-open': data = { opened: false, preview: true }; break;
    default: return { type: 'focus-space-result', request_id: message.request_id, action: message.action, ok: false, error: 'Unsupported fixture action.' };
  }
  return { type: 'focus-space-result', request_id: message.request_id, action: message.action, ok: true, data, preview: true };
}

export function createPreviewServer() {
  const nonce = 'workforce-local-preview';
  const stub = `<script nonce="${nonce}">(()=>{let saved;try{saved=JSON.parse(localStorage.getItem('workforce-preview-state')||'null')}catch{}window.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value;localStorage.setItem('workforce-preview-state',JSON.stringify(value))},postMessage:async m=>{if(m.type==='select-model'||m.type==='controlled-action'||m.type==='open-product'||m.type==='open-request-folder'||m.type==='open-local'||m.type==='connect'||m.type==='disconnect'||m.type==='select-model-catalog'){document.getElementById('notice').textContent='Fixture preview: no request, file or model change was made. Use WorkForce in VS Code for execution.';return;}if(m.type==='focus-space'){if(m.action==='cancel')return;const r=await fetch('/focus-space',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});window.postMessage(await r.json(),'*');return;}const data=await(await fetch('/snapshot'+window.location.search)).json();window.postMessage(data,'*');if(data.request_snapshot)window.postMessage(data.request_snapshot,'*');}});})();</script>`;

  const html = renderMonitorHtml({ cspSource: "'self'", script: '/monitor.js', universe: '/universe.js', style: '/monitor.css', focusScript: '/focus-space.js', focusStyle: '/focus-space.css', nonce })
    .replace('connect-src https://www.youtube.com', "connect-src 'self' https://www.youtube.com")
    .replace('<body>', '<body><aside class="preview-notice" role="note">FIXTURE PREVIEW · Sample requests, calendar and weather. No account access, live execution or real model changes.</aside>')
    .replace('<script nonce=', stub + '<script nonce=');
  return createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/focus-space') {
      let body = '', size = 0;
      request.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024 + 4096) request.destroy(); else body += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        try { response.end(JSON.stringify(createFocusPreviewResponse(JSON.parse(body)))); }
        catch { response.writeHead(400).end(JSON.stringify({ error: 'Invalid fixture request.' })); }
      }); return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/snapshot') {
      response.setHeader('content-type', 'application/json');
      const fixture = url.searchParams.get('fixture');
      response.end(JSON.stringify(fixture === 'error' ? { type: 'error', preview: true,
        message: 'Fixture error: local state is unavailable. This is an intentional preview scenario.' }
        : createPreviewSnapshot(['small', 'empty', 'question'].includes(fixture) ? fixture : 'default')));
    } else if (['/universe.js', '/monitor.js', '/monitor.css', '/focus-space.js', '/focus-space.css'].includes(url.pathname)) {
      try {
        response.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
        response.end(readFileSync(new URL(url.pathname.slice(1), assets)));
      } catch { response.writeHead(404).end(); }
    } else if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
    } else response.writeHead(404).end();
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createPreviewServer();
  server.listen(0, '127.0.0.1', () => console.log(`WorkForce UI preview: http://127.0.0.1:${server.address().port}`));
}
