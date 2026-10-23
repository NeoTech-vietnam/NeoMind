/* NeoMind orbital view. Original procedural artwork; no assets, requests or dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeoMindUniverse = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const limits = Object.freeze({ roles: 64, nodes: 256, edges: 512, dpr: 2 });
  const roleOrder = ['manager', 'requirements', 'architect', 'component-owner', 'reviewer', 'verifier',
    'researcher', 'codebase-analyst', 'curator', 'developer', 'check-executor', 'release'];
  const colors = { configured: '#849bb7', recorded: '#849bb7', running: '#78daaa', waiting: '#e6c274',
    blocked: '#f28b7f', failed: '#f28b7f', completed: '#71bfff', idle: '#849bb7', unknown: '#849bb7' };
  const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
  const finite = (n, fallback) => Number.isFinite(n) ? n : fallback;
  const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
  const clean = value => text(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
  function seed(value) {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
    return result >>> 0;
  }
  function random(value) {
    let state = value >>> 0;
    return () => { state += 0x6d2b79f5; let t = Math.imul(state ^ state >>> 15, 1 | state);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const pretty = role => role.split('-').map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ');

  /** Configuration creates planets, never invocation identities or communication evidence. */
  function buildScene(input = {}) {
    const map = input.map || {}, supplied = Array.isArray(map.nodes) ? map.nodes : [];
    const nodes = [], ids = new Set();
    for (const node of supplied) {
      if (nodes.length >= limits.nodes) break;
      if (!node || typeof node.id !== 'string' || !node.id || node.id.startsWith('role:') || ids.has(node.id) ||
        !['agent', 'workflow', 'task'].includes(node.kind)) continue;
      nodes.push(node); ids.add(node.id);
    }
    const configured = new Map();
    for (const value of Array.isArray(input.roles) ? input.roles : []) {
      const item = typeof value === 'string' ? { role: value } : value;
      if (configured.size >= limits.roles) break;
      if (item && typeof item.role === 'string' && item.role) configured.set(item.role, item);
    }
    const roleNames = new Set(configured.keys());
    for (const node of nodes) if (typeof node.role === 'string' && node.role && roleNames.size < limits.roles) roleNames.add(node.role);
    const names = [...roleNames].sort((a, b) => a.localeCompare(b));
    const planets = names.map(role => {
      const config = configured.get(role), related = nodes.filter(node => node.role === role), agents = related.filter(node => node.kind === 'agent');
      const observed = agents.filter(node => node.source === 'signed-receipt' || node.source === 'native-activity');
      const activity = agents.filter(node => node.source === 'native-activity');
      const states = ['running', 'waiting', 'blocked', 'failed', 'completed', 'idle', 'unknown'];
      const state = observed.length ? states.find(state => observed.some(node => node.state === state)) || 'recorded'
        : related.length ? 'recorded' : 'configured';
      const index = roleOrder.indexOf(role), value = seed(role), outer = index >= 0 ? index % 2 === 1 : true;
      return { id: `role:${role}`, kind: 'role', role, label: clean(config?.display_name) || pretty(role), configured: !!config,
        models: Array.isArray(config?.models) ? config.models.filter(model => typeof model === 'string') : [], provider: text(config?.provider) || null,
        state, evidence_count: related.length, agent_count: agents.length, activity_count: activity.length, seed: value,
        parentId: null, radius: 36 + (config?.strong ? 5 : 0) + value % 5,
        angle: index >= 0 ? Math.floor(index / 2) * TAU / 6 - Math.PI / 2 + (outer ? TAU / 12 : 0) : value / 4294967296 * TAU,
        orbit: index >= 0 ? (outer ? 540 : 330) : 540 + value % 40,
        speed: (outer ? .0011 : -.0015), material: index >= 0 ? index % 6 : value % 6, rings: [3, 5].includes(index >= 0 ? index % 6 : value % 6),
      };
    });
    const planetIds = new Set(planets.map(body => body.id));
    const bodies = [...planets, ...nodes.map(node => {
      const value = seed(node.id), station = node.kind === 'workflow';
      return { id: node.id, kind: node.kind, label: clean(node.label) || node.id, role: text(node.role) || null,
        state: text(node.state, 'unknown'), source: node.source, source_id: node.source_id,
        invocation_id: node.invocation_id, workflow_id: node.workflow_id, task_id: node.task_id,
        requested_model: node.requested_model, confirmed_model: node.confirmed_model, provider: node.provider,
        parentId: !station && planetIds.has(`role:${node.role}`) ? `role:${node.role}` : null,
        radius: station ? 9 : node.kind === 'agent' ? 7 : 5.5,
        angle: value / 4294967296 * TAU, orbit: station ? 137 + value % 53 : (node.kind === 'agent' ? 55 : 85) + value % 25,
        speed: station ? .004 : (node.kind === 'agent' ? .035 : -.022) * (value % 2 ? 1 : -1), seed: value,
      };
    })];
    const represented = new Set(bodies.map(body => body.id)), edges = [], edgeIds = new Set();
    for (const edge of Array.isArray(map.edges) ? map.edges : []) {
      if (edges.length >= limits.edges) break;
      if (!edge || !represented.has(edge.from) || !represented.has(edge.to) || edge.from === edge.to || edgeIds.has(edge.id)) continue;
      edges.push({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, source: edge.source,
        evidence_id: edge.evidence_id, at: edge.at, animated: edge.animated === true });
      edgeIds.add(edge.id);
    }
    return { planets, bodies, edges, stale: map.stale === true,
      counts: { configured_roles: configured.size, recorded_agents: nodes.filter(node => node.kind === 'agent').length,
        running_agents: nodes.filter(node => node.kind === 'agent' && node.source === 'signed-receipt' && node.state === 'running').length,
        tasks: nodes.filter(node => node.kind === 'task').length, workflows: nodes.filter(node => node.kind === 'workflow').length },
      omitted: { nodes: Math.max(0, supplied.length - nodes.length), edges: Math.max(0, (map.edges?.length || 0) - edges.length) } };
  }

  function worldPositions(scene, time, flattening) {
    const positions = new Map();
    for (const body of scene.bodies) {
      const parent = positions.get(body.parentId), angle = body.angle + time * body.speed;
      const flatten = body.kind === 'role' ? flattening : body.kind === 'workflow' ? flattening * .9 : .68;
      const orbit = body.parentId ? body.orbit : body.kind === 'role' || body.kind === 'workflow' ? body.orbit : 200 + body.orbit;
      positions.set(body.id, { x: (parent?.x || 0) + Math.cos(angle) * orbit,
        y: (parent?.y || 0) + Math.sin(angle) * orbit * flatten, depth: Math.sin(angle) });
    }
    return positions;
  }
  const orbitFlatten = (width, height) => clamp(height / width * .9, .4, 1.6);
  const viewScale = (width, height) => Math.min(Math.max(1, width - 72) / 1180,
    Math.max(1, height - 145) / (1080 * orbitFlatten(width, height) * .8661 + 100));
  function projectScene(scene, options = {}) {
    const width = Math.max(1, finite(options.width, 1000)), height = Math.max(1, finite(options.height, 700));
    const zoom = clamp(finite(options.zoom, 1), .55, 4), scale = viewScale(width, height) * zoom;
    const positions = worldPositions(scene, finite(options.time, 0), orbitFlatten(width, height));
    return scene.bodies.map(body => {
      const world = positions.get(body.id);
      return { ...body, worldX: world.x, worldY: world.y, x: width / 2 + world.x * scale + finite(options.panX, 0),
        y: height / 2 + world.y * scale + finite(options.panY, 0),
        radius: Math.max(body.kind === 'role' ? 12 : 3, body.radius * scale), scale, depth: world.depth };
    });
  }
  function hitTest(bodies, x, y) {
    const matches = bodies.filter(body => Math.hypot(body.x - x, body.y - y) <= body.radius + 6 ||
      (body.labelBounds && x >= body.labelBounds.x && x <= body.labelBounds.x + body.labelBounds.width && y >= body.labelBounds.y && y <= body.labelBounds.y + body.labelBounds.height));
    return matches.sort((a, b) => a.radius - b.radius || b.depth - a.depth)[0] || null;
  }
  const shouldAnimate = (requested, reduced, hidden) => requested === true && !reduced && !hidden;
  function controlPoint(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y, distance = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(100, distance * .2);
    return { x: (from.x + to.x) / 2 - dy / distance * bend, y: (from.y + to.y) / 2 + dx / distance * bend };
  }
  function curvePoint(from, to, amount) {
    const t = clamp(amount, 0, 1), c = controlPoint(from, to), a = 1 - t;
    return { x: a * a * from.x + 2 * a * t * c.x + t * t * to.x,
      y: a * a * from.y + 2 * a * t * c.y + t * t * to.y };
  }

  function mix(a, b, amount) { return a.map((value, index) => value + (b[index] - value) * clamp(amount, 0, 1)); }
  function lattice(x, y, value) { let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(value, 69069);
    n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967295; }
  function noise(x, y, value) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = lattice(ix, iy, value), b = lattice(ix + 1, iy, value), c = lattice(ix, iy + 1, value), d = lattice(ix + 1, iy + 1, value);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  }
  function fractal(x, y, value) { return noise(x, y, value) * .55 + noise(x * 2.05, y * 2.05, value + 1) * .28 + noise(x * 4.1, y * 4.1, value + 2) * .12 + noise(x * 8.2, y * 8.2, value + 3) * .05; }
  const palettes = [
    [[9, 40, 82], [36, 104, 128], [91, 132, 93], [206, 194, 140]],
    [[35, 77, 100], [96, 159, 174], [169, 206, 207], [227, 238, 222]],
    [[58, 28, 33], [133, 57, 41], [195, 108, 65], [234, 192, 126]],
    [[23, 41, 67], [64, 93, 145], [114, 153, 186], [183, 207, 211]],
    [[37, 28, 64], [92, 62, 126], [158, 112, 158], [210, 176, 187]],
    [[51, 40, 37], [116, 96, 62], [183, 158, 111], [234, 218, 177]],
  ];
  function surfaceSample(material, value, u, v) {
    const palette = palettes[material % palettes.length], shift = (value % 997) / 37;
    const terrain = fractal(u * 9 + shift, v * 6, value), fine = noise(u * 92, v * 61, value + 9);
    let result;
    if ([3, 4, 5].includes(material % 6)) {
      const bands = Math.sin(v * 67 + terrain * 9) * .14 + Math.sin(v * 23 + terrain * 4) * .16 + terrain;
      result = mix(palette[0], palette[2], bands);
      result = mix(result, palette[3], Math.pow(clamp(Math.sin(v * 92 + terrain * 6) * .5 + .5, 0, 1), 9) * .27);
    } else if (material % 6 === 0) {
      result = terrain < .51 ? mix(palette[0], palette[1], terrain * 1.3) : mix(palette[2], palette[3], (terrain - .52) * 3);
      const ice = clamp((Math.abs(v - .5) - .38 + terrain * .035) * 15, 0, 1);
      result = mix(result, [226, 233, 225], ice);
    } else {
      result = terrain < .48 ? mix(palette[0], palette[1], terrain * 1.4) : mix(palette[1], palette[3], (terrain - .4) * 1.6);
    }
    const clouds = clamp((fractal(u * 14 + shift + 19, v * 9 + 21, value + 4) - .57) * 6, 0, .8);
    if (material % 6 < 2) result = mix(result, [225, 234, 233], clouds);
    return result.map(channel => clamp(channel + (fine - .5) * 13, 0, 255));
  }

  function create(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new Error('NeoMind Universe needs a canvas.');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas rendering is unavailable. Use the recorded item list.');
    const doc = canvas.ownerDocument || (typeof document === 'object' ? document : null);
    const view = doc?.defaultView || (typeof window === 'object' ? window : null);
    const preference = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const frame = callback => view?.requestAnimationFrame ? view.requestAnimationFrame(callback) : null;
    const cancel = id => { if (id !== null && view?.cancelAnimationFrame) view.cancelAnimationFrame(id); };
    const offscreen = (width, height) => { const result = doc.createElement('canvas'); result.width = width; result.height = height; return result; };
    let scene = buildScene(), projected = [], selected = null, hovered = null, width = 1000, height = 700, dpr = 1;
    let requestedMotion = true, elapsed = 0, lastFrame = null, animation = null, destroyed = false, backdrop = null, solarTexture = null;
    let zoom = 1, panX = 0, panY = 0, pointer = null;
    const textureCache = new Map(), spriteCache = new Map(), listeners = [];
    function listen(target, event, callback, settings) { target?.addEventListener?.(event, callback, settings); listeners.push(() => target?.removeEventListener?.(event, callback, settings)); }
    const moving = () => shouldAnimate(requestedMotion, preference?.matches, doc?.hidden);

    function makeBackground() {
      backdrop = offscreen(Math.ceil(width * dpr), Math.ceil(height * dpr));
      const bg = backdrop.getContext('2d'); bg.scale(dpr, dpr);
      bg.fillStyle = '#03070f'; bg.fillRect(0, 0, width, height);
      const next = random(41823);
      bg.globalCompositeOperation = 'screen';
      for (let i = 0; i < 19; i++) {
        const x = width * (.08 + next() * .88), y = height * (.12 + next() * .78), radius = Math.max(width, height) * (.15 + next() * .25);
        const gradient = bg.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, i % 3 ? 'rgba(35,60,112,.075)' : 'rgba(104,44,101,.065)'); gradient.addColorStop(1, 'transparent');
        bg.fillStyle = gradient; bg.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      for (let i = 0; i < Math.min(800, Math.floor(width * height / 1100)); i++) {
        const x = next() * width, y = next() * height, radius = next() < .94 ? .35 + next() * .55 : 1 + next() * .55;
        bg.fillStyle = ['#9db8d1', '#c9daf4', '#b4bdd1', '#d4c1a6'][i % 4]; bg.globalAlpha = .13 + next() * .7;
        bg.beginPath(); bg.arc(x, y, radius, 0, TAU); bg.fill();
        if (radius > 1.3) { bg.globalAlpha *= .3; bg.fillRect(x - 3.5, y - .25, 7, .5); bg.fillRect(x - .25, y - 3.5, .5, 7); }
      }
      bg.globalAlpha = 1;
    }
    function texture(body) {
      if (textureCache.has(body.id)) return textureCache.get(body.id);
      const w = 256, h = 128, data = new Uint8ClampedArray(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const color = surfaceSample(body.material, body.seed, x / w, y / h), offset = (y * w + x) * 3;
        data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2];
      }
      const result = { w, h, data }; textureCache.set(body.id, result); return result;
    }
    function sphere(body) {
      const phase = Math.floor(elapsed * 3) / 3, lightAngle = Math.atan2(-body.worldY, -body.worldX);
      const key = `${phase}:${Math.round(lightAngle * 16)}`;
      const previous = spriteCache.get(body.id); if (previous?.key === key) return previous.canvas;
      const size = 112, sprite = previous?.canvas || offscreen(size, size), context = sprite.getContext('2d');
      const image = context.createImageData(size, size), surface = texture(body);
      const light = [Math.cos(lightAngle) * .84, Math.sin(lightAngle) * .65, .58];
      const length = Math.hypot(...light); for (let i = 0; i < 3; i++) light[i] /= length;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const nx = (x + .5 - size / 2) / (size / 2), ny = (y + .5 - size / 2) / (size / 2), r2 = nx * nx + ny * ny;
        if (r2 > 1) continue;
        const nz = Math.sqrt(1 - r2), u = ((Math.atan2(nx, nz) / TAU + .5 + phase * .012 + body.seed / 4294967296) % 1 + 1) % 1;
        const v = .5 + Math.asin(ny) / Math.PI;
        const offset = (Math.floor(v * (surface.h - 1)) * surface.w + Math.floor(u * (surface.w - 1))) * 3;
        const diffuse = Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
        const shade = .065 + Math.pow(diffuse, .85) * .97, limb = Math.pow(1 - nz, 2.6);
        const pixel = (y * size + x) * 4;
        const specular = body.material === 0 ? Math.pow(Math.max(0, nx * light[0] * .5 + ny * light[1] * .5 + nz * .91), 37) * 40 : 0;
        image.data[pixel] = clamp(surface.data[offset] * shade + limb * 9 + specular, 0, 255);
        image.data[pixel + 1] = clamp(surface.data[offset + 1] * shade + limb * 27 + specular, 0, 255);
        image.data[pixel + 2] = clamp(surface.data[offset + 2] * shade + limb * 44 + specular, 0, 255);
        image.data[pixel + 3] = clamp((1 - Math.sqrt(r2)) * size, 0, 1) * 255;
      }
      context.putImageData(image, 0, 0); spriteCache.set(body.id, { key, canvas: sprite }); return sprite;
    }
    function drawSun(scale) {
      const x = width / 2 + panX, y = height / 2 + panY, radius = Math.max(26, 75 * scale);
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      const halo = ctx.createRadialGradient(x, y, radius * .25, x, y, radius * 4.5);
      halo.addColorStop(0, '#ffad4770'); halo.addColorStop(.22, '#ff9b253b'); halo.addColorStop(.5, '#b4531511'); halo.addColorStop(1, 'transparent');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, radius * 4.5, 0, TAU); ctx.fill();
      ctx.shadowColor = '#ff9c35'; ctx.shadowBlur = radius * .5;
      const core = ctx.createRadialGradient(x - radius * .22, y - radius * .25, 1, x, y, radius);
      core.addColorStop(0, '#fff3b4'); core.addColorStop(.3, '#ffe38b'); core.addColorStop(.75, '#ffc35a'); core.addColorStop(1, '#ec762b');
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'source-over';
      if (!solarTexture) {
        const size = 256; solarTexture = offscreen(size, size); const solar = solarTexture.getContext('2d'), image = solar.createImageData(size, size);
        for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
          const nx = (px + .5 - size / 2) / (size / 2), ny = (py + .5 - size / 2) / (size / 2), rr = nx * nx + ny * ny;
          if (rr > 1) continue;
          const cell = fractal(nx * 28 + 20, ny * 28 + 20, 92), plasma = noise(nx * 8 + cell * 2, ny * 8 + cell * 2, 191);
          const grain = noise(nx * 113, ny * 113, 43), limb = .66 + .34 * Math.pow(1 - rr, .24), offset = (py * size + px) * 4;
          image.data[offset] = (238 + cell * 23) * limb;
          image.data[offset + 1] = (122 + cell * 103 + plasma * 29) * limb;
          image.data[offset + 2] = (24 + cell * 69 + grain * 12) * limb;
          image.data[offset + 3] = clamp((1 - Math.sqrt(rr)) * size, 0, 1) * 255;
        }
        solar.putImageData(image, 0, 0);
      }
      ctx.save(); ctx.translate(x, y); ctx.rotate(elapsed * .008); ctx.drawImage(solarTexture, -radius, -radius, radius * 2, radius * 2); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.clip();
      const next = random(901);
      for (let i = 0; i < 110; i++) {
        const a = next() * TAU + elapsed * .008, r = Math.sqrt(next()) * radius;
        ctx.strokeStyle = i % 2 ? '#ffe29b36' : '#ac4d1b29'; ctx.lineWidth = .7;
        ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * r, y + Math.sin(a) * r, 2 + next() * 7, 1 + next() * 3, a, 0, TAU); ctx.stroke();
      }
      ctx.restore(); ctx.restore();
      ctx.textAlign = 'center'; ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = '#fff4d2';
      ctx.fillText('NEOMIND', x, y + radius + 23);
      ctx.font = '9px system-ui, sans-serif'; ctx.fillStyle = '#baaa86'; ctx.fillText('ORCHESTRATOR', x, y + radius + 38);
    }
    function ring(body, foreground) {
      if (!body.rings) return;
      const radius = body.radius;
      ctx.save(); ctx.translate(body.x, body.y); ctx.rotate(-.3);
      ctx.strokeStyle = '#b7c6de45'; ctx.lineWidth = Math.max(2, radius * .17); ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.65, radius * .46, 0, foreground ? 0 : Math.PI, foreground ? Math.PI : TAU); ctx.stroke();
      ctx.strokeStyle = '#d2ccbd58'; ctx.lineWidth = Math.max(.6, radius * .035); ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.83, radius * .51, 0, foreground ? 0 : Math.PI, foreground ? Math.PI : TAU); ctx.stroke(); ctx.restore();
    }
    function drawPlanet(body) {
      const radius = body.radius;
      if (body.x + radius * 3 < 0 || body.x - radius * 3 > width || body.y + radius * 3 < 0 || body.y - radius * 3 > height) return;
      ring(body, false);
      const atmosphere = ctx.createRadialGradient(body.x, body.y, radius * .75, body.x, body.y, radius * 1.35);
      atmosphere.addColorStop(0, 'transparent'); atmosphere.addColorStop(.65, '#6bafe83b'); atmosphere.addColorStop(1, 'transparent');
      ctx.fillStyle = atmosphere; ctx.beginPath(); ctx.arc(body.x, body.y, radius * 1.35, 0, TAU); ctx.fill();
      ctx.drawImage(sphere(body), body.x - radius, body.y - radius, radius * 2, radius * 2); ring(body, true);
      if (body.evidence_count) {
        ctx.strokeStyle = scene.stale ? colors.unknown : colors[body.state] || colors.recorded; ctx.lineWidth = 1.2; ctx.globalAlpha = .75;
        ctx.beginPath(); ctx.arc(body.x, body.y, radius + 5, -.8, .8); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    function drawMoon(body) {
      const r = body.radius, tint = scene.stale ? colors.unknown : colors[body.state] || colors.unknown;
      ctx.save(); ctx.translate(body.x, body.y);
      if (body.kind === 'workflow') {
        ctx.rotate(-.35); ctx.fillStyle = '#6d9cb0'; ctx.strokeStyle = '#92d8ea85'; ctx.lineWidth = 1;
        ctx.fillRect(-r * 2.4, -r * .4, r * 1.5, r * .8); ctx.fillRect(r * .9, -r * .4, r * 1.5, r * .8);
        ctx.strokeRect(-r * 2.4, -r * .4, r * 1.5, r * .8); ctx.strokeRect(r * .9, -r * .4, r * 1.5, r * .8);
      }
      const shade = ctx.createRadialGradient(-r * .45, -r * .5, 0, 0, 0, r);
      shade.addColorStop(0, body.kind === 'agent' ? '#dbe9f6' : '#b6afa9'); shade.addColorStop(.45, body.kind === 'agent' ? '#6d91af' : '#7d7a78'); shade.addColorStop(1, '#111b2b');
      ctx.fillStyle = shade; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
      const next = random(body.seed);
      for (let i = 0; i < 4; i++) { const x = (next() - .5) * r * 1.5, y = (next() - .5) * r * 1.5;
        ctx.strokeStyle = '#d4d4d328'; ctx.lineWidth = .7; ctx.beginPath(); ctx.arc(x, y, r * (.12 + next() * .18), 0, TAU); ctx.stroke(); }
      ctx.restore();
      ctx.strokeStyle = tint; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, r + 2.5, -.7, .7); ctx.stroke();
      if (body.kind === 'agent') { ctx.fillStyle = body.source === 'signed-receipt' ? '#8bebc5' : '#c3b4e7'; ctx.beginPath(); ctx.arc(r + 1, -r, 1.8, 0, TAU); ctx.fill(); }
      ctx.restore();
    }
    function drawTrails(lookup) {
      for (const edge of scene.edges) {
        const from = lookup.get(edge.from), to = lookup.get(edge.to); if (!from || !to) continue;
        const c = controlPoint(from, to), emphasis = selected && ([edge.from, edge.to].includes(selected) || from.parentId === selected || to.parentId === selected);
        ctx.strokeStyle = emphasis ? '#c6f1ffba' : edge.animated ? '#66cce152' : '#a0b5d333'; ctx.lineWidth = emphasis ? 1.65 : .9;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(c.x, c.y, to.x, to.y); ctx.stroke();
        if (edge.animated && moving() && !scene.stale) {
          const t = ((elapsed * .19 + seed(String(edge.id)) / 4294967296) % 1), head = curvePoint(from, to, t);
          ctx.save(); ctx.shadowColor = '#a0edff'; ctx.shadowBlur = 8; ctx.fillStyle = '#c7f5ff';
          ctx.beginPath(); ctx.arc(head.x, head.y, 2, 0, TAU); ctx.fill(); ctx.restore();
          for (let i = 1; i < 7; i++) { const p = curvePoint(from, to, Math.max(0, t - i * .012));
            ctx.fillStyle = `rgba(107,209,241,${.34 * (1 - i / 7)})`; ctx.beginPath(); ctx.arc(p.x, p.y, 1.7 - i * .12, 0, TAU); ctx.fill(); }
        }
      }
    }
    function drawLabels() {
      const boxes = [];
      const items = [...new Map([...projected.filter(body => body.id === selected || body.id === hovered),
        ...projected.filter(body => body.kind === 'role' || body.kind === 'workflow')].map(body => [body.id, body])).values()];
      const scale = viewScale(width, height) * zoom, sunRadius = Math.max(26, 75 * scale);
      const sunBox = { x: width / 2 + panX - sunRadius - 10, y: height / 2 + panY - sunRadius - 10,
        width: sunRadius * 2 + 20, height: sunRadius * 2 + 66 };
      const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      for (const body of items) {
        if (body.x < -40 || body.x > width + 40 || body.y < -40 || body.y > height + 40) continue;
        const label = body.label.length > 25 ? `${body.label.slice(0, 24)}…` : body.label;
        ctx.font = `${body.id === selected ? '600' : '500'} 11px system-ui, sans-serif`;
        const w = ctx.measureText(label).width + 18, h = body.kind === 'role' ? 33 : 21;
        const candidates = [[body.x - w / 2, body.y + body.radius + 11], [body.x - w / 2, body.y - body.radius - h - 11],
          [body.x + body.radius + 12, body.y - h / 2], [body.x - body.radius - w - 12, body.y - h / 2],
          [body.x - w / 2, body.y + body.radius + h + 17], [body.x - w / 2, body.y - body.radius - h * 2 - 17]];
        const options = candidates.map(([x, y], index) => {
          const bounds = { x: clamp(x, 6, Math.max(6, width - w - 6)), y: clamp(y, 64, Math.max(64, height - h - 51)), width: w, height: h };
          const collisions = boxes.reduce((sum, b) => sum + overlap(bounds, { x: b.x - 4, y: b.y - 3, width: b.width + 8, height: b.height + 6 }), 0);
          const proximity = Math.hypot(bounds.x + w / 2 - body.x, bounds.y + h / 2 - body.y);
          return { bounds, score: collisions * 8 + overlap(bounds, sunBox) * 5 + proximity * .08 + index * .2 };
        }).sort((a, b) => a.score - b.score);
        const box = options[0].bounds, { x, y } = box; body.labelBounds = box; boxes.push(box);
        ctx.fillStyle = '#07101bd9'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = body.id === selected ? '#9ce6ff96' : '#6c8bad29'; ctx.lineWidth = .7; ctx.strokeRect(x, y, w, h);
        ctx.textAlign = 'center'; ctx.fillStyle = body.id === selected ? '#e3f8ff' : '#c8d8e9'; ctx.fillText(label, x + w / 2, y + 13);
        if (body.kind === 'role') { ctx.font = '9px system-ui, sans-serif'; ctx.fillStyle = scene.stale ? colors.unknown : body.evidence_count ? colors[body.state] || colors.recorded : '#7f93ac';
          ctx.fillText(body.activity_count ? `Reported ${body.state}` : body.evidence_count ? `${body.evidence_count} saved ${body.evidence_count === 1 ? 'record' : 'records'}` : 'Configured', x + w / 2, y + 26); }
      }
    }
    function draw() {
      if (destroyed) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (backdrop) ctx.drawImage(backdrop, 0, 0, width, height); else { ctx.fillStyle = '#03070f'; ctx.fillRect(0, 0, width, height); }
      projected = projectScene(scene, { width, height, time: elapsed, zoom, panX, panY });
      const scale = viewScale(width, height) * zoom, cx = width / 2 + panX, cy = height / 2 + panY;
      ctx.save(); ctx.strokeStyle = '#6785aa1b'; ctx.lineWidth = .8;
      for (const radius of [155, 330, 540]) { ctx.beginPath(); ctx.ellipse(cx, cy, radius * scale, radius * scale * orbitFlatten(width, height), 0, 0, TAU); ctx.stroke(); }
      const lookup = new Map(projected.map(body => [body.id, body]));
      if (selected) { const chosen = lookup.get(selected), parent = lookup.get(chosen?.parentId);
        if (parent) { ctx.strokeStyle = '#91bde52b'; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.ellipse(parent.x, parent.y, chosen.orbit * scale, chosen.orbit * scale * .68, 0, 0, TAU); ctx.stroke(); ctx.setLineDash([]); } }
      drawSun(scale); drawTrails(lookup);
      ctx.globalAlpha = scene.stale ? .6 : 1;
      for (const body of [...projected].sort((a, b) => a.depth - b.depth)) {
        if (body.kind === 'role') drawPlanet(body); else drawMoon(body);
        if (body.id === selected || body.id === hovered) { ctx.strokeStyle = body.id === selected ? '#b5ecff' : '#b5ecff75'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(body.x, body.y, body.radius + (body.kind === 'role' && body.rings ? 11 : 6), 0, TAU); ctx.stroke(); }
      }
      ctx.globalAlpha = 1; drawLabels(); ctx.restore();
      if (!scene.bodies.length) { ctx.textAlign = 'center'; ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#8fa6be'; ctx.fillText('Waiting for configured roles or saved project records', width / 2, height - 28); }
      if (scene.stale) { ctx.fillStyle = '#111b2de8'; ctx.fillRect(10, 10, 218, 25); ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#d4b78c'; ctx.fillText('Saved snapshot · refresh unavailable', 19, 27); }
    }
    function tick(stamp) {
      animation = null; if (destroyed || !moving()) { lastFrame = null; return; }
      if (lastFrame !== null) elapsed += clamp((stamp - lastFrame) / 1000, 0, .08);
      lastFrame = stamp; draw(); animation = frame(tick);
    }
    function refresh() { cancel(animation); animation = null; lastFrame = null; draw(); if (!destroyed && moving()) animation = frame(tick); }
    function resize() {
      if (destroyed) return;
      const box = canvas.getBoundingClientRect(); width = clamp(finite(box.width, 1000) || 1000, 1, 4096); height = clamp(finite(box.height, 700) || 700, 1, 4096);
      dpr = clamp(finite(view?.devicePixelRatio, 1), 1, limits.dpr);
      dpr = Math.min(dpr, Math.sqrt(8000000 / (width * height)));
      canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr); ctx.imageSmoothingEnabled = true;
      makeBackground(); refresh();
    }
    function point(event) { const box = canvas.getBoundingClientRect(); return { x: (event.clientX - box.left) * width / Math.max(1, box.width), y: (event.clientY - box.top) * height / Math.max(1, box.height) }; }
    listen(canvas, 'pointerdown', event => { if (event.button !== undefined && event.button !== 0) return; const p = point(event); pointer = { ...p, startX: p.x, startY: p.y, moved: false, id: event.pointerId }; try { canvas.setPointerCapture?.(event.pointerId); } catch { /* Optional capture. */ } });
    listen(canvas, 'pointermove', event => { const p = point(event);
      if (pointer) { const dx = p.x - pointer.x, dy = p.y - pointer.y; panX += dx; panY += dy; pointer.x = p.x; pointer.y = p.y; pointer.moved ||= Math.hypot(p.x - pointer.startX, p.y - pointer.startY) > 4; draw(); }
      else { const hit = hitTest(projected, p.x, p.y), id = hit?.id || null; if (hovered !== id) { hovered = id; if (canvas.style) canvas.style.cursor = id ? 'pointer' : 'grab'; draw(); } }
    });
    listen(canvas, 'pointerup', event => { const previous = pointer; pointer = null; if (!previous) return;
      try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* Optional capture. */ }
      if (!previous.moved) { const p = point(event), hit = hitTest(projected, p.x, p.y); if (hit) { selected = hit.id; options.onSelect?.(hit.id); draw(); } }
    });
    listen(canvas, 'pointercancel', () => { pointer = null; });
    listen(canvas, 'pointerleave', () => { hovered = null; if (!pointer) draw(); });
    listen(canvas, 'wheel', event => { event.preventDefault?.(); const p = point(event), before = zoom;
      zoom = clamp(zoom * Math.exp(-clamp(event.deltaY, -150, 150) * .0015), .55, 4);
      const factor = zoom / before; panX = (p.x - width / 2) - (p.x - width / 2 - panX) * factor; panY = (p.y - height / 2) - (p.y - height / 2 - panY) * factor; draw();
    }, { passive: false });
    listen(doc, 'visibilitychange', refresh); listen(preference, 'change', refresh);
    const observer = view?.ResizeObserver ? new view.ResizeObserver(resize) : typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (observer) observer.observe(canvas); else listen(view, 'resize', resize);
    resize();
    return {
      setData(input) { if (destroyed) return; scene = buildScene(input); const present = new Set(scene.planets.map(body => body.id));
        for (const id of textureCache.keys()) if (!present.has(id)) { textureCache.delete(id); spriteCache.delete(id); }
        if (selected && !scene.bodies.some(body => body.id === selected)) selected = null; refresh(); },
      setSelected(id) { if (destroyed) return; selected = typeof id === 'string' ? id : null; draw(); },
      setMotion(enabled) { requestedMotion = enabled === true; if (!destroyed) refresh(); },
      focus(id) { if (destroyed) return; const body = projectScene(scene, { width, height, time: elapsed }).find(body => body.id === id); if (!body) return;
        zoom = Math.max(1.6, zoom); const scale = viewScale(width, height) * zoom;
        panX = -body.worldX * scale; panY = -body.worldY * scale; selected = id; draw(); },
      resetView() { if (destroyed) return; zoom = 1; panX = 0; panY = 0; draw(); },
      getState() { return { selected, motion: moving() && !destroyed, elapsed, zoom, panX, panY, width, height, dpr, destroyed,
        counts: { ...scene.counts }, positions: projected.map(body => ({ id: body.id, x: body.x, y: body.y, radius: body.radius, labelBounds: body.labelBounds })) }; },
      destroy() { if (destroyed) return; destroyed = true; cancel(animation); animation = null; observer?.disconnect(); for (const remove of listeners) remove(); textureCache.clear(); spriteCache.clear(); backdrop = null; solarTexture = null; projected = []; },
    };
  }
  return Object.freeze({ create, buildScene, projectScene, hitTest, shouldAnimate, curvePoint, surfaceSample, limits });
});
