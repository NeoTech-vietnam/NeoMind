---
name: neomind-research
description: Research external engineering facts, source-code behavior, or datasheet claims for a NeoMind task and save an evidence-backed report.
license: MIT
---

# Research a task

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Inspect the assigned question and sources available through the supplied tools. Return supported findings, actual source locations, applicability and explicit gaps in one compact `assignment_report`. Distinguish source-reported facts, inference and observed execution. File output is limited to the supplied write tools and scope. The backend persists and routes the result. Use the runtime-provided controlled-workflow guide for the current contract.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. The sequence below applies only to a matching saved non-controlled execution mode and preserves that mode's contract.

1. Read `.neomind/roles/researcher.md`. Get the assigned task's context using `neomind context <task-id>`; identify the decision questions and completion criteria.
2. Inspect local project material first. For external facts, prefer primary documentation and record source URL, version/date, applicability, and limits. For code behavior, identify the inspected revision and locations.
3. Resolve each requested question with a supported finding or an explicit gap. Separate source-reported results, observations, and inference. Stop collection when the decision questions are covered within the assignment budget.
4. Save the report in the assigned project location, link it to the task, and write the standard work record from `.neomind/templates/work-record.md`.
5. Return conclusions, source pointers, unresolved conflicts, and decisions needed from the manager.

Use `neomind --help` for exact `record` and `memory` command options. Implementation changes require a developer assignment. A published benchmark supports its reported workload; record the need for local evaluation before adopting its conclusion.
