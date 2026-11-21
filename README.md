# langflow

Fixed, gated workflows for coding agents, for any project. LangGraph keeps the order of the steps and the gates;
Claude Code (`claude -p`) and Codex (`codex exec`) do the work inside each step, with the project's own instructions,
skills and hooks (OpenCode too, isolated and guarded by session permission rules, see below); a person answers the
gates from their own terminal.

```
start ──> ai step (agent, JSON schema) ──> script step (deterministic check) ──> gate (person) ──> ...
           └ live log + live page            └ non-zero exit stops the run      └ langflow approve <run>
```

## Install (once per machine)

```
uv tool install --editable <path to this repo>
langflow --version
```

This puts `langflow` and `langflow-guard` on PATH (`~/.local/bin`). Full guide: [INSTALL.md](INSTALL.md)
(prerequisites, agent CLIs, project setup and hooks, web UI, Nimbalyst panel, timed runs, upgrade, troubleshooting).

## Use in a project

```
cd <project root>
langflow init            # .langflow/config.toml, .langflow/workflows/smoke.py, .langflow/checks/,
                         # the langflow-design skill in .claude/skills and .agents/skills
langflow hooks           # snippets for .claude/settings.json and .codex/hooks.json
langflow start smoke smoke-1
langflow approve smoke-1 # in your own terminal (PowerShell / Windows Terminal)
langflow ui              # or watch and drive every run from a terminal UI
langflow stop smoke-1    # cancel a run; `langflow continue smoke-1` re-runs the cut step
langflow check <wf> [key=value ...]   # role and skills of every ai step, whether their files exist, cost warnings
langflow guide           # how to design a workflow that spends few tokens (read before writing one)
langflow skills | roles  # the project's skills / agent definitions and the steps that use them
langflow graph <wf>      # Mermaid diagram of a workflow (.md in <state_dir>/graphs)
```

`langflow ui` (Textual): runs on the left, the selected run's steps in run order coloured by state, the gate question,
and the live log at the bottom. Keys: `a` approve, `r` reject (optional note, run name typed back), `c` continue a
failed or cancelled run, `x` stop the run (type its name), `g` open the gate's files, `t` open the selected step's
transcript, `p` open the live page (Mermaid), `l` open the log, `q` quit.
It needs a real console, like `approve`; a run answered from the UI goes on inside the UI process.

### Web UI

```
langflow web             # http://127.0.0.1:8765/ (--port N, --open opens the browser)
langflow web --api-only --port 0 --stdin-watch   # for the Nimbalyst extension (first stdout line below)
```

`langflow web` serves the built web app (`ui/` → `npm run build` → `src/langflow/webui/`) and a JSON API under
`/api` on 127.0.0.1 only. It shows the runs, each run's graph coloured by state, the live log, memory and step
transcripts (Claude, Codex, OpenCode), and it can start runs, answer gates and continue failed runs. Gates answered
here are logged as by `web:<user>` (`panel:<user>` from the Nimbalyst panel); this is allowed by design, unlike
`langflow approve` from an agent shell. Every API request needs the header `X-Langflow-Token`: a random token made at
start, given to the page in `<meta name="langflow-token">`. `--api-only` serves no page and prints
`LANGFLOW_WEB {"port": N, "token": "..."}` as its first stdout line; `--stdin-watch` stops the server when stdin closes.
Runs started or answered from the page go on inside the server process, one job per run at a time; Ctrl-C stops the
server and cuts off a running step (`langflow continue <run>` re-runs it).

