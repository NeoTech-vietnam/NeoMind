---
name: neomind-verify
description: Define or execute NeoMind verification checks, validate evidence against its baseline, or independently review a submitted increment.
license: MIT
---

# Verify and review

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Verifier inspects implementation, writes only its checker/fixture paths and runs the prescribed `check_run`, including negative controls. Reviewer is read-only and uses `check_evidence` for actual execution and the backend workflow view for scoped preservation and lifecycle facts. Return one compact `assignment_report` with the actual verdict and concrete cause of any failure. The backend owns acceptance and recovery. Follow the supplied checkpoint/final-check purpose and runtime-provided controlled-workflow guide.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. The sequence below applies only to a matching saved non-controlled execution mode and preserves that mode's contract.

1. Read `.neomind/roles/verifier.md` for check work or `.neomind/roles/reviewer.md` for independent review. Read `.neomind/guides/process.md` for the selected gate and profile.
2. Inspect the requirement/design baseline, actual deliverable, check definitions, and prior evidence. Match each criterion to an appropriate method and expected result.
3. Execute authorized checks through core operations. Capture result, revision, environment, tool versions, output references, time, and limitations. Identify simulation, bench, HIL, or manual methods accurately.
4. Archive required execution evidence before final review. For review, run a separate invocation from implementation. Assess specification conformance, engineering standards, substantive work records, required project documentation, and evidence sufficiency on the current baseline; save actionable findings and their dispositions.
5. Run the appropriate `verify` gate and save a work record. Return failures and gaps to the manager with affected criterion and next action.

Use `neomind --help` for exact check, record, trace, and verify arguments. A hook notification or test summary alone cannot establish acceptance. Reassess evidence after a changed input or baseline.
