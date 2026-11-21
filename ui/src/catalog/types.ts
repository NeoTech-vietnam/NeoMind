/**
 * Skills and roles (agent definitions) bound to workflow steps — langflow phase 2b
 * (server side: src/langflow/catalog.py, web.py).
 */

/** Where a skill was found: .langflow/skills, .agents/skills, .claude/skills, or a `[catalog] skill_dirs` folder. */
export type SkillSource = 'langflow' | 'agents' | 'claude' | 'config' | string;
/** Which file a role comes from: .claude/agents/<id>.md, .codex/agents/<id>.toml, .langflow/agents/<id>.md. */
export type RoleSourceName = 'claude' | 'codex' | 'langflow' | string;
/** The CLI an ai step runs. */
export type StepAgent = 'claude' | 'codex' | 'opencode' | string;

/** A workflow step that uses a skill or role (from the compiled workflows + bindings.toml). */
export type StepRef = { workflow: string; step: string };

/** GET /api/catalog → skills[]. `missing`: a step names this id but no SKILL.md exists (only id and used_by then). */
export type SkillEntry = {
  id: string; name?: string; description?: string; source?: SkillSource; path?: string; sha256?: string; size?: number;
  /** Companion files next to SKILL.md, relative to the project root. */
  files?: string[];
  /** Lower-priority copies of the same id (not used). */
  shadowed?: { source: SkillSource; path: string; sha256?: string }[];
  used_by?: StepRef[]; missing?: boolean;
};
/** GET /api/catalog/skill/{id}: the entry plus the SKILL.md text. */
export type SkillDetail = SkillEntry & { text: string };

/** One file of a role. Model, effort and tools apply only when the step's CLI reads its own source. */
export type RoleSource = {
  name?: string; description?: string; path: string; sha256?: string; size?: number;
  model?: string | null; effort?: string | null; tools?: string[] | null;
  /** Detail only: the whole file and the instructions part (Markdown body or developer_instructions). */
  text?: string; instructions?: string;
};
/** GET /api/catalog → roles[]. */
export type RoleEntry = {
  id: string; name?: string; description?: string; sources?: Partial<Record<RoleSourceName, RoleSource>>;
  used_by?: StepRef[]; missing?: boolean;
};
export type RoleDetail = RoleEntry & { sources: Partial<Record<RoleSourceName, RoleSource>> };

/** The project's [catalog] settings of config.toml over the built-in defaults: `skill_mode` (inject), `role_mode`
 *  (null = automatic), `contract` (true), `native_fallback` (system), `retry_mode` (fresh). */
export type Catalog = { skills: SkillEntry[]; roles: RoleEntry[]; warnings?: string[]; skill_mode?: SkillMode | string; role_mode?: RoleMode | null; contract?: boolean;
  native_fallback?: NativeFallback | string; retry_mode?: RetryMode | string };

/** How a step's role reaches its CLI (catalog.ROLE_MODES): "append" = the CLI's system / developer channel
 *  (Claude --append-system-prompt-file, Codex developer_instructions), "agent" = Claude runs the role as its main
 *  agent (--agent, needs .claude/agents/<id>.md), "prompt" = the role text before the step prompt. */
export type RoleMode = 'append' | 'agent' | 'prompt';
export const ROLE_MODES: RoleMode[] = ['append', 'agent', 'prompt'];

/** How a step's skills reach the model (catalog.SKILL_MODES): "inject" = SKILL.md in the user prompt, "system" = in
 *  the CLI's system channel (Claude system file, Codex developer_instructions; else inject), "native" = the CLI loads
 *  its own copy (Claude Skill tool, Codex $mention, OpenCode attachment; checked after the call, else native_fallback),
 *  "name" = only the id. */
export type SkillMode = 'inject' | 'system' | 'native' | 'name';
export const SKILL_MODES: SkillMode[] = ['inject', 'system', 'native', 'name'];
/** What a "native" skill becomes when the CLI cannot load it (catalog.FALLBACKS); "fail" stops the step. */
export type NativeFallback = 'system' | 'inject' | 'fail';
export const NATIVE_FALLBACKS: NativeFallback[] = ['system', 'inject', 'fail'];
/** A guardrail retry: "fresh" = a new call with the whole prompt, "resume" = the same CLI session, only the check's
 *  feedback (catalog.RESUMABLE). */
export type RetryMode = 'fresh' | 'resume';
export const RETRY_MODES: RetryMode[] = ['fresh', 'resume'];
/** CLIs per capability: catalog.SYSTEM_SKILL_CLIS, NATIVE_SKILL_CLIS, RESUMABLE, and the CLIs modes() lets keep a
 *  role_mode append / agent (OpenCode: agent = the instance agent lf-role, append = [agents.opencode] role_channel). */
