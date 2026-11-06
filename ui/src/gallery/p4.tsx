/** Profiles and Memory gallery: all API responses are in-memory fixtures. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../app.css';
import App from '../App';
import { setApiTransport } from '../api';
import { templates } from '../../../src/domain/templates';
import type { Profile } from '../../../src/domain/schema';

const hash = location.hash.slice(1).split(','), isMemory = location.pathname.includes('memory');
localStorage.setItem('neomind.theme', hash.includes('light') ? 'light' : 'dark');
document.documentElement.classList.add(hash.includes('light') ? 'light-theme' : 'dark-theme');
const makeProfile = (profileId: string, name: string, write: boolean): Profile => ({ schemaVersion: 1, profileId, name, version: 1, instructions: 'Đọc yêu cầu và cấu trúc project.\n\nThực hiện thay đổi nhỏ, có thể kiểm chứng.\nGiải thích các quyết định quan trọng.', skills: [], requestedPermissions: { read: true, write, checks: true, gitCommit: false }, outputDefaults: {} });
const builtins = [makeProfile('implementer', 'Implementer', true), makeProfile('verifier', 'Verifier', false)];
const drafts: Record<string, Profile> = { 'ts-strict': { ...makeProfile('ts-strict', 'Implementer · TypeScript strict', true), version: 2, skills: [{ id: 'style-guide', path: 'skills/style/SKILL.md', sha256: 'a'.repeat(64) }] } };
let metadata = [{ profileId: 'ts-strict', name: 'Implementer · TypeScript strict', archived: false }];
const published: Record<string, number[]> = { 'ts-strict': [1, 2] };
const galleryFlow = structuredClone(templates.dev);
const implement = galleryFlow.definition.nodes.find(node => node.id === 'implement');
if (implement?.type === 'agent_task') { implement.profileId = 'ts-strict'; implement.profileVersion = 2; }
let root: string | null = hash.includes('root') ? null : 'W:\\projects\\neomind-demo\\neomind\\memory';
const records: { revision: string; body: string; header: { id: string; type: string; scope: string; sources: string[]; tags: string[] } }[] = [
  { revision: 'a'.repeat(64), body: 'Kiểm tra giá trị đầu vào và các trường hợp biên trước khi xử lý.', header: { id: 'guard-input', type: 'lesson', scope: 'src/', sources: ['run-1'], tags: ['validation'] } },
  { revision: 'b'.repeat(64), body: 'Chạy npm test trước khi giao thay đổi.', header: { id: 'checks', type: 'decision', scope: 'project', sources: ['AGENTS.md'], tags: ['tests'] } },
  { revision: 'c'.repeat(64), body: 'Project dùng TypeScript strict.', header: { id: 'typescript', type: 'context', scope: 'project', sources: ['tsconfig.json'], tags: ['typescript'] } },
];
const selection = { retrievalMode: 'lexical', scopes: [], tags: [], requireTaskMatch: false, inferTaskPaths: false, maxRecords: 30, maxBodyBytes: 16000 };
const proposal = { proposalId: 'lesson-1', record: { id: 'guard-input', type: 'lesson', scope: 'src/', tags: ['validation'], body: 'Kiểm tra dữ liệu đầu vào trước khi tính toán.', sources: ['src/parser.ts'] } };
let proposalVersion = 1, proposalStatus: 'pending' | 'promoted' | 'rejected' = 'pending';
setApiTransport(async (endpoint, method, body) => {
  const url = new URL(endpoint, 'http://gallery'), path = url.pathname, input = body as Record<string, unknown> | undefined;
  const ok = (value: unknown) => ({ status: 200, body: value });
  if (path === '/api/bootstrap') return ok({ projectName: 'neomind-demo', projectRoot: 'W:\\projects\\neomind-demo', templates: ['dev'], runtimeAvailable: true, flows: [{ flowId: 'dev', name: 'Dev', archived: false }] });
  if (path === '/api/runs') return ok({ runs: [] });
  if (path === '/api/flows/dev/draft') return ok({ draft: galleryFlow, revision: 'd'.repeat(64) });
  if (path === '/api/profiles' && method === 'GET') return ok({ profiles: metadata, builtins });
  if (path === '/api/profiles' && method === 'POST') { const id = String(input?.id), name = String(input?.name), template = builtins.find(item => item.profileId === input?.template) ?? builtins[0]!; drafts[id] = { ...structuredClone(template), profileId: id, name }; metadata.push({ profileId: id, name, archived: false }); return ok({ draft: drafts[id], revision: 'e'.repeat(64) }); }
  const profile = /^\/api\/profiles\/([^/]+)\/(draft|versions|publish|rename|clone|archive|restore|delete)$/.exec(path);
  if (profile) { const id = decodeURIComponent(profile[1]!), operation = profile[2]!;
    if (operation === 'draft' && method === 'PUT') { drafts[id] = structuredClone(input?.draft as Profile); return ok({ revision: 'e'.repeat(64) }); }
    if (operation === 'draft') return ok({ draft: drafts[id], revision: 'd'.repeat(64) });
    if (operation === 'versions') return ok({ versions: published[id] ?? [] });
    if (operation === 'publish') { const version = (published[id]?.at(-1) ?? 0) + 1; published[id] = [...(published[id] ?? []), version]; return ok({ version: { version } }); }
    if (operation === 'clone') { const targetId = String(input?.targetId); drafts[targetId] = { ...structuredClone(drafts[id]!), profileId: targetId, name: String(input?.name) }; metadata.push({ profileId: targetId, name: String(input?.name), archived: false }); return ok({}); }
    if (operation === 'rename') metadata = metadata.map(item => item.profileId === id ? { ...item, name: String(input?.name) } : item);
    if (operation === 'archive' || operation === 'restore') metadata = metadata.map(item => item.profileId === id ? { ...item, archived: operation === 'archive' } : item);
    if (operation === 'delete') metadata = metadata.filter(item => item.profileId !== id);
    return ok({});
  }
  if (path === '/api/memory' && method === 'GET') return ok({ root, records: root ? records : [] });
  if (path === '/api/memory' && method === 'POST') { const record = input?.record as { id: string; type: string; scope: string; sources: string[]; tags: string[]; body: string }; const saved = { revision: 'e'.repeat(64), body: record.body, header: { id: record.id, type: record.type, scope: record.scope, sources: record.sources, tags: record.tags } }; const index = records.findIndex(item => item.header.id === record.id && item.header.type === record.type); if (index >= 0) records[index] = saved; else records.push(saved); return ok({ record: saved }); }
  if (path === '/api/memory/configure') { root = String(input?.root ?? 'W:\\projects\\neomind-demo\\neomind\\memory'); return ok({ root, records }); }
  if (path === '/api/memory/selection') return ok({ selection, revision: 'f'.repeat(64) });
  if (path === '/api/memory/preview') return ok({ root, records: root ? [{ id: 'guard-input', type: 'lesson', scope: 'src/', selectionReason: 'khớp yêu cầu' }] : [] });
  if (path === '/api/memory/lesson-queue') return ok({ runs: proposalStatus === 'pending' ? [{ runId: 'run-1', task: 'Sửa parser', pending: 1 }] : [], errors: [], scanned: 1, totalCompleted: 1 });
  if (path === '/api/runs/run-1/lessons') return ok({ memoryRoot: root, proposals: [{ proposal, version: proposalVersion, proposalHash: 'b'.repeat(64), expectedRevision: null, promoted: proposalStatus === 'promoted', rejected: proposalStatus === 'rejected' }] });
  if (path.startsWith('/api/runs/run-1/lessons/')) { if (path.endsWith('/approve')) proposalStatus = 'promoted'; else if (path.endsWith('/reject')) proposalStatus = 'rejected'; else if (path.endsWith('/revise')) { proposal.record.body = String(input?.body); proposalVersion++; } return ok({}); }
  return { status: 404, body: { error: `Gallery has no ${method} ${path}` } };
});
createRoot(document.getElementById('root')!).render(<React.StrictMode><App shell={hash.includes('panel') ? 'panel' : 'web'} /></React.StrictMode>);
const click = (find: () => Element | undefined | null, next?: () => void, tries = 80) => { const item = find(); if (item) { if (item.getAttribute('role') === 'tab') item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); else (item as HTMLElement).click(); next?.(); } else if (tries) setTimeout(() => click(find, next, tries - 1), 100); };
const byText = (selector: string, text: string) => () => [...document.querySelectorAll(selector)].find(item => item.textContent?.includes(text));
click(byText('nav button, aside button', isMemory ? 'Memory' : 'Profiles'), () => {
  if (hash.includes('create')) click(byText('button', 'Tạo profile'));
  if (hash.includes('detail')) click(() => document.querySelector('.p4-record'));
  if (hash.includes('policy')) click(byText('button', 'Chọn memory cho run'));
  if (hash.includes('skills')) click(byText('button', 'Skills'));
  if (hash.includes('perm')) click(byText('button', 'Quyền'));
  if (hash.includes('usage')) click(byText('button', 'Được dùng ở'));
  if (hash.includes('edited')) click(() => document.querySelector('textarea[aria-label="Hướng dẫn"]'), () => { const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Hướng dẫn"]'); if (el) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, `${el.value}\nThay đổi mẫu.`); el.dispatchEvent(new Event('input', { bubbles: true })); } });
});
