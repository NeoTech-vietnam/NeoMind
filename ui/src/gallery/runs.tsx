/**
 * Runs screen with made-up data for every run state (dev only, /__gallery/runs.html). No real run is ever started:
 * the API transport answers from the tables below. Hash options: `#<state>[,light][,panel][,session][,new][,filter]`.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../app.css';
import App from '../App';
import { setApiTransport } from '../api';
import { templates } from '../../../src/domain/templates';
import type { Flow } from '../../../src/domain/schema';
import type { Run } from '../runTypes';
import type { TranscriptEvent } from '../../../src/core/transcript-types';

const now = Date.now(), minute = 60_000;
const values = (runner: string, model: string, reasoning: string) => ({ runner, provider: runner === 'codex' ? 'openai' : 'anthropic', model, reasoning });
const claudeOpus = values('claude-code', 'claude-opus-5-5', 'high'), claudeSonnet = values('claude-code', 'claude-sonnet-5-5', 'medium'), codexSol = values('codex', 'gpt-6.1-sol', 'high'), codexTerra = values('codex', 'gpt-6.1-terra', 'medium');
const flowOf = (id: keyof typeof templates, version = 3): Flow => ({ ...structuredClone(templates[id]), version });
const bindingsOf = (map: Record<string, ReturnType<typeof values>>) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, { values: value }]));
const devBindings = { plan: claudeOpus, implement: claudeSonnet, 'verify/required-reviewer': codexSol };
const parallelBindings = { plan: claudeOpus, 'implement-a': claudeSonnet, 'implement-b': codexTerra, integrate: claudeSonnet, 'verify/required-reviewer': codexSol };

const plan = { goal: 'calc.js có hàm power(a, b) trả về a mũ b, được export cùng add; calc.test.js kiểm tra số mũ dương, số mũ 0 và cơ số âm.',
  approach: '1. Trong calc.js, thêm function power(a, b) { return Math.pow(a, b); } ngay sau add.\n2. Sửa export thành module.exports = { add, power };, giữ nguyên add.\n3. Trong calc.test.js, thêm 3 assertion: power(2, 3) === 8, power(5, 0) === 1, power(-2, 3) === -8.\n4. Chạy npm test để xác nhận.',
  scope: ['calc.js', 'calc.test.js'], acceptanceCriteria: ['calc.js định nghĩa power(a, b) trả về Math.pow(a, b)', 'calc.js export cả add và power', 'calc.test.js có assertion cho số mũ dương, số mũ 0 và cơ số âm', 'Hàm add và assertion cũ giữ nguyên', 'npm test thoát 0'], checks: ['npm test'], riskChanges: [] };

type Scenario = { flow: Flow; bindings: Record<string, ReturnType<typeof values>>; task: string; phase: string; reason: string; graph: Record<string, string>; activeMs: number; extra?: Partial<Run>; attempts?: Attempt[] };
type Attempt = { id: string; nodeId: string; key: string; role: 'plan' | 'read' | 'write' | 'review'; runner: string; model: string; startOffset: number; ms: number; status?: 'completed'; usage: [number, number]; events: TranscriptEvent[] };

const at = (base: number, offset: number) => base + offset * 1000;
function events(base: number, kind: 'plan' | 'write-a' | 'write-b' | 'review', live: boolean): TranscriptEvent[] {
  const t = (offset: number) => at(base, offset);
  if (kind === 'plan') return [
    { kind: 'prompt', i: 0, t: t(0), text: 'Lập kế hoạch cho: "Thêm hàm power(a, b) vào calc.js và viết test cho nó". Đọc cấu trúc project, đề xuất plan có phạm vi sửa, tiêu chí hoàn thành và checks.' },
    { kind: 'search', i: 1, t: t(5), id: 's1', text: '**/*' }, { kind: 'result', i: 2, t: t(5), id: 's1', text: 'calc.js\ncalc.test.js\npackage.json' },
    ...['README.md', 'AGENTS.md', 'calc.js', 'calc.test.js', 'package.json', '.gitignore', 'progress.md'].map((path, index): TranscriptEvent => ({ kind: 'read', i: 3 + index, t: t(7 + index), id: `r${index}`, path })),
    { kind: 'structured_output', i: 11, t: t(77), text: JSON.stringify({ goal: plan.goal, scope: plan.scope, checks: plan.checks, acceptanceCriteria: plan.acceptanceCriteria, approach: 'Thêm power, export, 3 assertion' }) },
    { kind: 'end', i: 12, t: t(80), status: 'completed' }];
  if (kind === 'review') return [
    { kind: 'prompt', i: 0, t: t(0), text: 'Review độc lập thay đổi của bước Thực hiện theo các tiêu chí của kế hoạch. Kết luận pass / needs_changes / blocked.' },
    { kind: 'read', i: 1, t: t(4), id: 'r1', path: 'calc.js' }, { kind: 'read', i: 2, t: t(6), id: 'r2', path: 'calc.test.js' },
    { kind: 'command', i: 3, t: t(10), id: 'c1', command: 'git diff main', status: 'completed', exitCode: 1, text: 'fatal: bad revision main' },
    { kind: 'end', i: 4, t: t(47), status: 'completed' }];
  const file = kind === 'write-a' ? 'README.md' : 'docs/install.md';
  return [
    { kind: 'prompt', i: 0, t: t(0), text: `Thực hiện phần việc của bạn trong kế hoạch đã duyệt: ${file}.` },
    { kind: 'search', i: 1, t: t(3), id: 's1', text: 'docs/**' }, { kind: 'result', i: 2, t: t(3), id: 's1', text: 'docs/a.md\ndocs/b.md\ndocs/c.md\ndocs/d.md' },
    { kind: 'read', i: 3, t: t(5), id: 'r1', path: 'AGENTS.md' }, { kind: 'read', i: 4, t: t(5), id: 'r2', path: 'package.json' },
    { kind: 'edit', i: 5, t: t(192), id: 'e1', path: file, change: 'edit', added: 12, removed: 3, diff: '@@ -8,7 +8,16 @@ ## Cài đặt\n- npm install\n- npm run build\n+Cần Git và Node.js >= 22.16.\n+\n+npm ci\n+npm test' },
    { kind: 'command', i: 6, t: t(225), id: 'c1', command: 'npm test', status: live ? 'running' : 'completed', ...(live ? { text: '> neomind-demo@1.0.0 test\n> node --test\n\nok 1 - add cộng hai số' } : { exitCode: 0, durationMs: 3000, text: 'ok 1 - add cộng hai số\nok 2 - power' }) },
    ...(live ? [] : [{ kind: 'end', i: 7, t: t(240), status: 'completed' } as TranscriptEvent])];
}