export const SYSTEM_SKILL_CLIS = ['claude', 'codex'];
export const NATIVE_SKILL_CLIS = ['claude', 'codex', 'opencode'];
export const RESUMABLE = ['claude', 'codex', 'opencode'];
export const ROLE_SYSTEM_CLIS = ['claude', 'codex', 'opencode'];
/** The folder each CLI loads its own skill copies from (catalog.CLI_SKILL_DIRS); other CLIs load the catalog copy. */
export const CLI_SKILL_DIRS: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills' };

/** A step's role and skills; `role: null` = none. */
export type BindingValue = { role: string | null; skills: string[] };
/** The mode keys (catalog.MODE_KEYS) as `ai(...)` or bindings.toml set them; absent = not set there. */
export type BindingModes = { role_mode?: RoleMode; contract?: boolean; skill_mode?: SkillMode; native_fallback?: NativeFallback; retry_mode?: RetryMode };
export const MODE_KEYS = ['role_mode', 'contract', 'skill_mode', 'native_fallback', 'retry_mode'] as const;
export type ModeKey = typeof MODE_KEYS[number];
/** One `[<workflow>.<step>]` table of .langflow/bindings.toml. `role: ""` = no role; `skills` replaces, `skills_add` appends. */
export type BindingOverride = { role?: string; skills?: string[]; skills_add?: string[] } & BindingModes;
export type BindingOrigin = 'code' | 'bindings' | 'run' | string;

/** The copy of a skill that the step's CLI loads by itself (catalog.cli_skill): Claude .claude/skills (a personal
 *  ~/.claude/skills copy wins), Codex .agents/skills (~/.agents, ~/.codex copies as `shadow`), others the catalog copy. */
export type SkillCli = { path: string; sha256: string; source: 'project' | 'personal' | 'catalog' | string; shadow?: { path: string; sha256: string }[] };
/** A resolved skill of a step (bindings effective.skills_detail): `via` = how it reaches the model (the skill_mode,
 *  or its fallback: then `fallback_reason` says why), `cli` = the CLI's own copy, or null when that CLI has none.
 *  Under via "native", path / sha256 are those of the copy the CLI loads. */
export type SkillUse = { id: string; via?: SkillMode | string; path: string; sha256: string; cli?: SkillCli | null; fallback_reason?: string };

export type EffectiveBinding = BindingValue & BindingModes & {
  from?: { role: BindingOrigin; skills: BindingOrigin } & Partial<Record<ModeKey, BindingOrigin>>;
  skills_detail?: SkillUse[];
};

/** Where a resolved mode came from: code / bindings.toml / run arg, then [catalog] in config.toml, then the default. */
export type ModeOrigin = BindingOrigin | 'config' | 'default';
/** catalog.modes(): how the step's binding reaches its CLI now. `role_mode` null = the step has no role.
 *  `explicit` false = the automatic default (adapters keep their old path). `note`: a mode the CLI cannot give was changed. */
export type StepModes = {
  role_mode: RoleMode | null; explicit: boolean; contract: boolean; contract_system: boolean; skill_mode: SkillMode | string;
  /** Phase 2 (absent on an older server). `retry_mode` is already "fresh" when the CLI cannot resume (with a note). */
  native_fallback?: NativeFallback | string; retry_mode?: RetryMode | string;
  from: { role_mode: ModeOrigin | null; contract: ModeOrigin; skill_mode?: ModeOrigin; native_fallback?: ModeOrigin; retry_mode?: ModeOrigin }; note?: string;
};

/** GET /api/workflows/{wf}/bindings → steps[]: one row per ai step (fan-out workers under the fan-out name). */
export type StepBindingRow = {
  step: string; agent?: StepAgent | null; code: BindingValue & BindingModes; override: BindingOverride | null; effective: EffectiveBinding;
  workflow?: string;
  /** The server's check of the effective binding (catalog.resolve): missing role / skill files for this CLI. */
  problems?: string[];
  /** catalog.step_detail: the resolved modes and the warnings (another skill copy, a personal shadow, a changed mode). */
  modes?: StepModes; warnings?: string[];
  /** A fan-out's workers (row under the fan-out name): where the code binding comes from — `fanout(..., role=, skills=)`
   *  ("declared"), the worker function's `langflow_step` ("worker"), or one probe call of the worker ("probe"). */
  fanout?: 'declared' | 'worker' | 'probe' | string;
};
/** `defaults`: [catalog] of config.toml over the built-in defaults (catalog.DEFAULTS; role_mode null = automatic). */
export type WorkflowBindings = { workflow?: string; file?: string; steps: StepBindingRow[];
  defaults?: { role_mode: RoleMode | null; contract: boolean; contract_system?: boolean; skill_mode?: SkillMode; native_fallback?: NativeFallback; retry_mode?: RetryMode } };

