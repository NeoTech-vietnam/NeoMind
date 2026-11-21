/**
 * Mock of the `langflow web` API for `npm run dev` with `?mock` (dev builds only; never in the production bundle).
 * Serves real status files from examples/demo (copied into fixtures/), computes states/info like view.step_states,
 * and simulates a started run: running → waiting at its gate → (approve) running → done, so the gate card, start form,
 * live log and 409s can be tried without the server.
 *
 * Phase 2: usage/cost on ai events and run totals, a guardrail
 * round and a transient retry, a cancelled run, cancel, gate_files with an in-memory file store (/api/file), run
 * outputs, editable run and series memory, "propose to KB" (id "fail" makes the command fail), stats and schedules.
 *
 * Delete runs: DELETE /api/runs/{run}[?force=1] and
 * POST /api/runs/prune, with old copies of the fixtures (updated 12–200 days ago) so "Dọn run cũ" finds something.
 * ev-old-4 is "held by a web job": deleting it answers 409 and prune lists it under skipped.
 */
import type { ApiTransport } from '../api';
import { catalogMock, nodeBinding, recordedBinding, recordedModes } from '../catalog/mockData';
import type { ArgSpec, Graph, HistoryEvent, MemoryEntry, RunDetail, Schedule, StepInfo, StepState, Totals, Usage, Workflow } from '../types';

type Status = Omit<RunDetail, 'states' | 'info' | 'busy'> & Record<string, unknown>;
type Item = { status: Status; log: string[]; busy: boolean; cancel?: boolean; memory?: Record<string, MemoryEntry>; held?: string };

const files = import.meta.glob('./fixtures/*.json', { eager: true, import: 'default' }) as Record<string, Status>;
const logs = import.meta.glob('./fixtures/*.log.txt', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

const ROOT = 'W:\\projects\\AI\\langflow\\examples\\demo', STATE = `${ROOT}\\.langflow\\state`;
const runs = new Map<string, Item>();
for (const [path, status] of Object.entries(files)) {
  const name = path.replace(/^.*\/(.*)\.json$/, '$1');
  runs.set(name, { status: structuredClone(status), log: (logs[`./fixtures/${name}.log.txt`] ?? '').split(/\r?\n/).filter(Boolean), busy: false });
}

const stamp = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const now = () => stamp(new Date());

// ---------------------------------------------------------------- usage and cost on the fixtures

/** Deterministic fake usage for one ai call: Claude reports its cost, Codex is priced from config, OpenCode unknown. */
function fakeUsage(seed: string, agent: string | undefined, seconds = 5): Usage {
  let hash = 0; for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const input = 800 + (hash % 2400), output = 150 + Math.round(seconds * 40) + (hash % 300), cacheRead = (hash % 3) * 4000, cacheWrite = hash % 2 ? 1200 : 0;
  const priced = (input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1e6;
  if (agent === 'opencode') return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: null, cost_source: null };
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, reasoning_tokens: agent === 'codex' ? 320 : 0,
    cost_usd: Math.round(priced * 1e6) / 1e6, cost_source: agent === 'codex' ? 'pricing' : 'agent' };
}
function addUsage(status: Status) {
  const agents: Record<string, string> = {};
  for (const event of (status.history ?? []) as HistoryEvent[]) {
    if (!event.step || event.kind !== 'ai') continue;
    if (event.event === 'start' && typeof event.agent === 'string') agents[event.step] = event.agent;
    if ((event.event === 'done' || event.event === 'failed') && !event.usage) event.usage = fakeUsage(`${status.run}/${event.step}/${event.time}`, agents[event.step] ?? 'claude', typeof event.seconds === 'number' ? event.seconds : 5);
  }
}
for (const item of runs.values()) addUsage(item.status);

/** Phase 2b: what each ai step ran with, on its start event (as engine.py records it); see catalog/mockData.ts. */
function addBindings(status: Status) {
  for (const event of (status.history ?? []) as HistoryEvent[]) {
    if (event.kind !== 'ai' || !event.step) continue;
    // native phase 1: role_channel on the done event (what really ran)
    if (event.event === 'done' && event.role_channel === undefined) { Object.assign(event, recordedModes(status.workflow, event.step).done); continue; }
    if (event.event !== 'start' || event.binding !== undefined) continue;
    const binding = recordedBinding(status.workflow, event.step);
    if (binding) Object.assign(event, { role: binding.role?.id ?? null, skills: binding.skills.map(item => item.id), binding, ...recordedModes(status.workflow, event.step).start });
  }
}
for (const item of runs.values()) addBindings(item.status);
/** Graph nodes with their effective role and skills (engine.layout), read now so a saved override shows at once. */
function withBindings(graph: Graph | undefined, workflow: string): Graph | undefined {
  if (!graph) return graph;
  return { ...graph, nodes: graph.nodes.map(node => { const b = node.kind === 'ai' || node.kind === 'worker' ? nodeBinding(workflow, node.id) : null; return b ? { ...node, role: b.role, skills: b.skills } : node; }) };
}

/** Insert an event before the first event matching `before`. */
function insertBefore(name: string, before: (event: HistoryEvent) => boolean, event: Omit<HistoryEvent, 'time'>) {
  const status = runs.get(name)?.status; if (!status?.history) return;
  const index = status.history.findIndex(before);
  if (index < 0) return;
  status.history.splice(index, 0, { time: status.history[index]!.time, ...event } as HistoryEvent);
}
// A transient retry (rate limit) on an orchestrator worker and a guardrail round on the routing classifier.
insertBefore('or-1', event => event.step === 'research[1]' && event.event === 'done',
  { step: 'research[1]', kind: 'ai', event: 'retry', attempt: 1, wait: 15, error: 'API Error: 429 rate_limit_error: This request would exceed the rate limit (mock)' });
insertBefore('rt-1', event => event.step === 'classify' && event.event === 'done',
  { step: 'classify', kind: 'ai', event: 'check failed', attempt: 1, feedback: 'type must be one of bug, question, feature (got "issue")', usage: fakeUsage('rt-1/classify/check', 'claude', 3) });

