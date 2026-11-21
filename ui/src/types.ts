/** langflow's data as the web API returns it (server side: web.py; status file: engine.py, view.py). */

export type Project = { name: string; root: string; approver: string; allow_agent_approval: boolean; version: string; user?: string };
/** `error`: the workflow module failed to import (it cannot be started). */
export type Workflow = { name: string; description?: string | null; required: string[]; doc?: string | null; error?: string | null;
  /** What each run argument means (argspec.specs): required keys first, then optional ones from the docstring / ARGS. */
  args?: ArgSpec[];
  /** The args of the newest run of this workflow, to fill the form again. */
  last_args?: LastArgs | null };
export type ArgKind = 'text' | 'path' | 'paths' | 'dir' | 'choice' | 'number' | 'bool';
/** One run argument: `base` (from the project root) only scopes the path suggestions; the value is sent as typed. */
export type ArgSpec = { key: string; required: boolean; help?: string | null; kind: ArgKind | string; default?: string | null; choices?: string[] | null;
  example?: string | null; base?: string | null; source?: string };
export type LastArgs = { run: string; updated?: string | null; args: Record<string, unknown> };
/** GET /api/paths: entries under base/<folder of prefix>; `rel` is relative to base, folders end with "/". */
export type PathSuggestions = { base: string; dir: string; entries: { rel: string; dir: boolean }[] };

export type NodeKind = 'start' | 'end' | 'ai' | 'script' | 'write' | 'gate' | 'route' | 'loop' | 'fanout' | 'worker' | 'parallel' | 'join' | string;
/** Phase 2b: ai nodes (and a fan-out's `<name>_worker`) carry their effective `role` and `skills` (engine.layout). */
export type GraphNode = { id: string; kind: NodeKind; role?: string | null; skills?: string[] | null };
export type GraphEdge = { source: string; target: string; label: string | null; conditional: boolean };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Run status in the status file. */
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'rejected' | 'stopped' | 'cancelled' | string;
/** Step state from view.step_states. */
export type StepState = 'done' | 'running' | 'waiting' | 'failed' | 'rejected' | 'cancelled' | 'todo';

/** Usage of one ai step (phase-2 contract §1): `cost_source` "agent" (the CLI reported it), "pricing" (config) or null. */
export type Usage = {
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number;
  cost_usd?: number | null; cost_source?: 'agent' | 'pricing' | string | null;
};
/** Run totals the status file keeps after each ai step. */
export type Totals = {
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number;
  cost_usd?: number | null; ai_seconds?: number; steps?: number;
};

export type RunSummary = {
  run: string; workflow: string; status: RunStatus; step: string | null; gate: string | null; question: string | null;
  error: string | null; updated: string | null; started: string | null; series: string | null; busy: boolean;
  /** Run totals, when the server includes them in the list (cost chip). */
  totals?: Totals | null;
};

export type HistoryEvent = { time: string; step: string | null; kind: string; event: string; [key: string]: unknown };

/** Detail of one step (view.step_states), every field optional. */
export type StepInfo = {
  start?: string; end?: string; model?: string; effort?: string; seconds?: number; session?: string; hooks?: unknown;
  path?: string; transcript?: string; note?: string; by?: string; attempt?: number; feedback?: string; route?: string;
  round?: number; passed?: boolean; items?: number; collected?: number; decision?: string; error?: string; workers?: string; agent?: string;
  /** view.step_states sums usage over the node's events; counts transient retries and guardrail rounds. */
  usage?: Usage | null; attempts?: number;
  /** Phase 2b (view.step_states): what the step ran with ({role: {id, source, path, sha256, native}, skills: [{id, path, sha256}]}), also on its
   *  start event; `binding_changes`: files changed since (web.py run(), or a `binding changed` event on continue). */
  binding?: unknown; binding_changes?: string[] | null; role?: string | null; skills?: string[] | null; retries?: number; guardrail_rounds?: number; cancelled_by?: string | null;
  /** Native phase 1 (view.step_states): the resolved role_mode and contract (start event) and the channel the role
   *  really went through (`role_channel`, done event: agent | append | append-file | prompt | developer_instructions). */
  role_mode?: string | null; contract?: boolean | null; role_channel?: string | null;
  /** Phase 2 (view.step_states): `skill_mode` (start event, when the step has skills) and `retry_mode` (start event,
   *  only when not "fresh"); from the done event `skill_channel` (where system / native skills went: system-file,
   *  developer_instructions, native-tool, native-mention, …, joined by "+"), `skills_loaded` (native skills the
   *  adapter proved loaded) and `resumes` (resumed retry calls); `native_fallback`: skill ids that fell back at run
   *  time (`native fallback` events). `denials` is on the done event only (view does not copy it). */
  skill_mode?: string | null; retry_mode?: string | null; skill_channel?: string | null; skills_loaded?: string[] | null;
  resumes?: number | null; native_fallback?: string[] | null; denials?: number | null;
};

