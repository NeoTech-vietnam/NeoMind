---
name: handoff
description: End-of-session and pre-compaction checklist, for any AI harness. Use when the owner says "wrap up", "hand off", "prepare to compact", or before a long hand-off, or when the conversation is very long. Puts each finding in its owner file, brings the KB back to a clean state, lists what waits for the owner, and writes a short hand-off. Never pushes; commits only when the owner asks.
---

# Hand-off

Before a hand-off or a context compaction, write each decision, fact and blocker of the session into its owner file.
Write it once, and write nothing per turn (`G12`, `G13`). Run commands from the project root. `kb.py` below means
`python .aikit/kb/kb.py`.

```text
findings ──> owner files ──> KB clean ──> open items ──> repos ──> hand-off text
             (memory, docs)  (status, import, lint)     (contested)  (git status)  (max 15 lines)
```

1. **Findings to their owners.** For each decision, fact or blocker of the session, name the owner file and write it
   there once. The owner file is a memory file, a KB store group, or the source repository. Touch `MEMORY.md` only for a
   cross-project rule or a pointer. Never edit `RULES.md` without the owner's OK (`G1`).
2. **Lessons.** For each error met and fixed, or method proven, propose a LES row (`kb` skill, section 4). Do not apply
   it. The owner reviews.
3. **KB clean.** The `kb-curator` agent can do this part.
   - `kb.py status`. For a STALE read-only group whose source was edited on purpose: `kb.py import --group <name>`.
   - `kb.py lint --code`.
   - `python .aikit/competency/check_lessons.py`.
   - `python .aikit/agents/sync_agents.py --check`.
4. **Open items.** `kb.py contested` and `kb.py coverage`. List the proposals that wait for review, the open decisions,
   the blocked requirements, the moved or missing paths, the failing checks.
5. **Repos.** Run `git status --short` in each repository the session touched. List the uncommitted files and say which
   task they belong to. Do not commit unless the owner asked (`G16`). Never push (`G15`).
6. **Task tracker.** If the project uses one, add a comment to the item the session worked on: what changed, how it was
   verified, what waits.
7. **Hand-off text** in chat, at most 15 lines:

```text
Purpose        one sentence
Files          in reading order
Decision       the one taken, plus one option dropped and why
Invariants     new rules or assumptions the code now relies on
Uncertain      what you are not sure of
Proof          the test that was red before and is green after, with its command
Waiting        what waits for the owner, with IDs
Next           the next step
```

Skip a line that does not apply. Do not write a long walkthrough unless the owner asks.