// Phase 2 (skill_mode / retry_mode) on ev-1 (evaluator: write → judge, two rounds). write runs with retry_mode resume:
// round 1 has a guardrail round that resumed the session; in round 2 the resume failed and the engine made one fresh
// call. judge runs skill_mode native: in round 2 Claude did not load asd-ste100, so the engine wrote a `native
// fallback` event and called again with system; that done event also reports one permission denial.
{
  const history = runs.get('ev-1')?.status.history as HistoryEvent[] | undefined;
  const nth = (step: string, ev: string, n: number) => history ? history.map((event, index) => event.step === step && event.event === ev ? index : -1).filter(index => index >= 0)[n] ?? -1 : -1;
  if (history) {
    const w1 = nth('write', 'done', 0);
    if (w1 >= 0) {
      history.splice(w1, 0, { time: history[w1]!.time, step: 'write', kind: 'ai', event: 'check failed', attempt: 1, feedback: 'slogan has 14 words; the limit is 10', resumed: true, usage: fakeUsage('ev-1/write/check1', 'claude', 4) });
      history[w1 + 1]!.resumes = 1;
    }
    const w2 = nth('write', 'done', 1);
    if (w2 >= 0) history.splice(w2, 0,
      { time: history[w2]!.time, step: 'write', kind: 'ai', event: 'check failed', attempt: 1, feedback: 'slogan repeats the word "fast"', resumed: true, usage: fakeUsage('ev-1/write/check2', 'claude', 3) },
      { time: history[w2]!.time, step: 'write', kind: 'ai', event: 'resume failed', error: 'claude exit 1: No conversation found with session ID 4cf7899b-54a8-4043-8590-be56b458b38e (mock)' });
    const j2 = nth('judge', 'done', 1), start = history[nth('judge', 'start', 1)];
    if (j2 >= 0 && start) {
      const binding = structuredClone(start.binding) as { skills?: { id: string; via?: string; fallback_reason?: string }[] } | undefined;
      for (const skill of binding?.skills ?? []) if (skill.id === 'asd-ste100') Object.assign(skill, { via: 'system', fallback_reason: 'claude did not load it natively' });
      history.splice(j2, 0, { time: history[j2]!.time, step: 'judge', kind: 'ai', event: 'native fallback', skills: ['asd-ste100'], via: 'system', binding });
      const done = history[j2 + 1]!;
      delete done.skills_loaded;
      Object.assign(done, { role_channel: 'append-file', skill_channel: 'system-file', denials: 1 });
    }
  }
}

/** Totals like the engine's status file: sums over every ai done/failed event. */
function totalsOf(status: Status): Totals {
  const out: Totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, ai_seconds: 0, steps: 0 };
  for (const event of (status.history ?? []) as HistoryEvent[]) {
    const usage = event.usage as Usage | undefined;
    if (!usage || (event.event !== 'done' && event.event !== 'failed' && event.event !== 'check failed')) continue;
    out.input_tokens! += usage.input_tokens ?? 0; out.output_tokens! += usage.output_tokens ?? 0;
    out.cache_read_tokens! += usage.cache_read_tokens ?? 0; out.cache_write_tokens! += usage.cache_write_tokens ?? 0;
    if (typeof usage.cost_usd === 'number') out.cost_usd = (out.cost_usd ?? 0) + usage.cost_usd;
    if (typeof event.seconds === 'number') out.ai_seconds! += event.seconds;
    if (event.event !== 'check failed') out.steps! += 1;
  }
  if (out.cost_usd !== null) out.cost_usd = Math.round(out.cost_usd! * 1e6) / 1e6;
  return out;
}

// ---------------------------------------------------------------- files (gate_files, outputs, /api/file)

const fileStore = new Map<string, { text: string; mtime: string }>();
const normal = (path: string) => path.replace(/\//g, '\\').toLowerCase();
function putFile(path: string, text: string) { fileStore.set(normal(path), { text, mtime: now() }); }

const outlineMd = (topic: string) => `# Outline: ${topic}

> Bản nháp outline để người duyệt xem **trước** khi viết đoạn văn.

## Ý chính

1. Tests catch bugs before users do
2. Tests make refactoring safe
   - đổi code lớn mà không sợ hỏng hành vi cũ
   - [x] có ví dụ refactor
   - [ ] thêm số liệu thời gian sửa lỗi
3. Tests document intended behavior

## Nguồn

| Nguồn | Loại | Tin cậy |
|---|---|:-:|
| \`README.md\` | project | cao |
| [Martin Fowler — Test Pyramid](https://martinfowler.com/bliki/TestPyramid.html) | web | trung bình |

---

Ghi chú: _chưa_ có phần về chi phí; xem ~~bản cũ~~ evidence.json.

\`\`\`python
def test_add():
    assert add(2, 3) == 5
\`\`\`
`;
const evidenceJson = JSON.stringify({ claims: [{ id: 'C1', text: 'Tests catch bugs before users do', source: 'README.md', verified: true },
  { id: 'C2', text: 'Refactoring is safer with tests', source: null, verified: false }], open_questions: ['Do we have bug-escape numbers?'] });

function gateFilesFor(name: string): string[] {
  const outline = `${STATE}\\out\\${name} - outline.md`, evidence = `${STATE}\\work\\${name}\\evidence.json`;
  putFile(outline, outlineMd(String(runs.get(name)?.status.args?.topic ?? 'why unit tests matter')));
  putFile(evidence, evidenceJson);
  return [outline, evidence];
}
// Every path a fixture wrote gets a small markdown body so the outputs tab can preview it.
for (const item of runs.values()) for (const event of (item.status.history ?? []) as HistoryEvent[])
  if (typeof event.path === 'string') putFile(event.path, `# ${event.step}\n\nĐầu ra của run **${item.status.run}** (workflow \`${item.status.workflow}\`).\n\n- bước: \`${event.step}\`\n- thời gian: ${event.time}\n\nĐây là nội dung mock; server thật trả file trên đĩa.\n`);
putFile(`${STATE}\\work\\or-1\\plan.json`, JSON.stringify({ parts: ['history', 'how it works', 'pitfalls'] }));
{ const or1 = runs.get('or-1'); if (or1?.status.history) { const plan = (or1.status.history as HistoryEvent[]).find(event => event.step === 'plan' && event.event === 'done'); if (plan) plan.path = `${STATE}\\work\\or-1\\plan.json`; } }

function fileInfo(step: string | null, path: string) {
  const file = fileStore.get(normal(path)), ext = path.toLowerCase().split('.').pop();
  return { step, path, rel: path.startsWith(ROOT) ? path.slice(ROOT.length + 1).replace(/\\/g, '/') : path, exists: !!file, size: file ? new TextEncoder().encode(file.text).length : null,
    mtime: file?.mtime ?? null, kind: ext === 'md' ? 'markdown' : ext === 'json' ? 'json' : 'text' };
}
function outputsOf(status: Status) {
  const found = new Map<string, string | null>();
  for (const event of (status.history ?? []) as HistoryEvent[]) {
    if (typeof event.path === 'string') found.set(event.path, event.step);
    for (const file of (event.gate_files as string[] | undefined) ?? []) found.set(file, event.step);
  }
  for (const file of status.gate_files ?? []) found.set(file, status.gate ?? status.step);
  return [...found].map(([path, step]) => fileInfo(step, path));
}

// ---------------------------------------------------------------- extra runs: waiting with gate files, cancelled

// A run waiting at a gate, built from ch-1 (chain: outline -> outline_ok gate -> expand -> paragraph).
{
  const base = runs.get('ch-1');
  if (base) {
    const history = (base.status.history ?? []).slice(0, 3) as HistoryEvent[];
    const status: Status = { ...structuredClone(base.status), run: 'ch-wait', status: 'waiting', step: 'outline_ok', gate: 'outline_ok', started: now(), updated: now(),
      question: 'Outline: Tests catch bugs before users do | Tests make refactoring safe | Tests document intended behavior. Write the paragraph?',
      history: history.map(event => ({ ...event, time: now() })), passed: [],
      locks: [{ until: 'outline_ok', reason: 'outline must be approved before the paragraph is written', paths: ['*/out/ch-wait*'], commands: [] }] };
    runs.set('ch-wait', { status, log: [...base.log.slice(0, 6), `${now().slice(11)} outline_ok     WAITING for the reviewer: ${status.question} -> langflow approve ch-wait`], busy: false });
    status.gate_files = gateFilesFor('ch-wait');
  }
}
// A run cancelled while its synthesize step ran, built from or-1.
{
  const base = runs.get('or-1');
  if (base) {
    const history = structuredClone(base.status.history ?? []) as HistoryEvent[], cut = history.findIndex(event => event.step === 'synthesize' && event.event === 'start');
    const kept = history.slice(0, cut + 1);
    kept.push({ time: kept.at(-1)!.time, step: 'synthesize', kind: 'ai', event: 'cut' }, { time: kept.at(-1)!.time, step: null, kind: 'run', event: 'cancelled', by: 'web:mock-user' });
    const status: Status = { ...structuredClone(base.status), run: 'or-cancel', status: 'cancelled', step: 'synthesize', gate: null, history: kept, updated: kept.at(-1)!.time };
    runs.set('or-cancel', { status, log: [...base.log.slice(0, 12), `${kept.at(-1)!.time.slice(11)} run            cancelled by web:mock-user`], busy: false });
  }
}

// Old runs for "Dọn run cũ": copies of fixtures, last updated N days ago (with keep 3 per workflow and 30 days, the
// preview lists ch-old-1..4 and ev-old-2; ev-old-4 is held by a job and lands under skipped).
{
  const old: [name: string, base: string, status: string, days: number][] = [
    ['ch-old-1', 'ch-1', 'done', 95], ['ch-old-2', 'ch-1', 'done', 64], ['ch-old-3', 'ch-1', 'failed', 41], ['ch-old-4', 'ch-1', 'done', 33], ['ch-old-5', 'ch-1', 'done', 12],
    ['ev-old-1', 'ev-1', 'rejected', 50], ['ev-old-2', 'ev-1', 'cancelled', 120], ['ev-old-3', 'ev-1', 'done', 80], ['ev-old-4', 'ev-1', 'failed', 200],
    ['rt-old-1', 'rt-1', 'done', 75], ['pa-old-1', 'pa-2', 'stopped', 60],
  ];
  for (const [name, baseName, status, days] of old) {
    const base = runs.get(baseName); if (!base) continue;
    const updated = stamp(new Date(Date.now() - days * 86400000)), started = stamp(new Date(Date.now() - days * 86400000 - 5 * 60000));
    runs.set(name, { status: { ...structuredClone(base.status), run: name, status, started, updated, gate: null, question: null, gate_files: null,
      step: status === 'done' ? null : base.status.step ?? null, error: status === 'failed' ? 'exit 1: mock failure of an old run' : null },
      log: [...base.log], busy: false, ...(name === 'ev-old-4' ? { held: 'a web job (continue) holds it' } : {}) });
  }
}

/** Sum of two usages, as view.add_usage. */
function sumUsage(a: Usage | null | undefined, b: Usage): Usage {
  const out: Usage = { ...(a ?? {}) };
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const) out[key] = (out[key] ?? 0) + (b[key] ?? 0);
  out.cost_usd = typeof b.cost_usd === 'number' ? (out.cost_usd ?? 0) + b.cost_usd : out.cost_usd ?? null;
  out.cost_source = out.cost_source ?? b.cost_source ?? null;
  return out;
}

