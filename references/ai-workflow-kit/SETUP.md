# SETUP — install the kit in a project (for an AI agent)

You are an AI agent asked to set up this kit in a project. Follow the steps in order. Each step ends with a check;
do not go on while a check fails. Steps marked **ASK** need the owner's answer: ask with the harness's form tool if
there is one, else as numbered questions. Never guess an answer the owner has to give.

```text
1 prerequisites ──> 2 init ──> 3 kit.json (ASK) ──> 4 entry + memory files (ASK) ──> 5 first KB group
                                                                                       │
8 hand-off <── 7 verify all <── 6b gate + learning map (optional) <── 6a grants (optional, ASK)
```

`KIT` below is the folder of this kit (the folder holding this file and `init.py`). `PROJECT` is the project root.
Run every command from `PROJECT` unless a step says otherwise. Python 3.10+, standard library only.

## 1. Prerequisites

- `python --version` → 3.10 or newer. Git installed if the project is a Git repo (the gate needs it).
- **ASK** the owner: project name; owner name (and how to address them); interface language `en` or `vi`; which
  harnesses they use (`claude`, `codex`, `antigravity`).
- If `PROJECT` already has `.claude/`, `CLAUDE.md`, `AGENTS.md` or `kit.json`: `init` will **skip** those files, not
  merge them. List them to the owner before step 2 and say they will be merged by hand in step 4.

## 2. Install

```text
python KIT/init.py init --target PROJECT --name "<project name>" --owner "<owner name>" --lang en --harness claude,codex
```

Check: exit 0; the output lists `created:` files and any `skipped:` ones; `python KIT/init.py check --target PROJECT`
→ `check: ok`. Note every `skipped:` file for step 4.

What you now have in `PROJECT`:

| Path | What it is | Who edits it |
| --- | --- | --- |
| `.aikit/` | engine (KB, gate, learning map, hooks, agent sync) | nobody; `upgrade` replaces it |
| `kit.json` | every project-specific setting | you, with the owner |
| `CLAUDE.md`, `AGENTS.md` | entry files for Claude and Codex (same text) | you, with the owner |
| `.claude/memory/` | `RULES.md` (18 rules G1–G18), `MEMORY.md`, `workflow.md` | see step 4 |
| `.claude/skills/`, `.claude/agents/` | 16 skills, 12 agents | project-owned; vendored skills listed in `.claude/skills/VENDORED.json` stay unedited |
| `knowledge/kb/` | the knowledge base: `kb.json` (groups), copies, store journals | through `kb.py` only |
| `knowledge/competency/` | learning map, lessons, people's records, gate config | through the competency scripts |
| `.claude/settings.json`, `.codex/hooks.json` | hook configs written by `harness` | regenerate, do not hand-edit kit entries |

## 3. Fill `kit.json` (ASK)

Open `PROJECT/kit.json`. Set, with the owner's answers:

- `project.name`, `project.owner`, `project.reviewer` (who approves KB changes), `project.ui_lang`.
- `people.default`: the owner's id (lower-case ASCII; `init` already set it from the owner name).
- `repos`: every code repo the KB and the lessons may cite, `{"name", "path"}` with `path` relative to `PROJECT`.
  Add `"watch": true` to the code repos where a change without a test or lesson record should trigger the
  end-of-session reminder. Add `"index": false` to repos that must not be searched for bare file names in lessons.
- `kb.scopes`: the areas of knowledge, lower-case, e.g. `["product", "project"]`. Every KB group has one scope.
- `kb.tests` (optional, if the project keeps a test log): `group`, `levels` (lowest to highest), `add_levels`,
  `section`, `req_group`. `kb.lessons_group` (optional): the store group for lessons.
- `agents.assign`: every agent in `.claude/agents/` must have a tier (`H`, `M`, `L`); the template already assigns the 12.
- Leave `paths` as they are unless the owner wants other folders.

Check: `python KIT/init.py check --target PROJECT` → `check: ok`. Then, if `harnesses` changed:
`python KIT/init.py harness --target PROJECT`.

## 4. Entry and memory files (ASK)

- `CLAUDE.md` and `AGENTS.md`: fill the project map (folders and what each holds). Keep the two files identical.
  If they were `skipped:` in step 2, add the kit sections ("Read first", "Where things are", "Skills") to the
  existing files instead; show the owner the diff.
- `.claude/memory/RULES.md`: fill G2 (form of address) and G9 (recurring slips, may stay empty). **Rule G1: never
  change any other rule without the owner's OK.** Add new rules only when the owner states them.
- `.claude/memory/MEMORY.md`: one line per owner file (what to load when). Keep it short.
- If `.claude/settings.json` existed before, `harness` kept its other keys and only replaced kit hook entries;
  show the owner the result.