/** PUT /api/workflows/{wf}/bindings/{step} body. A key that is null or absent keeps the code value. */
export type BindingPut = { role?: string | null; skills?: string[] | null; skills_add?: string[]; role_mode?: RoleMode | null; contract?: boolean | null;
  skill_mode?: SkillMode | null; native_fallback?: NativeFallback | null; retry_mode?: RetryMode | null };

/** How the role reached the model in a run (`role_channel` on the done event): agent = Claude --agent / OpenCode
 *  instance agent lf-role, append = --append-system-prompt, append-file = --append-system-prompt-file,
 *  developer_instructions = Codex -c, instructions = OpenCode session instruction entry, prompt = before the prompt. */
export type RoleChannel = 'agent' | 'append' | 'append-file' | 'prompt' | 'developer_instructions' | 'instructions' | string;

/** What a run recorded for an ai step (`binding` on its start event and in info[step]). `role.mode`: the resolved
 *  role_mode; per skill `via` (skill_mode) and `cli` only when the CLI's own copy differs from the file sent. */
export type RecordedBinding = {
  role: { id: string; source: RoleSourceName; path: string; sha256: string; native?: boolean; mode?: RoleMode | null } | null;
  skills: { id: string; path: string; sha256: string; via?: string; fallback_reason?: string; cli?: { path: string; sha256: string; source: string } }[];
};

/** Graph node fields the engine layout adds for ai steps (plan: "engine.layout nodes get role and skills"). */
export type NodeBinding = { role?: string | null | undefined; skills?: string[] | null | undefined };

export const SKILL_SOURCE_LABEL: Record<string, string> = {
  langflow: '.langflow/skills', agents: '.agents/skills', claude: '.claude/skills', config: 'skill_dirs',
};
export const ROLE_SOURCE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', langflow: 'langflow' };
/** The role file each CLI reads, in priority order (catalog.py ROLE_ORDER). */
export const ROLE_ORDER: Record<string, RoleSourceName[]> = {
  claude: ['claude', 'langflow', 'codex'], codex: ['codex', 'langflow', 'claude'], opencode: ['langflow', 'claude', 'codex'],
};
export const DEFAULT_ROLE_ORDER: RoleSourceName[] = ['langflow', 'claude', 'codex'];

export const ROLE_MODE_LABEL: Record<string, string> = {
  append: 'system prompt của CLI (Claude --append-system-prompt-file, Codex developer_instructions)',
  agent: 'agent chính của Claude (--agent)',
  prompt: 'đưa vào prompt (trước câu lệnh của bước)',
};
export const ROLE_CHANNEL_LABEL: Record<string, string> = {
  agent: '--agent', append: '--append-system-prompt', 'append-file': '--append-system-prompt-file',
  developer_instructions: 'developer_instructions (-c)', instructions: 'session instructions (OpenCode)', prompt: 'trong prompt',
};
/** role_channel label for a CLI (OpenCode "agent" = its instance agent lf-role, not --agent). */
export const roleChannelLabel = (channel: string, agent?: string | null) => agent === 'opencode' && channel === 'agent' ? 'agent lf-role' : ROLE_CHANNEL_LABEL[channel] ?? channel;
export const SKILL_MODE_LABEL: Record<string, string> = {
  inject: 'langflow đưa cả SKILL.md vào prompt',
  system: 'SKILL.md vào kênh system của CLI (Claude: file system prompt, Codex: developer_instructions)',
  native: 'CLI tự nạp bản của nó (Claude: Skill tool, Codex: $mention, OpenCode: attachment); kiểm tra sau lần gọi',
  name: 'chỉ đưa tên skill; CLI tự nạp bản của nó',
};
export const FALLBACK_LABEL: Record<string, string> = {
  system: 'skill native không nạp được → kênh system (inject nếu CLI không có kênh system)',
  inject: 'skill native không nạp được → đưa vào prompt', fail: 'skill native không nạp được → bước lỗi',
};
export const RETRY_MODE_LABEL: Record<string, string> = {
  fresh: 'lần sửa theo check là một lần gọi mới với cả prompt',
  resume: 'lần sửa theo check tiếp tục session cũ, chỉ gửi phản hồi của check',
};
/** `skill_channel` on the done event (Claude / Codex adapters); parts joined by "+". */
const SKILL_CHANNEL_PART: Record<string, string> = {
  'system-file': 'file system prompt', developer_instructions: 'developer_instructions (-c)', prompt: 'trong prompt',
  'native-tool': 'Skill tool', 'native-preload': 'agent preload', 'native-mention': '$mention',
};
export const skillChannelLabel = (channel: string) => channel.split('+').map(part => SKILL_CHANNEL_PART[part] ?? part).join(' + ');
export const MODE_ORIGIN_LABEL: Record<string, string> = {
  code: 'code', bindings: 'bindings.toml', run: 'tham số run', config: 'config.toml [catalog]', default: 'tự động',
};
