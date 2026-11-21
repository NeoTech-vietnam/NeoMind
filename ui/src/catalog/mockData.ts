/**
 * Mock of the phase 2b endpoints for `npm run dev` with `?mock` (wired from mock/mock.ts; dev builds only).
 * A small catalog (skills in three folders, one shadowed copy, roles with Claude / Codex / langflow files), code
 * bindings on the demo workflows, an in-memory bindings.toml, and recorded run bindings where one skill changed after
 * the run (to show "đã đổi từ lúc chạy") and one role is missing (danger chip).
 *
 * Native phase 1 (role_mode / contract / per-CLI skill copies, catalog.modes / cli_skill / skill_notes): revise.draft
 * sets role_mode "append" in code, orchestrator.synthesize turns the contract off in code, bindings.toml asks
 * parallel.cons (Codex) for role_mode "agent" (→ append, with a note). Claude loads an older .claude/skills copy of
 * project-kb and a personal ~/.claude/skills copy of reasoning-router: both give warnings.
 *
 * Phase 2 (skill_mode / native_fallback / retry_mode, catalog.skill_via / modes): evaluator.write asks for
 * skill_mode native + retry_mode resume in code, but humanizer lives only in .agents/skills, so Claude has no copy of
 * its own → system with a fallback_reason; evaluator.judge is native in code (asd-ste100 has a .claude/skills copy).
 * bindings.toml sets opencode_smoke.look to role_mode agent (OpenCode keeps it now: instance agent lf-role),
 * skill_mode system (→ inject, OpenCode has no system channel) and retry_mode resume (OpenCode can resume).
 * parallel.merge is native in code and loads (skills_loaded, a ✓ on the run's skill chip).
 * A PUT of native_fallback "fail" on evaluator.write is refused with the server's 400 text.
 */
import type { ApiResult } from '../api';
import type {
  BindingModes, BindingOverride, BindingValue, Catalog, NativeFallback, RecordedBinding, RetryMode, RoleEntry, RoleMode, RoleSource, SkillCli, SkillEntry, SkillMode, SkillUse,
  StepBindingRow, StepModes, StepRef,
} from './types';
import { CLI_SKILL_DIRS, MODE_KEYS, NATIVE_FALLBACKS, NATIVE_SKILL_CLIS, RESUMABLE, RETRY_MODES, ROLE_MODES, ROLE_SYSTEM_CLIS, SKILL_MODES, SYSTEM_SKILL_CLIS } from './types';

