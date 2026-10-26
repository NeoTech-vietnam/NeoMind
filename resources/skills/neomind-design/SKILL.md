---
name: neomind-design
description: Design system or component boundaries, software-hardware interfaces, and verification allocations for NeoMind requirements.
license: MIT
---

# Design a verifiable increment

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Inspect the supplied requirements and readable project artifacts. Resolve the assigned architecture/interface question with concrete boundaries, failure behavior, tradeoffs and verification implications. Save one compact `assignment_report` with supported findings and unresolved decisions. The backend owns persistence, review and transitions; a consultation does not create another workflow. Use the runtime-provided controlled-workflow guide for the current contract.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. The sequence below applies only to a matching saved non-controlled execution mode and preserves that mode's contract.

1. Read `.neomind/roles/architect.md`. Inspect the task context, approved requirements, constraints, previous design, and research.
2. Identify boundaries and required/provided contracts. Allocate each requirement to a component or hardware/software responsibility. Record data, power, and control flow where relevant.
3. Specify failure behavior, operating limits, assumptions, tradeoffs, and applicable verification levels in design records using the installed template.
4. Link design decisions to requirements and planned checks. Coordinate changed interfaces with the manager and affected component owners.
5. Request design review, disposition findings, and assess the `design-ready` gate through `verify`. Save the standard work record with unresolved limits.

Read `.neomind/guides/process.md` for profile-specific evidence. Use `neomind --help` for record and gate arguments. Label simulation and estimates by their actual validation status.
