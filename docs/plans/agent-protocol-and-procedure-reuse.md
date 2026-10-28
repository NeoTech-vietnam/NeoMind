# NeoMind agent protocol and procedure reuse implementation plan

> **Historical roadmap; superseded for the WorkForce release.** Follow the [consolidated WorkForce plan](2026-10-28-workforce-final-plan.md) for current implementation decisions. Preserve the material below as provenance; do not reintroduce its native assignment handoffs, agent catalog or repair gates into the new controlled engine. Existing shipped procedure capabilities remain reusable as specified by the current plan.

Status: design and implementation roadmap, 2026-10-24. Initial baseline: `codex/plugin-control-panel` including local alpha.7 work. Alpha.8 implementation is on `codex/procedure-automation`: project script registration/discovery, parameterized execution and qualification, SQLite/FTS5 intake, native assignment handles/results, source-candidate traceability and Automation Library. Read `docs/procedures.md` for the shipped interface. The roadmap also contains later hardening and evaluation work; its full set of phases and native-client pilots must not be inferred complete from the initial release or fixture results.

The objective is to stop spending model reasoning on ownership fields, tool sequencing and report serialization, while letting proven procedures handle compatible repeat work. Extend the existing engineering core, recipe engine, indexing and native adapters rather than adding another orchestrator. Agents supply task-specific judgments and results; a deterministic module supplies valid context and calls the existing lifecycle operations.

## 1. What the current system already provides

| Existing capability | Current implementation | Implication |
| --- | --- | --- |
| Nine visible expert profiles over twelve core roles | `src/agent-profiles.ts`, `docs/roles.md` | Preserve saved role IDs and actual delegation; improve their interface rather than replace the set again. |
| Operation permissions and record authorship checks | `src/tools.ts`, `src/mcp.ts` | Scripts should call dedicated operations with derived context, preserving ownership guards. |
| Local assignment identity fallback | `src/native-assignment.ts`, `resources/guides/reported-assignments.md` | Reuse packet preparation and claiming; callers still transport credentials and manually assemble related fields. |
| Full lifecycle, immutable evidence and independent review | `src/manager.ts`, `src/engineering.ts`, `src/evidence-inputs.ts` | Completion comes from current gates, not an agent's `completed` string. |
| SQLite records and FTS5 search | `src/indexing.ts` | A database already exists. Its current records search is not an approved-procedure selector. |
| Provenance-bearing local knowledge search | `src/knowledge-reuse.ts` | Candidate retrieval exists, but text/platform similarity is deliberately advisory. |
| Three shipped parameterized recipes requiring current instance reviews/checks | `src/recipes.ts`, `resources/recipes/` | Begin with Cornell evidence notes, software configuration persistence and embedded hysteresis load control. Catalog presence and hashes do not establish procedural maturity. |
| Structured Cornell research compiler and export | `src/cornell-workflow.ts`, `src/cornell-publication.ts` | Reuse the format compiler and destination policy, including `00_note/NeoMind`; do not create another note format. |
| Lightweight native workflow | `src/lightweight.ts` | An eligible new request can use a compact route under policy; existing full/strict increments retain their saved mode. |
| Model routing and bounded repair escalation | `src/routing.ts`, `src/native.ts`, `src/engineering.ts` | Model availability fallback exists, but it is not yet a procedural maturity policy. |
| Native evaluation harness | `scripts/evaluate.mjs`, `docs/evaluation.md` | Extend existing measurements instead of inventing savings from estimated model prices or configuration. |

Current limitations matter to the implementation. Recipe preparation accepts `manager-workflow`, not `lightweight-workflow`. Lightweight recipe execution therefore needs an explicit adapter. Knowledge compatibility is currently prose, rather than a structured version/applicability resolver. SQLite is disposable retrieval state rebuilt from authoritative artifacts; a database row must not become authority for successful execution or maturity.

## 2. Why the reported errors happen

These guards are useful. The problem is requiring each model to reconstruct their inputs correctly on every call.

