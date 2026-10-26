---
name: neomind-requirements
description: Turn stakeholder needs into measurable NeoMind requirements and checks, or assess requirement changes and affected records.
license: MIT
---

# Define measurable requirements

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Read the supplied user intent, constraints and existing baseline. Describe observable behavior, measurable acceptance criteria, assumptions and checks for the assigned question, then save one compact `assignment_report`. The backend binds records and ownership and retains committed criteria. Use the runtime-provided controlled-workflow guide for the current contract.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. The sequence below applies only to a matching saved non-controlled execution mode and preserves that mode's contract.

1. Read `.neomind/roles/requirements.md` and `.neomind/guides/process.md`. Inspect the current needs, baseline, profile, constraints, and existing requirements.
2. Write one observable behavior per requirement. Specify conditions, measurable acceptance criterion, source, rationale, assumptions, and verification method using the installed requirement template.
3. Link derived requirements to their source needs and define corresponding checks. Distinguish intended-use validation from specification verification.
4. For a change, preserve its rationale and old baseline. Use the `trace` command's impact view to identify downstream records needing reassessment.
5. Confirm every in-scope need has a requirement/check or recorded disposition. Save a work record and return unresolved product decisions to the manager.

Use `record`, `trace`, and `verify` through the CLI or equivalent MCP core operations. Read `neomind --help` for arguments. The step is complete when the `ready` criteria can be assessed against specific records, rather than a promise of future tests.
