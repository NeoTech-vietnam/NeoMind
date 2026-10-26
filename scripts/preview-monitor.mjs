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
const work = {
  manager: ['Coordinate universe release', 'running'], requirements: ['Define the navigation contract', 'completed'],
  architect: ['Design role and task orbits', 'completed'], 'component-owner': ['Check renderer boundaries', 'waiting'],
  verifier: ['Review motion accessibility', 'waiting'], reviewer: ['Inspect policy protections', 'blocked'],
  researcher: ['Compare upstream agent maps', 'completed'], 'codebase-analyst': ['Trace existing runtime seams', 'completed'],
  curator: ['Record reusable UI findings', 'idle'], developer: ['Build the universe renderer', 'running'],
  'check-executor': ['Exercise selection and resize', 'running'], release: ['Prepare the reviewed package', 'blocked'],
};

/** Deterministic, unsigned sample records for visual QA; never execution attestations. */
export function createPreviewSnapshot(fixture = 'default') {
  const allRoles = [...strongRoles, ...workerRoles];
  const selected = fixture === 'small' ? new Set(['manager', 'architect', 'developer', 'reviewer']) : new Set(allRoles);
  const roles = allRoles.filter(role => selected.has(role)).map(role => ({
    role, provider: '9Router', models: [strongRoles.includes(role) ? 'demo/strategic' : 'demo/worker'],
    reasoning_effort: strongRoles.includes(role) ? 'high' : 'low', strong: strongRoles.includes(role),
  }));
  const workflow = 'fixture:workflow:universe';
  const base = { source: 'project-record', requested_model: null, confirmed_model: null, provider: null, execution_mode: null };
  const nodes = fixture === 'empty' ? [] : [{ ...base, id: workflow, kind: 'workflow',
    label: 'Universe monitor · demo increment', role: 'manager', state: 'running', source_id: workflow,
    invocation_id: null, workflow_id: workflow, task_id: null, updated_at: fixtureAt(0) }];
  const edges = [];
  function edge(from, to, kind, evidence, index) {
    edges.push({ id: `fixture:edge:${kind}:${from}:${to}`, from, to, kind, source: 'project-record',
      evidence_id: `fixture:${evidence}`, at: fixtureAt(index), animated: ['handoff', 'report', 'contribution'].includes(kind) });
  }
  if (fixture !== 'empty') roles.forEach(({ role }, index) => {
    const task = `fixture:task:${role}`, agent = `fixture:reported:${role}`, [label, state] = work[role];
    nodes.push({ ...base, id: task, kind: 'task', label, role, state, source_id: task,
      invocation_id: null, workflow_id: workflow, task_id: task, updated_at: fixtureAt(index + 1) });
    // A saved report is completed; its task may still be working, waiting or blocked.
    nodes.push({ ...base, id: agent, kind: 'agent', label: `${role} · sample report`, role, state: 'completed',
      source_id: `fixture:report:${role}`, invocation_id: `fixture-invocation-${role}`, workflow_id: workflow,
      task_id: task, execution_mode: 'unsigned-native-report', updated_at: fixtureAt(index + 2) });
    edge(workflow, task, 'assignment', `assignment:${role}`, index);
    edge(agent, task, 'report', `report:${role}`, index + 2);
    edge(agent, workflow, 'contribution', `contribution:${role}`, index + 2);
  });
  // Explicit sample events illustrate recorded replay, without a live message or signed receipt.
  if (fixture !== 'empty') for (const [from, to, index] of [
    ['researcher', 'architect', 15], ['architect', 'developer', 16], ['developer', 'reviewer', 17],
    ['reviewer', 'check-executor', 18], ['check-executor', 'release', 19],
  ]) if (selected.has(from) && selected.has(to)) {
    edge(`fixture:reported:${from}`, `fixture:reported:${to}`, 'handoff', `recorded-handoff:${from}:${to}`, index);
    edge(`fixture:task:${to}`, `fixture:task:${from}`, 'depends-on', `dependency:${from}:${to}`, index);
  }
  if (fixture === 'activity') {
    for (const [profile, role, state, summary] of [
      ['coordinator', 'manager', 'running', 'Coordinate bounded research and planning'],
      ['explorer', 'codebase-analyst', 'running', 'Trace the existing module interfaces'],
      ['planner', 'requirements', 'waiting', 'Define measurable product milestones'],
    ]) nodes.push({ ...base, id: `fixture:progress:${profile}`, kind: 'agent', label: `NeoMind ${profile[0].toUpperCase() + profile.slice(1)} Agent`,
      role, state, source: 'native-activity', source_id: `fixture:event:${profile}`, invocation_id: null, workflow_id: workflow, task_id: null,
      updated_at: fixtureAt(19), reported_at: fixtureAt(19), expires_at: fixtureAt(29), expired: false,
      profile_id: profile, assignment_id: profile === 'coordinator' ? 'coordinator' : `${profile}-1`,
      reported_state: profile === 'planner' ? 'dispatched' : 'running', activity_summary: summary, execution_mode: 'unsigned-native-progress' });
    for (const profile of ['explorer', 'planner']) edges.push({ id: `fixture:dispatch:${profile}`, from: 'fixture:progress:coordinator', to: `fixture:progress:${profile}`,
      kind: 'handoff', source: 'native-activity', evidence_id: `fixture:event:${profile}`, at: fixtureAt(19), animated: true });
  }
  return { type: 'snapshot', preview: true, map: { schema_version: 1,
    project: { id: 'FIXTURE', name: `NeoMind universe · ${fixture} fixture data` }, observed_at: fixtureAt(20), nodes, edges,
    diagnostics: { invalid_receipts: 0, omitted_receipts: 0, omitted_records: 0, omitted_edges: 0 } },
  roles, agent_profiles: agentProfiles.map(profile => ({ id: profile.id, name: profile.name, roles: [...profile.roles],
    model_role: profile.modelRole, description: profile.duty, native_tools: [...profile.nativeTools] })),
  router_configured: false, active_count: 0, control_unavailable: false };
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
  const nonce = 'neomind-local-preview';
  const stub = `<script nonce="${nonce}">(()=>{let saved;try{saved=JSON.parse(localStorage.getItem('neomind-preview-state')||'null')}catch{}window.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value;localStorage.setItem('neomind-preview-state',JSON.stringify(value))},postMessage:async m=>{if(m.type==='select-model'){document.getElementById('status').textContent='Fixture preview: no model change was made. Open the NeoMind universe in VS Code to use guarded model controls.';return;}if(m.type==='focus-space'){if(m.action==='cancel')return;const r=await fetch('/focus-space',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});window.postMessage(await r.json(),'*');return;}const data=await(await fetch('/snapshot'+window.location.search)).json();window.postMessage(data,'*');}});})();</script>`;
  const html = renderMonitorHtml({ cspSource: "'self'", script: '/monitor.js', universe: '/universe.js', style: '/monitor.css', focusScript: '/focus-space.js', focusStyle: '/focus-space.css', nonce })
    .replace('connect-src https://www.youtube.com', "connect-src 'self' https://www.youtube.com")
    .replace('<body>', '<body><aside class="preview-notice" role="note">FIXTURE PREVIEW · Sample agents, calendar and weather. No account access, live agents, signed receipts, router connection or real model changes.</aside>')
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
        : createPreviewSnapshot(['small', 'empty', 'activity'].includes(fixture) ? fixture : 'default')));
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
  server.listen(0, '127.0.0.1', () => console.log(`NeoMind demo preview: http://127.0.0.1:${server.address().port}`));
}