/** view.step_states, ported (phase 2: usage summed per node, retries, guardrail rounds, cut/cancelled steps). */
function stepStates(st: Status): { states: Record<string, StepState>; info: Record<string, StepInfo> } {
  const states: Record<string, StepState> = {}, info: Record<string, StepInfo & Record<string, unknown>> = {}, workers: Record<string, Record<string, StepState>> = {};
  const spend = (d: StepInfo, h: HistoryEvent) => {
    if (h.usage) d.usage = sumUsage(d.usage, h.usage as Usage);
    if (h.event === 'retry') d.retries = (d.retries ?? 0) + 1;
    if (h.event === 'check failed') d.guardrail_rounds = (d.guardrail_rounds ?? 0) + 1;
  };
  for (const h of (st.history ?? []) as HistoryEvent[]) {
    const name = h.step, ev = h.event;
    if (!name) continue;
    const match = /^(.*)\[(\d+)\]$/.exec(name);
    if (match) {
      const w = (workers[`${match[1]}_worker`] ??= {});
      w[match[2]!] = ({ start: 'running', done: 'done', failed: 'failed', cut: 'cancelled' } as Record<string, StepState>)[ev] ?? w[match[2]!] ?? 'running';
      spend((info[`${match[1]}_worker`] ??= {}), h);
      continue;
    }
    const d = (info[name] ??= {});
    if (ev === 'start') {
      states[name] = 'running'; d.start = h.time;
      for (const key of ['role', 'skills', 'binding', 'binding_changes', 'role_mode', 'contract', 'role_channel', 'skill_mode', 'retry_mode', 'skill_channel', 'skills_loaded', 'resumes', 'native_fallback']) delete d[key];
    }
    else if (ev === 'native fallback') {
      // a native skill did not load: the step ran again with the fallback; the binding shows the new `via`
      if (h.binding) d.binding = h.binding;
      d.native_fallback = [...new Set([...(d.native_fallback ?? []), ...((h.skills as string[] | undefined) ?? [])])];
    }
    else if (['done', 'kept', 'approve'].includes(ev)) { states[name] = 'done'; d.end = h.time; d.start ??= h.time; }
    else if (ev === 'failed') { states[name] = 'failed'; d.end = h.time; d.error = h.error as string; }
    else if (ev === 'reject') { states[name] = 'rejected'; d.end = h.time; }
    else if (ev === 'cut' || ev === 'cancelled') { if (ev === 'cut' || !states[name] || states[name] === 'running' || states[name] === 'waiting') { states[name] = 'cancelled'; d.end = h.time; } }
    spend(d, h);
    for (const key of ['model', 'effort', 'seconds', 'session', 'hooks', 'path', 'transcript', 'note', 'by', 'attempt', 'feedback', 'route', 'round', 'passed', 'items', 'collected', 'decision',
      'role_channel', 'skill_channel', 'skills_loaded', 'resumes'])
      if (h[key] !== null && h[key] !== undefined) d[key] = h[key];
    // the binding fields come from the start event only (view.step_states)
    if (ev === 'start') for (const key of ['role', 'skills', 'binding', 'role_mode', 'contract', 'skill_mode', 'retry_mode'])
      if (h[key] !== null && h[key] !== undefined && h[key] !== '' && !(Array.isArray(h[key]) && !(h[key] as unknown[]).length)) d[key] = h[key];
  }
  for (const [node, ws] of Object.entries(workers)) {
    const values = Object.values(ws);
    states[node] = values.includes('failed') ? 'failed' : values.includes('cancelled') && st.status === 'cancelled' ? 'cancelled' : values.includes('running') || values.includes('cancelled') ? 'running' : 'done';
    (info[node] ??= {}).workers = `${values.filter(v => v === 'done').length}/${values.length} done`;
  }
  if (st.status === 'waiting' && st.gate) states[st.gate] = 'waiting';
  if (st.status === 'failed' && st.step && info[st.step]) states[st.step] = 'failed';
  if (st.status === 'cancelled') for (const [node, state] of Object.entries(states)) if (state === 'running' || state === 'waiting') states[node] = 'cancelled';
  return { states, info };
}