const base = now - 40 * minute;
const attemptsFor = (flowId: string, running: boolean): Attempt[] => flowId === 'parallel' ? [
  { id: 'a-plan', nodeId: 'plan', key: 'plan', role: 'plan', runner: 'claude-code', model: 'claude-opus-5-5', startOffset: 0, ms: 108_000, status: 'completed', usage: [38_200, 3_100], events: events(base, 'plan', false) },
  { id: 'a-impl-a', nodeId: 'implement-a', key: 'implement-a', role: 'write', runner: 'claude-code', model: 'claude-sonnet-5-5', startOffset: 600, ms: 620_000, usage: [41_000, 5_000], events: events(now - 10.3 * minute, 'write-a', true) },
  { id: 'a-impl-b', nodeId: 'implement-b', key: 'implement-b', role: 'write', runner: 'codex', model: 'gpt-6.1-terra', startOffset: 600, ms: 620_000, usage: [38_000, 4_200], events: events(now - 10.3 * minute, 'write-b', true) }]
  : [{ id: 'a-plan', nodeId: 'plan', key: 'plan', role: 'plan', runner: 'claude-code', model: 'claude-opus-5-5', startOffset: 0, ms: 112_000, status: 'completed', usage: [38_200, 3_100], events: events(base, 'plan', false) },
    ...(running ? [] : [{ id: 'a-impl', nodeId: 'implement', key: 'implement', role: 'write' as const, runner: 'claude-code', model: 'claude-sonnet-5-5', startOffset: 400, ms: 151_000, status: 'completed' as const, usage: [74_000, 9_800] as [number, number], events: events(base + 400_000, 'write-a', false) },
      { id: 'a-review', nodeId: 'verify', key: 'verify/required-reviewer', role: 'review' as const, runner: 'codex', model: 'gpt-6.1-sol', startOffset: 600, ms: 47_000, status: 'completed' as const, usage: [39_100, 2_400] as [number, number], events: events(base + 600_000, 'review', false) }])];

