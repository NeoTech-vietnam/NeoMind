# Installing langflow

langflow is a command-line tool (Python) plus an optional Nimbalyst panel. Install the tool once per machine, then set
up each project that uses it.

```
1. prerequisites    Python 3.11+, uv, git, at least one agent CLI (Claude Code, Codex or OpenCode), logged in
2. install the tool uv tool install --editable <repo>      → langflow, langflow-guard on PATH
3. check            langflow --version; a smoke run in a scratch folder
4. per project      langflow init → edit .langflow/config.toml → langflow hooks (paste) → smoke run
5. optional         web UI: langflow web    ·    Nimbalyst panel: build and install extensions/nimbalyst
```

Tested on Windows 11 (PowerShell, Windows Terminal). **Linux and macOS are not tested yet**; the commands below follow
the same steps and the code has no Windows-only path except where noted (Git Bash for Claude Code, Task Scheduler for
`langflow schedule`, PowerShell for OpenCode).

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Python 3.11 or newer | langflow itself (3.12 recommended) | `python --version` (Linux/macOS: `python3 --version`) |
| [uv](https://docs.astral.sh/uv/) | installs langflow as a command with its own environment | `uv --version` |
| git | projects are found by their folder; agents work in git repositories | `git --version` |
| Claude Code CLI (optional) | `ai(..., agent="claude")` steps | `claude --version`, then log in once with `claude` |
| Codex CLI (optional) | `agent="codex"` steps | `codex --version`, then `codex login` |
| OpenCode 2.2.7 (optional) | `agent="opencode"` steps; other versions are refused | `opencode --version` |
| Windows only: Git for Windows | Claude Code needs Git Bash, or its hooks do not run | `git --version`; langflow finds `bash.exe` itself |
| Node.js 22+ (only to build UI) | rebuilding the web UI or the Nimbalyst panel | `node --version` |

Install uv:

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```
```bash
# Linux / macOS
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Open a new terminal afterwards so `~/.local/bin` (Windows: `%USERPROFILE%\.local\bin`) is on PATH.

## 2. Install the tool

From a local checkout (editable: changes to the source apply at once):

```bash
git clone <langflow repository> langflow          # or use an existing checkout
uv tool install --editable ./langflow
```

This puts two commands on PATH:

- `langflow`: the CLI (`init`, `start`, `status`, `watch`, `approve`, `continue`, `stop`, `check`, `graph`, `memory`,
  `schedule`, `ui`, `web`, ...; `langflow --help` lists them all).
- `langflow-guard`: the hook that Claude Code and Codex call (lists active runs, holds a run's locks).

Without uv:

```bash
python -m venv .venv
.venv/bin/pip install -e .            # Windows: .venv\Scripts\pip install -e .
.venv/bin/langflow --version          # Windows: .venv\Scripts\langflow.exe --version
```

The web UI is already built into the package (`src/langflow/webui/`), so Node.js is not needed to use it.

## 3. Check the installation

```bash
langflow --version                   # langflow 0.1.0
mkdir lf-check && cd lf-check && git init
langflow init                        # creates .langflow/config.toml, workflows/smoke.py, checks/ and the
                                     # langflow-design skill in .claude/skills and .agents/skills
langflow list                        # shows the smoke workflow
```

`smoke` calls Claude (haiku) and Codex; run it only when both CLIs are installed and logged in:

```bash
langflow start smoke smoke-1         # stops at the gate go_on
langflow approve smoke-1             # in your own terminal; type the run name to confirm
```

## 4. Set up a project

Run in the project's root folder (the one holding `.git`):

1. `langflow init` (also writes the `langflow-design` skill; read `langflow guide` before writing a workflow)
2. Edit `.langflow/config.toml`:
   - `[project] approver`: the person who answers gates (shown in messages).
   - `state_dir`: run state, logs and live pages. Add it to `.gitignore` (default `.langflow/state/`).
   - `[agents.claude] default_model`, `[agents.codex] default_model`, optional `default_effort`.
   - `[agents.opencode]` only if OpenCode is used: `default_model = "openai/gpt-6-luna"` (provider/model) and
     `allow_commands` (exact commands or `<cmd> *`; see README, OpenCode).
   - `[hook_check]`: `kind = "jsonl_log"` if the project has a hook that logs every call; otherwise `none`.
   - `allow_agent_approval = true` only in demo or test projects (agents may then answer gates).
3. Register the hooks: `langflow hooks` prints two JSON snippets.
   - Claude Code: merge the first into `.claude/settings.json` (`hooks` section).
   - Codex: merge the second into `.codex/hooks.json`, then open Codex and trust the new hooks with `/hooks`
     (Codex trusts each hook by a hash of its command, so it asks again after any change).
4. Write or copy workflows into `.langflow/workflows/` (examples: `examples/demo/.langflow/workflows/`).
5. Run `smoke` once (section 3) to confirm the agents, the hooks and the gate work in this project.

## 5. Optional parts

### Web UI

```bash
langflow web --open                  # http://127.0.0.1:8765/, bound to this machine only, with a random token
```

Gates answered there are recorded as `web:<user>`.

### Nimbalyst panel

The panel shows the same app inside Nimbalyst for every workspace that has `.langflow/config.toml`.

1. Build the UI and the extension (Node.js 22+):
   ```bash
   cd ui && npm install && npm run build && cd ..
   cd extensions/nimbalyst && npm install && npm run build && cd ../..
   ```
2. Install it. Nimbalyst names an installed extension's link after its folder, and the folder here is the generic
   `nimbalyst`, which another extension may already use. Install through a link named `langflow` instead:
   ```powershell
   # Windows: a junction named "langflow" that points at the extension folder
   New-Item -ItemType Junction -Path "$env:USERPROFILE\Nimbalyst-Extensions\langflow" -Target "<repo>\extensions\nimbalyst"
   ```
   Then install that path in Nimbalyst: ask an agent in Nimbalyst to call the extension-dev tool `extension_install`
   with path `%USERPROFILE%\Nimbalyst-Extensions\langflow` (this is how it was installed and tested).
   If the repository moves, the junction breaks and the extension no longer loads: delete the junction (only the
   link, not the target), create it again with the new path, and install again.
3. Open the **langflow** panel in the sidebar. The first time, Nimbalyst asks **"Enable langflow?"** (it starts
   `langflow web --api-only` in the workspace): accept it. Gates answered there are recorded as `panel:<user>`.
4. After changing the UI: rebuild (step 1) and reload the extension (`extension_reload`, extension id
   `local.langflow`, path = the same junction).

### Timed runs

```bash
langflow schedule add daily-plan 09:00 --days MON-FRI -- start daily_plan "daily-{date}"
langflow schedule list
langflow schedule remove daily-plan
```

Windows: a Task Scheduler task under `langflow\<project>`, run as you while you are logged on; its output goes to
`<state_dir>/schedule.log`. `--days` takes `DAILY` (default), `MON-FRI` or a list such as `MON,WED,FRI`. Arguments
may not hold `& | < > ^ % "` (cmd.exe would act on them), and the whole task command must stay under 261
characters (a schtasks limit). The web UI's schedule page uses the same code (`langflow.schedule`).
Linux/macOS: `add` prints a crontab line to add with `crontab -e`; `list` and `remove` are not supported there.

### Stopping a run

`langflow stop <run>` (or `x` in `langflow ui`, or the stop button in the web UI and panel) cancels a run:

- a running agent or script is killed with its whole process tree within about a second;
- a gate that waits stops waiting at once;
- the status becomes `cancelled`, and `langflow-guard` releases the run's locks.

`langflow continue <run>` re-runs the cut step from its start (a cancelled gate waits again). A run whose process has
died (`running` but nobody works on it) is cancelled at once.

### Cost and retries

Every AI step records its tokens (input, output, cache read and write, reasoning) and its cost in the run status;
`langflow status <run>`, the live page, `langflow ui` and the web UI show them, with totals per run. Claude Code
reports its own cost. For Codex (and OpenCode when it reports 0), add prices in USD per million tokens:

```toml
[pricing."gpt-6-luna"]        # the model name as in the workflow or default_model
input = 1.0                   # EXAMPLE numbers: copy the provider's current prices
output = 10.0
cache_read = 0.1              # optional; defaults to the input price
cache_write = 1.0             # optional; defaults to the input price
```

Transient agent errors (rate limit, HTTP 429, overloaded, 5xx, timeout, connection reset, "temporarily
unavailable") are retried with the same prompt after 15, 60 and 180 s (`[retry] attempts`, `delays`). A step's
own time limit is not retried. Each retry shows as a `retry` event in the run.

A fan-out starts all its workers at once. To stay under a provider's rate limit, cap the steps that run at the
same time with `[run] max_concurrency = 4` in config.toml, or `concurrency=4` for one run.

### Gate notifications

When a gate starts waiting, langflow runs the `[notify] command` of `.langflow/config.toml` (an argv list, no shell).
The run, gate, question, workflow and live page are in the environment variables `LANGFLOW_RUN`, `LANGFLOW_GATE`,
`LANGFLOW_QUESTION`, `LANGFLOW_WORKFLOW` and `LANGFLOW_PAGE`, and in the placeholders `{run}` `{gate}` `{question}`
`{workflow}` `{page}`. A question can hold any text: read it from the environment in a script; never paste
`{question}` into a shell line or a PowerShell `-Command` string. A failing command is logged in the run log and
never stops the run.

Windows toast (Windows PowerShell 5.1, no extra module). Save as `.langflow/notify.ps1`:

```powershell
# langflow gate notification: a Windows toast with the run, the gate and the question.
$title = "langflow: $env:LANGFLOW_RUN waits at gate $env:LANGFLOW_GATE"
$text = [string]$env:LANGFLOW_QUESTION
if ($text.Length -gt 200) { $text = $text.Substring(0, 200) + '...' }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $xml.GetElementsByTagName('text')
$lines.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
$lines.Item(1).AppendChild($xml.CreateTextNode($text)) | Out-Null
# Toasts need a registered app id; this is Windows PowerShell's own.
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show(
    [Windows.UI.Notifications.ToastNotification]::new($xml))
```

and in `.langflow/config.toml`:

```toml
[notify]
command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".langflow/notify.ps1"]
```

Check it without a run: set the variables and start the script once in PowerShell
(`$env:LANGFLOW_RUN='test'; $env:LANGFLOW_GATE='g'; $env:LANGFLOW_QUESTION='q'; powershell -File .langflow/notify.ps1`).
Toasts do not show while Windows "Do not disturb" (Focus) is on. The web UI and the Nimbalyst panel also notify by
themselves while they are open.

### Gate files

A workflow can show the files a person should read before answering a gate:
`gate("draft_ok", "Approve the draft?", show=lambda s: [draft_path(s), review_path(s)])` (a path, a list, or a
function of the state; relative paths are under the project root). While the gate waits, the status has
`gate_files`; the web UI and the panel show their content on the gate card, `langflow ui` opens them with `g`.

### Skills and roles per step

Bind a project skill or agent definition to an ai step in the workflow (`ai(..., role="report-writer",
skills=["asd-ste100"])`), in `.langflow/bindings.toml`, or for one run (`role.<step>=`, `skills.<step>=`); see the
README. Before a real run:
```bash
langflow roles                     # agent definitions found (.claude/agents, .codex/agents, .langflow/agents)
langflow skills                    # skills found (.langflow/skills, .agents/skills, .claude/skills, [catalog] skill_dirs)
langflow check <workflow> key=...  # every ai step's role and skills; exit 1 when one is missing
```
Optional config:
```toml
[catalog]
skill_dirs = ["tools/skills"]   # more skill folders inside the project
skill_mode = "inject"           # or "name" (the prompt only names the skill), "system" (the CLI's system channel),
                                # "native" (the CLI loads its own copy; checked after the call)
native_fallback = "system"      # for a skill that cannot be / was not loaded natively: "system", "inject", "fail"
retry_mode = "resume"           # default; "fresh": a guardrail retry starts a new session with the whole prompt
```
Try a mode on one run first: `langflow start <wf> <run> skill_mode.<step>=native retry_mode.<step>=resume`.

## Upgrade and uninstall

```bash
cd langflow && git pull
uv tool install --editable . --reinstall        # needed when dependencies change; source edits apply without it
uv tool uninstall langflow
```

After an upgrade, run `langflow init` again in each project: it keeps every existing file and adds what is new (the
`langflow-design` skill, 2026-11-18). Since 2026-11-18 a guardrail retry continues the session (`retry_mode`
`resume`); set `retry_mode = "fresh"` under `[catalog]` to keep the old behaviour.

Removing langflow from a project: delete `.langflow/` and the `langflow-guard` entries in `.claude/settings.json` and
`.codex/hooks.json`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `langflow: command not found` | `~/.local/bin` is not on PATH: open a new terminal, or run `uv tool update-shell` |
| `no .langflow/config.toml here or above` | run the command inside the project folder, or `langflow init` first |
| A step fails with "project hooks did not run" | the agent started without the project's hooks. Windows + Claude Code: Git Bash missing (set `[agents.claude] git_bash` to the full path of `bash.exe`). Codex: trust the hooks with `/hooks` |
| `approve needs an interactive console` | run `langflow approve` in PowerShell / Windows Terminal (not Git Bash's mintty, not an agent shell), or answer from `langflow ui`, the web page or the panel |
| A script step runs the wrong Python | write the full path of the interpreter in the workflow, or make sure the project's `python` comes first on PATH |
| OpenCode step: "OpenCode server version ...; this adapter supports 2.2.7 only" | install OpenCode 2.2.7 exactly |
| `langflow web`: address in use | `langflow web --port 8770` (any free port) |
| Panel says "Backend tool not available" | accept the "Enable langflow?" dialog, or enable the extension's backend in Settings → Extensions |
| A run stays `running` after a crash | `langflow continue <run>` re-runs the step that was cut off, or `langflow stop <run>` to cancel it |
| `langflow stop` says "cancel requested" but the run goes on | the process that runs it checks every second; a step in a library call without a child process stops at the next step. The request stays in `<state_dir>/runs/<run>.cancel` until it is applied |
| A step shows `retry` events | a transient agent error (rate limit, overload, network); it is retried up to `[retry] attempts` times. Nothing to do unless it fails in the end |
| `uv tool install ... --reinstall`: `failed to remove directory ...\uv\tools\langflow\Scripts: Access is denied` | a `langflow web` (often the Nimbalyst panel's `--api-only` server) still runs from the tool's Python. Close the panel / stop `langflow web` first. If the reinstall already broke the tool (`No module named 'langflow'`): `uv pip install --python "$env:APPDATA\uv\tools\langflow\Scripts\python.exe" -e <langflow folder>`, and copy `Scripts\langflow-guard.exe` back to `~\.local\bin` if it is missing (the hooks call it) |
| `langflow start`: "a role or skill it binds is missing" | `langflow check <workflow>` lists the step and the id. Add the file (`.claude/agents/<id>.md`, `<skills dir>/<id>/SKILL.md`), fix the id, or override it in `.langflow/bindings.toml` |
| Log `native skill x did not load; fresh call with system` (or the step fails with `native skill x did not load`) | the CLI did not load the skill by itself. `langflow check <workflow> skill_mode.<step>=native` shows which copy the CLI loads (`.claude/skills` for Claude, `.agents/skills` for Codex) and any personal copy that shadows it; a skill only in `.agents/skills` cannot be native for Claude. Keep `native_fallback = "system"` (default) or use `skill_mode = "system"` |
| Log `codex launcher not found …; instructions before the prompt instead` | `-c developer_instructions` (role or `system` skills) needs `node` + `<npm>/node_modules/@openai/codex/bin/codex.js` next to `codex.cmd`; without them the text goes before the prompt (stdin), which still works |
| Log `resume failed, fresh retry` | the CLI could not continue the session (deleted, or a flag refused); langflow made one fresh call instead. Nothing to do unless it repeats; then set `retry_mode = "fresh"` |
| A step fails with `binding: skill x: not found` | the file disappeared after the run started; restore it (or change the binding) and `langflow continue <run>` |
| No toast at a gate | check the run log for a `notify:` line (exit code and output); run the script by hand (see Gate notifications); Focus/Do not disturb hides toasts |