const ok = (body: unknown, status = 200) => ({ status, body });
const fail = (status: number, error: string) => ({ status, body: { error } });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function event(name: string, ev: Record<string, unknown>, fields: Partial<Status> = {}) {
  const item = runs.get(name)!, time = now();
  Object.assign(item.status, fields, { updated: time });
  item.status.history = [...(item.status.history ?? []), { time, ...ev } as HistoryEvent];
  item.log.push(`${time.slice(11)} ${String(ev.step ?? 'run').padEnd(14)} ${ev.kind} ${ev.event}`);
}
function say(name: string, step: string, text: string) { runs.get(name)!.log.push(`${now().slice(11)} ${step.padEnd(14)} ${text}`); }

/** A cancel request takes effect at the next check (the engine checks every second while an agent runs). */
function cancelled(name: string): boolean {
  const item = runs.get(name)!;
  if (!item.cancel) return false;
  item.cancel = false;
  if (item.status.step) event(name, { step: item.status.step, kind: 'ai', event: 'cut' });
  event(name, { step: null, kind: 'run', event: 'cancelled', by: 'web:mock-user' }, { status: 'cancelled' });
  say(name, 'run', 'cancelled: agent process tree stopped');
  item.busy = false;
  return true;
}

/** A simulated chain run: outline (3 s, one transient retry) -> gate with two files to review. */
async function simulateStart(name: string) {
  const item = runs.get(name)!; item.busy = true;
  event(name, { step: null, kind: 'run', event: 'start' });
  event(name, { step: 'outline', kind: 'ai', agent: 'claude', event: 'start', model: 'haiku', effort: 'low', binding: recordedBinding('chain', 'outline'), ...recordedModes('chain', 'outline').start }, { status: 'running', step: 'outline' });
  await wait(1200); if (cancelled(name)) return; say(name, 'outline', 'session 0000-mock model claude-haiku-5-5');
  event(name, { step: 'outline', kind: 'ai', event: 'retry', attempt: 1, wait: 1, error: 'API Error: 529 overloaded_error (mock)' });
  await wait(1200); if (cancelled(name)) return; say(name, 'outline', 'says: 1. Why it matters 2. How to start 3. What to avoid');
  await wait(800); if (cancelled(name)) return;
  event(name, { step: 'outline', kind: 'ai', event: 'done', seconds: 3.2, session: '0000-mock', transcript: 'C:/mock/transcript.jsonl', usage: fakeUsage(`${name}/outline`, 'claude', 3.2), ...recordedModes('chain', 'outline').done });
  const question = 'Outline: Why it matters | How to start | What to avoid. Write the paragraph?';
  say(name, 'outline_ok', `WAITING for the reviewer: ${question} -> langflow approve ${name}`);
  Object.assign(item.status, { status: 'waiting', step: 'outline_ok', gate: 'outline_ok', question, updated: now(), gate_files: gateFilesFor(name) });
  item.busy = false;
}
async function simulateAnswer(name: string, decision: string, note: string | null, by: string) {
  const item = runs.get(name)!; item.busy = true;
  event(name, { step: item.status.gate, kind: 'gate', event: decision, note, by, gate_files: item.status.gate_files ?? undefined },
    { status: 'running', gate: null, question: null, gate_files: null, passed: decision === 'approve' ? [...(item.status.passed ?? []), item.status.step!] : item.status.passed ?? [] });
  if (decision !== 'approve') { event(name, { step: null, kind: 'run', event: 'rejected' }, { status: 'rejected', step: null }); item.busy = false; return; }
  event(name, { step: 'expand', kind: 'ai', agent: 'claude', event: 'start', model: 'haiku', effort: 'low', binding: recordedBinding('chain', 'expand'), ...recordedModes('chain', 'expand').start }, { step: 'expand' });
  await wait(2500); if (cancelled(name)) return; say(name, 'expand', 'says: Unit tests matter because …');
  event(name, { step: 'expand', kind: 'ai', event: 'done', seconds: 2.6, session: '0001-mock', transcript: 'C:/mock/transcript2.jsonl', usage: fakeUsage(`${name}/expand`, 'claude', 2.6), ...recordedModes('chain', 'expand').done });
  const path = `${STATE}\\out\\${name} - paragraph.md`;
  putFile(path, '# Why unit tests matter\n\nUnit tests catch bugs **before** users do, make refactoring safe, and document how the code should behave.\n');
  event(name, { step: 'paragraph', kind: 'write', event: 'done', path }, { step: 'paragraph' });
  event(name, { step: null, kind: 'run', event: 'done' }, { status: 'done', step: null });
  item.busy = false;
}

