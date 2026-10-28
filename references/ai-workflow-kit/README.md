# ai-workflow-kit

A template repo for AI-assisted project work. `init.py` installs it into a project in two parts:

- **engine** (code, replaced on upgrade) goes to `<project>/.aikit/`, with a `manifest.json` of file hashes.
- **template** (project-owned files) is copied once and never overwritten.

The engine holds a knowledge base, a comprehension gate and learning map, hooks with time-limited grants, and agent
sync between Claude and Codex. Python 3.10+, standard library only. Works on Windows and POSIX.

**Setting up a project? An AI agent should read [SETUP.md](SETUP.md) and follow it step by step.** This README is the
reference for each part.

## Usage

```text
python init.py init    --target DIR --name NAME --owner OWNER [--lang en|vi] [--harness claude,codex,antigravity]
python init.py upgrade --target DIR [--force]
python init.py check   --target DIR
python init.py harness --target DIR
```

- `init` copies the engine to `DIR/.aikit/`, copies each template file that is not already in `DIR`
  (existing files are listed as `skipped:`), fills `{{project_name}} {{owner}} {{owner_id}} {{lang}} {{project_root}}`
  in text files, and sets `harnesses` in `kit.json` from `--harness` (default `claude,codex`). It ends with the
  `harness` step below. A second `init` on the same folder changes nothing.
- `upgrade` replaces `.aikit/` with this kit's engine. It touches nothing else.
- `check` validates `kit.json`, the engine against its manifest, and that every `paths.*` folder exists.
  Warnings (for example unknown top-level keys) do not fail it.
