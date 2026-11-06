/** Local-only Flow Studio gallery. No requests reach the NeoMind backend. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../app.css';
import App from '../App';
import { setApiTransport } from '../api';
import { templates } from '../../../src/domain/templates';
import type { Flow } from '../../../src/domain/schema';

const hash = location.hash.slice(1).split(',');
localStorage.setItem('neomind.theme', hash.includes('light') ? 'light' : 'dark');
document.documentElement.classList.add(hash.includes('light') ? 'light-theme' : 'dark-theme');
const drafts: Record<string, Flow> = { dev: { ...structuredClone(templates.dev), version: 3 }, parallel: { ...structuredClone(templates.parallel), version: 1 } };
const diagnostics = [{ code: 'sample', nodeId: 'repair', message: 'Chọn ít nhất một agent sửa.' }, { code: 'sample', nodeId: 'verify', message: 'Kiểm tra lại cấu hình reviewer.' }];
setApiTransport(async (endpoint, method, body) => {
  const url = new URL(endpoint, 'http://gallery'), path = url.pathname;
  const ok = (value: unknown) => ({ status: 200, body: value });
  if (path === '/api/bootstrap') return ok({ projectName: 'neomind-demo', projectRoot: 'W:\\projects\\neomind-demo', templates: ['dev', 'parallel'], runtimeAvailable: true, flows: hash.includes('empty') ? [] : [{ flowId: 'dev', name: 'Dev', archived: false }, { flowId: 'parallel', name: 'Dev song song', archived: false }] });
  if (path === '/api/runs') return ok({ runs: [] });
  if (path === '/api/skills' && method === 'GET') return ok({ skills: [{ id: 'review', path: 'neomind/skills/review/SKILL.md', sha256: 'a'.repeat(64), name: 'Review', description: 'Review độc lập', source: 'neomind' }] });
  if (path === '/api/skills/status' && method === 'POST') return ok({ skills: ((body as { refs?: unknown[] }).refs ?? []).map(ref => ({ ...(ref as object), status: 'ok' })) });
  if (path === '/api/runners') return ok({ runners: [{ runner: 'codex', provider: 'openai', models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], reasoning: ['low', 'medium', 'high'] }, { runner: 'claude-code', provider: 'anthropic', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], reasoning: ['low', 'medium', 'high'] }] });
  const match = /^\/api\/flows\/([^/]+)\/(draft|validate|versions|publish)$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]!), action = match[2], flow = drafts[id];
    if (!flow) return { status: 404, body: { error: 'Unknown flow' } };
    if (action === 'draft' && method === 'PUT') { drafts[id] = structuredClone((body as { draft: Flow }).draft); return ok({ revision: 'gallery' }); }
    if (action === 'draft') return ok({ draft: structuredClone(flow), revision: 'gallery' });
    if (action === 'validate') return ok(hash.includes('errors') ? { valid: false, diagnostics } : { valid: true, order: [] });
    if (action === 'versions') {
      if (url.searchParams.has('version')) { const previous = structuredClone(flow); if (hash.includes('ai')) { const node = previous.definition.nodes.find(item => item.id === 'implement'); if (node) node.label = 'Thực hiện trước đây'; previous.definition.limits.activeTimeSeconds = 1200; } return ok({ version: previous }); }
      return ok({ versions: [1, 2, 3], versionInfo: [1, 2, 3].map(version => ({ version, author: version === 3 && hash.includes('ai') ? { kind: 'ai', reason: 'Tạo flow theo yêu cầu', sessionId: 'session-demo' } : { kind: 'human' } })) });
    }
    if (action === 'publish') return ok({ version: { version: 4 } });
  }
  return { status: 404, body: { error: `Gallery has no ${method} ${path}` } };
});
createRoot(document.getElementById('root')!).render(<React.StrictMode><App shell={hash.includes('panel') ? 'panel' : 'web'} /></React.StrictMode>);
const click = (find: () => Element | null | undefined, then?: () => void, tries = 80) => { const element = find(); if (element) { if (element.getAttribute('aria-label') === 'Quản lý flow') element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); else (element as HTMLElement).click(); then?.(); } else if (tries > 0) setTimeout(() => click(find, then, tries - 1), 100); };
const byText = (selector: string, text: string) => () => [...document.querySelectorAll(selector)].find(item => item.textContent?.includes(text));
click(byText('nav button, aside button', 'Flows'), () => {
  if (hash.includes('command')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  if (hash.includes('errors')) click(byText('button', 'Kiểm tra'));
  if (hash.includes('add')) click(() => document.querySelector('button[aria-label="Thêm bước"]'));
  if (hash.includes('compare')) click(() => document.querySelector('[aria-label="Quản lý flow"]'), () => click(byText('[role="menuitem"]', 'So sánh phiên bản')));
  else if (hash.includes('menu')) click(() => document.querySelector('[aria-label="Quản lý flow"]'));
  if (hash.includes('insp')) click(() => document.querySelector('.react-flow__node[data-id="implement"]'));
  if (hash.includes('repair')) click(() => document.querySelector('.react-flow__node[data-id="repair"]'));
});