const arg = (key: string, fields: Partial<ArgSpec> = {}): ArgSpec => ({ key, required: false, help: null, kind: 'text', default: null, choices: null, example: null, base: null, source: 'doc', ...fields });
const topicArg = arg('topic', { required: true, help: 'what to write about, one line', example: '"why unit tests matter"' });
/** Arg specs (GET /api/workflows → args, argspec.py) and last_args; client_report has every kind, like a real project's. */
const workflows: Workflow[] = [
  { name: 'chain', description: 'prompt chaining: outline, gate, expand', required: ['topic'], doc: 'Prompt chaining: outline -> gate (a person checks the outline) -> expand -> file.\n\n  langflow start chain <run> topic="why unit tests matter" [max_points=3 outline points]',
    args: [topicArg, arg('max_points', { kind: 'number', default: '3', help: 'outline points' })],
    last_args: { run: 'ch-1', updated: '2026-11-18 09:12:00', args: { topic: 'why unit tests matter', 'model.expand': 'sonnet' } } },
  { name: 'client_report', description: 'Client report: draft from the request and sources, review, cover email', required: ['area', 'name', 'request', 'sources', 'prev'],
    doc: "Client report (mock).\n\n  langflow start client_report <run> area=<folder under reports/documents> name=<base file name>\n      request=<file with the client's request, verbatim> sources=<path,path,...> prev=<last SENT doc of this kind> [cover=L2|L3|L4] [model=sonnet]",
    args: [
      arg('area', { required: true, kind: 'dir', help: 'folder under reports/documents', base: 'reports/documents' }),
      arg('name', { required: true, help: 'base file name', example: 'Sprint 9 Review Report' }),
      arg('request', { required: true, kind: 'path', help: "file with the client's request, verbatim" }),
      arg('sources', { required: true, kind: 'paths', help: 'path,path,...' }),
      arg('prev', { required: true, kind: 'path', help: 'last SENT doc of this kind' }),
      arg('cover', { kind: 'choice', choices: ['L2', 'L3', 'L4'], help: 'cover email level' }),
      arg('model', { default: 'sonnet' }),
      arg('max_rounds', { kind: 'number', default: '2', help: 'review rounds before the gate' }),
      arg('dry_run', { kind: 'bool', choices: ['true', 'false'], default: 'false' }),
    ],
    last_args: { run: 'client_report-20261117-1405', updated: '2026-11-17 14:31:00', args: { area: 'sprint9', name: 'Sprint 9 Review Report', request: 'inbox/request-1117.md',
      sources: 'data/chart_report/sprint9/summary.csv,reports/documents/sprint9/notes.md', prev: 'reports/documents/sprint8/Sprint 8 Review Report v3.docx', cover: 'L3', 'model.draft': 'opus' } } },
  { name: 'evaluator', description: 'evaluator-optimizer: write, judge, rewrite until it passes', required: ['topic'], doc: null, args: [topicArg] },
  { name: 'orchestrator', description: 'orchestrator-worker: plan parts, one worker per part (Send), synthesize', required: ['topic'], doc: null },
  { name: 'parallel', description: 'parallelization: pros, cons, risks in parallel (Claude and Codex), then merge', required: ['topic'], doc: null, args: [topicArg] },
  { name: 'revise', description: 'series memory: write, reviewer gate, remember across v1, v2, v3 runs', required: ['doc', 'topic'], doc: null,
    args: [arg('doc', { required: true, kind: 'path', help: 'the document to revise', example: 'docs/plan.md' }), topicArg] },
  { name: 'routing', description: 'routing: classify, then bug / question / feature branch', required: ['ticket'], doc: null,
    args: [arg('ticket', { required: true, help: 'the ticket text', example: '"login fails after update"' }), arg('lane', { kind: 'choice', choices: ['bug', 'question', 'feature'], help: 'skip the classifier' })] },
];

// ---------------------------------------------------------------- path suggestions (/api/paths): a small fake tree

const TREE = ['README.md', 'inbox/request-1117.md', 'inbox/request-1103.md', 'docs/plan.md', 'docs/notes.md',
  'reports/documents/sprint8/Sprint 8 Review Report v3.docx', 'reports/documents/sprint8/notes.md',
  'reports/documents/sprint9/notes.md', 'reports/documents/sprint9/drafts/outline.md', 'reports/documents/planning/Sprint 10 Planning.docx',
  'data/chart_report/sprint9/summary.csv', 'data/chart_report/sprint9/flow.png', 'data/chart_report/sprint8/summary.csv', '.git/config', '.env'];
const HIDDEN = /(^|\/)(\.git|\.env[^/]*|node_modules|__pycache__|\.venv)(\/|$)/i;
const outside = (path: string) => /^[A-Za-z]:|^\//.test(path) || path.split('/').includes('..');
/** Like argspec.suggest_paths: entries under base/<folder of prefix> starting with the rest; folders first, with "/". */
function suggestPaths(prefix: string, base: string, kind: string) {
  if (outside(base)) return fail(403, 'base is outside the project');
  const last = (prefix.replace(/\\/g, '/').split(/[,;]/).pop() ?? '').trimStart();
  if (outside(last)) return fail(403, 'path is outside the project');
  const cut = last.lastIndexOf('/'), folder = cut < 0 ? '' : last.slice(0, cut), start = last.slice(cut + 1).toLowerCase();
  const root = [base.replace(/\/+$/, ''), folder].filter(Boolean).join('/');
  const names = new Map<string, boolean>();
  for (const file of TREE) {
    if (HIDDEN.test(file) || (root && !file.startsWith(`${root}/`))) continue;
    const rest = root ? file.slice(root.length + 1) : file, slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    names.set(name, slash >= 0 || names.get(name) === true);
  }
  const entries = [...names].filter(([name, dir]) => name.toLowerCase().startsWith(start) && (kind !== 'dir' || dir))
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .map(([name, dir]) => ({ rel: `${folder ? `${folder}/` : ''}${name}${dir ? '/' : ''}`, dir }));
  return ok({ base, dir: folder, entries });
}
const graphOf = (workflow: string): Graph | undefined => withBindings([...runs.values()].find(item => item.status.workflow === workflow)?.status.graph, workflow);

const transcript = (step: string) => ({ step, agent: 'claude', path: `C:/mock/${step}.jsonl`, events: [
  { role: 'user', kind: 'prompt', text: `Give 3 short outline points for a one-paragraph explainer.\n\n## Workflow memory (this run)\n(empty)` },
  { role: 'assistant', kind: 'thinking', text: 'The user wants three points, max ten words each, JSON only.' },
  { role: 'assistant', kind: 'tool_use', text: 'Read README.md' },
  { role: 'tool', kind: 'tool_result', text: '# langflow demo\n\nA demo project for langflow workflows.' },
  { role: 'assistant', kind: 'text', text: '{"points": ["Tests catch bugs before users do", "Tests make refactoring safe", "Tests document intended behavior"]}' },
] });

// ---------------------------------------------------------------- memory (run and series), propose

function runMemory(item: Item): Record<string, MemoryEntry> {
  return item.memory ??= Object.fromEntries(((item.status.memory_recent ?? []) as MemoryEntry[]).filter(entry => entry.key && entry.scope !== 'series').map(entry => [entry.key!, { ...entry }]));
}
const seriesStore = new Map<string, MemoryEntry[]>();
function seriesMemory(workflow: string, series: string): MemoryEntry[] {
  const key = `${workflow}\u0000${series}`;
  if (!seriesStore.has(key)) seriesStore.set(key, [...runs.values()].filter(item => item.status.workflow === workflow && item.status.series === series)
    .flatMap(item => ((item.status.memory_recent ?? []) as MemoryEntry[]).filter(entry => entry.scope === 'series').map(entry => ({ ...entry }))));
  return seriesStore.get(key)!;
}
// rv-2's own (run-scoped) memory: two entries, so the run table has rows to edit next to the series ones.
{ const rv = runs.get('rv-2'); if (rv) rv.memory = {
  'draft-outline': { key: 'draft-outline', text: 'Three sentences: what it is, battery life, care. No brand name.', step: 'draft', run: 'rv-2', scope: 'run', time: rv.status.started ?? now() },
  'review-note': { key: 'review-note', text: 'Reviewer asked to mention the 10-day battery life.', step: 'review', run: 'rv-2', scope: 'run', time: rv.status.updated ?? now() } }; }

