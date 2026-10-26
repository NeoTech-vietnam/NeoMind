---
name: neomind-cornell
description: Capture source-backed research and learning as Cornell notes with worked examples, mapped questions, practice and separate answers. Use within a NeoMind assignment for durable findings or when preparing a reviewed note for the user's notes repository.
---

# Cornell evidence notes

## Backend-owned session

An explicit NeoMind-owned role/stage packet and bound tools select this branch. Use the advertised `cornell_research_compile` for the assigned bundle; the backend binds the requirement, output folder and provenance. Pass existing semantic research JSON by `input_path`, or supply newly authored semantic fields. Primary implementation supplies an expected worked result; a separately assigned synthesis uses actual current check evidence. Preserve separate practice and answers and save one compact `assignment_report`. The backend schedules verification and required review. Use the runtime-provided controlled-workflow guide for payload and evidence details.

## Client intake and other saved modes

For controlled client intake without a worker packet, submit through `manager_run` or resume the exact receipt through `manager_control`. The preparation, export and publication sequence below applies only to a matching saved non-controlled execution mode and its existing authorization.

1. Read the saved requirement, its current revision, assignment and existing notes. Reuse the same workflow and current applicable note. Consolidate the explanation into one visible narrative linked from engineering records.
2. Collect supporting sources with titles, retrieval dates, locators and local file or record fingerprints. Label material claims observed, source-reported, expected or inferred. A retrieved citation supports only what its source establishes.
3. For structured research, author an abstract, O1-style objectives, methods, explanations, results, discussion, worked example, Q1-style research questions and P1-style practice. Map every objective to an assessment; supply reference answers separately. Use read-only `cornell_research_compile` to inspect the deterministic note envelope, then pass its `recipe_input` to existing `recipe_prepare`. CLI `cornell prepare` provides the equivalent reusable preparation. Supply actual requirement/workflow IDs and revision. Read the installed package's `docs/cornell-workflow.md` for the exact schema when available; these core rules also apply to direct `note_create` inputs.
4. Review and run the saved `cornell-evidence-note` instance through the existing recipe gates and `recipe_run`, or use the authorized `note_create` route. A worked example may stay expected. Practice has an argument-vector command or, for structured research, explicit manual steps. Preserve user-written solutions; supplied answers and format checks establish no learner completion. Root-cause notes additionally cover reproduction, hypotheses, eliminating evidence, confirmed/unresolved conclusion, repair and regression results.
5. Run `note_validate` and obtain the required current independent note review. Resolve stale sources, artifact changes, broken links and unsupported claims before reporting a validated finding. Only actual passing execution evidence supports observed outcomes; independent review assesses educational correctness.
6. When the user requests a notes copy, use explicit CLI `neomind cornell destination` / `configure`, then `export-plan --data-file FILE`. The default directory is `00_note/NeoMind`; external `notes_root` is a per-project choice. Present the exact preview and apply its saved hash with `export-apply` within the authorized scope. Include only reviewed files, preserving authored solutions unless explicitly selected. A changed source, requirement, review or target requires a fresh preview; preserve authored edits.

For an explicitly requested remote publication, use CLI `cornell publish-plan` with the completed export hash, selected remote and base branch, then `cornell publish` with the reviewed publication hash. The existing remote-enabled policy is required. Publication creates one new review branch using an isolated Git index; PR creation and merging are separate actions. Stop on changed hashes, a moved base, a conflicting branch or unavailable credentials and report the concrete blocker. Agent MCP tools do not push notes.

Completion requires current validation, engineering links, substantive sources, a concrete demonstration and practical exercises. Report generation, local copy and remote branch publication as separate outcomes using their actual receipts. The exact quote comes from the installed Cornell template. The managed record owns provenance; the visible note owns the explanation.