const reviewEvidence = { criteria: [{ criterion: 'divide(a, 0) ném RangeError', status: 'pass' }, { criterion: 'divide trả đúng kết quả khi b khác 0', status: 'pass' }, { criterion: 'calc.test.js có test cho chia cho 0', status: 'pass' },
  { criterion: 'add, subtract, multiply giữ nguyên hành vi', status: 'unresolved' }, { criterion: 'Chỉ sửa calc.js và calc.test.js', status: 'pass' }, { criterion: 'npm test thoát 0', status: 'pass' }],
  findings: [{ id: 'F1', criterion: 'calc.js:1-12', explanation: 'Không chạy được git diff main trong sandbox, nên không so được 3 hàm đầu với bản trước khi sửa.' }] };

const scenarios: Record<string, Scenario> = {
  waiting: { flow: flowOf('dev'), bindings: devBindings, task: 'Thêm hàm power(a, b) vào calc.js và viết test', phase: 'waiting_approval', reason: 'Chờ bạn duyệt kế hoạch',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'waiting' }, activeMs: 112_000, attempts: attemptsFor('dev', true).slice(0, 1) },
  running: { flow: flowOf('parallel', 1), bindings: parallelBindings, task: 'Viết lại phần cài đặt trong README', phase: 'running', reason: '',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', fork: 'succeeded', 'implement-a': 'running', 'implement-b': 'running' }, activeMs: 12 * minute + 8000, attempts: attemptsFor('parallel', true) },
  blocked: { flow: flowOf('dev'), bindings: devBindings, task: 'Sửa lỗi chia cho 0 trong divide()', phase: 'blocked', reason: 'Code đã sửa xong và npm test đạt, nhưng reviewer bắt buộc vẫn chưa xác nhận được 1 tiêu chí sau 2 vòng sửa: nó không chạy được git diff trong sandbox nên không so được với bản trước khi sửa. NeoMind dừng trước khi commit để bạn quyết định.',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', implement: 'succeeded', repair: 'succeeded', verify: 'waiting', commit: 'pending' }, activeMs: 6 * minute + 41_000, attempts: attemptsFor('dev', false),
    extra: { checks: [{ checkId: 'c1', command: 'npm test', status: 'passed' }], acceptedReviews: [], reviewerOutputs: [1, 2, 3].map(n => ({ attemptId: `rv${n}`, nodeId: 'verify', summary: n === 3 ? 'divide() ném RangeError khi b bằng 0 và có test cho trường hợp này. Không so được calc.js với bản trước khi sửa, nên chưa xác nhận các hàm khác giữ nguyên.' : 'Cần sửa thêm.', result: { reviewerId: 'required-reviewer', verdict: n === 3 ? 'inconclusive' : 'needs_changes', findingIds: ['F1'] }, ...(n === 3 ? { evidence: reviewEvidence } : {}) })) } },
  timeout: { flow: flowOf('dev'), bindings: devBindings, task: 'Tách module parser', phase: 'blocked', reason: 'Đã dùng hết thời gian xử lý.',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', implement: 'running', repair: 'pending', verify: 'pending', commit: 'pending' }, activeMs: 30 * minute, attempts: attemptsFor('dev', true), extra: { timeLimitMs: 30 * minute } },
  commit: { flow: flowOf('dev'), bindings: devBindings, task: 'Thêm cờ --precision cho CLI', phase: 'blocked', reason: 'Git commit lỗi: index.lock đang bị giữ bởi một tiến trình khác.',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', implement: 'succeeded', repair: 'skipped', verify: 'succeeded', commit: 'failed' }, activeMs: 4 * minute, attempts: attemptsFor('dev', false),
    extra: { unresolvedCommitNodeIds: ['commit'], checks: [{ checkId: 'c1', command: 'npm test', status: 'passed' }], acceptedReviews: [{ nodeId: 'verify' }] } },
  completed: { flow: flowOf('dev'), bindings: devBindings, task: 'Thêm cờ --precision cho CLI', phase: 'completed', reason: '',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', implement: 'succeeded', repair: 'skipped', verify: 'succeeded', commit: 'succeeded', finish: 'succeeded' }, activeMs: 4 * minute + 32_000, attempts: attemptsFor('dev', false),
    extra: { checks: [{ checkId: 'c1', command: 'npm test', status: 'passed' }], acceptedReviews: [{ nodeId: 'verify' }], delivery: [{ nodeId: 'commit', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', parent: 'main', files: ['cli.js', 'calc.js', 'calc.test.js'] }],
      reviewerOutputs: [{ attemptId: 'rv1', nodeId: 'verify', summary: 'Mọi tiêu chí đạt; npm test thoát 0.', result: { reviewerId: 'required-reviewer', verdict: 'pass', findingIds: [] }, evidence: { criteria: reviewEvidence.criteria.map(item => ({ ...item, status: 'pass' })), findings: [] } }] } },
  handoff: { flow: flowOf('fast', 1), bindings: { plan: claudeSonnet, implement: claudeSonnet }, task: 'Dọn test cũ', phase: 'completed', reason: '',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', implement: 'succeeded', finish: 'succeeded' }, activeMs: 3 * minute, attempts: attemptsFor('fast', false).slice(0, 1), extra: { handoff: { files: ['calc.test.js', 'old.test.js'], applied: false } } },
  cancelled: { flow: flowOf('dev'), bindings: devBindings, task: 'Dọn test cũ trong calc', phase: 'cancelled', reason: 'Đã hủy bởi người dùng',
    graph: { start: 'succeeded', plan: 'succeeded', approval: 'succeeded', implement: 'failed', repair: 'pending', verify: 'pending', commit: 'pending' }, activeMs: 9 * minute, attempts: attemptsFor('dev', true).slice(0, 1) },
};

function runOf(id: string, scenario: Scenario): Run {
  const flow = scenario.flow;
  return { runId: id, busy: false, timeExtensionsMs: 0, proposedPlanHash: 'a'.repeat(64), runtimeState: { phase: scenario.phase, reason: scenario.reason, activeMs: scenario.activeMs },
    runtimeContext: { workspaceMode: 'isolated', task: scenario.task, workspace: 'C:\\Users\\dev\\AppData\\Local\\neomind\\ab12\\workspaces\\' + id, sourceHead: '3648ef2', memory: { root: 'neomind/memory', text: 'rule · test-style\nlesson · guard-invalid-input', records: [{ id: 'test-style', type: 'rule', scope: 'project', revision: '9f2c1a0e11', sources: ['AGENTS.md'], selectionReason: 'khớp đường dẫn calc.js' }] } },
    snapshot: { configuration: { flow, bindings: bindingsOf(scenario.bindings) } }, bindingSelections: [], usage: { totalTokens: scenario.phase === 'waiting_approval' ? 24_000 : 167_000, partial: false },
    graph: { nodes: Object.fromEntries(flow.definition.nodes.map(node => [node.id, { status: scenario.graph[node.id] ?? 'pending' }])) },
    plans: [{ nodeId: 'plan', plan }], approvals: scenario.phase === 'waiting_approval' ? [] : [{ nodeId: 'approval', approval: { source: flow.flowId === 'fast' ? 'flow' : 'user' } }],
    checks: [], reviewerOutputs: [], acceptedReviews: [], artifacts: [{ nodeId: 'plan', kind: 'agent', text: 'Kế hoạch đã ghi' }], unresolvedCommitNodeIds: [], nodeData: [], ...scenario.extra };
}

const list = [
  ['run-waiting-1', 'waiting', 12], ['run-waiting-2', 'blocked', 38], ['run-running-1', 'running', 4], ['run-completed-1', 'completed', 120], ['run-timeout-1', 'timeout', 1500], ['run-cancelled-1', 'cancelled', 4300], ['run-handoff-1', 'handoff', 2900],
] as const;
const runIds = Object.fromEntries(list.map(([id, key]) => [id, key]));

function transcriptsOf(scenario: Scenario) {
  const transcripts = (scenario.attempts ?? []).map(item => ({ meta: { attemptId: item.id, nodeId: item.nodeId, key: item.key, role: item.role, runner: item.runner, model: item.model, sessionId: 'sess-' + item.id + '-abcdef', workspace: '/w' },
    startedAt: item.events[0]?.t, endedAt: item.status ? (item.events[0]?.t ?? 0) + item.ms : undefined, status: item.status, events: item.events.length,
    reads: item.events.filter(event => event.kind === 'read').length, edits: item.events.filter(event => event.kind === 'edit').length, commands: item.events.filter(event => event.kind === 'command').length,
    files: item.events.flatMap(event => event.kind === 'edit' && event.path ? [event.path] : []), added: 12, removed: 3,
    usage: { inputTokens: item.usage[0], outputTokens: item.usage[1], cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: item.usage[0] + item.usage[1] }, last: item.events.at(-1), attemptStatus: item.status ? 'succeeded' : 'running' }));
  return { transcripts, history: [] };
}

const hash = location.hash.slice(1).split(',').filter(Boolean);
const wanted = Object.keys(scenarios).find(key => hash.includes(key)) ?? 'waiting';
const wantsNew = hash.includes('new'), wantSession = hash.includes('session');
localStorage.setItem('neomind.theme', hash.includes('light') ? 'light' : 'dark');
// The panel shell follows the page around it, the way Nimbalyst marks its theme.
document.documentElement.classList.add(hash.includes('light') ? 'light-theme' : 'dark-theme');
const wantedId = list.find(([, key]) => key === wanted)?.[0] ?? list[0][0];

setApiTransport(async (endpoint, method, body) => {
  const url = new URL(endpoint, 'http://gallery'), path = url.pathname;
  const ok = (value: unknown) => ({ status: 200, body: value });
  if (path === '/api/bootstrap') return ok({ projectName: 'neomind-demo', projectRoot: 'W:\\projects\\neomind-demo', templates: ['fast', 'dev', 'parallel', 'research'], runtimeAvailable: true,
    flows: [{ flowId: 'dev', name: 'Dev', archived: false }, { flowId: 'parallel', name: 'Dev song song', archived: false }, { flowId: 'writing', name: 'Viết tài liệu', archived: false }] });
  if (path === '/api/runners') return ok({ runners: [{ runner: 'codex', provider: 'openai', models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], reasoning: ['low', 'medium', 'high'] }, { runner: 'claude-code', provider: 'anthropic', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], reasoning: ['low', 'medium', 'high'] }] });
  if (path === '/api/runs' && method === 'GET') return ok({ runs: [...list].sort((left, right) => right[2] - left[2]).map(([id, key, ago]) => { const item = scenarios[key]!;
    return { runId: id, task: item.task, flowId: item.flow.flowId, flowName: item.flow.name, createdAt: new Date(now - ago * minute).toISOString(), phase: item.phase, reason: item.reason, activeMs: item.activeMs }; }) });
  if (path === '/api/runs/preview') { const input = body as { flowId: string };
    if (input.flowId === 'writing') return { status: 409, body: { error: 'Publish the flow before starting a run' } };
    const source = input.flowId === 'parallel' ? scenarios.running! : scenarios.waiting!;
    return ok({ runtimeDiagnostics: [], snapshot: { configuration: { flow: source.flow, bindings: bindingsOf(source.bindings) } }, configurationHash: 'b'.repeat(64), sourceHead: '3648ef2a1b2c3d4e', dirtyPaths: [], gitDelivery: 'local',
      flowExceptions: [], dirtyImport: { baselineHash: 'c'.repeat(64), changes: hash.includes('dirty') ? [{ path: 'calc.js', change: 'modified' }, { path: 'README.md', change: 'modified' }] : [], blockers: [] } }); }
  if (path === '/api/memory/preview') return ok({ root: 'neomind/memory', records: [{ id: 'test-style', type: 'rule', scope: 'project', revision: '9f2c1a0e11223344', selectionReason: 'khớp đường dẫn calc.test.js' }, { id: 'guard-invalid-input', type: 'lesson', scope: 'calc.js', revision: '4b81e3d255667788', selectionReason: 'khớp đường dẫn calc.js' }, { id: 'checks-command', type: 'fact', scope: 'project', revision: '1c07aa9399aabbcc', selectionReason: 'luôn chọn' }], inferredPaths: ['calc.js', 'calc.test.js'], excluded: [{ id: 'old-note', reason: 'quá cũ' }] });
  const match = /^\/api\/runs\/([a-z0-9-]+)(?:\/(transcripts)(?:\/([A-Za-z0-9_-]+))?|\/(lessons)|\/(\w+))?$/.exec(path);
  if (match) {
    const scenario = scenarios[runIds[match[1]!]!];
    if (!scenario) return { status: 404, body: { error: 'Unknown run' } };
    if (match[2] && !match[3]) return ok(transcriptsOf(scenario));
    if (match[2] && match[3]) { const attempt = scenario.attempts?.find(item => item.id === match[3]); const after = Number(url.searchParams.get('after') ?? 0); return ok({ source: url.searchParams.get('source') ?? 'neomind', recorded: true, events: (attempt?.events ?? []).filter(event => (event.i ?? 0) >= after) }); }
    if (match[4]) return ok({ memoryRoot: 'neomind/memory', proposals: scenario.phase === 'completed' && scenario.flow.flowId === 'dev' ? [{ proposal: { proposalId: 'lesson-1', record: { body: 'Khi thêm cờ CLI, kiểm tra giá trị đầu vào trước khi dùng và có test cho giá trị biên.', sources: ['cli.js'] } }, version: 1, proposalHash: 'd'.repeat(64), expectedRevision: null, promoted: false }] : [] });
    if (match[5]) return ok(runOf(match[1]!, scenario));
    return ok(runOf(match[1]!, scenario));
  }
  return { status: 404, body: { error: `Gallery has no ${method} ${path}` } };
});

createRoot(document.getElementById('root')!).render(<React.StrictMode><App shell={hash.includes('panel') ? 'panel' : 'web'} /></React.StrictMode>);

/** Open the wanted run (or the new-run form) the way a user would: click it. */
const click = (find: () => Element | null | undefined, then?: () => void, tries = 60) => { const element = find(); if (element) { (element as HTMLElement).click(); then?.(); } else if (tries > 0) setTimeout(() => click(find, then, tries - 1), 100); };
const byText = (selector: string, text: string) => () => [...document.querySelectorAll(selector)].find(item => item.textContent?.includes(text));
if (!wantsNew) click(byText('aside[aria-label="Danh sách run"] button', scenarios[wanted]!.task), () => {
  if (wantSession) click(byText('button', 'Xem session'));
  if (hash.includes('filter')) click(byText('button', 'Lọc'));
});
else if (hash.includes('filter')) click(byText('button', 'Lọc'));
