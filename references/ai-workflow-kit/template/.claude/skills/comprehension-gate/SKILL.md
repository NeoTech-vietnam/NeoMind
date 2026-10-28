---
name: comprehension-gate
description: Comprehension gate, for any AI harness. Before the owner accepts AI-written core code, or before the owner sends or signs a document the AI wrote, ask 2-3 multiple-choice questions on what the change really does, written by the gate-quiz agent from the diff; teach what was answered wrong; record the result; then hand off in at most 15 lines. Use when the owner says "run the gate" or "gate", when a plan reaches the end of a step in a core area, or before a client-facing document goes out. It never blocks work and never raises a learning level on its own.
---

# Comprehension gate

Reading and approving a change does not build understanding. Answering first does. The gate checks that the owner can
explain the change without asking an AI.

```text
scope ──> gate-quiz writes questions ──> owner answers (form) ──> grade, teach the wrong ones ──> record ──> hand-off (max 15 lines)
```

## 1. Scope

- **Code:** `python .aikit/competency/gate.py scope --project <name> --json`.
  It lists the core commits since the last gate (or the baseline) and the uncommitted core files.
  The projects, their repo and core paths are in `knowledge/competency/gate_config.json`.
  - "Nothing to gate": say so and stop.
  - More files than the step limit (`max_core_files_per_step`): say the step was too big. Still run the gate, on the most
    important behaviour.
  - The command stages the core paths in a scratch index. It never touches the real index, the working tree or a branch.
- **Document:** the file the owner is about to send or sign (report, email, plan).
- A project with no `repo` and `core` in the config has document gates only.

## 2. Questions

Call the `gate-quiz` agent with the scope JSON or the document path, the number of questions (3; 2 for a small
change), and the lessons in `knowledge/competency/lessons/` that cover the files, if any.

- Do not write the questions in the session that wrote the code. A fresh reading is the point.
- If the agent is not in the list yet (agents load at session start), run a general subagent told to read
  `.claude/agents/gate-quiz.md` and follow it.
- Check the answer before you use it. Each `key` must hold at HEAD: open the `file:line` in `why`.
  Drop a question whose key you cannot confirm.
- Keep `findings` (code that differs from the commit message or the document) for step 4.

## 3. Ask

- Ask with the harness's form tool if it has one: one single-choice question each, options A to E, no explanation shown.
- If there is no form tool, or the owner closes it, ask the same questions as numbered text. The owner answers with a digit.
- The owner answers before reading any hand-off or explanation of the change.

## 4. Grade and teach

- Right: one line why, with `file:line`.
- Wrong or "not sure": teach that part in a few lines (what happens, where, why). Then move on.
- No retry loop. No blocking.
- Then show `findings` and `not_asked`. Fix a finding about a client document before it is sent.

## 5. Record

Write the result to a JSON file in `knowledge/.cache/`. Run:
`python .aikit/competency/gate.py record --project <name> --input <file>` (add `--person <id>` for someone other than
the default).

```json
{"kind": "code", "session": "<session id>", "support": "independent",
 "questions": [{"q": "...", "key": "B", "given": "B", "topic": "..."}],
 "map_items": ["L-..."], "notes": "findings, if any"}
```

- `kind: "doc"` needs `"doc": "<path>"`.
- `support`: `independent` when the owner answered before any teaching on this change; `taught-first` when the change was
  taught first.
- A code gate moves the scope forward. A document gate does not.

**Link to the learning map.** If a map item covers the change, propose the level the result supports (`catchup` skill).
Write it to `knowledge/competency/people/<id>.json` only after the owner confirms. If no item covers a change in a core
area, add a `change` item with its lesson (`catchup` skill), or say in the hand-off that it is missing.

## 6. Hand-off (at most 15 lines)

1. Purpose, in one sentence.
2. Files in reading order.
3. The decision taken, plus one option dropped and why.
4. New invariants or assumptions.
5. What is uncertain.
6. The test that proves the new behaviour: red before, green after.

Do not explain what the code says plainly. Write a long walkthrough only when the owner asks.

## Rules

- The gate reminds and records. It never blocks a commit or a task.
- The questions come before the hand-off and before any explanation of the change.
- The AI never raises a learning level on its own. The owner confirms every level.
- Never edit `catchup.html` by hand.