| API | |
|---|---|
| `GET /api/project`, `/api/workflows`, `/api/workflows/<name>/graph` | project, workflows, a workflow's nodes and edges |
| `GET /api/runs`, `/api/runs/<run>` | run list (newest first, `busy`, `totals`); status file + `states`, `info` (with `usage` per ai step), `totals`, `gate_files`, `transcripts`, `job` |
| `GET /api/runs/<run>/log?offset=N`, `/memory`, `/transcript?step=<step>` | log lines after byte N; memory; transcript summary |
| `POST /api/runs` `{workflow, run, args}` | start a run (409 if it exists) |
| `POST /api/runs/<run>/answer` `{decision, note, confirm}` | answer the gate (`confirm` = run name; 409 if busy or not waiting) |
| `POST /api/runs/<run>/continue` | re-run the failed, cancelled or cut-off step (409 if waiting, done or busy) |
| `POST /api/runs/<run>/cancel` | stop the run (`engine.request_cancel`; 409 if done, rejected or cancelled) |
| `GET /api/runs/<run>/outputs` | files the run wrote (history `path`) or shows at its gate (`gate_files`): `[{step, path, rel, exists, size, mtime, kind}]` |
| `GET /api/file?path=<abs or rel>` | file preview `{path, rel, size, mtime, text, truncated, kind}`; kind markdown, json, text or binary; text capped at 512 kB |
| `PUT /api/runs/<run>/memory/<key>` `{text}`, `DELETE …/memory/<key>` | edit or delete a run memory key (URL-encode the key) |
| `PUT /api/memory/series` `{workflow, series, key, text}`, `DELETE` `{workflow, series, key}` | edit or delete a series memory entry |
| `GET /api/memory/propose`, `POST` `{entries: [{key, text, scope, run, step}], fields: {..}}` | propose entries to the project's knowledge base (below); `{enabled, fields, description}` / `{ok, exit, output, command}` |
| `GET /api/catalog` | `{skills, roles, warnings, skill_mode}`; each entry has `used_by: [{workflow, step}]`; ids a step uses but the project lacks come with `missing: true` |
| `GET /api/catalog/skill/{id}`, `/api/catalog/role/{id}` | the entry + `text` (SKILL.md), or per source `text` and `instructions` |
| `GET /api/workflows/{wf}/bindings` | `{workflow, file, defaults: {role_mode, contract}, steps: [{step, agent, code: {role, skills, role_mode?, contract?}, override, effective: {role, skills, role_mode?, contract?, from, skills_detail: [{id, via, path, sha256, cli}]}, modes: {role_mode, contract, from, …}, warnings, problems}]}` |
| `PUT /api/workflows/{wf}/bindings/{step}` | body `{role?, skills?, skills_add?, role_mode?, contract?}` (null = keep the code value; `""` / `[]` = none); writes `.langflow/bindings.toml`, keeps other tables and comments; 400 for an unknown role or skill or a bad mode; returns the GET shape |
| `DELETE /api/workflows/{wf}/bindings/{step}` | removes the override; returns the GET shape |
| `GET /api/stats?workflow=<name>` | per workflow (all when absent): runs by status, median time of done runs, cost, tokens, guardrail rounds, transient retries, reject rate per gate, series with run counts, per-step medians |
| `GET /api/schedules`, `POST` `{name, time: "HH:MM", days, args}`, `DELETE /api/schedules/<name>` | timed runs (`langflow.schedule`) |

Limits and rules:

- **File preview** serves only files below the project root or the state dir; `..`, network paths, `.git/`, `.env*`
  and key files are refused (403).
- **Run memory** is changed in the run's latest checkpoint (LangGraph `update_state`, as the node that wrote last, so
  the next step stays the same). Allowed when the run waits at a gate, failed, was cancelled or is done, or is
  `running` but its process is gone (cut off); refused (409) while a job or a live process runs it, and when the last
  checkpoint came from parallel branches (ambiguous).
  Each edit is a history event `{"kind": "memory", "event": "edited" | "deleted", "key", "by"}`.
- **Series memory** edits only an existing series (404 otherwise); the entry keeps its run and step and gets
  `edited_by`.
- **Schedules** from the web may only run `langflow start …` or `langflow continue …`; arguments must not hold
  `& | < > ^ % "` (they end up in a `cmd /c` line). Days: `DAILY`, `MON-FRI` or `MON,WED,FRI`; time `HH:MM`.
- **Tokens** in stats = input + output + cache read + cache write. Cost comes from the agent (`cost_source` "agent")
  or from `[pricing]` in config.toml; runs without usage count as 0 tokens and no cost. Median time counts done runs
  from start to their last event, gate waits included.

Propose to the knowledge base: langflow never applies anything itself. It writes the chosen entries to a temporary
markdown file (one row per entry) and runs the project's own command in the project root; the output is shown in the
page and every call is logged to `<state_dir>/propose.log`. Without `[memory.propose]` the dialog is hidden.

