---
name: meeting-recap
description: Create a structured meeting recap DOCX from a VTT or DOCX transcript. Use when the owner asks for meeting notes, a recap, decisions, or action items from a meeting transcript.
---

# Meeting Recap

Create a concise, evidence-based recap from the transcript the owner provides. Works with VTT and DOCX transcripts.
Write the recap in English by default; use another language when the owner asks.

```text
find source ──> read all ──> sort into topics, decisions, ──> build DOCX ──> reopen, render, ──> report
(folder rule)   (VTT/DOCX)   open questions, actions         (fixed layout)   check every page
```

## Find the source

- Use an explicit transcript path or meeting-folder argument first.
- Meetings live where the owner says. Read the meeting folder from `.claude/memory/MEMORY.md`. If it is not recorded,
  ask once, then record it there (`G12`). The layout under it is one dated folder per meeting, `<YYYYMMDD>/`, with the
  recap in a `recap/` subfolder.
- Search the dated folder recursively. Exclude files inside `recap/` when you select a transcript.
- If no source is given, take the most recently modified dated folder and its newest `.vtt` or `.docx` transcript.
- If more than one plausible transcript remains and the choice could change the recap, ask which one to use.

## Read and analyze

- VTT: extract each cue's timestamp, speaker and text. Join adjacent captions from the same speaker when useful. Keep
  the timestamps so you can check claims.
- DOCX: convert to Markdown with `markitdown` before reading when it is available. If that fails, extract paragraph and
  table text with `python-docx`.
- Keep extracted text in memory or a temporary folder. Do not leave `transcript_text.txt` beside the meeting files.
- Read the full transcript. Group related discussion into sections. Find the metadata, findings, explicit decisions,
  open questions and action items.
- The transcript is the primary source. Use related project documents only to correct clear speech-recognition errors in
  names, labels and established terms. Do not use them to fill gaps in what the meeting decided.
- Keep uncertainty. Attribute proposals and reports to the speaker. A suggestion, a tentative agreement or a discussion
  is not a decision.
- Assign an action only when an owner accepted it or the transcript clearly assigns it. Keep the stated owner and
  deadline. A person who presented a topic does not own its work by that fact.
- Check technical terms and numbers against the transcript. If the audio is unclear and the detail matters, omit it or
  flag it in the final reply (`G3`).
- State attendee roles and absences only when the transcript supports them. Estimate the duration from the timestamps
  and label it approximate.

## Create the DOCX

Save the recap as `<meeting folder>/<YYYYMMDD>/recap/Meeting Recap - <YYYYMMDD>.docx`.

If that file exists, keep it. Write a parallel file with the harness suffix (`_codex` or `_claude`). If that exists too,
add a number. Overwrite only when the owner explicitly asks.

Use `python-docx` and a document-rendering skill when one is available. Default layout (the owner's house style in
`MEMORY.md` wins):

- Centered title `Meeting Recap - YYYY-MM-DD`, 18 pt bold, color `#003A70`.
- A four-row, two-column `Table Grid` metadata table: Date, Attendees, Topic, Next meeting. Use `TBD` when no next
  meeting was set.
- One Heading 1 (14 pt bold, `#003A70`) for each discussion topic, with 10 pt bullets for the details.
- Heading 2 (11 pt bold, `#1F497D`) for a Decision, Finding or Open question block when the topic has one.
- An Action Items section at the end. Format each item as `[Owner]  description`, with the owner bold and `#003A70`.
- A centered 9 pt italic grey last line: `- End of Recap -`.
- Page margins: 1.0 in top and bottom, 1.2 in left and right.

Add no source note or extra section unless it explains a material ambiguity in the transcript (`G8`). Keep the recap
short. Keep technical detail only when it changes how a result or a follow-up reads.

## Verify and report

- Reopen the DOCX. Check the title, the four metadata rows, the headings, the action owners and the full text.
- Render it and look at every page. If no renderer is available, finish the structural checks and say that you could
  not check the pages visually.
- Reply in the owner's language. Name the output file, the number of topic sections and the number of actions. State
  any material assumption or unclear transcript point. Do not say the recap was approved or sent unless the owner says
  so.
