# Lightweight native workflow

## Contract

This is NeoMind-persisted Copilot native-client execution, not the signed bridge coordinator. Native VS Code tools edit and check under existing permissions. `manager_run` returns saved state and a native-agent handoff immediately; there is no bridge polling. Reports are `unsigned-native-report`, never strict acceptance or independently attested model/evidence receipts. Strict validators, task permissions and previous workflows stay unchanged.

Read `automation.json` and `routing.json` first. New ordinary requests may select `execution_mode: lightweight`. Existing workflows retain their saved mode. Explicit strict/signed acceptance, release qualification, security/safety changes or broad irreversible migrations require a new strict increment before mutation. Configuration alone never authorizes execution. Domain approvals remain authoritative.

## Procedure

For universe visibility, use `agent_activity` with the saved workflow_id, stable assignment_id, exact profile_id, observed state and a short non-sensitive summary. Coordinator uses assignment_id `coordinator`, reports dispatched before actual delegation, and passes assignment identity to each specialist. Specialists report running before work and completed/blocked/failed after actual results, updating long work at meaningful milestones/at least every two minutes. Coordinator reports final activity before the final checkpoint. Progress expires after five minutes without an update. These unsigned observations do not replace lightweight_checkpoint and do not enable full-workflow reporting or signed acceptance.

1. Use the configured strong model in `NeoMind Coordinator Agent`; no silent replacement. Read relevant source and project standards. Save at most five plan steps and risk-based review rationale before editing. An agent already executing the handoff continues directly without another `manager_run`.
2. Execute with native tools. Delegate only for useful research, disjoint ownership, diagnosis, verification or review, using the applicable profile from `copilot-native.md`. Explorer, Researcher, Implementer and Debugger use their configured worker routes; Planner, Architect, Verifier and Reviewer use their configured strong routes. Implementer and Debugger share the `developer` route. Preserve user edits and native permissions.
3. Run relevant checks against final changes. Save actual command, result and concise output. Failed or unavailable required checks leave phase `blocked` with a concrete next action.
4. Obtain separate review for authorization, persistence, concurrency, public contract changes or other meaningful risk. Save actual returned invocation identity and result. Unavailable review remains `pending` and blocks completion. Low-risk work may use `not-needed` with a specific rationale. Reports are not signed receipts.
5. Checkpoint actual changes, checks, limitations, review and next action. No mandatory specialist rounds, Cornell exercises, archives or PRs for lightweight work. Publication requires separate authorization.

## Persistence and resumption

Start `manager_run` with a stable `request_id` and complete original requirement. Generic intake launches returned `handoff.agent` (`NeoMind Coordinator Agent` for Copilot) once with its unchanged prompt through the standard agent tool, then waits for its result. A directly selected Coordinator continues that returned prompt itself; an already assigned Coordinator continues its packet without another intake call or self-launch. A failed launch is a blocker, not permission for inline substitution. Resume by `workflow_id`, preserving exact original text if supplied; no recursive intake or unrelated workflow resumption. Only Coordinator is user-invocable; specialists execute their bounded assignments as delegates.

Supply `message` for a clarification or narrower continuation. Validated messages persist separately in ordered `continuations`; `original_requirements` never changes. Handoff includes both, including saved continuations when resuming without a message or retrying the intake request ID. Repeating the latest message is idempotent; adding another advances the revision, so reread before checkpointing. Continuations cannot expand original authorization. Completed reports reject new continuations; create a new increment instead.

Use `lightweight_checkpoint` with `workflow_id`, current `expected_revision`, `phase` (`execution`, `blocked`, `completed`), `risk` (`low`, `elevated`, `strict-required`), `plan`, `changed_files` (canonical project-relative paths), `checks` (`command`, `result`, `output`), `limitations`, `review` (`disposition`, `reason`, actual `invocation_id` and `result: pass|fail` for completed review), `summary` and `next_action` while unfinished. Re-read revision after updates. CLI equivalent: `workflow checkpoint WORKFLOW_ID --data JSON`; `workflow status WORKFLOW_ID` reads saved state. Signed bound worker sessions cannot checkpoint lightweight reports.

Completion requires a plan, passing relevant checks and resolved review; elevated risk requires a separate passing review. Storage status is `submitted`, never `accepted`. Reports are not an execution sandbox or proof of actual checks. If configured model selection, review or required tools are unavailable, checkpoint a blocker instead of inventing success.

## Source-backed reproducibility

`src/lightweight.ts`, manager/CLI/MCP integration and generated adapter instructions implement this mode upstream. Build from source and run regression tests before packaging; no installed `dist` patch is required. `npx neomind update` regenerates agents from `routing.json`. Client access and model/tool support still require live verification. See `docs/copilot-runtime.md` for MCP, native-agent and signed-bridge boundaries.