/** Deterministic fake sha256 (64 hex chars) of a text. */
export function fakeSha(text: string): string {
  let out = '';
  for (let round = 0; out.length < 64; round++) {
    let hash = 2166136261 ^ round;
    for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}
const bytes = (text: string) => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------- skills

/** `personal`: a ~/.claude/skills/<id> copy (Claude loads it instead of the project's). */
type MockSkill = { id: string; source: string; folder: string; text: string; files?: string[]; shadowed?: { source: string; folder: string; text: string }[]; personal?: string };
const skillFiles: MockSkill[] = [
  { id: 'asd-ste100', source: 'claude', folder: '.claude/skills', files: ['.claude/skills/asd-ste100/rules.md', '.claude/skills/asd-ste100/dictionary.csv'], text: `---
name: asd-ste100
description: Rewrite text in ASD Simplified Technical English (STE100) so an agent or a reader cannot misread it.
---
# ASD-STE100 rewrite

Use when English text must be parsed without a human to resolve ambiguity.

## Rules
1. One instruction per sentence; **max 20 words** in a procedure sentence.
2. Use the active voice and the approved verbs (\`dictionary.csv\`).
3. Do not use \`-ing\` forms as nouns.

| Not approved | Approved |
|---|---|
| utilize | use |
| in order to | to |
` },
  { id: 'humanizer', source: 'agents', folder: '.agents/skills', text: `---
name: humanizer
description: Rewrite AI-sounding text so it reads naturally without changing what it says.
---
# Humanizer

- Remove inflated claims and sales language.
- Replace vague sources with the real source or delete the claim.
- Vary sentence structure; no stock AI words (*delve*, *leverage*, *robust*).
` },
  { id: 'project-kb', source: 'langflow', folder: '.langflow/skills', files: ['.langflow/skills/project-kb/lookup.md'], text: `---
name: project-kb
description: Look up the project knowledge base before asking or re-reading whole files.
---
# Project KB

Run \`python tools/kb/kb.py search "<words>"\` first; cite record IDs.
`, shadowed: [{ source: 'claude', folder: '.claude/skills', text: '---\nname: project-kb\ndescription: old copy\n---\nOld text.\n' }] },
  { id: 'no-ai-slop', source: 'claude', folder: '.claude/skills', text: `---
name: no-ai-slop
description: Edit drafts into sharper, more human writing while keeping the writer's voice.
---
# No AI slop

Cut filler. Say the claim, then the evidence.
` },
  { id: 'reasoning-router', source: 'claude', folder: '.claude/skills', text: `---
name: reasoning-router
description: Select the smallest useful reasoning method for technical analysis and decisions.
---
# Reasoning router

Pick one: direct answer, checklist, 5-whys, decision matrix, pre-mortem.
`, personal: '---\nname: reasoning-router\ndescription: my own variant\n---\nPersonal copy.\n' },
];

// ---------------------------------------------------------------- roles

type MockRole = { id: string; files: Partial<Record<'claude' | 'codex' | 'langflow', { text: string; model?: string | null; effort?: string | null; tools?: string[] | null; instructions: string }>> };
const md = (name: string, description: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
const writerBody = '# Report writer\n\nWrite sprint documents as .docx.\n\n- Follow the writing lessons in the KB.\n- Every number comes from a summary CSV; cite it.';
const reviewerBody = '# Report reviewer\n\nRead-only. Check content accuracy, format and the writing lessons. One line per finding.';
const codeReviewBody = '# Reviewer\n\nReview the diff for correctness, register-map consistency and safety. Severity-tag each finding; no praise.';
const roleFiles: MockRole[] = [
  { id: 'report-writer', files: {
    claude: { text: md('report-writer', 'Writes/edits sprint planning documents and reports as .docx.', writerBody, 'tools: Read, Write, Edit, Bash\nmodel: opus\n'), model: 'opus', tools: ['Read', 'Write', 'Edit', 'Bash'], instructions: writerBody },
    codex: { text: `name = "report-writer"\ndescription = "Writes sprint documents."\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = """\n${writerBody}\n"""\n`, model: 'gpt-5.5', effort: 'high', instructions: writerBody },
  } },
  { id: 'report-reviewer', files: {
    claude: { text: md('report-reviewer', 'Reviews documents for accuracy, format and writing lessons. Read-only.', reviewerBody, 'tools: Read, Grep, Bash\n'), tools: ['Read', 'Grep', 'Bash'], instructions: reviewerBody },
  } },
  { id: 'reviewer', files: {
    claude: { text: md('reviewer', 'Reviews firmware/tool diffs. Read-only.', codeReviewBody, 'tools: Read, Grep, Bash\nmodel: sonnet\n'), model: 'sonnet', tools: ['Read', 'Grep', 'Bash'], instructions: codeReviewBody },
    codex: { text: `name = "reviewer"\ndescription = "Reviews diffs."\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = """\n${codeReviewBody}\n"""\n`, effort: 'medium', instructions: codeReviewBody },
  } },
  { id: 'planner', files: {
    langflow: { text: md('planner', 'Breaks a topic into parts for orchestrator workers.', '# Planner\n\nReturn 3–5 parts, each answerable alone.'), instructions: '# Planner\n\nReturn 3–5 parts, each answerable alone.' },
  } },
];

// ---------------------------------------------------------------- code bindings of the demo workflows

/** `ai(..., role=, skills=, role_mode=, contract=)` as the demo workflows would write it; agent = the step's CLI. */
const codeBindings: Record<string, Record<string, { agent: string } & BindingValue & BindingModes>> = {
  chain: { outline: { agent: 'claude', role: 'planner', skills: [] }, expand: { agent: 'claude', role: 'report-writer', skills: ['asd-ste100', 'humanizer'] } },
  evaluator: { write: { agent: 'claude', role: 'report-writer', skills: ['humanizer'], skill_mode: 'native', retry_mode: 'resume' }, judge: { agent: 'claude', role: 'report-reviewer', skills: ['asd-ste100'], skill_mode: 'native' } },
  orchestrator: { plan: { agent: 'claude', role: 'planner', skills: ['reasoning-router'] }, research: { agent: 'claude', role: null, skills: ['project-kb'] }, synthesize: { agent: 'claude', role: 'report-writer', skills: [], contract: false } },
  parallel: { pros: { agent: 'claude', role: null, skills: [] }, cons: { agent: 'codex', role: 'reviewer', skills: [] }, risks: { agent: 'claude', role: 'reviewer', skills: ['reasoning-router'] }, merge: { agent: 'claude', role: 'report-writer', skills: ['no-ai-slop'], skill_mode: 'native' } },
  revise: { draft: { agent: 'claude', role: 'report-writer', skills: ['asd-ste100'], role_mode: 'append' } },
  routing: { classify: { agent: 'claude', role: null, skills: [] }, answer: { agent: 'claude', role: null, skills: ['project-kb'] }, bug_triage: { agent: 'claude', role: 'reviewer', skills: [] }, feature_spec: { agent: 'claude', role: 'report-writer', skills: [] } },
  opencode_smoke: { look: { agent: 'opencode', role: 'planner', skills: ['humanizer'] }, edit_in: { agent: 'opencode', role: null, skills: [] }, edit_out: { agent: 'opencode', role: null, skills: [] } },
};

/** Rows that stand for a fan-out's workers, and where their code binding comes from (catalog.fanout_meta). */
const FANOUTS: Record<string, Record<string, string>> = { orchestrator: { research: 'declared' } };

/** In-memory .langflow/bindings.toml; one override to start with so the "override" marker shows. */
const overrides: Record<string, Record<string, BindingOverride>> = { evaluator: { judge: { skills: ['asd-ste100', 'no-ai-slop'] } }, parallel: { cons: { role_mode: 'agent' } },
  opencode_smoke: { look: { role_mode: 'agent', skill_mode: 'system', retry_mode: 'resume' } } };

/** [catalog] of config.toml merged over the built-in defaults (web.py bindings `defaults`). */
const DEFAULTS = { role_mode: null as RoleMode | null, contract: true, contract_system: false, skill_mode: 'inject' as SkillMode, native_fallback: 'system' as NativeFallback, retry_mode: 'fresh' as RetryMode };

// ---------------------------------------------------------------- derived views

const skillPath = (s: { folder: string; id: string }) => `${s.folder}/${s.id}/SKILL.md`;
const roleExt = { claude: '.md', codex: '.toml', langflow: '.md' } as const, roleDir = { claude: '.claude/agents', codex: '.codex/agents', langflow: '.langflow/agents' } as const;
const rolePath = (id: string, source: keyof typeof roleExt) => `${roleDir[source]}/${id}${roleExt[source]}`;

function effective(workflow: string, step: string): StepBindingRow['effective'] {
  const code = codeBindings[workflow]?.[step], override = overrides[workflow]?.[step];
  let role = code?.role ?? null, skills = [...(code?.skills ?? [])];
  const from: NonNullable<StepBindingRow['effective']['from']> = { role: 'code', skills: 'code' }, extra: Record<string, unknown> = {};
  for (const key of MODE_KEYS) if (code?.[key] !== undefined) { extra[key] = code[key]; from[key] = 'code'; }
  if (override?.role !== undefined) { role = override.role || null; from.role = 'bindings'; }
  if (override?.skills) { skills = [...override.skills]; from.skills = 'bindings'; }
  if (override?.skills_add?.length) { skills = [...skills, ...override.skills_add.filter(id => !skills.includes(id))]; from.skills = 'bindings'; }
  for (const key of MODE_KEYS) if (override?.[key] !== undefined) { extra[key] = override[key]; from[key] = 'bindings'; }
  return { role, skills, ...(extra as BindingModes), from };
}

// ---------------------------------------------------------------- native phase 1: modes and CLI skill copies

/** catalog.pick_source for the mock roles. */
function roleSource(roleId: string | null, agent: string): 'claude' | 'codex' | 'langflow' | null {
  const r = roleId ? roleFiles.find(item => item.id === roleId) : undefined;
  if (!r) return null;
  const order = ({ claude: ['claude', 'langflow', 'codex'], codex: ['codex', 'langflow', 'claude'] } as Record<string, string[]>)[agent] ?? ['langflow', 'claude', 'codex'];
  return (order.find(name => r.files[name as keyof MockRole['files']]) as 'claude' | 'codex' | 'langflow' | undefined) ?? null;
}
/** catalog._pick: effective (code / bindings / run), then [catalog] (DEFAULTS stands for config + built-in here). */
function pick<K extends 'contract' | 'skill_mode' | 'native_fallback' | 'retry_mode'>(eff: StepBindingRow['effective'], key: K): [NonNullable<StepBindingRow['effective'][K]>, string] {
  const value = eff[key];
  return value !== undefined && value !== null ? [value as NonNullable<StepBindingRow['effective'][K]>, eff.from?.[key] ?? 'code'] : [DEFAULTS[key] as unknown as NonNullable<StepBindingRow['effective'][K]>, 'default'];
}
/** catalog.modes, ported (phase 2: skill_mode / native_fallback / retry_mode; Claude's automatic role_mode is append;
 *  OpenCode keeps agent and append). */
function modesOf(eff: StepBindingRow['effective'], agent: string): StepModes {
  let mode: RoleMode | null = eff.role_mode ?? DEFAULTS.role_mode, modeFrom: string | null = eff.role_mode ? eff.from?.role_mode ?? 'code' : DEFAULTS.role_mode ? 'config' : null;
  const notes: string[] = [];
  let explicit = mode !== null;
  const source = roleSource(eff.role, agent), native = source === agent;
  if (!eff.role || !source) { mode = null; explicit = false; modeFrom = null; }
  else if (mode === null) { mode = agent === 'claude' ? 'append' : 'prompt'; modeFrom = 'default'; }
  else if (mode === 'agent' && agent === 'claude' && !native) { mode = 'append'; notes.push(`role_mode agent needs .claude/agents/${eff.role}.md; append used`); }
  else if (mode === 'agent' && agent === 'codex') { mode = 'append'; notes.push('codex has no main-thread agent; append (developer_instructions) used'); }
  else if (mode !== 'prompt' && !ROLE_SYSTEM_CLIS.includes(agent)) { mode = 'prompt'; notes.push(`${agent} has no system channel for a role yet; prompt used`); }
  const [contract, contractFrom] = pick(eff, 'contract'), [skillMode, skillFrom] = pick(eff, 'skill_mode'), [fallback, fallbackFrom] = pick(eff, 'native_fallback');
  let [retry, retryFrom] = pick(eff, 'retry_mode');
  if (retry === 'resume' && !RESUMABLE.includes(agent)) { retry = 'fresh'; notes.push(`${agent} cannot resume a session (retry_mode resume); fresh retries used`); }
  return { role_mode: mode, explicit, contract, contract_system: DEFAULTS.contract_system, skill_mode: skillMode, native_fallback: fallback, retry_mode: retry,
    from: { role_mode: modeFrom, contract: contractFrom, skill_mode: skillFrom, native_fallback: fallbackFrom, retry_mode: retryFrom }, ...(notes.length ? { note: notes.join('; ') } : {}) };
}
/** catalog.skill_via, ported: [via, reason]; via "fail" = native impossible under native_fallback fail. */
function skillVia(agent: string, mode: string, cli: SkillCli | null, fallback: string, path: string): [string, string | null] {
  if (mode === 'system') return SYSTEM_SKILL_CLIS.includes(agent) ? ['system', null] : ['inject', `${agent} has no system channel for skills`];
  if (mode !== 'native') return [mode, null];
  let reason: string;
  if (!NATIVE_SKILL_CLIS.includes(agent)) reason = `${agent} cannot load skills by itself`;
  else if (!cli) reason = `${agent} does not read ${path}${CLI_SKILL_DIRS[agent] ? ` and has no ${CLI_SKILL_DIRS[agent]}/<id> copy` : ''}`;
  else return ['native', null];
  if (fallback === 'fail') return ['fail', reason];
  if (fallback === 'system' && !SYSTEM_SKILL_CLIS.includes(agent)) return ['inject', reason];
  return [fallback === 'inject' ? 'inject' : 'system', reason];
}
/** catalog.cli_skill: the copy the step's CLI loads by itself (Claude .claude/skills, a personal copy wins; Codex .agents/skills). */
function cliSkill(s: MockSkill, agent: string): SkillCli | null {
  const copies = [{ folder: s.folder, text: s.text }, ...(s.shadowed ?? [])];
  const dir = ({ claude: '.claude/skills', codex: '.agents/skills' } as Record<string, string>)[agent];
  if (!dir) return { path: skillPath(s), sha256: fakeSha(s.text), source: 'catalog', shadow: [] };
  const own = copies.find(copy => copy.folder === dir);
  const ownCli = own ? { path: skillPath({ folder: dir, id: s.id }), sha256: fakeSha(own.text) } : null;
  if (agent === 'claude' && s.personal) return { path: `~/.claude/skills/${s.id}/SKILL.md`, sha256: fakeSha(s.personal), source: 'personal', shadow: ownCli ? [ownCli] : [] };
  return ownCli ? { ...ownCli, source: 'project', shadow: [] } : null;
}
/** catalog.skill_notes for the mock. */
function skillNotes(agent: string, use: SkillUse, mode: string): string[] {
  const cli = use.cli, out: string[] = [];
  if (use.fallback_reason) out.push(`${use.id}: skill_mode ${mode} not possible (${use.fallback_reason}); ${use.via} used`);
  if (!cli) return out;
  if (cli.source === 'personal') out.push(`${use.id}: ${agent} loads the personal copy ${cli.path} #${cli.sha256.slice(0, 8)}${cli.shadow?.length ? `, not the project's ${cli.shadow[0]!.path}` : ''}`);
  else if (cli.sha256 !== use.sha256) out.push(`${use.id}: ${agent} loads ${cli.path} #${cli.sha256.slice(0, 8)}, the catalog's first copy (the text langflow sends) is ${use.path} #${use.sha256.slice(0, 8)}`);
  return out;
}
/** catalog.resolve for the skills: via per skill (skill_via), under native the CLI's copy; `problems` for "fail". */
function resolveSkills(ids: string[], agent: string, mode: string, fallback: string): { uses: SkillUse[]; problems: string[] } {
  const uses: SkillUse[] = [], problems: string[] = [];
  for (const id of ids) {
    const s = skillFiles.find(item => item.id === id);
    if (!s) continue;
    const cli = cliSkill(s, agent), path = skillPath(s), [via, reason] = skillVia(agent, mode, cli, fallback, path);
    if (via === 'fail') { problems.push(`skill ${id}: not native (${reason}) and native_fallback is "fail"`); continue; }
    const own = via === 'native' && cli && cli.path !== path ? { path: cli.path, sha256: cli.sha256 } : { path, sha256: fakeSha(s.text) };
    uses.push({ id, via, ...own, cli, ...(reason ? { fallback_reason: reason } : {}) });
  }
  return { uses, problems };
}

export function bindingRows(workflow: string): StepBindingRow[] {
  return Object.entries(codeBindings[workflow] ?? {}).map(([step, code]) => {
    const eff = effective(workflow, step), problems = [
      ...(eff.role && !roleFiles.some(r => r.id === eff.role) ? [`role ${eff.role}: no .claude/agents/${eff.role}.md, .codex/agents/${eff.role}.toml or .langflow/agents/${eff.role}.md`] : []),
      ...eff.skills.filter(id => !skillFiles.some(s => s.id === id)).map(id => `skill ${id}: not found in .langflow/skills, .agents/skills, .claude/skills`)];
    const modes = modesOf(eff, code.agent), { uses, problems: skillProblems } = resolveSkills(eff.skills, code.agent, modes.skill_mode, modes.native_fallback ?? 'system');
    problems.push(...skillProblems);
    const warnings = [...uses.flatMap(use => skillNotes(code.agent, use, modes.skill_mode)), ...(modes.note ? [modes.note] : [])];
    const { agent, ...codeValue } = code;
    return { workflow, step, agent, code: codeValue, override: overrides[workflow]?.[step] ?? null, effective: { ...eff, skills_detail: uses }, modes, warnings, problems,
      ...(FANOUTS[workflow]?.[step] ? { fanout: FANOUTS[workflow]![step]! } : {}) };
  });
}
/** role + skills for graph nodes (engine.layout adds them); the fan-out worker node carries its fan-out's binding. */
export function nodeBinding(workflow: string, node: string): BindingValue | null {
  const step = codeBindings[workflow]?.[node] ? node : node.replace(/_worker$/, '');
  if (!codeBindings[workflow]?.[step]) return null;
  const { role, skills } = effective(workflow, step);
  return { role, skills };
}

function usedBy(): { skills: Record<string, StepRef[]>; roles: Record<string, StepRef[]> } {
  const out = { skills: {} as Record<string, StepRef[]>, roles: {} as Record<string, StepRef[]> };
  for (const workflow of Object.keys(codeBindings)) for (const row of bindingRows(workflow)) {
    if (row.effective.role) (out.roles[row.effective.role] ??= []).push({ workflow, step: row.step });
    for (const id of row.effective.skills) (out.skills[id] ??= []).push({ workflow, step: row.step });
  }
  return out;
}

function skillEntry(s: MockSkill): SkillEntry {
  const meta = /description:\s*(.*)/.exec(s.text)?.[1] ?? '';
  return { id: s.id, name: s.id, description: meta, source: s.source, path: skillPath(s), sha256: fakeSha(s.text), size: bytes(s.text), files: s.files ?? [],
    shadowed: (s.shadowed ?? []).map(copy => ({ source: copy.source, path: skillPath({ folder: copy.folder, id: s.id }), sha256: fakeSha(copy.text) })) };
}
function roleEntry(r: MockRole, withText: boolean): RoleEntry {
  const sources: Partial<Record<string, RoleSource>> = {};
  let description = '';
  for (const [name, file] of Object.entries(r.files) as [keyof typeof roleExt, NonNullable<MockRole['files']['claude']>][]) {
    const desc = /description\s*[:=]\s*"?([^"\n]*)"?/.exec(file.text)?.[1] ?? '';
    description ||= desc;
    sources[name] = { name: r.id, description: desc, path: rolePath(r.id, name), sha256: fakeSha(file.text), size: bytes(file.text),
      model: file.model ?? null, effort: file.effort ?? null, tools: file.tools ?? null, ...(withText ? { text: file.text, instructions: file.instructions } : {}) };
  }
  return { id: r.id, name: r.id, description, sources };
}

export function catalog(): Catalog {
  const use = usedBy();
  const skills: SkillEntry[] = skillFiles.map(s => ({ ...skillEntry(s), used_by: use.skills[s.id] ?? [] }));
  const roles: RoleEntry[] = roleFiles.map(r => ({ ...roleEntry(r, false), used_by: use.roles[r.id] ?? [] }));
  for (const [id, refs] of Object.entries(use.skills)) if (!skillFiles.some(s => s.id === id)) skills.push({ id, missing: true, used_by: refs });
  for (const [id, refs] of Object.entries(use.roles)) if (!roleFiles.some(r => r.id === id)) roles.push({ id, missing: true, used_by: refs });
  return { skills: skills.sort((a, b) => a.id.localeCompare(b.id)), roles: roles.sort((a, b) => a.id.localeCompare(b.id)), skill_mode: DEFAULTS.skill_mode,
    role_mode: DEFAULTS.role_mode, contract: DEFAULTS.contract, native_fallback: DEFAULTS.native_fallback, retry_mode: DEFAULTS.retry_mode,
    warnings: ['.claude/skills/broken: no SKILL.md frontmatter (mock warning)'] };
}

// ---------------------------------------------------------------- what runs recorded

/**
 * `binding` for an ai step of a fixture run: its code binding, hashed as at run time. In `revise` the run used an
 * older asd-ste100 (hash differs now → "đã đổi từ lúc chạy"); in `routing` bug_triage used a role file since deleted.
 */
export function recordedBinding(workflow: string, step: string): RecordedBinding | null {
  const base = step.replace(/\[\d+\]$/, ''), code = codeBindings[workflow]?.[base];
  if (!code || (!code.role && !code.skills.length)) return null;
  const roleFile = code.role ? roleFiles.find(r => r.id === code.role) : undefined;
  const source = roleFile ? (['claude', 'langflow', 'codex'] as const).filter(name => roleFile.files[name]).sort((a, b) => Number(b === code.agent) - Number(a === code.agent))[0] : undefined;
  const role: RecordedBinding['role'] = workflow === 'routing' && base === 'bug_triage' ? { id: 'triager', source: 'claude', path: '.claude/agents/triager.md', sha256: fakeSha('triager v1'), native: true }
    : code.role && roleFile && source ? { id: code.role, source, path: rolePath(code.role, source), sha256: fakeSha(roleFile.files[source]!.text), native: source === code.agent } : null;
  const modes = codeModes(code), mode = role ? modes.role_mode : null;
  const skills = code.skills.map(id => {
    const s = skillFiles.find(item => item.id === id);
    const cli = s ? cliSkill(s, code.agent) : null;
    const [via, reason] = s ? skillVia(code.agent, modes.skill_mode, cli, modes.native_fallback ?? 'system', skillPath(s)) : ['inject', null];
    const text = s ? (workflow === 'revise' && id === 'asd-ste100' ? `${s.text}\n(older version)` : s.text) : id;
    // under native the run records the copy the CLI loaded
    const own = via === 'native' && cli ? { path: cli.path, sha256: cli.sha256 } : { path: s ? skillPath(s) : `.claude/skills/${id}/SKILL.md`, sha256: fakeSha(text) };
    // catalog.record keeps `cli` only when the CLI's own copy differs from the file sent
    return { id, ...own, via, ...(reason ? { fallback_reason: reason } : {}),
      ...(cli && (cli.path !== own.path || cli.sha256 !== own.sha256) ? { cli: { path: cli.path, sha256: cli.sha256, source: cli.source } } : {}) };
  });
  return { role: role ? { ...role, mode } : null, skills };
}

/**
 * What the start event (role_mode, contract) and the done event (role_channel) of a fixture ai step record
 * (engine.ai): the channel follows the mode and the CLI (Claude: agent → --agent, explicit append → the file,
 * automatic append → argv; Codex append → developer_instructions; others prompt).
 */
export function recordedModes(workflow: string, step: string): { start: { role_mode?: RoleMode | null; contract?: boolean; skill_mode?: string; retry_mode?: string };
  done: { role_channel?: string; skill_channel?: string; skills_loaded?: string[] } } {
  const base = step.replace(/\[\d+\]$/, ''), code = codeBindings[workflow]?.[base];
  if (!code || (!code.role && !code.skills.length)) return { start: {}, done: {} };
  const modes = codeModes(code);
  // OpenCode append goes before the prompt by default ([agents.opencode] role_channel = "prompt")
  // engine.ai done event: skill_channel from the Claude / Codex adapters, skills_loaded = the native skills proved loaded
  const { uses } = resolveSkills(code.skills, code.agent, modes.skill_mode, modes.native_fallback ?? 'system');
  // Claude: an automatic append goes on argv, unless system skills fill the system file (then the role goes there too)
  const channel = !modes.role_mode ? undefined : modes.role_mode === 'agent' ? 'agent' : modes.role_mode === 'prompt' ? 'prompt'
    : code.agent === 'codex' ? 'developer_instructions' : code.agent === 'opencode' ? 'prompt'
    : modes.explicit || uses.some(use => use.via === 'system') ? 'append-file' : 'append';
  const parts = [...new Set(uses.map(use => use.via))].flatMap(via => via === 'system' ? [code.agent === 'codex' ? 'developer_instructions' : 'system-file']
    : via === 'native' && code.agent !== 'opencode' ? [code.agent === 'codex' ? 'native-mention' : 'native-tool'] : []);
  const loaded = uses.filter(use => use.via === 'native').map(use => use.id);
  return { start: { role_mode: modes.role_mode, contract: modes.contract, ...(code.skills.length ? { skill_mode: modes.skill_mode } : {}), ...(modes.retry_mode !== 'fresh' ? { retry_mode: modes.retry_mode } : {}) },
    done: { ...(channel ? { role_channel: channel } : {}), ...(parts.length ? { skill_channel: parts.join('+') } : {}), ...(loaded.length ? { skills_loaded: loaded } : {}) } };
}
/** The modes of a step's code binding (fixture runs ran with the code values). */
function codeModes(code: { agent: string } & BindingValue & BindingModes): StepModes {
  const from: NonNullable<StepBindingRow['effective']['from']> = { role: 'code', skills: 'code' };
  for (const key of MODE_KEYS) if (code[key] !== undefined) from[key] = 'code';
  const { agent: _agent, ...value } = code;
  return modesOf({ ...value, from }, code.agent);
}

// ---------------------------------------------------------------- routes

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const fail = (status: number, error: string): ApiResult => ({ status, body: { error } });
const validId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

/** Handles the phase 2b routes; null for any other route. `parts`: the path after /api/, decoded. */
export function catalogMock(parts: string[], method: string, body: unknown): ApiResult | null {
  if (parts[0] === 'catalog' && parts.length === 1) return ok(catalog());
  if (parts[0] === 'catalog' && parts[1] === 'skill' && parts[2]) {
    const s = skillFiles.find(item => item.id === parts[2]);
    return s ? ok({ ...skillEntry(s), used_by: usedBy().skills[s.id] ?? [], text: s.text }) : fail(404, `no skill '${parts[2]}'`);
  }
  if (parts[0] === 'catalog' && parts[1] === 'role' && parts[2]) {
    const r = roleFiles.find(item => item.id === parts[2]);
    return r ? ok({ ...roleEntry(r, true), used_by: usedBy().roles[r.id] ?? [] }) : fail(404, `no role '${parts[2]}'`);
  }
  if (parts[0] === 'workflows' && parts[2] === 'bindings') {
    const workflow = parts[1]!, step = parts[3];
    if (!codeBindings[workflow]) return fail(404, `no workflow '${workflow}'`);
    if (!step && method === 'GET') return ok({ workflow, file: '.langflow/bindings.toml', steps: bindingRows(workflow), defaults: DEFAULTS });
    if (!step || !codeBindings[workflow][step]) return fail(404, `no ai step '${step}' in ${workflow}`);
    if (method === 'DELETE') { if (overrides[workflow]) delete overrides[workflow][step]; return ok({ workflow, file: '.langflow/bindings.toml', steps: bindingRows(workflow), defaults: DEFAULTS }); }
    if (method === 'PUT') {
      const input = (body ?? {}) as Record<string, unknown>, clean: BindingOverride = {};
      for (const key of Object.keys(input)) if (!['role', 'skills', 'skills_add', ...MODE_KEYS].includes(key)) return fail(400, `unknown keys ['${key}'] (allowed: role, skills, skills_add, ${MODE_KEYS.join(', ')})`);
      for (const key of Object.keys(input)) if (input[key] === null) delete input[key];  // null keeps the code value
      if (input.role_mode !== undefined) { if (!ROLE_MODES.includes(input.role_mode as RoleMode)) return fail(400, `[${workflow}.${step}]: role_mode must be one of ${ROLE_MODES.join(', ')}`); clean.role_mode = input.role_mode as RoleMode; }
      if (input.skill_mode !== undefined) { if (!SKILL_MODES.includes(input.skill_mode as SkillMode)) return fail(400, `[${workflow}.${step}]: skill_mode must be one of ${SKILL_MODES.join(', ')}`); clean.skill_mode = input.skill_mode as SkillMode; }
      if (input.native_fallback !== undefined) { if (!NATIVE_FALLBACKS.includes(input.native_fallback as NativeFallback)) return fail(400, `[${workflow}.${step}]: native_fallback must be one of ${NATIVE_FALLBACKS.join(', ')}`); clean.native_fallback = input.native_fallback as NativeFallback; }
      if (input.retry_mode !== undefined) { if (!RETRY_MODES.includes(input.retry_mode as RetryMode)) return fail(400, `[${workflow}.${step}]: retry_mode must be one of ${RETRY_MODES.join(', ')}`); clean.retry_mode = input.retry_mode as RetryMode; }
      if (input.contract !== undefined) { if (typeof input.contract !== 'boolean') return fail(400, `[${workflow}.${step}]: contract must be true or false`); clean.contract = input.contract; }
      if (input.role !== undefined) { if (typeof input.role !== 'string' || (input.role && !validId(input.role))) return fail(400, 'role must be a role id or "" (none)'); clean.role = input.role; }
      for (const key of ['skills', 'skills_add'] as const) if (input[key] !== undefined) {
        if (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(validId)) return fail(400, `${key} must be a list of skill ids`);
        clean[key] = [...new Set(input[key] as string[])];
      }
      if (!Object.keys(clean).length) { if (overrides[workflow]) delete overrides[workflow][step]; return ok({ workflow, file: '.langflow/bindings.toml', steps: bindingRows(workflow), defaults: DEFAULTS }); }
      const next = (() => { const saved = overrides[workflow]?.[step]; (overrides[workflow] ??= {})[step] = clean; const eff = effective(workflow, step);
        if (saved) overrides[workflow]![step] = saved; else delete overrides[workflow]![step]; return eff; })();
      const nextModes = modesOf(next, codeBindings[workflow][step].agent);
      const problems = [...(next.role && !roleFiles.some(r => r.id === next.role) ? [`role ${next.role}: not found`] : []),
        ...next.skills.filter(id => !skillFiles.some(item => item.id === id)).map(id => `skill ${id}: not found`),
        ...resolveSkills(next.skills, codeBindings[workflow][step].agent, nextModes.skill_mode, nextModes.native_fallback ?? 'system').problems];
      if (problems.length) return fail(400, problems.join('; '));
      (overrides[workflow] ??= {})[step] = clean;
      return ok({ workflow, file: '.langflow/bindings.toml', steps: bindingRows(workflow), defaults: DEFAULTS });
    }
  }
  return null;
}