| Observed error | What the guard checks | Planned prevention |
| --- | --- | --- |
| `Activity task must belong to the same unsigned workflow.` | The supplied task is a real task owned by the selected compatible unsigned workflow. | Derive task, workflow, profile and correlation key from one validated assignment context. An actor cannot choose them independently in a progress update. |
| `Assignment reporting requires a bound invocation or reported native workflow identity.` | A signed invocation or valid native identity and targets exist. A display name/activity key is insufficient. | Establish the actor session during actual delegation. The report renderer uses that session and allowed targets; the worker supplies substantive result fields. |
| `Native updates cannot rewrite workflow ownership, assurance, or reserved lifecycle state.` | A generic record patch does not include protected ownership, mode, assurance or lifecycle fields, even when copied unchanged. | Generate operation-specific patches. Completion calls `task_submit`, review and closure operations; it never sends a read record back as a generic update. |

There is also live guidance drift to repair. The common native identity instructions tell every specialist to call `manager_discuss`, while Developer, Check Executor and Release do not have that operation. The Requirements role document permits check-plan creation, while executable authorship reserves `check` records for Verifier. Generate guidance from the executable role contract and make output obligations conditional on permitted operations. Do not grant unrelated privileges just to make contradictory prose succeed.

A subsequent actual Copilot trace for workflow `NM-11D03369-KNW-0061` exposes a bootstrap failure: Explorer called `assignment_claim` with the correlation label `exercise-explore`, an empty claim token, and `reported_assignment: {id: "", token: ""}`. Coordinator later called `assignment_prepare` with the same empty optional credential object. Both failed with `Invalid local reported assignment identity` before a new packet/session existed. The required report was consequently unavailable; this trace does not establish a report storage failure. The runtime must omit an optional credential until one exists, claim the prepared server-issued packet identity rather than its display/correlation label, and inject valid credentials after actual claim. Missing or partial credentials must not turn into an authorization bypass.

Prevention applies to avoidable protocol mistakes. Real failed tests, unavailable execution permissions, incompatible scope and missing tools remain visible outcomes. Repeating an unchanged invalid request is not recovery.

## 3. Current role catalog

Native model tiers below are policy defaults, not fixed model IDs or confirmed execution observations. A native profile selects one route for its invocation. Strict Bridge routing can address all twelve core roles separately.

| Core role | Visible profile | Inputs and current responsibility | Required useful output | Native route |
| --- | --- | --- | --- | --- |
| `manager` | Coordinator | Original intent, saved workflow, policies, working tree and specialist findings. Owns intake, bounded delegation, discussion integration, decisions and closure. | Scoped plan, actual delegate results, decision, completion status and concrete unresolved actions. | Strong `manager`. |
| `codebase-analyst` | Explorer | Bounded questions, source paths and baseline. Traces entrypoints, dependencies, data/control flow and existing procedures. | Source references, repository map, supported answers, unknowns and analysis work record. | Worker `codebase-analyst`; read/search native duties. |
| `researcher` | Researcher | Questions, versions, source policy and budget. Checks local knowledge and permitted primary sources. | Source ledger, applicability/version differences, compatibility recommendation, limits and research record. | Worker `researcher`; read/search/web duties. |
| `requirements` | Planner | User intent, constraints and evidence. Defines observable behavior, measurable acceptance and bounded work. | Requirement records, acceptance checklist, trace links and unresolved product choices. | Strong `requirements`; no product implementation. |
| `architect` | Architect | Requirements, source findings and integration constraints. Defines responsibilities, interfaces, alternatives and failure handling. | Design records and a concrete implementation contract with verification implications. | Strong `architect`. |
| `component-owner` | Architect | Allocated subsystem/interface obligations. Details a component contract and its integration assumptions. | Component design, dependencies, operating limits and integration risks. | Native profile uses `architect`; strict role has its own route. |
| `developer` | Implementer or Debugger | Reviewed task, allowed paths, baseline and checks. Implementer delivers scoped code/docs; Debugger establishes a reproduction and cause before repair. | Patch/artifacts, real observations, regression evidence where appropriate and producer work record/submission. | Worker `developer`; the two profiles share this policy. |
| `verifier` | Verifier | Requirements/design and acceptance conditions. Defines independent expectations, coverage, boundaries and protected check plans. | Reviewable verification strategy, check records, expected results and limits. | Strong `verifier`. |
| `check-executor` | Verifier | Reviewed procedure, exact baseline, available toolchain and scope. Executes or inspects without changing production code or protected expectations. | Actual command/tool versions, output, exit status or inspection observations and archived evidence. | Native profile still uses strong `verifier`; strict can route this role separately. |
| `reviewer` | Reviewer | Current deliverable, contract, evidence, documentation and producer report. Reviews independently from the producer. | Actionable findings or supported pass, affected criteria, coverage, limitations and work record. | Strong `reviewer`; read/search/web duties, no product edits or terminal execution. |
| `curator` | Coordinator | Verified findings, sources and evidence. Produces readable Cornell knowledge and decides whether a generalized lesson is justified. | Validated note/practice/answers and an explicit curation disposition; qualified contributions when applicable. | Native profile uses `manager`; strict can route separately. |
| `release` | Coordinator | Accepted outputs, packaging/archive/publication policies and actual authorization. Manages reproducible delivery and permitted publication operations. | Versioned deliverables, checksums, installation/archive/publication evidence and limits. | Native profile uses `manager`; strict can route separately. |

