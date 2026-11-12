---
name: neomind-flow-authoring
description: Read before creating, editing, publishing or debugging a NeoMind flow, AI profile (agent) or NeoMind skill, and whenever a NeoMind run is blocked, stuck or produces no output. Covers runtime constraints that flow validation does not catch, a preflight checklist, and how to diagnose a failed run from its logs instead of guessing. Applies to any agent, model or runner, and to humans.
---

# Authoring NeoMind flows without trial and error

Tool names below are the NeoMind tool names without any client prefix (your client may show them as e.g. `<prefix>neomind_flow_draft`).

## Why this exists

Flow validation (`neomind_flow_validate`) only checks the schema. A flow can validate cleanly and still fail at preview or at runtime. Every test run costs hundreds of thousands of tokens and several minutes, so get the design right before the first run. One earlier attempt needed 11 versions because these rules were discovered one failed run at a time.

Since 2026-11-12, validation also runs what a preview would refuse (bindings, runners, models, profile versions, skills) and the authoring rules marked below. Errors block publishing; diagnostics with `severity: "warning"` do not. Rows without a marker are still not checked: keep following them.

## 1. Start from something that already runs

1. List flows (`neomind_flows`). If the project has a working custom flow close to the need, start the new draft from it (`neomind_flow_draft` with `from: {flowId: "<working flow>"}`).
2. Otherwise read the built-in flows (`neomind_flow_get` for `fast`, `dev`, `research`, `parallel`) and copy the shape of the closest one. Do not invent a node graph from scratch.
3. Read `neomind_flow_blocks` for node types, project policy (for example `requireApprovalBeforeWrite`, `maxRepairRounds`) and role defaults.

## 2. Runtime constraints that validation does not catch

| Rule | What you see if it is broken |
| --- | --- |
| Custom profiles do not inherit the project's runner and model. Pin every binding field (runner, provider, model, reasoning) with `{"mode": "pinned", "value": ...}`. The only modes are `inherit` and `pinned`. (NeoMind ≥ 2026-11-12 reports error `binding_unresolved` naming each step and missing field) | Preview error: no value configured for runner. |
| Use only runner ids that this NeoMind installation supports (seen so far: `codex` with provider `openai`, `claude-code` with provider `anthropic`, `opencode`). A plausible-looking name such as `claude` is rejected. If unsure, look at the runner values recorded in past runs' `events.jsonl`. (NeoMind ≥ 2026-11-12 reports error `unknown_runner` with the likely id, and `provider_mismatch` / `model_not_allowed` / `reasoning_not_supported` for Codex and Claude Code bindings) | Preview blocker: runner not supported. |
| A `join` node needs `requiredBranches`. A profile draft needs a numeric `version`. (schema error already; NeoMind ≥ 2026-11-12 also reports `missing_profile_version` when a step references an unpublished profile version) | Schema diagnostics on draft. |
| A `review_group` can only review a node that changed files (it needs a baseline). It cannot review a text-only or report-only node. (NeoMind ≥ 2026-11-12 reports error `review_target_plan`. Verified cause: a `plan` step is recorded without a baseline. A read-only report step does record one and can be reviewed, as in the built-in `research` flow) | Run blocked: no execution baseline to review. |
| An `approval` node with `mode: "auto"` needs an earlier agent node whose `outputContract` is `plan` (the `fast` shape: plan, then auto approval, then implement). (NeoMind ≥ 2026-11-12 reports error `auto_approval_without_plan`: the plan step must be the direct predecessor of the approval) | Run stuck in `waiting_approval`: no plan to auto-approve. |
| Reviewers inside a `review_group` may be unable to run commands. Never make "re-run the tests yourself" a pass condition. Let them verify by reading the code and accept quoted output that is consistent with it. (NeoMind ≥ 2026-11-12 warns `review_needs_commands` when criteria ask to run commands and the reviewer runs on a runner without a shell or its profile lacks checks) | Repair loop until the repair budget is exhausted. |
| The plan step chooses the checks that gate the run. If a check is expected to fail (for example tests of a deliberately wrong program that is being reviewed), the plan step's goal must say exactly which checks to list. | Run blocked on a failing check. |
| Review evidence (artifact hash, source line number, quote) is validated character by character. Tell reviewers: one reference per criterion, prefer quotes from the artifact, copy hashes and quotes exactly, re-check before returning. Give reviewers a careful, higher-reasoning model; sloppy models fail here repeatedly. | Run blocked: evidence or criteria not verified / receipts must be copied exactly. |
| A read-only flow writes no file; its result exists only in the run transcript. If people need a file, add a write step with a narrow `writeScopes` and name the single file it may change. (NeoMind ≥ 2026-11-12 warns `read_only_output_file` when a flow without a write step asks for a file) | "Where is the output?" |
| Some runners may give a read-only step no shell, so it cannot run tests. Either give that step check permission and confirm it really runs commands, or accept trace-based evidence clearly marked UNVERIFIED. (NeoMind ≥ 2026-11-12 warns `step_cannot_run_commands`. Verified: only `codex` sessions have a shell; `claude-code` and `opencode` sessions get file tools only, read-only or not) | Report says tests could not be run. |
| Do not instruct agents to "write UTF-8 without BOM"; on Windows one agent then wrote the system code page and destroyed non-ASCII text. Say "keep non-ASCII characters intact (UTF-8)". (NeoMind ≥ 2026-11-12 warns `bom_instruction` in flow text and profile instructions) | `?` in place of accented letters. |

## 3. Preflight checklist (before the first run)

- [ ] Shape copied from a built-in or a working flow. Every node reachable from `start`; every path ends at `finish` (validation reports `unreachable` and `dead_end`).
- [ ] Every binding pinned with a supported runner id. Higher reasoning for reviewers and auditors.
- [ ] Every `review_group` targets a node that writes files. No review criterion requires running commands.
- [ ] Every auto approval has a plan node before it, and the plan goal names the checks to use.
- [ ] Write steps have minimal `writeScopes` and name exactly which files they may change.
- [ ] Profiles referenced at their exact published version. Skills pinned at their current hash (after editing a skill, re-pin and re-publish the profiles that use it). Validation reports `missing_profile_version`, and warns `skill_changed` (a run still refuses a changed skill).
- [ ] Validate is clean, the diff was shown to the person you work for, the flow is published, and preview shows no blockers.
- [ ] The flow is the smallest one that does the job. Every extra node is another place to break and costs more tokens.

## 4. When a run fails: diagnose, don't guess

1. Status and wait tools only give a one-line reason. Read the real cause in the NeoMind data directory (on Windows `%LOCALAPPDATA%/neomind/<project-hash>/`): `runs/<runId>/events.jsonl`. Search it for `validation failed`, `review_retry_requested` and `runtime_state` entries with phase `blocked`.
2. Agent transcripts are in `runs/<runId>/transcripts/`. Files a run wrote are in `workspaces/<runId>/`.
3. List all the risks you can see, fix them together, redo the preflight, then run once. Never fix one symptom and re-run the whole flow each time.
4. Before switching models, decide whether the failure is a design problem (section 2) or model sloppiness (evidence receipts, encoding, wrong claims). A better model does not fix a design problem.

## 5. Working with the person you work for

- Show the validation diff before every publish; never publish silently.
- Ask before applying a run's changes to their checkout. Cancel stale runs only when asked.
- Report the token and time cost of each test run.