Check: `python .aikit/agents/sync_agents.py --check` → `"ok": true` (run `--write` once if Codex is enabled and
`.codex/agents/` is missing).

## 5. First KB group

The KB indexes records from documents. Two kinds of group:

- **read-only**: the document stays the source; the KB keeps a verified copy. Use for specs, requirement lists,
  registers.
- **store**: the KB journal becomes the source and the document an export; changes go through
  `propose → review (owner) → apply`. Use for decisions, lessons, a test log.

Pick one existing document with stable IDs (ask the owner which). Write an entry file, e.g. `group.json`:

```json
{"group": "product-reqs", "scope": "product", "mode": "read-only", "authority": "original-source",
 "parser": "md-table", "source": "docs/requirements.md", "section": "## Requirements",
 "id_pattern": "REQ-\\d{3}", "type": "REQ", "status": "unknown", "approval_status": "not-stated-in-source",
 "expected_ids": ["REQ-001", "REQ-002"]}
```

Parsers: `md-table` (first table under `section`), `id-table` (every table holding an ID row), `md-bullet-id`
(`- **ID** …` bullets), `decision-table` (rows `| D1 |` under `| # |` tables, status from the section heading; set
`sections` and `id_pattern` if the headings are not `## Decided / ## Open / ## Responses`), `docx-field-table`,
`xlsx-table` (needs `sheet`), `py-literal` (needs `variable`, `id_column`). `expected_ids` must list exactly the IDs
in the source; on a mismatch the command names the missing and unexpected ones: copy them in and run again.

```text
python .aikit/kb/kb.py add-group --file group.json --reason "first group, asked by <owner>"
python .aikit/kb/kb.py status
python .aikit/kb/kb.py get REQ-001
```

Check: `status` → `"ok": true` and the group listed; `get` returns the row with a citation. Delete `group.json`.
To make a group a store: `python .aikit/kb/kb.py store transfer --group <name> --approved-by "<owner>" --reason "…"`
only after the owner says so; quote their OK in `--reason`.

## 6a. Grants for dangerous commands (optional, ASK)

For commands that must never run without the owner's live permission (deploy, flash, production database):

```json
"grants": [{"name": "deploy", "max_minutes": 30}],
"guard_rules": [{"match": "\\bmake\\s+deploy\\b", "action": "deny-without-grant", "grant": "deploy",
                 "reason": "Deploys to production."}]
```

Then `python KIT/init.py harness --target PROJECT`. The owner opens a grant **from their own terminal**:
`python .aikit/hooks/grant.py deploy grant 10` (`status`, `revoke`). You never run `grant`; the guard denies it.
Other actions: `allow`, `ask`.

## 6b. Comprehension gate and learning map (optional)

- Gate: add the core code to `knowledge/competency/gate_config.json` → `projects`:
  `"<id>": {"title": "…", "repo": "<repo path>", "baseline": "<commit>", "core": ["src/core/"]}`.
  Check: `python .aikit/competency/gate.py scope --project <id> --json`.
- Learning map: replace the two starter items in `knowledge/competency/map.json` and their lessons
  (`knowledge/competency/lessons/L-BASIC-0*.md`) with the project's own, from `lessons/_TEMPLATE.md`.
  Check: `python .aikit/competency/check_lessons.py` and `python .aikit/competency/build_catchup.py`.
- Skip this step if the owner does not want gates or learning sessions.

## 7. Verify everything

```text
python KIT/init.py check --target PROJECT
python .aikit/kb/kb.py status
python .aikit/agents/sync_agents.py --check
python .aikit/competency/check_lessons.py
```

All exit 0. For Codex: tell the owner to open Codex and re-trust the hooks with `/hooks` (Codex trusts each hook by
the hash of its command; any change to `.codex/hooks.json` needs it again). Antigravity: confirm `.agents/hooks.json`
exists if it was enabled.

## 8. Hand-off (at most 15 lines)

What was installed, what the owner answered, which files were skipped and merged, the first KB group, what is left
optional (grants, gate, learning map), and the two owner actions: re-trust Codex hooks; review `RULES.md` G2/G9.

## Later

- New kit version: `python KIT/init.py upgrade --target PROJECT`, then `python KIT/init.py harness --target PROJECT`.
  `upgrade` refuses (exit 3) when `.aikit/` was edited: report it, do not use `--force` without the owner.
- Never edit `.aikit/`. Project-specific behaviour goes in `kit.json` or a plugin listed in `kit.json` `plugins`
  (a `.py` file with `register(api)`: `api.command(...)`, `api.add_types(...)`, `api.on('post_bash', fn)`).
- Commit and push only when the owner asks (RULES G15, G16).