Profiles do not all need to run for every request. The Coordinator cannot impersonate a worker's participation or perform independent review of its own production work. Verifier combines two duties but uses distinct core-role assignments where required. Native tool declarations are also client-dependent: generated Copilot tools and Codex instructions do not establish identical enforcement or signed model identity.

Codex can inherit its parent model rather than select a different model for every profile. Explicit routing must be configured and observed before attributing savings to strong/worker tiers. Generated 9router preferences affect new invocations and do not establish what executed.

## 4. Proposed module and agent-facing interface

Create one deterministic assignment runtime module over the current core. CLI commands, MCP tools and native adapters call the same implementation. Its interface owns context, permitted transitions, idempotency, validation, report rendering and reconciliation. Keep the existing low-level operations for compatibility and advanced recovery.

Proposed public operations, names subject to implementation review:

| Operation | Caller supplies | Runtime derives or validates |
| --- | --- | --- |
| `work_prepare` | Request text/structured parameters, request ID and project selection. | Existing authorized resumption, candidate procedures, risk/applicability decision, proposed mode, context differences and next action. Preparation does not launch agents or execute a retrieved script. |
| `assignment_context` | Bound actor session or one scoped assignment handle. | Workflow/task/profile/core role, allowed paths, current baseline, required output schema, permitted operations and completion obligations. |
| `assignment_progress` | Actor context, state and short summary. | Correct activity identity and task/workflow linkage. Execution state remains separately authoritative. |
| `assignment_result` | Actor context and a typed result. | Artifact checks, evidence references, appropriate metadata patch, seven-section rendering, producer submission when applicable and unfinished gates. |
| `work_resume` / status | Run ID and authorized session. | Last durable phase, committed operations, current attempt and next legal action without repeating completed side effects. |

Coordinator decisions, Verifier execution and Reviewer findings use typed role-specific result variants. They call current dedicated operations internally. A worker result such as `outcome: completed` is a completion request, not accepted engineering evidence.

Example of business content returned by an implementation worker:

```json
{
  "schema_version": 1,
  "outcome": "completed",
  "summary": "Implemented the bounded linked-list exercise.",
  "changes": [
    { "path": "practice/707/linked-list.c", "description": "Implement the reviewed list contract." }
  ],
  "decisions": [
    { "decision": "Use the reviewed sentinel and tail contract.", "basis": "Assigned design." }
  ],
  "evidence_refs": ["assigned-evidence-reference"],
  "limitations": ["External judge submission was outside this assignment."]
}
```