export type MemoryEntry = { key?: string; text: string; step?: string; run?: string; scope?: string; time?: string; updated?: string };
export type Lock = { until: string; reason: string; paths: string[]; commands: string[] };

export type RunDetail = {
  run: string; workflow: string; status: RunStatus; step: string | null; gate: string | null; question?: string | null;
  error?: string | null; updated?: string; started?: string; series?: string | null; approver?: string;
  args?: Record<string, unknown>; passed?: string[]; locks?: Lock[]; graph?: Graph; history?: HistoryEvent[];
  memory_recent?: MemoryEntry[]; states: Record<string, StepState>; info: Record<string, StepInfo>; busy: boolean;
  /** step (fan-out workers as "name[i]") -> its transcript file. */
  transcripts?: Record<string, { path: string; agent?: string | null }>;
  /** The server's last job for this run. */
  job?: Job | null;
  totals?: Totals | null;
  /** Absolute paths the waiting gate shows (`gate(show=...)`). */
  gate_files?: string[] | null;
};
export type Job = { action: 'start' | 'answer' | 'continue' | string; started: string; finished: string | null; state: string | null; message: string };

export type LogPage = { offset: number; lines: string[] };
export type RunMemory = { run: Record<string, MemoryEntry>; series: MemoryEntry[] };
export type TranscriptEvent = { role?: string; kind?: string; text?: string };
export type Transcript = { step: string; agent?: string | null; path?: string | null; events: TranscriptEvent[] };

/** GET /api/runs/{run}/outputs */
export type Output = { step: string | null; path: string; rel?: string | null; exists: boolean; size?: number | null; mtime?: string | number | null; kind?: string | null };
/** GET /api/file */
export type FileKind = 'markdown' | 'json' | 'text' | 'binary';
export type FileContent = { path: string; rel?: string | null; size: number; text: string | null; truncated: boolean; kind: FileKind };

/** GET /api/memory/propose */
export type ProposeConfig = { enabled: boolean; fields: string[]; description?: string | null };
/** POST /api/memory/propose */
export type ProposeResult = { ok: boolean; exit: number | null; output: string };

/** GET /api/stats */
export type GateStats = { gate: string; approve: number; reject: number; reject_rate: number | null };
export type StepStats = {
  step: string; kind: string; runs: number; median_seconds: number | null; median_tokens: number | null; total_cost_usd: number | null; guardrail_rounds: number;
};
export type WorkflowStats = {
  workflow: string; runs: number; by_status: Record<string, number>; median_seconds: number | null; total_cost_usd: number | null; total_tokens: number | null;
  guardrail_rounds: number; transient_retries: number; gates: GateStats[]; series: { series: string; runs: number }[]; steps: StepStats[];
};
export type Stats = { workflows: WorkflowStats[] };

/** GET /api/schedules (langflow.schedule.list_tasks) */
export type Schedule = {
  name: string; schedule?: string | null; days?: string[] | string | null; time?: string | null; next_run?: string | null; last_run?: string | null;
  last_result?: string | number | null; command?: string | null; args?: string[] | null;
};

/** DELETE /api/runs/{run}[?force=1]: what was removed; the run's outputs and its series memory stay. */
export type DeleteResult = { run: string; removed: string[]; checkpoints: number; kept_outputs: string[] };
/** POST /api/runs/prune */
export type PruneRequest = { days?: number; statuses?: string[]; keep?: number; workflow?: string; dry_run?: boolean };
export type PruneCandidate = { run: string; workflow: string; status: RunStatus; updated: string | null };
export type PruneResult = { candidates: PruneCandidate[]; deleted: DeleteResult[]; skipped: { run: string; reason: string }[] };