```toml
[memory.propose]
description = "File a KB proposal; it is reviewed with kb.py store review"
command = ["python", "tools/kb/kb.py", "store", "--group", "{group}", "propose", "add", "{id}",
           "--section", "{section}", "--text-file", "{text_file}", "--reason", "{reason}", "--actor", "langflow"]
fields = ["group", "id", "section", "reason"]   # asked in the dialog; one line each, not starting with "-"
row = "| {key} | {text} | {source} |"            # optional row template: {key} {text} {scope} {run} {step} {source}
```

### Designing for few tokens

[src/langflow/DESIGN.md](src/langflow/DESIGN.md) (`langflow guide`) holds the design rules: where the tokens of an
`ai` step go (every agent turn re-sends the context), and ten rules with a checklist (prepare the input in a script
step, read a shared source once, limit tools, choose model and effort per step, cheap guardrails with `retry_mode`
resume, pilot before a fan-out). Every project gets it three ways: the SessionStart hook of `langflow-guard` points
each agent session that is not itself a workflow step to `langflow guide` (agent steps run with `LANGFLOW_STEP=1`
and get no extra line); `langflow init` writes the `langflow-design` skill; and `langflow check <wf>` prints a
`cost:` line for the costly patterns it can see (guardrail retries in `fresh` mode, more than 2 retries, fan-out
workers with default tools or search tools, fan-out workers at effort high or on an Opus model, any step at xhigh
or max). Cost warnings never fail the check.

Tests: `"%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest discover -s tests -v` (script-only workflows, no
agent calls).

Project files:

| Path | What |
|---|---|
| `.langflow/config.toml` | approver, state dir, default models, how to check that the hooks ran |
| `.langflow/workflows/<name>.py` | one workflow: `META`, optional `REQUIRED`, `LOCKS`, and `steps(args)` |
| `.langflow/checks/` | helper modules the workflows import (lint scripts, renderers) |
| `.langflow/state/` | run state, `runs/<run>.log` (live log), `runs/<run>.md` (live page); keep out of git |

## Writing a workflow

```python
from langflow import ai, gate, script, write, current

META = {"description": "what it does"}
REQUIRED = ["topic"]                       # args the run must get: langflow start <wf> <run> topic=...
LOCKS = [{"until": "review_ok", "reason": "No release before review.",
          "paths": ["*/release/*"], "commands": ["make release"]}]

def steps(args):
    return [
        ai("draft", "Draft notes on {topic}.", SCHEMA, agent="claude", tools=["Read", "Grep"], check=my_lint),
        write("draft_file", lambda s, run: current().root / f"notes ({run}).md", lambda s: s["results"]["draft"]["text"]),
        gate("review_ok", "Notes ready. Release?"),
        script("release", ["make", "release"]),
    ]
```

Step kinds (`engine.py` has the full signatures):

| Step | Main options |
|---|---|
| `ai(name, prompt, schema, agent=...)` | `model`, `effort`, `tools`, `sandbox`; `check=fn` (guardrail, `retries` rounds); `transient=N` (retries of a rate limit / overload / network error, default `[retry] attempts` in config, `0` = none; each wait is a `retry` event and a cancel stops it); `memory=["run", "series"]`; `role=`, `skills=` (below) |
| `script(name, argv)` | non-zero exit stops the run; `timeout`; a cancel kills the process tree |
| `write(name, path, content)` | the runner writes the file from the state; `keep_existing=True` never overwrites a person's copy |
| `gate(name, question, show=...)` | waits for a person; `show` = files to read before answering (a path, a list, `{arg}` placeholders, or `fn(state)`), shown in the web UI, the panel, the TUI (`g`) and the live page |
| `fanout(name, items, worker, role=, skills=)` | see Patterns; `role=` / `skills=` (and `agent=`) declare the workers' binding so `check`, "used by" and the graph see it |

Stopping a run: `langflow stop <run>` (web **Dừng run**, TUI `x`). A running agent or script is killed within about a
second and the status becomes `cancelled`; a waiting gate is cancelled at once. `langflow continue <run>` re-runs the cut
step (a gate waits again). A gate answer and a stop at the same moment: the first one wins. A stop that comes first
refuses the answer ("was cancelled ... the answer was not applied"); an answer that comes first is recorded, then the run
stops before the next step.

