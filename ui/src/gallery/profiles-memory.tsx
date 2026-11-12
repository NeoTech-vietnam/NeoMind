/** Agents (profiles), Skills and Memory gallery: all API responses are in-memory fixtures. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../app.css';
import App from '../App';
import { setApiTransport } from '../api';
import { templates } from '../../../src/domain/templates';
import type { Profile } from '../../../src/domain/schema';
import { compactLegacyLessonBody } from '../../../src/memory/lesson-body';
import { legacyLessonBody, shortLessonBody } from './memory-fixtures';

const hash = location.hash.slice(1).split(','), isMemory = location.pathname.includes('memory'), isSkills = location.pathname.includes('skills');
localStorage.setItem('neomind.theme', hash.includes('light') ? 'light' : 'dark');
document.documentElement.classList.add(hash.includes('light') ? 'light-theme' : 'dark-theme');
const makeProfile = (profileId: string, name: string, write: boolean): Profile => ({ schemaVersion: 1, profileId, name, version: 1, instructions: 'Đọc yêu cầu và cấu trúc project.\n\nThực hiện thay đổi nhỏ, có thể kiểm chứng.\nGiải thích các quyết định quan trọng.', skills: [], requestedPermissions: { read: true, write, checks: true, gitCommit: false }, outputDefaults: {} });
const builtins = [makeProfile('implementer', 'Implementer', true), makeProfile('verifier', 'Verifier', false)];
const drafts: Record<string, Profile> = { 'ts-strict': { ...makeProfile('ts-strict', 'Implementer · TypeScript strict', true), version: 2, skills: [{ id: 'style-guide', path: 'skills/style/SKILL.md', sha256: 'a'.repeat(64) }] } };
let metadata = [{ profileId: 'ts-strict', name: 'Implementer · TypeScript strict', archived: false }];
const published: Record<string, number[]> = { 'ts-strict': [1, 2] };
const catalog = [{ id: 'style-guide', path: 'skills/style/SKILL.md', sha256: 'b'.repeat(64), name: 'Style guide', description: 'Quy tắc code', source: 'claude' }, { id: 'review', path: 'neomind/skills/review/SKILL.md', sha256: 'c'.repeat(64), name: 'Review', description: 'Review độc lập', source: 'neomind' }];
const galleryFlow = structuredClone(templates.dev);
const implement = galleryFlow.definition.nodes.find(node => node.id === 'implement');
if (implement?.type === 'agent_task') { implement.profileId = 'ts-strict'; implement.profileVersion = 2; }
let root: string | null = hash.includes('root') ? null : 'W:\\projects\\neomind-demo\\neomind\\memory';
const records: { revision: string; body: string; header: { id: string; type: string; scope: string; sources: string[]; tags: string[]; expiresAt?: string; supersedes?: string[] } }[] = [
  { revision: 'a'.repeat(64), body: 'Kiểm tra giá trị đầu vào và các trường hợp biên trước khi xử lý.', header: { id: 'guard-input', type: 'lesson', scope: 'src/', sources: ['run-1'], tags: ['validation'] } },
  { revision: 'b'.repeat(64), body: 'Chạy npm test trước khi giao thay đổi.', header: { id: 'checks', type: 'decision', scope: 'project', sources: ['AGENTS.md'], tags: ['tests'] } },
  { revision: 'c'.repeat(64), body: 'Project dùng TypeScript strict.', header: { id: 'typescript', type: 'context', scope: 'project', sources: ['tsconfig.json'], tags: ['typescript'] } },
];
records.push({ revision: 'd'.repeat(64), body: 'Chạy npm test và npm run build:ui trước khi giao thay đổi giao diện.', header: { id: 'checks-ui', type: 'decision', scope: 'ui', sources: ['user-note'], tags: ['tests', 'ui'], supersedes: ['checks'] } });
// An approved repair lesson in the old format (scoped to the project id) and one in the short format runs write now.
records.unshift({ revision: '1'.repeat(64), body: legacyLessonBody('run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b', 'F2'), header: { id: 'lesson-50801f40ebe11824d36dca70', type: 'lesson', scope: 'project-08bfdf94e4e74fcf', sources: ['run:run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b', 'run:run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b/event:191', 'proposal:lesson-50801f40ebe11824d36dca70', 'approval:approval-272e6837'], tags: ['repair', 'review'] } },
  { revision: '2'.repeat(64), body: shortLessonBody, header: { id: 'lesson-c26d880d43a970c64d6e3673', type: 'lesson', scope: 'project', sources: ['run:run-b00f9a41-afff-419e-aebe-7c790c4ebaa8', 'run:run-b00f9a41-afff-419e-aebe-7c790c4ebaa8/event:212'], tags: ['repair', 'review'] } });
const stats: Record<string, { uses: number; helpful: number; irrelevant: number; wrong: number; score: number }> = {
  'lesson/guard-input': { uses: 7, helpful: 3, irrelevant: 0, wrong: 0, score: 3 }, 'context/typescript': { uses: 12, helpful: 1, irrelevant: 2, wrong: 0, score: -1 }, 'decision/checks-ui': { uses: 2, helpful: 0, irrelevant: 0, wrong: 1, score: -3 } };
/**
 * Pending proposals of every origin: a repair lesson in the old long format and one in the short format, plan feedback,
 * a "remember this" merged with a run's duplicate, an AI proposal that repeats a record.
 */
