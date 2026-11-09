'use strict';
// Development-only read-only DOM/computed-style observations in the real native
// webview. This never supplies workflow state or changes editor preferences.
const { randomUUID, createHash } = require('node:crypto');
const stageIds = ['requirements', 'analysis', 'architecture', 'module-design', 'coding', 'unit', 'integration', 'system', 'acceptance'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function proofScript(channel) {
  return `(() => {
  const channel = ${JSON.stringify(channel)};
  let observedSnapshot;
  const text = (value, maximum = 160) => String(value ?? '').slice(0, maximum);
  const style = element => {
    if (!element) return null;
    const value = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { display: value.display, visibility: value.visibility, opacity: value.opacity,
      fill: value.fill, stroke: value.stroke, stroke_dasharray: value.strokeDasharray,
      animation_name: value.animationName, animation_duration: value.animationDuration,
      animation_play_state: value.animationPlayState, transition_duration: value.transitionDuration,
      border_color: value.borderColor, color: value.color,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  };
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'snapshot') { observedSnapshot = data; return; }
    if (data?.type !== 'wf-vmodel-style-request' || data.channel !== channel || typeof data.id !== 'string') return;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      const snapshot = observedSnapshot;
      const snapshot_sha256 = snapshot ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot))))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('') : null;
      if (snapshot !== observedSnapshot) return;
      const svg = document.querySelector('svg.v-model'), focus = document.activeElement, repair = document.querySelector('.v-rework');
      vscode.postMessage({ type: 'wf-vmodel-style-observation', channel, id: data.id, snapshot_sha256,
        body_classes: text(document.body.className, 1024), os_reduce_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        svg_motion: svg?.getAttribute('data-motion') ?? null,
        viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
        request_id: text(document.getElementById('request')?.value),
        title: text(document.getElementById('title')?.textContent, 400),
        action: text(document.getElementById('action')?.textContent, 400),
        focus: { tag: text(focus?.tagName), id: text(focus?.id), stage: text(focus?.getAttribute('data-stage')) },
        stages: [...document.querySelectorAll('.v-node[data-stage]')].map(node => ({
          id: node.getAttribute('data-stage'), state: node.getAttribute('data-state'),
          aria_pressed: node.getAttribute('aria-pressed'), shape: style(node.querySelector('path')) })),
        review: { state: document.getElementById('review')?.getAttribute('data-state'), style: style(document.getElementById('review')) },
        repair: { state: repair?.getAttribute('data-state'), style: style(repair), path_style: style(repair?.querySelector('path')) }
      });
    }));
  });
})();`;
}
function instrumentClientSource(source, channel) {
  const anchor = 'const vscode = acquireVsCodeApi();';
  if (typeof source !== 'string' || source.split(anchor).length !== 2) throw new Error('Exact native client API anchor required for read-only observer.');
  return source.replace(anchor, `${anchor}\n${proofScript(channel)}`);
}
function createVModelProofObserver(vscode, context, write, { autoCapture = false, timeoutMs = 5000, clientSource } = {}) {
  if (typeof clientSource !== 'string') throw new Error('Exact native client source required.');
  let current;
  const requests = new Map();
  async function capture(label = 'explicit-native-observation') {
    const owned = current;
    if (!owned) return { observed: false, reason: 'no-observed-native-panel' };
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { requests.delete(id); resolve({ observed: false, reason: 'no-native-dom-observation', id }); }, timeoutMs);
      requests.set(id, { owned, label: typeof label === 'string' ? label.slice(0, 100) : 'explicit-native-observation', resolve, timer,
        snapshot: owned.snapshot ? structuredClone(owned.snapshot) : undefined });
      void Promise.resolve(owned.webview.postMessage({ type: 'wf-vmodel-style-request', channel: owned.channel, id })).catch(() => {
        clearTimeout(timer); requests.delete(id); resolve({ observed: false, reason: 'native-post-unavailable', id });
      });
    });
  }
  const window = new Proxy(vscode.window, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property !== 'createWebviewPanel') return typeof value === 'function' ? value.bind(target) : value;
    return (...args) => {
      const panel = Reflect.apply(value, target, args);
      if (args[0] !== 'workforce.vModel') return panel;
      const owned = { channel: randomUUID(), webview: panel.webview, snapshot: undefined, signature: undefined };
      current = owned;
      const receive = panel.webview.onDidReceiveMessage(message => {
        if (message?.type !== 'wf-vmodel-style-observation' || message.channel !== owned.channel) return;
        const pending = requests.get(message.id);
        if (!pending || pending.owned !== owned) return;
        const expected = pending.snapshot ? hash(pending.snapshot) : null;
        if (message.snapshot_sha256 !== expected) {
          clearTimeout(pending.timer); requests.delete(message.id);
          pending.resolve({ observed: false, reason: 'native-snapshot-advanced', id: message.id }); return;
        }
        if (!Array.isArray(message.stages) || message.stages.length !== stageIds.length ||
            !message.stages.every((stage, index) => stage?.id === stageIds[index])) return;
        const data = { body_classes: message.body_classes, os_reduce_motion: message.os_reduce_motion, svg_motion: message.svg_motion,
          viewport: message.viewport, request_id: message.request_id, title: message.title, action: message.action,
          focus: message.focus, stages: message.stages, review: message.review, repair: message.repair };
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 64 * 1024) return;
        clearTimeout(pending.timer); requests.delete(message.id);
        const file = `v-model-native-style-${message.id}.json`;
        try {
          write(file, { schema_version: 1, observed_at: new Date().toISOString(), source: 'actual-owned-webview-dom',
            label: pending.label, snapshot_sha256: expected,
            client_source_sha256: createHash('sha256').update(clientSource).digest('hex'),
            instrumentation: 'development-only-read-only-dom-observer-in-native-client-closure',
            snapshot: pending.snapshot, computed: data }, 'wx');
          pending.resolve({ observed: true, file });
        } catch { pending.resolve({ observed: false, reason: 'observation-write-unavailable', id: message.id }); }
      });
      panel.onDidDispose(() => {
        receive.dispose(); if (current === owned) current = undefined;
        for (const [id, pending] of requests) if (pending.owned === owned) {
          clearTimeout(pending.timer); requests.delete(id); pending.resolve({ observed: false, reason: 'native-panel-closed', id });
        }
      });
      const webview = new Proxy(panel.webview, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'postMessage') return typeof value === 'function' ? value.bind(target) : value;
          return message => {
            if (message?.type === 'snapshot') {
              owned.snapshot = structuredClone(message);
              const signature = hash(message.requests);
              if (autoCapture && signature !== owned.signature) { owned.signature = signature; queueMicrotask(() => { if (current === owned) void capture('actual-native-snapshot-change'); }); }
            }
            return Reflect.apply(value, target, [message]);
          };
        },
        set(target, property, value) {
          if (property === 'html' && typeof value === 'string') {
            const nonce = /<script nonce="([a-f0-9]+)"/.exec(value)?.[1];
            const script = /<script nonce="[a-f0-9]+" src="[^"]*v-model-panel\.js[^"]*"><\/script>/g;
            if (nonce && [...value.matchAll(script)].length === 1) {
              const instrumented = instrumentClientSource(clientSource, owned.channel).replace(/<\/script/gi, '<\\/script');
              value = value.replace(script, () => `<script nonce="${nonce}">${instrumented}</script>`);
            }
          }
          return Reflect.set(target, property, value, target);
        },
      });
      return new Proxy(panel, { get(target, property) { if (property === 'webview') return webview;
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; } });
    };
  } });
  context.subscriptions.push(vscode.commands.registerCommand('workforceM2.captureVModelStyles', capture));
  const client = new Proxy(vscode, { get(target, property) { return property === 'window' ? window : Reflect.get(target, property, target); } });
  return { vscode: client, capture };
}
module.exports = { createVModelProofObserver, proofScript, instrumentClientSource };