Deleting runs: `langflow rm <run> [...] [--force] [--yes]` and `langflow prune [--days N] [--status ...] [--keep N]
[--workflow W] [--yes]` (without `--yes`, prune only lists). Web: **Xoá run** in the run view, select and **Xoá đã
chọn** or **Dọn run cũ** in the run list (`DELETE /api/runs/<run>[?force=1]`, `POST /api/runs/prune`). A delete removes
the run's state: status, log and live page, `runs/<run>/`, its checkpoints and its OpenCode transcript copies. It keeps
the files the run wrote and the series memory, so v2 of a report still sees what v1 learned. A running run is refused
(stop it first); a run waiting at a gate needs `--force` / `force=1`. Each delete is logged to `<state_dir>/deleted.log`.

Patterns (examples to run in `examples/demo`: `cd examples/demo; langflow start <name> <run> ...`):

| Pattern | Step | Demo |
|---|---|---|
| Prompt chaining | steps in order, `gate` between them | `chain` |
| Evaluator-optimizer | `loop(name, [generate, evaluate], until, max_rounds)`; or `ai(..., check=fn)` for a code check | `evaluator` |
| Routing | `route(name, decide, {"label": [steps], ...})` | `routing` |
| Parallelization | `parallel(name, [step or [steps], ...])`, then a merge step; the step after it runs once, when every branch is done (branches may differ in length) | `parallel` |
| Orchestrator-worker | `fanout(name, items, worker)`: one worker per item (LangGraph `Send`); results in `results["<name>_join"]`; `fanout(..., role=, skills=)` binds every worker | `orchestrator` |

