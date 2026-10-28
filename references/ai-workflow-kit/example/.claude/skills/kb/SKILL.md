---
name: kb
description: How to use the project knowledge base (KB) during work, for any AI harness. Use at the start of a task, before asking the owner something the KB may already answer, before editing a source file, before calling work done, and when something behaves unexpectedly. Covers lookup (get, search, trace, file, contested), the plan template, verification with a control, recording tests (TST) and lessons (LES), changing store content only through proposals, and which agent to delegate to.
---

# KB

The KB is one index over many groups of records. In a **store-mode** group the KB is the source and the `.md` file is an
export. In a **read-only** group the document is the source and the KB holds a checked copy.

Run commands from the project root. `kb.py` means `python .aikit/kb/kb.py`.

```text
start ──> look up ──> plan ──> owner OK ──> edit ──> verify (+ control) ──> record TST/LES ──> done
            │                                │                                  │
            before asking the owner          read the records on the file       propose only; the owner reviews
```

## 1. Look up before asking or reading whole files

| Need | Command |
| --- | --- |
| One record, verbatim, with its citation | `kb.py get <ID>` |
| Find by words | `kb.py search "<words>" --scope <scope> --type <TYPE> --status <STATUS>` |
| What a record names, and what names it | `kb.py trace <ID>` |
| Everything about a file or folder | `kb.py file <path>` |
| What is still open | `kb.py contested` |
| Which requirements have a passing test | `kb.py coverage` |

- Scopes: `kb.scopes` in `kit.json`.
- Cite a decision on record. Do not ask it again.
- An empty search is not proof of absence: retry with the source document's words, then say what you searched.
- A group reported unavailable or STALE: say so. Do not guess its content.
- Before you edit a file, run `kb.py file <path>`, unless a hook already listed its records.

## 2. Plan a change

One line per field. Skip a field that does not apply.

- **Repo:** repository and files.
- **Action:** what changes, in one or two sentences.
- **Mirror:** what must change with it: a header and its source, code and its docs, `.claude/agents/*.md` and the copies
  for other harnesses (`python .aikit/agents/sync_agents.py --write`), a KB source and its group
  (`kb.py import --group <name>`).
- **Gotcha:** the LES records and rules that apply (`kb.py file <path>`).
- **Validate:** the level of proof you will reach, and the command that gives it.
- **Trace:** the requirement IDs it serves, and the decisions it depends on.

Direction, scope and anything irreversible stay with the owner (`workflow.md`).

## 3. Verify before saying done

A claim is done only with the command, its output, its exit code, and **a control**. A control proves the check can
fail: the test was red before the fix, a bad input is rejected, a known value comes out. No output, no "pass".

## 4. Record what was checked and learned

- A check of a requirement:
  `kb.py test add --req <REQ-ID> --level <level> --cmd "..." --output "..." --result pass|partial|fail --build <label> --reason "..." --actor AI`.
  It creates a proposal. **The owner reviews every TST row.**
- The owner's own test review: `kb.py test import-review --source "<file>.md" --group <name> --reason "..."`.
- A lesson (an error met and its fix, or a method proven):
  `kb.py store propose add LES-NNN --group <lessons-group> --section "<heading>" --text-file row.txt --reason "..." --actor AI`.
  The **Applies to** cell must hold exact paths in backticks, or a folder ending in `/`. No globs. The store refuses a
  LES row without one: lookup by file finds lessons only by path. Put line numbers in the Evidence cell.
- A lesson that holds for every project goes to `.claude/memory/` instead (`G12`).
- What waits for the owner: `kb.py store pending --out "knowledge/.cache/review/pending.md"`.

## 5. Change store content

- Only through `kb.py store propose edit|add|move|remove|intro <ID> --group <name> ...`.
- Never edit a store journal or an exported `.md` by hand: it shows as export drift.
- The reviewer is the owner. Only after the owner said OK in chat, run
  `kb.py store review <proposal> --decision approved --reviewed-by "Alex Doe" --reason "<the OK, quoted>"`,
  then `kb.py store apply <proposal> --actor AI`.
- Whole-store review: `kb.py review export --out "<file>.xlsx"`; the owner marks each row; then
  `kb.py review import --file "<file>.xlsx"`.
- Editing the source document of a read-only group is normal. Afterwards run `kb.py import --group <name>`.

## 6. Something behaves unexpectedly

1. Write the symptom as seen, with the version and the setup.
2. Search the KB: the symptom words, then `--type LES`, `--type DEV`, `--type BKL`.
3. Rank the likely causes. Run the safest checks first: read logs and state before any action that changes anything.
   Ask the owner before an action that touches real equipment or real data.
4. When solved, propose a LES row (section 4).

## 7. Delegate by model tier

Each agent has a fixed tier in `kit.json` (`agents.tiers`, `agents.assign`).

- `kb-lookup` (L): multi-step or reverse questions. For one known ID, run `kb.py get` yourself.
- `kb-curator` (L): checkpoint health and open items for the owner.
- `reviewer` (M): a diff before commit.
- `gate-quiz` (M): questions for the `comprehension-gate` skill.

Do small lookups inline: delegating bounded work usually costs more (`workflow.md`).
