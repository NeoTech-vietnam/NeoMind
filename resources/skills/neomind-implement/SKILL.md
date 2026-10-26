---
name: neomind-implement
description: Implement an assigned NeoMind software, firmware, or hardware task within its allowed scope, then submit artifacts and actual check results.
license: MIT
---

# Implement a bounded assignment

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Read the supplied baseline and implement only the assigned paths with `task_file_write`. Use advertised `task_run` with its declared step title or a bound `procedure_run`; pass already-readable public prepared JSON by `input_path` rather than copying serialized tool text. The backend captures the payload's read-only source baseline while retaining the saved command and write scope. A report-only assignment edits only its supplied report paths using actual bound evidence. Save one compact `assignment_report`; the backend schedules independent checks, review and closure. Follow the runtime-provided controlled-workflow guide when payload or evidence details are needed.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. The sequence below applies only to a matching saved non-controlled execution mode and preserves that mode's contract.

1. Read `.neomind/roles/developer.md` and `.neomind/guides/workflow.md`. Inspect `neomind context <task-id>`, the baseline, allowed paths, dependencies, and working tree.
2. Assess the `ready` gate, then start the task using core operations. Complete the assigned behavior within the agreed contracts and ownership boundary.
3. Run the applicable executable checks through the `check` command group. Capture actual results and implementation artifacts. Report unavailable checks and failures explicitly.
4. Update the task's implementation references and required project documentation. Complete substantive content under all seven sections of the standard work-record template.
5. Submit the task with outputs, evidence pointers, remaining limits, and the full `work_record` body for an independent reviewer invocation. The core stores the linked work record; documentation remains part of the reviewed baseline.

Use `neomind --help` for exact task, record, and check arguments. Return interface changes, missing inputs, or out-of-scope work to the manager. One feedback repair is allowed; repeated failure triggers escalation. Submission is distinct from acceptance.
