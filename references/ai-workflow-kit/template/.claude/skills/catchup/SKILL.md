---
name: catchup
description: Learning sessions so the owner (or a new team member) understands the code and the changes the AI wrote, for any AI harness. Use when the person says "Catch-up <ID>", "catch up", "what do I learn today", "open the learning page", or asks about the learning map, level or progress; also at the end of any task that changed code, to add the learning items for that change. The AI coaches and checks. It never raises a level on its own.
---

# Catch-up

The learning map lists what the person must understand. Each item has a lesson. Each person has a record of levels and
evidence.

```text
map.json (items) ──> lesson ──> session: predict, read, exercise ──> level proposed ──> person confirms ──> record ──> page rebuilt
```

| File (in `knowledge/competency/`) | Content |
| --- | --- |
| `map.json` | Shared map: items with id, kind, area, priority, study-first list, sources, exercises |
| `lessons/<ID>.md` | Shared lesson, written from `lessons/_TEMPLATE.md` |
| `people/<id>.json` | One person's levels, evidence, gaps, review dates |
| `people/<id>/<ID>.md` | That person's own answers and log for one item |
| `catchup.html` | Built page, read-only |

Commands: `python .aikit/competency/build_catchup.py [--person <id>]` builds the page.
`python .aikit/competency/check_lessons.py [ID ...]` checks the lessons. The default person is `{{owner_id}}`.

## When the person says

| Person says | Do |
| --- | --- |
| `Catch-up <ID>` | Run the session steps below for that item. |
| "catch up", "what do I learn today" | Run `build_catchup.py --today`. Offer the picks. The person chooses. |
| "open the learning page", progress, level | Run `build_catchup.py`. Point to `knowledge/competency/catchup.html`. |
| "placement test" | `grade_placement.py --new <id>`; the person answers; you grade part B; run `grade_placement.py --person <id>`. Run `--record` only after the person confirms the proposal. |
| A task that changed code is done | Add `change` items to `map.json` and their lessons. Run `check_lessons.py`. Rebuild the page. |

## Session steps

1. Read the item in `map.json`, its sources (`python .aikit/kb/kb.py get <ID>`) and the code at the current commit.
2. Ask the person to rate their own level and say what is unclear.
3. Ask the person to **predict** first: a behaviour, an order, a value, from a concrete situation. Show no code yet.
4. Read the code and tests together. Compare with the prediction. Explain what was wrong, no more than needed.
5. The person does one exercise from the lesson (or a variant). Hints go up one step at a time: none, direction, specific,
   solution. Code exercises run on a practice copy (a worktree or a `practice/<ID>` branch), never on the working branch.
6. Propose a level from the evidence. **The person confirms.**
7. Write the record after the confirmation. Rebuild the page.

```json
"L-EXAMPLE-02": {
  "level": "understand",
  "self": "understand",
  "evidence": [{"date": "2026-01-15", "exercise": "Exercise 1 + prediction", "support": "hint-direction", "level": "understand"}],
  "gaps": "what is still unclear",
  "review_after": "2026-01-29"
}
```

- Levels: `unassessed`, `aware`, `understand`, `apply`, `apply-advanced`.
- Support: `independent`, `hint-direction`, `hint-specific`, `taught-first`, `saw-solution`.
- Review date: two weeks after the session, unless the person asks for another.

## Teach-first mode

Some people learn better when the lesson comes first. Then:

- Teach briefly in chat: the call chain, a small diagram, `file:line`, the "Easy to get wrong" table.
- Ask 3-4 multiple-choice questions, A to D plus "E. I do not know", in a form (or numbered text).
- Make each question a new situation on what you just taught. Do not repeat the lesson's wording.
- Record `support: taught-first`. If all answers are right, propose `understand` at most.

Record the mode the person chose in `.claude/memory/MEMORY.md` so you do not ask again.

## Rules

- Never raise a level because you explained something or because the person read it.
- Use the lesson's prediction questions, exercises and hints. Do not write them again.
- The person's own answers go in `people/<id>/<ID>.md`. Chat keeps a short summary and the links.
- A lesson that is wrong or stale against the code: fix the lesson, run `check_lessons.py`.
- A real bug found while studying: propose it to the KB (`kb` skill) and add an `open-question` item to the map.
- A real action on real equipment is never part of an exercise without the owner's OK.
- Never edit `catchup.html` by hand.
- Keep explanations short and plain, in the person's language.

## Add items for a change

After a task that changed code, add the items the person now needs to understand:

1. Add an item of kind `change` to `map.json`. Its source is the commit or the document. Give `prereq` ids that exist.
   Tag an item for new people `onboarding`.
2. Write `lessons/<ID>.md` from `lessons/_TEMPLATE.md`: main idea, picture, points to remember, easy to get wrong,
   prediction questions with answers, three exercises (Understand, Apply, Apply advanced) with hints and a solution.
3. Run `python .aikit/competency/check_lessons.py`. It checks the sections, the three tiers and every `path:line`.
4. Run `build_catchup.py`.