const propose = { enabled: true, fields: ['group', 'id', 'section', 'reason'], description: 'Tạo một đề xuất trong KB (kb.py store propose add); người duyệt KB xem lại, không có gì được áp dụng tự động. (mock: id "fail" làm lệnh lỗi)' };

// ---------------------------------------------------------------- stats

const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const seconds = (a?: string | null, b?: string | null) => a && b ? (new Date(b.replace(' ', 'T')).getTime() - new Date(a.replace(' ', 'T')).getTime()) / 1000 : NaN;
const tokens = (usage?: Usage | null) => usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0) : 0;
function statsOf(workflow: string) {
  const list = [...runs.values()].map(item => item.status).filter(status => status.workflow === workflow);
  const byStatus: Record<string, number> = {}, gates = new Map<string, { approve: number; reject: number }>(), series = new Map<string, number>();
  const steps = new Map<string, { kind: string; runs: number; sec: number[]; tok: number[]; cost: number | null; guard: number }>();
  let cost: number | null = null, total = 0, guard = 0, retries = 0; const durations: number[] = [];
  for (const status of list) {
    byStatus[status.status] = (byStatus[status.status] ?? 0) + 1;
    if (status.series) series.set(status.series, (series.get(status.series) ?? 0) + 1);
    if (!['running', 'waiting'].includes(status.status)) { const s = seconds(status.started, status.updated); if (!Number.isNaN(s)) durations.push(s); }
    const totals = totalsOf(status); total += tokens(totals as Usage); if (typeof totals.cost_usd === 'number') cost = (cost ?? 0) + totals.cost_usd;
    for (const h of (status.history ?? []) as HistoryEvent[]) {
      if (!h.step) continue;
      const node = /^(.*)\[\d+\]$/.exec(h.step)?.[1] ? `${/^(.*)\[\d+\]$/.exec(h.step)![1]}_worker` : h.step;
      if (h.kind === 'gate' && (h.event === 'approve' || h.event === 'reject')) { const g = gates.get(node) ?? { approve: 0, reject: 0 }; g[h.event]++; gates.set(node, g); }
      if (h.event === 'check failed') guard++;
      if (h.event === 'retry') retries++;
      const s = steps.get(node) ?? { kind: h.kind, runs: 0, sec: [], tok: [], cost: null, guard: 0 };
      if (h.event === 'done' || h.event === 'kept' || h.event === 'approve') s.runs++;
      if (typeof h.seconds === 'number') s.sec.push(h.seconds);
      const usage = h.usage as Usage | undefined;
      if (usage && h.event !== 'check failed') { s.tok.push(tokens(usage)); if (typeof usage.cost_usd === 'number') s.cost = (s.cost ?? 0) + usage.cost_usd; }
      if (h.event === 'check failed') s.guard++;
      steps.set(node, s);
    }
  }
  return { workflow, runs: list.length, by_status: byStatus, median_seconds: median(durations), total_cost_usd: cost === null ? null : Math.round(cost * 1e4) / 1e4, total_tokens: total,
    guardrail_rounds: guard, transient_retries: retries,
    gates: [...gates].map(([gate, g]) => ({ gate, ...g, reject_rate: g.approve + g.reject ? g.reject / (g.approve + g.reject) : null })),
    series: [...series].map(([name, count]) => ({ series: name, runs: count })),
    steps: [...steps].filter(([, s]) => s.runs || s.guard).map(([step, s]) => ({ step, kind: s.kind, runs: s.runs, median_seconds: median(s.sec), median_tokens: median(s.tok), total_cost_usd: s.cost, guardrail_rounds: s.guard })) };
}

// ---------------------------------------------------------------- schedules

const schedules: Schedule[] = [
  { name: 'morning-plan', schedule: 'Weekly', days: 'MON,TUE,WED,THU,FRI', time: '08:00', next_run: '2026-11-18 08:00:00', last_run: '2026-11-17 08:00:01', last_result: 0,
    command: null, args: ['start', 'chain', 'chain-{date}', 'topic=morning plan'] },
  { name: 'weekly-review', schedule: 'Weekly', days: 'FRI', time: '16:30', next_run: '2026-11-20 16:30:00', last_run: '2026-11-13 16:30:02', last_result: 1,
    command: null, args: ['start', 'evaluator', 'evaluator-{date}', 'topic=weekly review'] },
];

// ---------------------------------------------------------------- delete runs

const parseStamp = (text?: string | null) => text ? new Date(text.replace(' ', 'T')).getTime() : NaN;
/** Why a run cannot be deleted now (409), or null. */
function deleteBlock(item: Item, force: boolean): string | null {
  const name = item.status.run;
  if (item.status.status === 'running' || item.busy) return `run '${name}' is running; stop it first`;
  if (item.held) return `run '${name}' is busy: ${item.held}`;
  if (item.status.status === 'waiting' && !force) return `run '${name}' is waiting at gate ${item.status.gate ?? ''}; use force to delete it and drop the gate`;
  return null;
}
/** Remove one run like engine.delete_run: status/log/page files, runs/<run>/, checkpoints, OpenCode transcripts; outputs and series memory stay. */
function removeRun(item: Item) {
  const status = item.status, name = status.run;
  if (status.series) seriesMemory(status.workflow, status.series);  // series memory outlives the run
  const history = (status.history ?? []) as HistoryEvent[];
  const transcripts = history.filter(event => event.agent === 'opencode' && event.step).map(event => `.langflow/state/opencode/${name}/${event.step}.json`);
  const removed = [`.langflow/state/${name}.json`, `.langflow/state/${name}.log`, `.langflow/state/pages/${name}.md`, `.langflow/state/runs/${name}/`, ...new Set(transcripts)];
  const checkpoints = history.filter(event => event.event === 'done' || event.event === 'kept' || event.event === 'approve').length;
  const kept = outputsOf(status).filter(file => file.exists).map(file => file.rel);
  runs.delete(name);
  return { run: name, removed, checkpoints, kept_outputs: kept };
}
function prune(input: Record<string, unknown>, dryRun: boolean) {
  const days = input.days === undefined || input.days === null ? null : Number(input.days), keep = Number(input.keep ?? 0);
  const statuses = Array.isArray(input.statuses) ? (input.statuses as string[]) : ['done', 'cancelled', 'failed', 'rejected'];
  const workflow = typeof input.workflow === 'string' && input.workflow ? input.workflow : null;
  if (days !== null && (!Number.isInteger(days) || days < 0)) return fail(400, 'days must be a whole number >= 0');
  if (!Number.isInteger(keep) || keep < 0) return fail(400, 'keep must be a whole number >= 0');
  const all = [...runs.values()].filter(item => !workflow || item.status.workflow === workflow);
  const kept = new Set<string>(), byWorkflow = new Map<string, Item[]>();
  for (const item of all) byWorkflow.set(item.status.workflow, [...(byWorkflow.get(item.status.workflow) ?? []), item]);
  for (const list of byWorkflow.values()) list.sort((a, b) => (b.status.updated ?? '').localeCompare(a.status.updated ?? '')).slice(0, keep).forEach(item => kept.add(item.status.run));
  const cutoff = days === null ? null : Date.now() - days * 86400000;
  const matched = all.filter(item => !kept.has(item.status.run) && statuses.includes(item.status.status) && (cutoff === null || parseStamp(item.status.updated) < cutoff))
    .sort((a, b) => (a.status.updated ?? '').localeCompare(b.status.updated ?? ''));
  const candidates = matched.map(item => ({ run: item.status.run, workflow: item.status.workflow, status: item.status.status, updated: item.status.updated ?? null }));
  const skipped: { run: string; reason: string }[] = [], deleted: ReturnType<typeof removeRun>[] = [];
  for (const item of matched) {
    const block = deleteBlock(item, false);
    if (block) skipped.push({ run: item.status.run, reason: block });
    else if (!dryRun) deleted.push(removeRun(item));
  }
  return ok({ candidates, deleted, skipped });
}