Model and effort per step: `ai(..., model="haiku", effort="low")`; defaults per agent in config
(`[agents.claude] default_model`, `default_effort`). A run can override them without editing the workflow:
`langflow start <wf> <run> model.<step>=opus effort.<step>=high` (`model.*=` / `effort.*=` for every AI step; a
fan-out's workers use the fan-out name). Effort levels: low, medium, high, xhigh, max (Codex: max becomes xhigh).

Concurrency: a fan-out starts every worker at once, and parallel branches run together. `[run] max_concurrency = N`
in config.toml, or `concurrency=N` for one run (the run arg wins), caps how many steps run at the same time
(LangGraph `max_concurrency`; one limit for the whole run). Unset = no limit. A fan-out's `limit` is different:
it refuses a list longer than `limit`.

Skills and roles per step (`catalog.py`): `ai("draft", prompt, SCHEMA, role="report-writer", skills=["asd-ste100"])`.
- A **role** is an agent definition: `.claude/agents/<id>.md` (frontmatter name, description, tools, model; body =
  instructions), `.codex/agents/<id>.toml` (`developer_instructions`, `model`, `model_reasoning_effort`) or
  `.langflow/agents/<id>.md` (Claude format). Claude runs its own file natively with `--agent <name>`; otherwise the
  instructions go in with `--append-system-prompt`. Codex and OpenCode get them before the prompt (Codex prefers its
  `.toml`, OpenCode the langflow file). Model, effort and tools of a role are defaults under the step's own values,
  and only from the CLI's own file.
- A **skill** is `<dir>/<id>/SKILL.md` in `.langflow/skills`, `.agents/skills`, `.claude/skills` (first one wins;
  others are listed as shadowed) or a `[catalog] skill_dirs` folder. Its text goes before the prompt
  (`Skills for this step (follow them):`, the SKILL.md, its companion file list); `[catalog] skill_mode = "name"`
  only names it. Paths must stay inside the project.
- Override without editing the workflow, in `.langflow/bindings.toml` (by hand or from the web UI):
  `[client_report.draft]` `role = "report-writer"` (`""` = none), `skills = [...]` (replaces), `skills_add = [...]`
  (appends). Per run: `role.<step>=<id>` (empty = none), `skills.<step>=a,b` (replace), `skills.<step>=+c` (add).
  Precedence: run arg > bindings.toml > code.
- Fan-out workers are built at run time, so the check reads their binding from `fanout(..., role=, skills=)` first
  (a declared value replaces the worker's own), then from the worker function's `langflow_step`, then from one probe
  call `worker(None, 0)`; a worker that needs a real item is not seen unless declared. They show as `<fanout>[*]`.
- `langflow check <workflow> [args]` lists every ai step's role and skills (and where each value comes from) and
  exits 1 when one is missing; `langflow start` refuses such a workflow. `langflow skills` / `langflow roles` list the
  catalog with the steps that use each entry.
- Each step's `start` event keeps `binding` (ids, paths, sha256). `langflow continue` compares them with the files and
  logs `binding changed` for a skill or role edited since (not fatal); the web run view shows it too.
- **role_mode** (per step: `ai(role_mode=)`, `role_mode = "…"` in bindings.toml, run arg `role_mode.<step>=`,
  `[catalog] role_mode`; run arg > bindings.toml > ai() > config > automatic):

  | | Claude | Codex | OpenCode |
  |---|---|---|---|
  | `append` | `--append-system-prompt-file <state>/runs/<run>/<step>.system.md` (default system prompt kept) | `-c developer_instructions=…` through node + codex.js (not `codex.cmd`); before the prompt when that launcher is missing or the line passes 30,000 chars | `[agents.opencode] role_channel`: `"prompt"` (default, before the prompt) or `"instructions"` (a session instruction entry, experimental) |
  | `agent` | `--agents <state>/runs/<run>/<step>.agents.json --agent lf-<id>` (a copy of the role whose tools keep StructuredOutput): **replaces** the default system prompt; `--tools` = the step's tools, `--disallowedTools Write,Edit,NotebookEdit` when the step is read-only (`[agents.claude] restrict_tools = false` turns both off) | same as `append` (no main-thread agent) | the instance agent `lf-role` (replaces OpenCode's base prompt; the session permission rules still win) |
  | `prompt` | before the prompt | before the prompt | before the prompt |
  | automatic | `append` (`--append-system-prompt <text>` on the command line, or the system file when the step has `system` skills) | before the prompt | before the prompt |

  A role's tools never widen a step's: they apply only under `agent` when the step has no `tools`, and without
  Write / Edit / Bash when `sandbox="read-only"` (the default).
- **Step contract** (`contract`, default true; same four places): with a role or skills bound, a short block
  (`catalog.CONTRACT`: return the JSON, no files, no questions unless the step says so) is the prompt's **last** block,
  after memory and after guardrail feedback. `[catalog] contract_system = true` also puts it in the agent's system
  prompt under Claude `--agent`.
- **skill_mode** (same four places as role_mode, plus `[catalog] skill_mode`; default `inject`):

  | | Claude | Codex | OpenCode |
  |---|---|---|---|
  | `inject` | the SKILL.md text before the prompt | same | same |
  | `name` | `- Use the skill <id> (<path>).` before the prompt | same | same |
  | `system` | in the same `<step>.system.md` as the role (`--append-system-prompt-file`), after the role | in `developer_instructions` with the role (needs the launcher; before the prompt when it is missing or the command line passes 30,000 chars) | before the prompt (no system channel) |
  | `native` | the Skill tool: a first prompt line asks for it, `Skill(<id>)` is auto-approved and kept in a limited tool list ([agents.claude] `native_skills = "tool"`, default). `"preload"` (an `--agents` file with `skills:`) exists but Claude Code 2.1.312 does not preload skills for the main-thread agent in `-p` | first prompt line `Load these skills before you start: [$id](<abs path>/SKILL.md)` (the linked form binds the exact file) | skill attachment (see the OpenCode section) |

  `native` uses the copy the CLI itself loads (Claude `.claude/skills` or a personal `~/.claude/skills` copy; Codex
  `.agents/skills`), and the adapter proves after the call that it loaded (the skill text or a Skill call in the
  transcript / rollout → `skills_loaded` in the done event). A skill that cannot be native (Claude has no
  `.claude/skills/<id>`) or did not load uses **native_fallback**: `system` (default; `inject` where there is no system
  channel), `inject`, or `fail` (`langflow check` / `start` refuse it up front; a load failure fails the step). A
  load failure re-runs the step once, fresh, with the fallback (`native fallback` event).
- **retry_mode** (same places; default `resume` since 2026-11-18, before: `fresh`, see DESIGN.md rule 5): a guardrail
  retry is a new session with the whole prompt, the feedback and the previous answer (`fresh`), or continues the same
  session with only the feedback and the contract
  (`resume`: Claude `claude -p --resume <session>` with the same flags; Codex `codex exec resume <thread>` with
  `-c sandbox_mode=…` instead of `-s` / `-C`). A resume that fails falls back to one fresh call (`resume failed`
  event). The CLIs report the session's totals after a resume; langflow counts only the new call's tokens and cost.
  Measured on 2026-11-18 (Haiku 5.5, gpt-6-luna; one guardrail retry): Claude resume wrote 1.4k cache tokens against
  9.0k (`system`) and 14.8k (`inject`) for a fresh retry; Codex resume read 21.1k of 21.4k input tokens from its cache,
  a fresh retry 0. OpenCode resume: a new, fully re-checked server re-opens the saved session (one
  retry: 32% fewer input tokens).
- `langflow check` shows each step's role mode and, per skill, the file sent and the file the step's CLI loads by
  itself (Claude: `.claude/skills`, a personal `~/.claude/skills` copy wins; Codex: `.agents/skills`, plus
  `~/.agents/skills` / `~/.codex/skills`), with a warning when they differ.

OpenCode (`agent="opencode"`, OpenCode 2.2.7): each step starts its own isolated `opencode serve` on loopback (no
user/project config, plugins or MCP; the user's login stays), creates a session with deny-by-default permission
rules, re-reads the session to verify them, sends the prompt, takes the JSON answer, and stops the server.
- Config: `[agents.opencode] default_model = "openai/gpt-6-luna"` (provider/model), `default_effort` (a variant of
  that model, e.g. `low`), `allow_commands = ["make build", "make flash *"]` (shell commands; none by default).
- Rights: read/glob/grep always; edit only with `sandbox="workspace-write"`; read and edit are denied above the
  step's folder (`../*`), and everything outside the git worktree (`external_directory`). grep/glob can still
  search above the folder inside the worktree. OpenCode runs no project hooks: these rules are its guard.
- Shell (Windows PowerShell, pinned): only `allow_commands`. Write an exact command, or `<cmd> *` for its arguments
  (also matches the bare command); `make flash*` would also match `make flash-grant`, so other wildcards are
  refused, as are wrappers (`cmd`, `powershell`, `bash`, `python`, `uv` ...). Every part of a compound command
  (`a; b`, `a && b`, `a | b`) must be allowed. Grant and rig commands are denied by session rules and by a hard
  config policy, whatever the list says. Not an OS sandbox: with edit allowed, an agent can change what an allowed
  `make` target runs.
- The transcript is a copy of the session timeline in `<state_dir>/opencode/<session>.json`.
- Demo: `opencode_smoke` (read-only answer, an edit inside, an edit outside that must be denied, a file check).

Memory (`memory.py`), like an MCU: run memory = RAM of one task, series memory = RAM shared between tasks, the
project's knowledge base = Flash (written only after review):
- `ai(..., memory=["run", "series"])`: the runner adds the memory to the prompt and a `memory` field to the answer
  schema; the agent writes `[{key, text, scope}]`, the runner stores it (same key replaces).
- Run memory lives in the run's State (checkpointed per step). Series memory lives in `<state_dir>/memory.sqlite`
  (LangGraph SqliteStore), shared by every run whose workflow sets `MEMORY_SERIES` to the same value
  (e.g. `"{doc}"`: revise v1, v2, v3 of one document). Gate notes and rejects are remembered automatically.
- `langflow memory <run>`, `langflow memory --series`, `langflow memory --clear <workflow> <series>`.
- Demo: `revise` (v2 follows the reviewer's note given at v1's gate).

Rules that keep runs safe:
- Agents answer in JSON; the runner writes the files (`write`). Give agents read-only tools unless a step must edit.
- A step cut off by a crash runs again from its start (`langflow continue`): put the run name in output file names.
- Code before a gate's question runs again on resume; keep it free of side effects.
- `LOCKS` are enforced in agent sessions by `langflow-guard` until the named gate is approved.
- `approve` refuses a non-console stdin, so an agent cannot pass a gate by itself. A demo or test project can set
  `allow_agent_approval = true` under `[project]`: then `approve` works without a console and records `by: agent`. It stops mistakes, not a determined
  agent that edits files directly; the guard denies agent edits of the state dir as a second layer.
