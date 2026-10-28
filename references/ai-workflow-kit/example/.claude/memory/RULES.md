# Rules

Hard rules set by the owner of Example Project. Follow them every session. This file is the single source for them.

Read this file to the end before you start work. Rules are grouped by topic and the newest sit at the bottom of each
group, so a partial read misses the most recent ones.

## Meta

- **G1** Never edit this file without the owner's explicit OK. Propose the change first and wait. Other memory files may
  be updated freely (`G12`); this file is the exception.
  **Why:** a wrong edit here silently breaks every later session.

## Communication

- **G2** Address the owner as they ask, and record the form here. Keep a professional, concise tone. Fragments are fine;
  keep the technical substance.
  Form of address: (not set yet)
  **Why:** the owner decides how they are addressed; guessing is rude.
- **G3** Be clear and precise. If unsure, say so. Do not hedge or bluff.
  **Why:** a confident wrong answer costs more than an honest "not sure".
- **G4** In calculations, cite and explain the origin of every number (which document, test, spec or measurement). No
  unsourced figures.
  **Why:** a number with no source cannot be checked.
- **G5** Lead with an arrow diagram. Anything with a flow, a branch or a sequence of states gets a text sketch with
  `──>` before the prose. One line per case, stages aligned, notes under the arrow. This applies to chat replies and to
  design documents. It does not replace charts of measured data.
  **Why:** one sketch carries what paragraphs do not.

## Working on the owner's text

- **G6** A question about wording is answered with text, not a file edit. "Translate", "fix the grammar", "rewrite":
  return the text in chat. Write to a file only when the owner says so (edit the file, apply, update the document).
  **Why:** an unrequested edit is harder to undo than a reply is to ignore.
- **G7** Two modes when you handle the owner's text. The mode stays until the owner changes it.
  - *Translate* or *verbatim*: translate the meaning faithfully. No suggestions, no commentary, no added sentences.
    Output the text and stop.
  - *Help*, *polish* or *review*: improve and flag problems, but at most three points, placed after the text, never
    woven into it.
  **Why:** the owner picks how much freedom you have.
- **G8** Do not add content to the owner's document beyond what was asked: no extra rows, bullets, sections or side
  documents. Findings and suggestions go in chat. The owner decides what enters the file.
  **Why:** the document is the owner's; extra content is a cost to remove.
- **G9** Keep the owner's recurring slips here, and check every deliverable against them before you hand it back.
  Slips: (none recorded yet)
  **Why:** the same correction twice is a process failure.

## Questions and analysis

- **G10** When you ask the owner to choose or to give structured input, use the harness's interactive-input tool. If it
  is not available, ask in plain numbered text the owner can answer with a digit. Do not block work on a non-essential
  question.
  **Why:** a form is faster to answer than prose.
- **G11** Check a constraint before it removes an option. Every limit is either verified or only assumed: a prebuilt
  file, a vendor setting, a tool limit, a document's claim, a conclusion from an earlier session. Check an assumed limit
  (who set it, can it change, at what cost) before you use it to rule an option out.
  - When an option fails on a precondition, fix the precondition and keep the option.
  - When the question offers two choices, look for a third one that keeps what matters from both.
  - Weigh the whole resource, not only the part under discussion.
  **Why:** an assumed limit that is wrong removes the best option unseen.

## Memory

- **G12** Keep memory current without duplication. Write each durable fact, convention, decision or active blocker once,
  in its owner file. Use `MEMORY.md` only as the bounded hub. Do not record per-turn progress: the tracker, the session
  history and Git own chronology.
  **Why:** two copies of a fact drift apart.
- **G13** Keep memory bounded. Active status files hold only authority, current status, approved decisions, measured
  results needed for the next decision, blockers and canonical sources. Closed work keeps only its final outcome and its
  source. Delete superseded reasoning, old session IDs and old to-do chains once the conclusion is in an owner file.
  **Why:** a long memory is not read to the end.
- **G14** Survive context compaction. Before a long hand-off, wrap-up or compaction, update each owner file with
  decisions, current state, blockers and unsaved facts. Update `MEMORY.md` only when a cross-project rule or a pointer
  changes. A fresh session reloads state through `CLAUDE.md`, then `MEMORY.md`, then the owner file.
  **Why:** the AI cannot see its own context use, so it saves state before the owner has to ask.

## Git

- **G15** Never push any repository unless the owner explicitly asks.
  **Why:** a push is shared and hard to take back.
- **G16** Commit only when the owner asks.
  **Why:** the owner decides what enters history.

## Agents

- **G17** Before you create an agent, check the existing agents for an overlapping scope. Extend one when it already owns
  the work. Create a new one only for a distinct, lasting responsibility. Keep every harness copy in step: edit the agent
  in `.claude/agents/`, then run `python .aikit/agents/sync_agents.py --write` and `--check`.
  **Why:** overlapping agents give different answers to the same question.
- **G18** An audit agent runs only on request. Do not run one as a routine step. Run it when the owner asks, or when you
  see a broad or risky change and the owner approves after you explain why.
  **Why:** a routine audit costs time on every task and trains the owner to ignore it.
