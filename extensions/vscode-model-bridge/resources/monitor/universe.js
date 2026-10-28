/* WorkForce V-model. Stage truth comes from backend milestones, never timers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkForceUniverse = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const stages = Object.freeze([
    { id: 'requirements', label: 'Requirement Gathering', role: 'WF.SWSD', x: 24, y: 28, width: 254, height: 84 },
    { id: 'analysis', label: 'System Analysis', role: 'WF.SWSD', x: 79, y: 122, width: 254, height: 84 },
    { id: 'architecture', label: 'Software Design', role: 'WF.P-RES', x: 134, y: 216, width: 254, height: 84 },
    { id: 'module-design', label: 'Module Design', role: 'WF.P-RES', x: 189, y: 310, width: 224, height: 84 },
    { id: 'coding', label: 'Coding', role: 'WF.FnD', x: 326, y: 414, width: 258, height: 88 },
    { id: 'unit', label: 'Unit Testing', role: 'WF.Tester', x: 497, y: 310, width: 224, height: 84 },
    { id: 'integration', label: 'Integration Testing', role: 'WF.Tester', x: 522, y: 216, width: 254, height: 84 },
    { id: 'system', label: 'System Testing', role: 'WF.Tester', x: 577, y: 122, width: 254, height: 84 },
    { id: 'acceptance', label: 'Acceptance Testing', role: 'WF.Tester', x: 632, y: 28, width: 254, height: 84 },
  ]);
  const stageAliases = { requirement: 'requirements', 'requirement-gathering': 'requirements', 'system-analysis': 'analysis',
    'software-design': 'architecture', design: 'architecture', module: 'module-design', implementation: 'coding',
    'unit-testing': 'unit', 'integration-testing': 'integration', 'system-testing': 'system', 'acceptance-testing': 'acceptance' };
  const states = new Set(['pending', 'queued', 'running', 'waiting', 'repairing', 'interrupted', 'uncertain', 'completed', 'passed', 'failed', 'not-applicable', 'not_applicable']);
  const text = (value, max = 256) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
  function stageId(value) { const key = text(value, 64).toLowerCase().replaceAll('_', '-'); return stageAliases[key] ?? key; }
  function stageState(value) { return states.has(value) ? value === 'passed' ? 'completed' : value === 'not_applicable' ? 'not-applicable' : value : 'pending'; }
  function buildScene(request) {
    const milestones = Array.isArray(request?.stages) ? request.stages : Array.isArray(request?.milestones) ? request.milestones : [];
    const source = new Map(milestones.filter(item => item && typeof item.id === 'string').map(item => [stageId(item.id), item]));
    return { request_id: request?.workflow_id ?? request?.request_id ?? null,
      stages: stages.map(stage => {
        const milestone = source.get(stage.id);
        return { ...stage, state: stageState(milestone?.state ?? milestone?.status),
          summary: text(milestone?.summary ?? milestone?.rationale),
          role: text(milestone?.agent ?? milestone?.role, 64) || stage.role };
      }), review: request?.review ?? milestones.find(item => stageId(item?.id) === 'review') ?? null };
  }
  function create(container, { onSelect = () => {} } = {}) {
    const document = container.ownerDocument ?? globalThis.document, ns = 'http://www.w3.org/2000/svg';
    let selected = null;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 910 526'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'V-model engineering stages');
    svg.setAttribute('class', 'v-model');
    const links = document.createElementNS(ns, 'g'); links.setAttribute('class', 'v-links');
    for (let index = 0; index < 4; index++) {
      const line = document.createElementNS(ns, 'path'), left = stages[index], right = stages[8 - index];
      line.setAttribute('d', `M${left.x + left.width + 8} ${left.y + 42} H${right.x - 8}`);
      line.setAttribute('class', 'v-pair'); links.append(line);
    }
    const route = document.createElementNS(ns, 'path');
    route.setAttribute('d', 'M148 70 L450 460 L762 70'); route.setAttribute('class', 'v-route'); links.append(route);
    svg.append(links);
    const rows = new Map();
    function select(id) { selected = id; for (const [key, row] of rows) row.group.setAttribute('aria-pressed', String(id === key)); }
    for (const stage of stages) {
      const group = document.createElementNS(ns, 'g'); group.setAttribute('class', 'v-node'); group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button'); group.setAttribute('aria-pressed', 'false'); group.setAttribute('data-stage', stage.id);
      const shape = document.createElementNS(ns, 'path');
      const inset = stage.x < 326 ? 36 : -36;
      shape.setAttribute('d', stage.id === 'coding'
        ? `M${stage.x} ${stage.y} H${stage.x + stage.width} L${stage.x + stage.width - 36} ${stage.y + stage.height} H${stage.x + 36} Z`
        : `M${stage.x} ${stage.y} H${stage.x + stage.width} L${stage.x + stage.width + inset} ${stage.y + stage.height} H${stage.x + inset} Z`);
      const label = document.createElementNS(ns, 'text'); label.setAttribute('x', stage.x + stage.width / 2); label.setAttribute('y', stage.y + 30); label.textContent = stage.label;
      const role = document.createElementNS(ns, 'text'); role.setAttribute('x', stage.x + stage.width / 2); role.setAttribute('y', stage.y + 50); role.setAttribute('class', 'v-role'); role.textContent = stage.role;
      const state = document.createElementNS(ns, 'text'); state.setAttribute('x', stage.x + stage.width / 2); state.setAttribute('y', stage.y + 69); state.setAttribute('class', 'v-state'); state.textContent = 'Pending';
      const title = document.createElementNS(ns, 'title'); group.append(title, shape, label, role, state); svg.append(group);
      const pick = () => { select(stage.id); onSelect(stage.id); };
      group.addEventListener('click', pick); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } });
      rows.set(stage.id, { group, state, role, title });
    }
    container.replaceChildren(svg);
    return { setData(request) {
      const scene = buildScene(request);
      for (const stage of scene.stages) {
        const row = rows.get(stage.id); row.group.setAttribute('data-state', stage.state);
        row.group.setAttribute('aria-label', `${stage.label}: ${stage.state.replaceAll('-', ' ')}. ${stage.role}${stage.summary ? `. ${stage.summary}` : ''}`);
        row.state.textContent = stage.state.replaceAll('-', ' '); row.role.textContent = stage.role;
        row.title.textContent = `${stage.label} · ${stage.state}${stage.summary ? ` — ${stage.summary}` : ''}`;
      }
    }, setSelected: select, setMotion(enabled) { svg.setAttribute('data-motion', String(Boolean(enabled))); },
    resetView() { select(null); }, focus(id) { rows.get(id)?.group.focus?.(); }, getState() { return { selected }; },
    destroy() { container.replaceChildren(); } };
  }
  return { stages, stageId, stageState, buildScene, create };
});