- `harness` writes the hook configuration of each harness enabled in `kit.json` `harnesses` (see "Hooks and harness
  configs"). Exit 2 if the engine hooks are not installed or an existing config file is not valid JSON.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | `check` found at least one error (including a missing or unreadable `kit.json`). |
| 2 | Refused: bad arguments or input; `upgrade` without `kit.json` or `.aikit/manifest.json`; `init` where `.aikit/` exists without a manifest or `kit.json` is unusable. |
| 3 | `upgrade` refused because engine files differ from the manifest (local edits). Changed, missing and extra files are listed. Use `--force` to overwrite. |

Messages start with `error:`, `warning:`, `created:`, `skipped:` or `engine:`.

## Layout

```text
init.py            the CLI
VERSION            kit version
engine/            replaceable code, installed to .aikit/ (config.py, kb/, competency/, hooks/, agents/)
template/          project-owned files, copied once (kit.json, CLAUDE.md, AGENTS.md, knowledge/, .claude/memory/)
example/           output of: python init.py init --target example --name "Example Project" --owner "Alex Doe" --harness claude
                   (without Codex: its hook file holds absolute paths of the machine that made it)
tests/             python -m unittest discover -s tests -t . -v   (run from the kit root)
```

### Skills and agents in the template

Every skill and agent below is installed by default (no opt-in flag).

- **Kit-written skills** (`template/.claude/skills/`): `kb`, `comprehension-gate`, `catchup`, `handoff`,
  `meeting-recap`, `open-in-vscode`.
- **Agents** (`template/.claude/agents/`): `reviewer`, `gate-quiz`, `kb-lookup`, `kb-curator`, `governance-auditor`
  (opt-in audit, `G18`), `chart-builder`, `test-data-analyst`, `test-plan-reviewer`, `report-writer`,
  `report-reviewer`, `email-writer`, `english-coach`. Each has a tier in `kit.json` `agents.assign`
  (`opus` is `H`, `sonnet` is `M`, `haiku` is `L`).
- **Vendored skills** (`template/.claude/skills/`): `asd-ste100`, `humanizer`, `improve-claude-md`,
  `build-iterated-agentic-loop`, `design-control-loop`, `show-me`, `visual-pr`, `narrow-react-prop-types`,
  `reasoning-router`, `no-ai-slop`. They come from other authors. The kit does not edit them.
  `template/.claude/skills/VENDORED.json` lists each one with its licence, copyright and a note.
  `no-ai-slop` and `reasoning-router` have no LICENSE file: check their source before an external release.
  `init` copies a vendored folder and `VENDORED.json` byte for byte: no placeholder rendering and no line-end change
  (some files hold GitHub Actions `${{ ... }}` and CRLF line ends). As for every template file, `init` skips a file that
  already exists and `upgrade` never touches it.

`kit.json` in the project is the only place for project-specific settings. `engine/config.py` loads it, merges it
over built-in defaults and resolves `paths.*` under the project root.

## Comprehension gate and learning map (`engine/competency/`)

Five scripts, run as `python .aikit/competency/<script>.py`. All read `kit.json` from the project root; the
environment variable `AIKIT_PROJECT_ROOT` overrides the search. The competency folder is `paths.competency`, the
default person is `people.default`, the page and report language is `project.ui_lang` (`strings/<lang>.json`).

| Script | Does |
|---|---|
| `gate.py scope\|record` | What a comprehension gate must cover (core commits and uncommitted core changes since the last code gate), and the record of each gate in `people/<person>/gates.jsonl`. Core paths per project: `gate_config.json`. Scratch files: `<paths.cache>/gate/`. |
| `build_catchup.py [--person NAME] [--out FILE] [--today]` | Builds the learning-map page (default `<competency>/catchup.html`) from `map.json` and `people/<person>.json`. `--today` prints today's suggestions. |
| `grade_placement.py --check \| --new NAME \| --person NAME [--record --date D]` | Placement test: check the test against the map, start a sheet, grade it, record the confirmed levels (never lowers a level). |
| `check_lessons.py [ID ...]` | Checks `lessons/<ID>.md`: title, sections, three exercise tiers with hints and solution, and every `` `path:line` `` reference against the repos. Exit 1 on any problem. |
| `migrate_ids.py --check \| --write [--root DIR]` | Rewrites legacy (non-English) ids to the English ids; see below. |

Settings in `kit.json`:

- `repos`: `[{"name", "path", "index"?}]`, paths relative to the project root. Lesson references are resolved against
  every repo; a bare file name is looked up among the repos whose `index` is not `false`.
- `competency.kb_get_command`: command copied by the KB button of a source that has a `kb` id (default
  `python .aikit/kb/kb.py get {id}`); `null` shows the label only.
- `competency.markers`: text the parsers look for, merged over the English defaults. `lesson`: `exercise_heading`
  (with `{n}`), `tiers`, `hints`, `sections`, `ref_extensions`. `placement`: `folder`, `test`, `key`, `sheet`,
  `answer`, `grade`, `grade_values` (`right`, `partial`, `wrong`).

Settings in `map.json`: `stages` (area names in learning order; default: the order of `areas`) and optional
`pinned_first` (item id prefixes that always go to the first stage). Items of kind `open-question` hang as branches.

Ids are English: levels `unassessed aware understand apply apply-advanced`; support `independent hint-direction
hint-specific taught-first saw-solution`; kinds `module foundation change open-question decision`. A file that still
holds legacy ids is read correctly, with one `warning: N legacy ids read ...` on stderr per run; `migrate_ids.py
--write` rewrites map, person records and `gates.jsonl` in place and keeps key order, indentation, line endings and
non-ASCII text. New files are always written with English ids.

`template/` ships two starter items (`L-BASIC-01`, `L-BASIC-02`) with lessons, an empty person record is created by
`init`, and `lessons/_TEMPLATE.md` is the lesson template that `check_lessons.py` accepts with the default markers.
Replace the starter items with your own.

## Hooks, grants and harness configs (`engine/hooks/`)

Hook scripts read one JSON payload on stdin and print one JSON decision or context, always exit 0, and never block
work because of their own error (the action guard asks instead, see below). The project root is the environment
variable `KB_HOOK_ROOT`, else `CLAUDE_PROJECT_DIR`, else the folder that holds `kit.json` above the script. Every call
is logged to `<paths.cache>/hooks/calls.log` (kept under 200 KB).

| Script | Events | Does |
|---|---|---|
| `kb_guard.py` | SessionStart, PreToolUse and PostToolUse of edit tools | Session note (project, KB groups, scopes, KB command, reviewer). Denies a hand edit of a KB store journal or export (use `store propose`); asks before a hand edit of `kb.json`; after an edit of a read-only group's source, reminds to import. |
| `kb_context.py` | SessionStart, PreToolUse of edit tools, PostToolUse of Bash, Stop | Adds the KB records that name the file about to be edited. After a Bash command, calls each plugin callback registered with `api.on('post_bash', fn)` as `fn(kb, root, command)`; a returned string becomes context. At the first Stop after files changed in the watched repos with no new test-log or lessons proposal, shows one reminder per session. |
| `action_guard.py` | PreToolUse | Applies `guard_rules` to Bash commands and protects the grant files (below). |
| `grant.py` | run by the person | Starts, ends and shows a time-limited grant. |
| `antigravity.py` | PreToolUse (Antigravity) | One adapter that maps Antigravity's `run_command`, `replace_file_content` and `write_to_file` to the KB guard and the action guard. |

Settings in `kit.json` used by the hooks:

- `kb.cli`: the KB command named in notes (default `python <paths.engine>/kb/kb.py`).
- `kb.tests.group` (test log) and `kb.lessons_group` (lessons log): the Stop reminder names them and the levels of
  `kb.tests.add_levels`; a part whose group is not set is left out, and with neither set there is no reminder.
- `repos[].watch: true`: repos whose changes the Stop reminder watches. The environment variable `KB_HOOK_REPOS`
  (path list) overrides it.
- `plugins`: a plugin adds project-specific behaviour after a shell command with `api.on('post_bash', fn)`
  (for example recording a build result). A callback that raises is skipped.

### Grants and the action guard

A grant lets the AI run a command that the guard otherwise denies, for a limited time, after the person agrees.

```json
"grants": [{"name": "release", "max_minutes": 30}],
"guard_rules": [
  {"match": "\\bpublish\\b", "action": "deny-without-grant", "grant": "release", "reason": "Publishing is live."},
  {"match": "drop table", "action": "ask", "reason": "This deletes data."}
]
```

`action_guard.py` checks each Bash command against `guard_rules` in order; the first rule whose regex is found in
the command wins: `allow` (run), `ask` (ask the person; Codex cannot ask, so the command is denied there) or
`deny-without-grant` (run while the named grant is valid, else deny and name the command the person runs).
`grant.py <name> status` and `revoke` are never held back by a rule.

The person starts a grant from their own terminal:

```text
python .aikit/hooks/grant.py <name> grant [MINUTES]   # default 5, at most max_minutes
python .aikit/hooks/grant.py <name> revoke
python .aikit/hooks/grant.py <name> status
```

The grant is the file `.claude/grants/<name>.json` (`granted_epoch`, `expires_epoch`, `minutes`, `granted_local`).
The guard always denies a Bash command that would create or extend a grant (it runs `grant.py` with `grant`, or writes
into `.claude/grants/`) and any edit of `.claude/grants/**`, `<engine>/hooks/grant.py` and
`<engine>/hooks/action_guard.py`; `harness` also adds `Edit(...)`/`Write(...)` entries for them to
`permissions.deny`. The guard reads command text. It stops habit and mistakes, not a command built to hide its own
text; keep the grant in the person's hands.

### Harness configs (`python init.py harness --target DIR`)

Writes, for each harness enabled in `kit.json` `harnesses`, and runs at the end of `init`:

- **Claude**: `.claude/settings.json`. Created if absent. If present, only hook entries whose command contains
  `/<engine>/hooks/` are replaced; every other key and hook is kept. Hooks: SessionStart `kb_guard` + `kb_context`;
  PreToolUse `Bash` `action_guard`; PreToolUse `Edit|Write|MultiEdit` `action_guard` + `kb_guard` + `kb_context`;
  PostToolUse `Edit|Write|MultiEdit` `kb_guard`; PostToolUse `Bash` `kb_context`; Stop `kb_context`. Commands are
  `python "$CLAUDE_PROJECT_DIR/<engine>/hooks/<script>.py"`.
- **Codex**: `.codex/hooks.json` with absolute forward-slash paths, no quotes, and `--codex` (Codex on Windows runs
  hook commands through `cmd.exe`, where quotes do not work, and cannot "ask"; `--codex` turns ask into deny).
  Matchers: `Bash` and `apply_patch|Edit|Write`.
  **Codex trusts each hook by a hash of its command: after the file is created or changed, re-trust the hooks in
  Codex with `/hooks`.** `harness` prints a reminder when it changes the file. A moved project needs it again.
- **Antigravity** (only when enabled): `.agents/hooks.json`, one block `aikit-guards` for `antigravity.py`.

A second run changes nothing. After `upgrade`, run `harness` again if the hook list changed.

### Agent sync (`engine/agents/sync_agents.py`)

`.claude/agents/<name>.md` is the source; `python .aikit/agents/sync_agents.py --write` sets each agent's Claude
`model:` from its tier and writes `.codex/agents/<name>.toml` (`name`, `description`, `model`,
`model_reasoning_effort`, `developer_instructions`; `CLAUDE.md` becomes `AGENTS.md`). `--check` lists the differences
and exits 1. Tiers come from `kit.json` `agents` (`tiers`, and `assign`: agent to tier), or from the JSON file named in
`agents.tiers_file` (keys `tiers` and `agents`). The Claude `tools:` line is kept. Codex custom agents have no
read-only setting (the Codex documentation says `sandbox_mode` in an agent file does not override the parent session),
so nothing about tools is written to the TOML.