// ---------------------------------------------------------------- routes

export const mockTransport: ApiTransport = async (endpoint, method, body) => {
  await wait(80);
  const url = new URL(endpoint, 'http://mock'), parts = url.pathname.replace(/^\/api\/?/, '').split('/').map(decodeURIComponent);
  const input = (body ?? {}) as Record<string, unknown>;
  if (parts[0] === 'project') return ok({ name: 'langflow demo (mock)', root: ROOT, approver: 'the reviewer', allow_agent_approval: true, version: '0.0.0-mock', user: 'mock-user' });
  { const routed = catalogMock(parts, method, body); if (routed) return routed; }
  if (parts[0] === 'workflows' && parts.length === 1) return ok(workflows);
  if (parts[0] === 'paths') return suggestPaths(url.searchParams.get('prefix') ?? '', url.searchParams.get('base') ?? '', url.searchParams.get('kind') ?? 'path');
  if (parts[0] === 'workflows' && parts[2] === 'graph') { const graph = graphOf(parts[1]!) ?? (workflows.some(item => item.name === parts[1]) ? graphOf('chain') : undefined); return graph ? ok(graph) : fail(404, `no workflow '${parts[1]}'`); }
  if (parts[0] === 'stats') {
    const only = url.searchParams.get('workflow'), names = [...new Set([...runs.values()].map(item => item.status.workflow))].sort();
    return ok({ workflows: (only ? names.filter(name => name === only) : names).map(statsOf) });
  }
  if (parts[0] === 'file') {
    const raw = url.searchParams.get('path') ?? '';
    if (!raw) return fail(400, "query parameter 'path' is required");
    const path = /^[a-z]:[\\/]/i.test(raw) ? raw : `${ROOT}\\${raw.replace(/\//g, '\\')}`;
    if (!normal(path).startsWith(normal(ROOT))) return fail(403, 'only files below the project root or the state dir are served');
    const file = fileStore.get(normal(path));
    if (!file) return fail(404, `no file ${raw}`);
    const info = fileInfo(null, path);
    return ok({ path, rel: info.rel, size: info.size, mtime: file.mtime, text: file.text, truncated: false, kind: info.kind });
  }
  if (parts[0] === 'memory' && parts[1] === 'propose') {
    if (method === 'GET') return ok(propose);
    const entries = (input.entries ?? []) as { key: string; text: string; scope: string; run?: string; step?: string }[], fields = (input.fields ?? {}) as Record<string, string>;
    if (!entries.length) return fail(400, 'entries is empty');
    const missing = propose.fields.filter(field => !fields[field]);
    if (missing.length) return fail(400, `missing fields: ${missing.join(', ')}`);
    await wait(600);
    const rows = entries.map(entry => `| ${entry.key} | ${entry.text.replace(/\|/g, '\\|')} | langflow run ${entry.run ?? '?'} · step ${entry.step ?? '?'} · ${entry.scope} |`).join('\n');
    if (fields.id === 'fail') return ok({ ok: false, exit: 2, output: `kb.py: error: group '${fields.group}' has no record ${fields.id}\n(mock)` });
    return ok({ ok: true, exit: 0, output: `$ python tools/kb/kb.py store --group ${fields.group} propose add ${fields.id} --section ${fields.section} --text-file <tmp> --reason "${fields.reason}" --actor langflow\nproposal P-0042 created (${entries.length} row(s)); review with: kb.py store proposals\n\n${rows}\n(mock)` });
  }
  if (parts[0] === 'memory' && parts[1] === 'series' && (method === 'PUT' || method === 'DELETE')) {
    const workflow = String(input.workflow ?? ''), series = String(input.series ?? ''), key = String(input.key ?? '');
    if (!workflow || !series || !key) return fail(400, 'workflow, series and key are required');
    const list = seriesMemory(workflow, series), index = list.findIndex(entry => entry.key === key);
    if (index < 0) return fail(404, `series ${workflow}/${series} has no key '${key}'`);
    if (method === 'DELETE') { list.splice(index, 1); return ok({ deleted: key }); }
    if (typeof input.text !== 'string' || !input.text.trim()) return fail(400, 'text is required');
    list[index] = { ...list[index]!, text: input.text, updated: now() };
    return ok(list[index]);
  }
  if (parts[0] === 'schedules') {
    if (parts.length === 1 && method === 'GET') return ok(schedules);
    if (parts.length === 1 && method === 'POST') {
      const name = String(input.name ?? ''), time = String(input.time ?? ''), days = String(input.days ?? 'DAILY'), args = (input.args ?? []) as string[];
      if (!/^[\w-]+$/.test(name)) return fail(400, `bad task name '${name}'`);
      if (!/^\d{2}:\d{2}$/.test(time)) return fail(400, `bad time '${time}' (HH:MM)`);
      if (schedules.some(item => item.name === name)) return fail(409, `task '${name}' already exists; remove it first`);
      if (args[0] !== 'start' || args.length < 3) return fail(400, 'args must start with: start <workflow> <run>');
      const task: Schedule = { name, schedule: days === 'DAILY' ? 'Daily' : 'Weekly', days: days === 'MON-FRI' ? 'MON,TUE,WED,THU,FRI' : days, time, next_run: `(mock) next ${time}`, last_run: null, last_result: null, command: null, args };
      schedules.push(task);
      return ok(task);
    }
    if (parts.length === 2 && method === 'DELETE') {
      const index = schedules.findIndex(item => item.name === parts[1]);
      if (index < 0) return fail(404, `no task '${parts[1]}'`);
      schedules.splice(index, 1);
      return ok({ removed: parts[1] });
    }
    return fail(404, 'not found');
  }
  if (parts[0] !== 'runs') return fail(404, 'not found');
  if (parts.length === 1 && method === 'GET') {
    const list = [...runs.values()].map(({ status, busy }) => ({ run: status.run, workflow: status.workflow, status: status.status, step: status.step ?? null, gate: status.gate ?? null,
      question: status.question ?? null, error: status.error ?? null, updated: status.updated ?? null, started: status.started ?? null, series: status.series ?? null, busy, totals: totalsOf(status) }));
    return ok(list.sort((a, b) => (b.started ?? '').localeCompare(a.started ?? '')));
  }
  if (parts.length === 1 && method === 'POST') {
    const workflow = String(input.workflow ?? ''), d = new Date(), p = (n: number) => String(n).padStart(2, '0');
    const name = String(input.run ?? '').replace('{date}', `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`).replace('{time}', `${p(d.getHours())}${p(d.getMinutes())}`);
    if (!name) return fail(400, 'run name missing');
    if (runs.has(name)) return fail(409, `run '${name}' already exists; runs are never reused, pick a new name`);
    const spec = workflows.find(item => item.name === workflow);
    if (!spec) return fail(404, `no workflow '${workflow}'`);
    const args = (input.args ?? {}) as Record<string, unknown>, missing = spec.required.filter(key => !(key in args));
    if (missing.length) return fail(400, `workflow '${workflow}' needs: ${missing.join(', ')}`);
    const graph = graphOf('chain')!;
    runs.set(name, { status: { run: name, workflow: 'chain', args, series: null, status: 'running', step: null, gate: null, started: now(), updated: now(), approver: 'the reviewer', passed: [], locks: [], graph, history: [] }, log: [], busy: true });
    void simulateStart(name);
    return ok({ started: name });
  }
  if (parts.length === 2 && parts[1] === 'prune' && method === 'POST') { await wait(400); return prune(input, input.dry_run === true); }
  const item = runs.get(parts[1]!);
  if (!item) return fail(404, `no run '${parts[1]}'`);
  if (parts.length === 2 && method === 'DELETE') {
    const block = deleteBlock(item, ['1', 'true'].includes(url.searchParams.get('force') ?? ''));
    if (block) return fail(409, block);
    await wait(300);
    return ok(removeRun(item));
  }
  const action = parts[2];
  if (!action) {
    const transcripts: Record<string, { path: string; agent: string | null }> = {}, agents: Record<string, string> = {};
    for (const h of item.status.history ?? []) {
      if (!h.step) continue;
      if (typeof h.agent === 'string') agents[h.step] = h.agent;
      if (typeof h.transcript === 'string') transcripts[h.step] = { path: h.transcript, agent: agents[h.step] ?? null };
    }
    return ok({ ...structuredClone(item.status), graph: withBindings(item.status.graph, item.status.workflow), ...stepStates(item.status), busy: item.busy, transcripts, job: null, totals: totalsOf(item.status), gate_files: item.status.gate_files ?? null });
  }
  if (action === 'log') {
    const text = item.log.map(line => `${line}\n`).join(''), bytes = new TextEncoder().encode(text);
    const offset = Number(url.searchParams.get('offset') ?? 0), rest = new TextDecoder().decode(bytes.slice(offset));
    return ok({ offset: bytes.length, lines: rest.split('\n').filter(Boolean).slice(-2000) });
  }
  if (action === 'memory' && parts.length === 3) {
    return ok({ run: runMemory(item), series: item.status.series ? seriesMemory(item.status.workflow, item.status.series) : [] });
  }
  if (action === 'memory' && parts.length === 4 && (method === 'PUT' || method === 'DELETE')) {
    if (item.busy) return fail(409, `run '${item.status.run}' is busy; edit its memory when the current step is done`);
    const memory = runMemory(item), key = parts[3]!;
    if (!memory[key]) return fail(404, `run '${item.status.run}' has no memory key '${key}'`);
    if (method === 'DELETE') { delete memory[key]; return ok({ deleted: key }); }
    if (typeof input.text !== 'string' || !input.text.trim()) return fail(400, 'text is required');
    memory[key] = { ...memory[key]!, text: input.text, updated: now() };
    return ok(memory[key]);
  }
  if (action === 'outputs') return ok(outputsOf(item.status));
  if (action === 'transcript') {
    const step = url.searchParams.get('step') ?? '', info = stepStates(item.status).info[step];
    const worker = (item.status.history ?? []).some(event => event.step === step && event.transcript);
    return info?.transcript || worker ? ok(transcript(step)) : fail(404, `step '${step}' has no transcript`);
  }
  if (action === 'cancel' && method === 'POST') {
    const status = item.status.status;
    if (status !== 'running' && status !== 'waiting') return fail(409, `run '${item.status.run}' is ${status}; only a running or waiting run can be stopped`);
    if (status === 'waiting' && !item.busy) {
      event(item.status.run, { step: null, kind: 'run', event: 'cancelled', by: 'web:mock-user' }, { status: 'cancelled', gate_files: null });
      return ok({ accepted: true });
    }
    item.cancel = true;
    if (!item.busy) cancelled(item.status.run);  // a fixture run "running" in another process: the flag ends it at once here
    return ok({ accepted: true });
  }
  if (action === 'answer' && method === 'POST') {
    if (item.busy) return fail(409, `run '${item.status.run}' is busy`);
    if (item.status.status !== 'waiting') return fail(409, `run '${item.status.run}' is not waiting at a gate (status: ${item.status.status})`);
    if (input.confirm !== item.status.run) return fail(400, 'confirm must equal the run name');
    if (input.decision !== 'approve' && input.decision !== 'reject') return fail(400, 'decision must be approve or reject');
    void simulateAnswer(item.status.run, input.decision, (input.note as string | null) ?? null, 'web:mock-user');
    return ok({ accepted: true });
  }
  if (action === 'continue' && method === 'POST') {
    if (item.busy || item.status.status === 'waiting') return fail(409, `run '${item.status.run}' is ${item.busy ? 'busy' : 'waiting at a gate; answer it instead'}`);
    event(item.status.run, { step: item.status.step, kind: 'run', event: 'continue' }, { status: 'running', error: null });
    item.busy = true;
    setTimeout(() => { event(item.status.run, { step: item.status.step, kind: 'script', event: 'failed', exit: 1 }, { status: 'failed', error: `${item.status.step} exit 1: still failing (mock)` }); item.busy = false; }, 2500);
    return ok({ started: item.status.run });
  }
  return fail(404, 'not found');
};