The evidence reference is checked against actual stored results, not treated as a free-form claim. The worker does not supply `workflow_id`, `owner`, `assurance`, `execution_mode`, lifecycle status, a self-invented invocation ID or confirmed-model fields. Report sections derive from substantive assigned inputs and observed results; missing reasoning remains missing instead of being filled with invented boilerplate.

### Actual client context is a first milestone

Independent CLI/headless processes can receive private assignment credentials through a launcher-owned session and bound transport. Ordinary native Copilot/Codex subagents may share one MCP client connection and may not expose per-agent identity. A global "current assignment" variable would attribute concurrent calls incorrectly.

Prototype both real clients before promising transparent identity injection. Prefer host-supplied, per-assignment binding where available. Otherwise require one scoped opaque handle, validated against the stored packet; scripts supply the remaining fields. Retain honest unsigned attribution for the existing fallback. A shared trusted client still cannot cryptographically prove independent agents. The Coordinator never claims or submits on a specialist's behalf.

### Templates and hooks

Generate prompts and JSON schemas from a canonical role contract containing duties, input/result schema, legal operations, authorable record types, model alias, required reports and independence constraints. The prompt contains the objective, allowed inputs/paths, completion criteria and result contract rather than instructions to reconstruct lifecycle metadata.

Lifecycle hooks prepare validated context before real launch, record observed launch/progress, validate the result before commit, and record closure or failure. Hooks and telemetry cannot launch an unavailable native capability by assertion, establish model identity, or replace independent review. Retain the existing three-worker cap and serialize conflicting writes.

## 5. Durable recovery and errors

Use a durable operation intent and attempt state, not the Universe activity feed, as execution authority. The activity feed is a bounded, expiring progress projection.

Each operation records request/run/assignment identifiers, template version/hash, immutable input digest, expected revision, current attempt, side-effect disposition and committed result IDs. An identical client retry returns the same result. Changed input with the same idempotency key conflicts. A separate new user request can reuse a recipe but receives a new run; similar words do not merge it into a historical workflow.

Add lease/attempt fencing before unattended scheduling. Current local claims have packet idempotency but are not exclusive worker leases. A superseded actor must not reclaim Coordinator ownership by replaying an old claim. Late results from cancelled, expired or replaced attempts cannot commit. An uncertain file/network side effect requires inspection or reconciliation before retry. Arbitrary commands cannot promise exactly-once execution; approved procedures declare idempotent effects or a recovery procedure.

Enforce fencing in the underlying core claim and mutation paths for runtime-owned work, including calls through the low-level CLI/MCP interface. A facade-only check would let an old `assignment_claim` or direct mutation escape cancellation. A missing or superseded attempt is refused for a runtime-managed run. Legacy inspection remains compatible; legacy execution is resumed through an explicit audited adoption/recovery operation that establishes current context without rewriting original ownership, assurance or saved history. Low-level compatibility is not a bypass for managed attempts. This protects supported mutation interfaces; native filesystem access remains subject to the client's actual permissions.

