# {{project_name}}

Owner: {{owner}}

This text is in two files with the same content: `CLAUDE.md` for Claude and `AGENTS.md` for Codex.

## Project map

<!-- List the repos and folders of this project, one line each. -->

## Read first, every session

1. `.claude/memory/RULES.md`: read it to the end. Follow it.
2. `.claude/memory/MEMORY.md`: the hub of durable project memory.
3. `.claude/memory/workflow.md`: how work is done here.

Keep memory current: write each durable fact once, in its owner file (`G12`).

## Where things are

- Knowledge base: `knowledge/kb/`. Use it through the `kb` skill (`python .aikit/kb/kb.py`).
- Learning map, lessons and people's records: `knowledge/competency/`. Page: `knowledge/competency/catchup.html`.
- Project settings: `kit.json`.
- Workflow engine: `.aikit/`. Do not edit it; `python init.py upgrade` replaces it.

## Skills

- `kb`: look up before asking; plan, verify with a control, record tests and lessons.
- `comprehension-gate`: questions on a change before the owner accepts it or sends a document.
- `catchup`: learning sessions and the learning map.
- `handoff`: end of session, before compaction.
- Writing: `asd-ste100`, `humanizer`, `no-ai-slop`; meetings: `meeting-recap`; reasoning: `reasoning-router`.
- Others: `open-in-vscode`, `show-me`, `visual-pr`, `improve-claude-md`, `build-iterated-agentic-loop`,
  `design-control-loop`, `narrow-react-prop-types`. Origin and licence: `.claude/skills/VENDORED.json`.

Agents (`.claude/agents/`): `reviewer`, `gate-quiz`, `kb-lookup`, `kb-curator`, `governance-auditor` (on request
only), `chart-builder`, `test-data-analyst`, `test-plan-reviewer`, `report-writer`, `report-reviewer`,
`email-writer`, `english-coach`.
