(() => {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('field'), ctx = canvas.getContext('2d');
  const status = document.getElementById('status'), roles = document.getElementById('roles');
  const list = document.getElementById('nodes'), selection = document.getElementById('selection');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let snapshot, positions = [], width = 1000, height = 480, animation, selected;
  const colors = { running: '#f9d57c', waiting: '#bca5f7', blocked: '#f29a6f', failed: '#e66f78', completed: '#88d49b', idle: '#a9b8ba', unknown: '#a9b8ba' };
  const nativeGroups = { manager: ['Manager', 'manager'], researcher: ['Manager', 'manager'], 'codebase-analyst': ['Manager', 'manager'], curator: ['Manager', 'manager'], release: ['Manager', 'manager'],
    requirements: ['SWSD', 'requirements'], architect: ['P-RES', 'architect'], 'component-owner': ['P-RES', 'architect'],
    developer: ['FnD', 'developer'], reviewer: ['Reviewer', 'reviewer'], 'check-executor': ['Tester', 'check-executor'], verifier: ['Tester', 'check-executor'] };
  const element = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  function detail(node) {
    selected = node.id;
    selection.replaceChildren(element('strong', node.label), element('div', `${node.kind} · ${node.state} · ${node.source}`),
      element('div', `Source: ${node.source_id}`));
    if (node.kind === 'agent') selection.append(element('div', `Requested: ${node.requested_model ?? 'unavailable'} · Observed: ${node.confirmed_model ?? 'unavailable'} · Provider: ${node.provider ?? 'unavailable'}`),
      element('div', `Execution: ${node.execution_mode ?? 'unavailable'} · Updated: ${node.updated_at}`));
    const edges = snapshot.edges.filter(edge => edge.from === node.id || edge.to === node.id);
    for (const edge of edges.slice(0, 16)) selection.append(element('div', `${edge.kind}: ${edge.from} → ${edge.to} · ${edge.source} ${edge.evidence_id}`));
  }
  function layout() {
    positions = [];
    if (!snapshot) return;
    const agents = snapshot.nodes.filter(node => node.kind === 'agent').slice(0, 24);
    const work = snapshot.nodes.filter(node => node.kind !== 'agent').slice(0, 12);
    const slots = [0, 0, 0, 0];
    for (const node of agents) {
      const zone = node.state === 'blocked' || node.state === 'waiting' ? 3
        : ['reviewer', 'verifier', 'check-executor'].includes(node.role) ? 2
          : ['developer', 'component-owner', 'release'].includes(node.role) ? 1 : 0;
      if (slots[zone] >= 8) continue;
      const index = slots[zone]++, x = (zone % 2 ? width * .56 : width * .08) + (index % 4) * width * .09;
      const y = (zone < 2 ? height * .23 : height * .65) + Math.floor(index / 4) * 53;
      positions.push({ node, x, y });
    }
    work.forEach((node, index) => positions.push({ node, x: width * .075 + (index % 6) * width * .16,
      y: index < 6 ? height * .45 : height * .9 }));
  }
  function text(value, x, y, color = '#dce8cf', size = 11) {
    ctx.fillStyle = color; ctx.font = `${size}px monospace`; ctx.textAlign = 'center'; ctx.fillText(value, x, y);
  }
  function draw(time = 0) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1d3638'; ctx.fillRect(0, 0, width, height);
    // Original procedural scenery: grass, field beds, a footpath, crops and fences.
    ctx.fillStyle = '#2c4941';
    for (let x = 13; x < width; x += 29) for (let y = 15; y < height; y += 23) ctx.fillRect(x + (y % 3) * 3, y, 2, 2);
    ctx.fillStyle = '#655f48'; ctx.fillRect(width * .46, 0, width * .08, height); ctx.fillRect(0, height * .48, width, 25);
    for (let zone = 0; zone < 4; zone++) {
      const x = zone % 2 ? width * .55 : width * .025, y = zone < 2 ? 48 : height * .57;
      const w = width * .425, h = height * .31;
      ctx.fillStyle = '#343c30'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#798568'; ctx.strokeRect(x, y, w, h);
      text(['RESEARCH & PLAN', 'BUILD & RELEASE', 'CHECK & REVIEW', 'WAITING & BLOCKED'][zone], x + w / 2, y - 12, '#bad1a6');
      ctx.fillStyle = '#4b6a43';
      for (let cx = x + 10; cx < x + w - 5; cx += 15) ctx.fillRect(cx, y + h - 13, 3, 8);
    }
    ctx.fillStyle = '#8b926a'; ctx.fillRect(0, 12, width, 5);
    for (let x = 16; x < width; x += 37) ctx.fillRect(x, 5, 5, 20);
    const lookup = new Map(positions.map(position => [position.node.id, position]));
    for (const edge of snapshot?.edges ?? []) {
      const from = lookup.get(edge.from), to = lookup.get(edge.to); if (!from || !to) continue;
      ctx.strokeStyle = edge.animated ? '#79c7df99' : '#e2c98370'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
      if (edge.animated && !reduced.matches) {
        const t = (time / 4200) % 1; ctx.fillStyle = '#92e4f5'; ctx.fillRect(from.x + (to.x - from.x) * t - 2, from.y + (to.y - from.y) * t - 2, 4, 4);
      }
    }
    for (const { node, x, y } of positions) {
      const color = colors[node.state], bounce = !reduced.matches && node.state === 'running' ? Math.floor(time / 320) % 2 : 0;
      if (node.kind === 'agent') {
        const cy = y - bounce; ctx.fillStyle = '#c7a17d'; ctx.fillRect(x - 6, cy - 15, 12, 11);
        ctx.fillStyle = '#35495d'; ctx.fillRect(x - 7, cy - 7, 14, 14);
        ctx.fillStyle = color; ctx.fillRect(x - 9, cy - 19, 18, 5); ctx.fillRect(x - 5, cy - 23, 10, 5);
        ctx.fillStyle = '#19242d'; ctx.fillRect(x - 5, cy + 7, 4, 8); ctx.fillRect(x + 2, cy + 7, 4, 8);
        ctx.fillStyle = '#17272e'; ctx.fillRect(x - 3, cy - 12, 2, 2); ctx.fillRect(x + 3, cy - 12, 2, 2);
        if (node.state === 'waiting' || node.state === 'blocked') text('!', x + 13, cy - 23, color, 15);
      } else {
        ctx.fillStyle = node.kind === 'workflow' ? '#6b8d76' : '#8a805b'; ctx.fillRect(x - 8, y - 12, 16, 14);
        ctx.fillStyle = color; ctx.fillRect(x - 5, y - 9, 10, 3);
      }
      const labelLimit = Math.max(9, Math.floor(width * .08 / 6));
      text(node.label.length > labelLimit ? `${node.label.slice(0, labelLimit - 1)}…` : node.label, x, y + 27, color, 10);
      if (node.id === selected) { ctx.strokeStyle = '#fff1bf'; ctx.strokeRect(x - 15, y - 28, 30, 45); }
    }
    if (!positions.length) {
      ctx.fillStyle = '#172d30ed'; ctx.fillRect(width * .18, height / 2 - 35, width * .64, 70);
      text('No recorded agents or work yet', width / 2, height / 2 - 8, '#d6e6cd', 15);
      text('Configured role models are available below', width / 2, height / 2 + 16);
    }
    if (snapshot && snapshot.nodes.length > positions.length) text(`${snapshot.nodes.length - positions.length} more items in the list below`, width / 2, height - 8);
  }
  function tick(time) { draw(time); if (!reduced.matches && !document.hidden) animation = requestAnimationFrame(tick); }
  function animate() { cancelAnimationFrame(animation); draw(); if (!reduced.matches && !document.hidden) animation = requestAnimationFrame(tick); }
  function resize() { const box = canvas.getBoundingClientRect(); width = box.width; height = box.height;
    const scale = window.devicePixelRatio || 1; canvas.width = width * scale; canvas.height = height * scale; ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.imageSmoothingEnabled = false; layout(); animate(); }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'error') { status.textContent = message.message; return; }
    if (message.type !== 'snapshot') return;
    snapshot = message.map;
    const counts = snapshot.nodes.filter(node => node.kind === 'agent').length;
    const signed = snapshot.nodes.filter(node => node.kind === 'agent' && node.source === 'signed-receipt').length;
    const omitted = Object.values(snapshot.diagnostics).reduce((sum, count) => sum + count, 0);
    status.textContent = `${snapshot.project.name} · ${signed} signed / ${counts - signed} reported agents · ${message.active_count ?? 'unknown'} active invocations · ${message.control_unavailable ? 'Model controls unavailable: inspect policy or invalid receipts' : message.router_configured ? '9router configured' : 'VS Code provider routing'} · ${new Date(snapshot.observed_at).toLocaleTimeString()}${omitted ? ` · ${omitted} invalid or omitted items` : ''}`;
    roles.replaceChildren();
    for (const role of message.roles) {
      const card = element('div', '', 'role'); card.append(element('strong', role.role), element('span', role.models.join(' → ')),
        element('span', `${role.provider ?? 'configured provider'} · ${role.reasoning_effort} effort`));
      const group = nativeGroups[role.role];
      if (group) card.append(element('span', `Native ${group[0]} file uses ${group[1]} model policy.`));
      const button = element('button', group && group[1] !== role.role ? 'Choose role model (strict bridge)' : 'Choose model'); button.addEventListener('click', () => vscode.postMessage({ type: 'select-model', role: role.role }));
      card.append(button); roles.append(card);
    }
    list.replaceChildren();
    for (const node of snapshot.nodes) { const button = element('button', `${node.label} · ${node.kind} · ${node.state} · ${node.source}`, 'node'); button.addEventListener('click', () => { detail(node); draw(); }); list.append(button); }
    if (!counts) list.prepend(element('p', 'No agent receipts or saved role contributions yet. Available role models are configuration, and appear above. Task and workflow records can still appear on the map.', 'empty'));
    const current = snapshot.nodes.find(node => node.id === selected); if (current) detail(current);
    resize();
  });
  canvas.addEventListener('click', event => { const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
    const target = positions.find(position => Math.abs(position.x - x) < 23 && Math.abs(position.y - y) < 30); if (target) { detail(target.node); draw(); } });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.addEventListener('visibilitychange', animate); reduced.addEventListener('change', animate);
  new ResizeObserver(resize).observe(canvas); resize();
  vscode.postMessage({ type: 'refresh' });
})();