Use structured errors such as `INVALID_INPUT`, `CONTEXT_MISMATCH`, `STALE_BASELINE`, `SCOPE_DENIED`, `LEASE_EXPIRED`, `MISSING_TOOL`, `LAUNCH_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `CAPACITY_EXCEEDED`, `CHECK_FAILED` and `RETRY_EXHAUSTED`. Include a code, failed phase, retryability and next legal action. Transient retries are bounded; protocol serialization is corrected deterministically; scope/permission failures are not retried unchanged.

The user-facing stream reports one concise problem and its effect when intervention is necessary. Detailed redacted diagnostics remain available. This reduces noise without hiding failed checks or claiming unfinished work is complete. Preserve the saved repair limit rather than silently expanding it.

## 6. Request indexing and applicability

Literal word IDs are useful for retrieval but insufficient for selecting executable work. Separate five identities:

- `request_id`: one incoming intent or client retry.
- `intent_id`: a reusable task family, such as Cornell export or configuration persistence.
- `recipe_id` plus version and generator hash: the approved procedure.
- `run_id`: one execution under particular scope and inputs.
- `context_digest`: the relevant acceptance, environment, dependency and policy inputs.

Normalize natural-language text for retrieval, including controlled English/Vietnamese synonyms and spelling variants. Preserve original text. Do not apply natural-language normalization to case-sensitive paths or executable arguments. Start with the existing FTS5/BM25 facilities and structured tags; add an optional semantic reranker only if measured retrieval failures justify it.

The retrieval flow is: extract task family and typed parameters, find candidates, load authoritative artifacts, validate compatibility, then select `exact`, `adapt`, `new` or `blocked`. Similarity scores never authorize execution.

Compatibility dimensions are recipe-specific: parameter schema, output format, acceptance class, runtime/toolchain and relevant versions, OS/architecture, client/host, required tools/plugins and reviewed pins, authorized paths/effects, network/publication policy, assurance/mode and verification identity. Different unimportant project paths need not prevent a parameterized recipe from matching. Missing required dimensions, changed contracts or relevant version drift prevent an exact match.

Illustrative examples:

| New request | Reuse decision |
| --- | --- |
| Export another already validated Cornell artifact to the configured notes folder using the same supported schema. | Candidate for a script-only export after input, destination and artifact-conflict checks. |
| Create a research-format note on a different algorithm. | Reuse the research compiler, formatting, question mapping and export. Obtain fresh content reasoning, sources and relevant verification. |
| Generate another supported scalar configuration module with valid typed parameters. | Reuse the existing recipe within its declared constraints and required current reviews/checks. |
| Request nested configuration, schema migration or concurrent-writer durability. | Adapt/new; the current scalar persistence recipe explicitly does not supply those capabilities. |
| Fix playback inside a VS Code webview when the previous test only passed in a standalone browser. | New or suspended compatibility claim; standalone browser success is insufficient for the webview target. |
| Repeat similar wording under a different Linux toolchain or stricter policy. | Revalidate relevant differences; do not copy a Windows result or reduce assurance. |

Add durable procedure-candidate metadata referencing completed work and its evidence/reviews without editing closed records. Extend disposable SQLite projections for procedure applicability, validated runs, aliases and measured outcomes. Historical failures stay searchable for diagnosis but are not successful procedure qualifications. Validate current artifact/evidence bytes after retrieval; a stored success flag or unchanged record-source hash is insufficient. Index corruption is an explicit repair condition, not an empty successful search.

## 7. Procedural maturity and automation capture

Procedural maturity is proposed execution eligibility. It is separate from knowledge approval, number of GitHub stars, number of mentions or permission to publish.

| Proposed state | Meaning | Execution eligibility |
| --- | --- | --- |
| Observed | A request has actual recorded outcomes and limits. | Historical reference. |
| Candidate | Repeatable steps and an automation opportunity have been captured. | Draft only. |
| Reviewed | Typed inputs, applicability, scope, protected verification, recovery and provenance have independent review. | Bounded pilot under policy. |
| Pilot | The reviewed procedure is being tested across representative variants and negative cases. | Explicitly scoped trials. |
| Eligible | The reviewed contract and qualifying pilots satisfy configured risk/performance policy. | Automatic selection for compatible authorized requests. |
| Suspended | Current evidence, dependencies, policy, script hash or observed outcomes no longer support eligibility. | Diagnosis/reference until reassessed. |

A suggested initial promotion threshold is three successful real runs across at least two representative parameter sets, plus independent contract/oracle review and negative-case tests. This is a configurable starting rule, not proof of universal correctness. Script/policy changes require reviewed versioning and requalification as appropriate. Fixture-only success cannot count as a real native-client pilot.

Every completed request receives a short automation opportunity check: reuse an existing tool, parameterize a known procedure, draft a new bounded procedure, or retain a reason why only shared intake/reporting can be automated. Do not create a different near-duplicate script for every request. Search approved workspace tools and the current recipe catalog first. A successful first solution supplies the reference example and candidate procedure, not automatic broad execution authority.

New generators and tests come from actual completed work. Architect/Implementer can draft the parameterization; Verifier owns independent expected outcomes; Reviewer evaluates the reusable contract and effect scope. Preserve original artifacts and failed cases. Scripts use approved executable/argument arrays, explicit cwd, timeouts, schemas, allowed effects, output checks and recovery behavior. Retrieved prose is never executed automatically.

## 8. Routing and expert involvement

Use three routes:

1. **Script-only**: approved mechanical work with supported inputs, authorized effects and current checks. Run the script without inventing an agent invocation. Record its actual outcome.
2. **Recipe reuse**: a compatible procedure with fresh bindings and necessary current verification. Bounded workers handle well-specified content or implementation; the existing full lifecycle applies when that is the selected mode.
3. **Full expert workflow**: novel semantics, incompatible inputs, changed expectations, high consequence, ambiguous scope, failed checks or unsupported environments. Select the relevant experts rather than every profile by default.

For new low-risk eligible work, implement a reviewed recipe-to-lightweight adapter. Keep its checkpoint and reported assurance; do not label it strict acceptance. Existing full/strict work cannot be converted to escape its gates. In the first rollout, apply recipe reuse to full workflows and keep lightweight recipe selection advisory until that adapter is validated.

When a strong Coordinator is involved, pass a compact reuse brief: extracted intent, selected procedure/version, qualification evidence, relevant context differences, eligibility/risk decision, required checks and escalation triggers. It should assess uncertainty rather than reread every historical report. Pure approved mechanical steps need not invoke a top model solely to repeat bookkeeping.

Cheap routing is conditional on actual client support. Native Verifier currently uses its strong route for both planning and execution. Moving deterministic execution to a runner or a separately routed Check Executor requires an explicit adapter/policy change. 9router metadata records requested choices; observations determine what actually ran. Preserve real model-unavailability and permission outcomes.

## 9. Implementation sequence

| Phase | Changes and likely modules | Exit condition |
| --- | --- | --- |
| A. Canonical contracts and baseline | Consolidate role permissions/authorship/result obligations; generate relevant guidance and schemas from one source. Extend `tools.ts`, `agent-profiles.ts`, adapter generation and MCP contract tests. | Guidance cannot require forbidden operations; the three reported error classes have reproducible fixtures and structured classifications. |
| B. Assignment runtime | Add `assignment-runtime.ts` over `native-assignment.ts`, `mcp.ts`, `engineering.ts` and `manager.ts`. Derive context, render reports, issue operation-specific patches, add durable intents/fencing and typed errors. | Real script/MCP calls use valid stored scope; retries and interrupted commits reconcile without duplicated work or forged results. |
| C. Native client adapters | Validate context delivery and launch on actual Copilot and Codex clients. Generate versioned prompt templates and connect lifecycle hooks to runtime state. | Both client pilots prove context isolation, actual separate delegates, current evidence and restart/resume. Shared-client limitations remain explicit. |
| D. Advisory reuse planner | Add `procedure-reuse.ts`; extend existing indexing/knowledge modules with structured candidate projections and deterministic compatibility checks. | `exact/adapt/new/blocked` explanations are correct for positive, near-match, drift and corrupted-input fixtures. No retrieved script executes yet. |
| E. Procedure capture and promotion | Extend the existing recipe catalog with reviewed project procedure manifests, candidate records, qualifying runs and suspension rules. Seed existing recipes and Cornell compiler/export as candidates, not automatically Reviewed or Eligible. | Closed history is unchanged; reviewed candidates have independent expected outcomes, negative cases and recoverable effects. |
| F. Automatic routing | Integrate eligibility into new request intake. Add the explicit lightweight adapter after full-reuse pilots; retain strict/full constraints. Pass a reuse brief and enforce budgets/escalation. | Only eligible compatible authorized work takes the shorter route; unrelated or risky near-matches escalate correctly. |
| G. Controls and evaluation | Extend the monitor with an Automation Library and reuse/run details. Extend `evaluate.mjs` with matched fresh-versus-reuse trials and actual telemetry. | Measured benefit is reported with observation counts, no quality regression in the pilot corpus, and a tested per-procedure disable/recovery path. |

Suggested delivery uses small reviewable changes in that order, with B/C before unattended replay and D read-only before F. Existing uncommitted work is preserved; implementation branches/worktrees are created deliberately when implementation starts. Do not combine this plan with unrelated media repairs or a new release.

The Automation Library should show procedure state, scope, version/hash, supported environments, last validated run, measured reuse, reason for suspension and enable/disable controls. The Universe should distinguish configured profiles, actual active agents and script executions. A script-only run is a procedure node, not a fabricated worker or inferred conversation.

## 10. Acceptance and evaluation

Required regression scenarios include:

- All twelve role contracts generate valid required operation sets and output schemas; Verifier planning and execution remain distinct.
- The three reported malformed-call cases cannot be generated by the high-level interface's valid business inputs. Deliberately forged scope and reserved-field mutations still fail.
- Bootstrap covers the observed KNW-0061 failure: empty optional credential objects are never emitted, an unprepared correlation label cannot be claimed as an identity, and a worker cannot be launched without the actual prepared packet. Malformed or partial credentials produce one typed failure before side effects rather than repeated authentication attempts.
- Two concurrent assignments in one native client cannot share a mutable global identity. Every mutation uses the validated current attempt and assigned scope.
- Same request/operation key and payload are idempotent; changed payload conflicts. Restart after prepare, launch, output write and result commit reconciles without duplicating completed effects.
- An old Coordinator claim, cancelled worker or expired attempt cannot regain authority or submit late work through high-level or raw supported CLI/MCP mutation paths. Legacy recovery establishes a new audited context rather than bypassing this rule.
- Report rendering preserves actual rationale/observations and cannot manufacture test success, review independence or model identity.
- Text near-matches with incompatible schemas, versions, environments, paths, permissions or assurance fail exact reuse. A new task still requires current evidence.
- A previously successful procedure with later failure, stale artifacts, changed scripts or a broken verification record loses eligibility while historical evidence remains intact.
- SQLite deletion/rebuild preserves authoritative eligibility decisions; corruption or missing sources is not reported as a valid no-match.
- Output conflicts preserve authored files. Policy forbidding network/publication remains effective during reused runs.
- Lightweight completion remains an unsigned report. Full/strict mode and completed historical records cannot be rewritten or downgraded.
- A real end-to-end pilot runs in both clients. Isolated MCP/fixture tests complement that pilot rather than substitute for actual native launch, permissions and host-specific verification.

Extend the existing evaluator with new, exact-repeat, adapted-repeat, false-friend and interrupted-run cases. Measure time to accepted or correctly reported completion, protocol repair calls, retries, escalations, agent/model calls, observed tokens/cost, human correction time, escaped defects and false exact matches. Separate search hits, eligible procedure reuse and reused result bytes. Unknown cost/model observations stay unavailable.

The first acceptance target is zero occurrences of the three known avoidable protocol errors in the valid high-level pilot corpus, zero unsafe exact matches in the negative corpus, and no escaped defect increase relative to the same protected acceptance checks. Set numeric time/token savings targets only after baseline measurements. Prefer this measurable improvement over a promise that every future task can run without any error.

## 11. Decisions to carry into implementation

Recommended defaults are local discovery, advisory matching first, reuse of the current recipe and Cornell tools, automatic drafting of procedure candidates, independently reviewed promotion, one bounded repair before existing escalation, and no change to publication authorization. Use the saved per-project notes destination rather than hardcoded Windows paths.

The main technical uncertainty is per-agent context delivery in shared native MCP clients. Validate it in phase C and retain the scoped-handle fallback when transparent binding is unavailable. The main product choice is how broadly eligible low-risk requests may select lightweight execution; expose that policy explicitly and preserve existing workflows.

This plan changes the amount of protocol reasoning agents perform. It does not turn previous successful outputs into proof about a new request, replace the user's product intent with keyword guesses, or erase meaningful failed verification.