let pending: { proposal: { proposalId: string; createdAt: string; origin?: string; reason?: string; record: { id: string; type: string; scope: string; tags: string[]; body: string; sources: string[] } }; version: number; proposalHash: string; runId: string | null; merged: { runId: string | null; proposalId: string }[]; duplicateOf?: string }[] = [
  { proposal: { proposalId: 'lesson-c553ecc0ed554f8956729229', createdAt: '2026-11-11T07:50:00.000Z', record: { id: 'lesson-c553ecc0ed554f8956729229', type: 'lesson', scope: 'project-08bfdf94e4e74fcf', tags: ['repair', 'review'], body: legacyLessonBody('run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b', 'F1'), sources: ['run:run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b', 'run:run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b/event:191'] } }, version: 1, proposalHash: 'e'.repeat(64), runId: 'run-9ed3c3cb-3006-4079-9d7d-f4fe4782df4b', merged: [] },
  { proposal: { proposalId: 'lesson-7e0a51c2b9d84f61a3c05e2d', createdAt: '2026-11-12T03:10:00.000Z', origin: 'repair', reason: 'Reviewer yêu cầu sửa và run đã sửa xong; ghi lại để agent sau tránh lặp lại.', record: { id: 'lesson-7e0a51c2b9d84f61a3c05e2d', type: 'lesson', scope: 'project', tags: ['repair', 'review'], body: shortLessonBody, sources: ['run:run-b00f9a41-afff-419e-aebe-7c790c4ebaa8', 'run:run-b00f9a41-afff-419e-aebe-7c790c4ebaa8/event:212'] } }, version: 1, proposalHash: 'f'.repeat(64), runId: 'run-b00f9a41-afff-419e-aebe-7c790c4ebaa8', merged: [] },
  { proposal: { proposalId: 'decision-1', createdAt: '2026-11-11T08:00:00.000Z', origin: 'plan_revision', reason: 'Bạn đã yêu cầu sửa kế hoạch trong run này; ghi lại nếu yêu cầu đúng cho các run sau.', record: { id: 'decision-1', type: 'decision', scope: 'project', tags: ['plan-feedback'], body: 'Khi lập kế hoạch, người dùng yêu cầu: chỉ sửa một file mỗi lần và giữ test cũ.\n\n(Task gốc: Sửa parser)', sources: ['run:run-1'] } }, version: 1, proposalHash: 'b'.repeat(64), runId: 'run-1', merged: [] },
  { proposal: { proposalId: 'memory-2', createdAt: '2026-11-11T08:05:00.000Z', origin: 'user_note', reason: 'Bạn chọn "Ghi nhớ điều này" trên run này', record: { id: 'parser-tabs', type: 'lesson', scope: 'project', tags: [], body: 'Parser phải giữ nguyên tab trong chuỗi.', sources: ['run:run-2'] } }, version: 2, proposalHash: 'c'.repeat(64), runId: 'run-2', merged: [{ runId: 'run-3', proposalId: 'memory-3' }] },
  { proposal: { proposalId: 'memory-4', createdAt: '2026-11-11T08:09:00.000Z', origin: 'ai_session', reason: 'Người dùng nói vậy trong session.', record: { id: 'typescript-2', type: 'context', scope: 'project', tags: ['typescript'], body: 'Project dùng TypeScript strict.', sources: ['session:abc'] } }, version: 1, proposalHash: 'd'.repeat(64), runId: null, merged: [], duplicateOf: 'context/typescript' },
];
const selection = { retrievalMode: 'lexical', scopes: [], tags: [], requireTaskMatch: false, inferTaskPaths: false, maxRecords: 30, maxBodyBytes: 16000 };
const proposal = { proposalId: 'lesson-1', record: { id: 'guard-input', type: 'lesson', scope: 'src/', tags: ['validation'], body: 'Kiểm tra dữ liệu đầu vào trước khi tính toán.', sources: ['src/parser.ts'] } };
type GallerySkill = { id: string; source: 'neomind' | 'claude'; name: string; description: string; body: string; files: Record<string, string>; sha256: string };
const skillLibrary: GallerySkill[] = [
  { id: 'review', source: 'neomind', name: 'Review', description: 'Review độc lập có bằng chứng', body: '# Checklist review\n\n- Thay đổi đúng yêu cầu và kế hoạch đã duyệt\n- Có test cho hành vi mới\n- Trích dẫn file và dòng làm bằng chứng\n', files: { 'reference.md': '# Tham khảo\n\nCác lỗi thường gặp khi review.\n' }, sha256: 'c'.repeat(64) },
  { id: 'release-notes', source: 'neomind', name: 'Release notes', description: 'Viết ghi chú phát hành ngắn', body: '# Ghi chú phát hành\n\nMỗi thay đổi một dòng, bắt đầu bằng động từ.\n', files: {}, sha256: 'e'.repeat(64) },
  { id: 'style-guide', source: 'claude', name: 'Style guide', description: 'Quy tắc code', body: 'Dùng TypeScript strict.\n', files: {}, sha256: 'b'.repeat(64) },
];
const skillContent = (skill: GallerySkill) => `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
const skillPathOf = (skill: GallerySkill) => `${skill.source === 'claude' ? '.claude' : 'neomind'}/skills/${skill.id}/SKILL.md`;
const skillUsageOf = (skill: GallerySkill) => skill.id === 'review' ? { sha256: skill.sha256,
  profiles: [{ profileId: 'ts-strict', name: 'Implementer · TypeScript strict', revision: 'd'.repeat(64), draft: { sha256: hash.includes('stale') ? 'a'.repeat(64) : skill.sha256, stale: hash.includes('stale') }, latest: { version: 2, sha256: 'a'.repeat(64), stale: true } }],
  flows: [{ flowId: 'dev', name: 'Dev', revision: 'd'.repeat(64), draft: [{ nodeId: 'verify/independent-reviewer', label: 'Review · independent-reviewer', sha256: 'a'.repeat(64), stale: hash.includes('stale') }], published: [{ nodeId: 'verify/independent-reviewer', label: 'Review · independent-reviewer', sha256: 'a'.repeat(64), stale: true }], publishedVersion: 3 }] }
  : { sha256: skill.sha256, profiles: [], flows: [] };
const skillDetail = (skill: GallerySkill) => {
  const files = Object.keys(skill.files).map(file => `neomind/skills/${skill.id}/${file}`);
  return { id: skill.id, path: skillPathOf(skill), source: skill.source, editable: skill.source === 'neomind', sha256: skill.sha256, content: skillContent(skill), name: skill.name, description: skill.description, body: skill.body, frontmatter: {},
    files: Object.keys(skill.files), prompt: `Skill ${skill.name} (${skill.id}):\n${skillContent(skill)}${files.length ? `\nCompanion files (read only if needed and permitted): ${files.join(', ')}` : ''}` };
};
const readOnly = { read: true, write: false, checks: true, gitCommit: false };
const agentTemplates = [
  { id: 'implementer', label: 'Implementer', description: 'Lập kế hoạch ngắn rồi sửa code trong phạm vi được duyệt.', reviewer: false, suggestedSkills: [], instructions: '', requestedPermissions: { read: true, write: true, checks: true, gitCommit: false } },
  { id: 'planner', label: 'Planner', description: 'Đọc code và đề xuất kế hoạch có tiêu chí nghiệm thu; không sửa file.', reviewer: false, suggestedSkills: [], instructions: '', requestedPermissions: readOnly },
  { id: 'reviewer', label: 'Reviewer độc lập', description: 'Đánh giá kết quả so với yêu cầu và kế hoạch, có bằng chứng.', reviewer: true, suggestedSkills: ['review-checklist'], instructions: '', requestedPermissions: readOnly },
  { id: 'ui-reviewer', label: 'Reviewer UI', description: 'Review giao diện: trạng thái, khả năng truy cập, sáng/tối, màn hẹp.', reviewer: true, suggestedSkills: ['review-checklist', 'ui-review'], instructions: '', requestedPermissions: readOnly },
  { id: 'security-reviewer', label: 'Reviewer bảo mật', description: 'Tìm lỗ hổng: input không tin cậy, đường dẫn, quyền, bí mật.', reviewer: true, suggestedSkills: ['review-checklist', 'security-review'], instructions: '', requestedPermissions: readOnly },
  { id: 'research', label: 'Research (chỉ đọc)', description: 'Tìm hiểu và viết báo cáo; không sửa file, không chạy checks.', reviewer: true, suggestedSkills: [], instructions: '', requestedPermissions: { read: true, write: false, checks: false, gitCommit: false } },
];
let proposalVersion = 1, proposalStatus: 'pending' | 'promoted' | 'rejected' = 'pending';
setApiTransport(async (endpoint, method, body) => {
  const url = new URL(endpoint, 'http://gallery'), path = url.pathname, input = body as Record<string, unknown> | undefined;
  const ok = (value: unknown) => ({ status: 200, body: value });
  if (path === '/api/bootstrap') return ok({ projectName: 'neomind-demo', projectRoot: 'W:\\projects\\neomind-demo', templates: ['dev'], runtimeAvailable: true, flows: [{ flowId: 'dev', name: 'Dev', archived: false }] });
  if (path === '/api/runs') return ok({ runs: [] });
  if (path === '/api/skills' && method === 'GET') return ok({ skills: catalog });
  if (path === '/api/skills/status' && method === 'POST') return ok({ skills: (input?.refs as { id: string; path: string; sha256: string }[] ?? []).map(ref => { const found = catalog.find(item => item.path === ref.path); return found ? { ...ref, status: found.sha256 === ref.sha256 ? 'ok' : 'changed', currentSha256: found.sha256 } : { ...ref, status: 'missing' }; }) });
  if (path === '/api/flows/dev/draft') return ok({ draft: galleryFlow, revision: 'd'.repeat(64) });
  if (path === '/api/skill-library') return ok({ skills: skillLibrary.map(skill => { const usage = skillUsageOf(skill); return { id: skill.id, path: skillPathOf(skill), sha256: skill.sha256, name: skill.name, description: skill.description, source: skill.source, editable: skill.source === 'neomind', used: usage.profiles.length + usage.flows.length, stale: hash.includes('stale') && skill.id === 'review' ? 2 : 0 }; }), templates: ['empty', 'review-checklist'] });
  if (path === '/api/skills' && method === 'POST') { const skill: GallerySkill = { id: String(input?.id), source: 'neomind', name: String(input?.name), description: String(input?.description ?? ''), body: '# Khi nào dùng\n\n# Cách làm\n', files: {}, sha256: 'f'.repeat(64) }; skillLibrary.push(skill); return ok({ skill: skillDetail(skill) }); }
  const skillRoute = /^\/api\/skills\/([^/]+)(?:\/(usage|repin|delete|files)(?:\/(.+))?)?$/.exec(path);
  if (skillRoute && skillRoute[1] !== 'status') {
    const skill = skillLibrary.find(item => item.id === decodeURIComponent(skillRoute[1]!) && item.source === (url.searchParams.get('source') === 'claude' ? 'claude' : 'neomind'));
    if (!skill) return { status: 404, body: { error: 'Không có skill' } };
    if (!skillRoute[2] && method === 'PUT') { Object.assign(skill, { name: input?.name ?? skill.name, description: input?.description ?? skill.description, body: input?.body ?? skill.body }); return ok({ skill: skillDetail(skill), usage: skillUsageOf(skill) }); }
    if (!skillRoute[2]) return ok(skillDetail(skill));
    if (skillRoute[2] === 'usage') return ok(skillUsageOf(skill));
    if (skillRoute[2] === 'repin') return ok({ sha256: skill.sha256, profiles: [{ profileId: 'ts-strict' }], flows: [{ flowId: 'dev', changed: 1 }] });
    if (skillRoute[2] === 'delete') { skillLibrary.splice(skillLibrary.indexOf(skill), 1); return ok({ deleted: true }); }
    if (skillRoute[2] === 'files' && skillRoute[3]) {
      const file = decodeURIComponent(skillRoute[3]);
      if (method === 'GET') return ok({ path: file, content: skill.files[file] ?? '', sha256: 'a'.repeat(64) });
      if (method === 'DELETE') delete skill.files[file]; else skill.files[file] = String(input?.content ?? '');
      return ok({ path: file, sha256: 'b'.repeat(64) });
    }
  }
  if (path === '/api/profile-templates') return ok({ templates: agentTemplates });
  if (path === '/api/profiles/from-template') { const id = String(input?.id), name = String(input?.name); drafts[id] = makeProfile(id, name, input?.template === 'implementer'); metadata.push({ profileId: id, name, archived: false }); return ok({ draft: drafts[id], revision: 'e'.repeat(64) }); }
  const removal = /^\/api\/profiles\/([^/]+)\/(remove|set-archived)$/.exec(path);
  if (removal) { const id = decodeURIComponent(removal[1]!); metadata = removal[2] === 'remove' ? metadata.filter(item => item.profileId !== id) : metadata.map(item => item.profileId === id ? { ...item, archived: true } : item); return ok({}); }
  if (path === '/api/profiles' && method === 'GET') return ok({ profiles: metadata, builtins });
  if (path === '/api/profiles' && method === 'POST') { const id = String(input?.id), name = String(input?.name), template = builtins.find(item => item.profileId === input?.template) ?? builtins[0]!; drafts[id] = { ...structuredClone(template), profileId: id, name }; metadata.push({ profileId: id, name, archived: false }); return ok({ draft: drafts[id], revision: 'e'.repeat(64) }); }
  const savedProfile = /^\/api\/profiles\/([^/]+)\/versions\/(\d+)$/.exec(path);
  if (savedProfile) { const id = decodeURIComponent(savedProfile[1]!), profile = drafts[id] ?? builtins.find(item => item.profileId === id); return ok({ version: { ...structuredClone(profile), version: Number(savedProfile[2]) } }); }
  const profile = /^\/api\/profiles\/([^/]+)\/(draft|versions|publish|rename|clone|archive|restore|delete|usage|migrate|skills-status)$/.exec(path);
  if (profile) { const id = decodeURIComponent(profile[1]!), operation = profile[2]!;
    if (operation === 'draft' && method === 'PUT') { drafts[id] = structuredClone(input?.draft as Profile); return ok({ revision: 'e'.repeat(64) }); }
    if (operation === 'draft') return ok({ draft: drafts[id], revision: 'd'.repeat(64) });
    if (operation === 'versions') return ok({ versions: published[id] ?? [] });
    if (operation === 'usage') return ok({ flows: [{ flowId: 'dev', name: 'Dev', archived: false, revision: 'd'.repeat(64), draftValid: true, draft: [{ nodeId: 'implement', label: 'Implement', version: 1 }], published: [{ nodeId: 'implement', label: 'Implement', version: 1 }], publishedVersion: 1 }] });
    if (operation === 'migrate') return ok({ results: ((input?.flows ?? []) as { flowId: string }[]).map(item => ({ flowId: item.flowId, changed: 1, revision: 'e'.repeat(64) })) });
    if (operation === 'skills-status') return ok({ skills: [] });
    if (operation === 'publish') { const version = (published[id]?.at(-1) ?? 0) + 1; published[id] = [...(published[id] ?? []), version]; return ok({ version: { version } }); }
    if (operation === 'clone') { const targetId = String(input?.targetId); drafts[targetId] = { ...structuredClone(drafts[id]!), profileId: targetId, name: String(input?.name) }; metadata.push({ profileId: targetId, name: String(input?.name), archived: false }); return ok({}); }
    if (operation === 'rename') metadata = metadata.map(item => item.profileId === id ? { ...item, name: String(input?.name) } : item);
    if (operation === 'archive' || operation === 'restore') metadata = metadata.map(item => item.profileId === id ? { ...item, archived: operation === 'archive' } : item);
    if (operation === 'delete') metadata = metadata.filter(item => item.profileId !== id);
    return ok({});
  }
  if (path === '/api/memory' && method === 'GET') return ok({ root, records: root ? records : [], stats: root ? stats : {}, inactive: root ? [{ id: 'checks', reason: 'superseded' }] : [],
    location: { root: 'W:\\projects\\neomind-demo\\neomind\\memory', configured: false, isDefault: true, exists: !!root, inRepository: true, relativePath: 'neomind/memory' } });
  if (path === '/api/memory/proposals' && method === 'GET') return ok({ memoryRoot: 'W:\\projects\\neomind-demo\\neomind\\memory', proposals: root ? pending : [], errors: [] });
  if (path.startsWith('/api/memory/proposals/')) { pending = pending.filter(item => item.proposal.proposalId !== input?.proposalId); return ok({}); }
  if (path === '/api/memory/note') { const id = `note-${records.length}`; records.push({ revision: 'f'.repeat(64), body: String(input?.body), header: { id, type: String(input?.type), scope: String(input?.scope), sources: ['user-note'], tags: (input?.tags as string[]) ?? [] } }); return ok({ record: records.at(-1) }); }
  if (path === '/api/memory/expire') { const record = records.find(item => item.header.id === input?.id)!; record.header.expiresAt = new Date().toISOString(); return ok({ record }); }
  if (path === '/api/memory/delete') { records.splice(records.findIndex(item => item.header.id === input?.id), 1); return ok({ deleted: true }); }
  if (path === '/api/memory' && method === 'POST') { const record = input?.record as { id: string; type: string; scope: string; sources: string[]; tags: string[]; body: string }; const saved = { revision: 'e'.repeat(64), body: record.body, header: { id: record.id, type: record.type, scope: record.scope, sources: record.sources, tags: record.tags } }; const index = records.findIndex(item => item.header.id === record.id && item.header.type === record.type); if (index >= 0) records[index] = saved; else records.push(saved); return ok({ record: saved }); }
  if (path === '/api/memory/compact') {
    // One record or proposal at a time, as the page asks; the server does the same through the audited write path.
    const target = input?.target as { type?: string; id?: string; runId?: string | null; proposalId?: string } | undefined, changes: { kind: string; key: string; before: string; after: string; applied: boolean }[] = [];
    for (const record of records) { const after = compactLegacyLessonBody(record.body)?.body; if (!after || (target && (target.type !== record.header.type || target.id !== record.header.id))) continue;
      changes.push({ kind: 'record', key: `${record.header.type}/${record.header.id}`, before: record.body, after, applied: true }); record.body = after; record.header.scope = 'project'; record.header.sources = [...record.header.sources, 'compacted']; }
    for (const item of pending) { const after = compactLegacyLessonBody(item.proposal.record.body)?.body; if (!after || (target && target.proposalId !== item.proposal.proposalId)) continue;
      changes.push({ kind: 'proposal', key: `${item.runId ?? 'project'}/${item.proposal.proposalId}`, before: item.proposal.record.body, after, applied: true }); item.proposal.record.body = after; item.version++; item.proposalHash = '9'.repeat(64); }
    return ok({ dryRun: false, changes, skipped: [] });
  }
  if (path === '/api/memory/configure') { root = String(input?.root ?? 'W:\\projects\\neomind-demo\\neomind\\memory'); return ok({ root, records }); }
  if (path === '/api/memory/selection') return ok({ selection, revision: 'f'.repeat(64) });
  if (path === '/api/memory/preview') return ok({ root, records: root ? [{ id: 'guard-input', type: 'lesson', scope: 'src/', selectionReason: 'khớp yêu cầu' }] : [] });
  if (path === '/api/memory/lesson-queue') return ok({ runs: proposalStatus === 'pending' ? [{ runId: 'run-1', task: 'Sửa parser', pending: 1 }] : [], errors: [], scanned: 1, totalCompleted: 1 });
  if (path === '/api/runs/run-1/lessons') return ok({ memoryRoot: root, proposals: [{ proposal, version: proposalVersion, proposalHash: 'b'.repeat(64), expectedRevision: null, promoted: proposalStatus === 'promoted', rejected: proposalStatus === 'rejected' }] });
  if (path.startsWith('/api/runs/run-1/lessons/')) { if (path.endsWith('/approve')) proposalStatus = 'promoted'; else if (path.endsWith('/reject')) proposalStatus = 'rejected'; else if (path.endsWith('/revise')) { proposal.record.body = String(input?.body); proposalVersion++; } return ok({}); }
  return { status: 404, body: { error: `Gallery has no ${method} ${path}` } };
});
createRoot(document.getElementById('root')!).render(<React.StrictMode><App shell={hash.includes('panel') ? 'panel' : 'web'} /></React.StrictMode>);
const click = (find: () => Element | undefined | null, next?: () => void, tries = 80) => { const item = find(); if (item) { if (item.getAttribute('role') === 'tab') item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); else if (item.getAttribute('aria-label') === 'Quản lý agent') item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); else (item as HTMLElement).click(); next?.(); } else if (tries) setTimeout(() => click(find, next, tries - 1), 100); };
const byText = (selector: string, text: string) => () => [...document.querySelectorAll(selector)].find(item => item.textContent?.includes(text));
const tab = (text: string) => () => [...document.querySelectorAll('[role="tab"]')].find(item => item.textContent?.includes(text));
if (isSkills) click(byText('nav button, aside button', 'Skills'), () => {
  if (hash.includes('create')) click(byText('button', 'Skill mới'));
  if (hash.includes('claude')) click(byText('.profiles-list button', 'Style guide'));
  if (hash.includes('files')) click(tab('File phụ'), () => click(byText('.profiles-tab button', 'reference.md')));
  if (hash.includes('usage')) click(tab('Nơi dùng'));
  if (hash.includes('prompt')) click(byText('button', 'Xem đoạn chèn vào prompt'));
  if (hash.includes('delete')) click(() => document.querySelector('button[aria-label="Xóa skill"]'));
});
else click(byText('nav button, aside button', isMemory ? 'Memory' : 'Agents'), () => {

  if (hash.includes('create')) click(byText('button', 'Agent mới'));
  if (hash.includes('remove')) click(() => document.querySelector('[aria-label="Quản lý agent"]'), () => click(byText('[role="menuitem"]', 'Xóa agent')));
  if (hash.includes('saved')) click(() => document.querySelector('textarea[aria-label="Hướng dẫn"]'), () => {
    const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Hướng dẫn"]');
    if (el) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, `${el.value}\nĐã sửa.`); el.dispatchEvent(new Event('input', { bubbles: true })); }
    setTimeout(() => click(() => [...document.querySelectorAll<HTMLButtonElement>('.profiles-detail-header button')].find(item => item.textContent === 'Lưu' && !item.disabled)), 300);
  });

  if (hash.includes('detail') || hash.includes('edit')) click(() => document.querySelector('.memory-record-row'), () => { if (hash.includes('edit')) click(byText('[role="dialog"] button', 'Sửa')); });
  if (hash.includes('note')) click(byText('button', 'Ghi chú'));
  // `#full` expands the old long proposal (JSON folded); `#compact` asks to shorten it; `#records` scrolls to the table.
  if (hash.includes('full')) click(byText('button.memory-more', 'Xem đầy đủ'));
  if (hash.includes('compact')) click(byText('button', 'Rút gọn'));
  if (hash.includes('shortened')) click(byText('button', 'Rút gọn'), () => click(byText('[role="alertdialog"] button', 'Rút gọn')));
  if (hash.includes('records')) click(() => document.querySelector('.memory-records'), () => document.querySelector('.memory-records')?.scrollIntoView({ block: 'start' }));
  if (hash.includes('review')) click(byText('button', 'Sửa rồi duyệt'));
  if (hash.includes('policy')) click(byText('button', 'Chọn memory cho run'));
  if (hash.includes('skills')) click(tab('Skills'));
  if (hash.includes('perm')) click(tab('Quyền'));
  if (hash.includes('usage')) click(tab('Được dùng ở'));
  if (hash.includes('migrate')) click(byText('button', 'Chuyển flow sang bản này'));
  if (hash.includes('edited')) click(() => document.querySelector('textarea[aria-label="Hướng dẫn"]'), () => { const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Hướng dẫn"]'); if (el) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, `${el.value}\nThay đổi mẫu.`); el.dispatchEvent(new Event('input', { bubbles: true })); } });
});
