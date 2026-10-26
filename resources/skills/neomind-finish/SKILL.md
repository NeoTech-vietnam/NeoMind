---
name: neomind-finish
description: Finish or checkpoint a NeoMind task, record resumable role history, and prepare generalized lessons for reviewed knowledge contributions.
license: MIT
---

# Finish with evidence and reusable knowledge

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Read the supplied current state and advertised evidence, then save one compact `assignment_report` with the actual professional result, remaining findings and limitations. Preserve incomplete work with its truthful outcome. The backend evaluates verification, required review and workflow closure; a saved worker result alone establishes none of those. Use the runtime-provided controlled-workflow guide for report lifecycle details.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. Report closure only from the actual runtime state. The sequence below applies only to a matching saved non-controlled execution mode and preserves that mode's contract.

1. Read `.neomind/guides/workflow.md`. Inspect the current task, baseline, submissions, review findings, and evidence.
2. Run `neomind verify TASK_ID --gate accepted`. Use `neomind task accept TASK_ID` only after that gate passes. A `verified` result alone does not establish acceptance. Record any owner-approved exception as a reviewed change to the requirement baseline, then reassess affected designs and rerun checks; exceptions do not bypass missing or mismatched evidence. For incomplete work, record its blocker and next executable action.
3. Confirm that core submission stored a substantive seven-section work record and that required documentation was reviewed. Repair missing content before a passing review; writing documentation after acceptance changes the reviewed baseline and requires reassessment.
4. Read `.neomind/roles/curator.md`, `.neomind/guides/process.md`, and `.neomind/guides/manager.md`. Consolidate qualified lessons and create a separate generalized candidate with provenance, applicability, assumptions, limitations, and independent generalization review. Record a specific no-lesson reason when none applies.
5. Complete contribution disposition through the contribution core under `.neomind/automation.json`: enabled policy creates a reviewed draft PR automatically; disabled policy keeps the candidate local. Keep upstream merging pending human approval. Finish the manager workflow only after child tasks and policy-required contribution disposition are accounted for.

Use `neomind --help` for exact task, record, memory, and pack arguments. Record unavailable model/cost observations explicitly. A resumption note is complete when a new session can find the baseline, current state, outstanding decisions, and next action.
