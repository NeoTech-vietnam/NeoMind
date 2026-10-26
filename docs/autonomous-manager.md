# Coordinator-first workflow

After installation, give the native agent one engineering requirement in ordinary language. Managed Copilot instructions route engineering intent to `NeoMind Coordinator Agent`, the only user-invocable profile. It delegates bounded work to eight profiles: NeoMind Explorer Agent, NeoMind Researcher Agent, NeoMind Planner Agent, NeoMind Architect Agent, NeoMind Implementer Agent, NeoMind Debugger Agent, NeoMind Verifier Agent and NeoMind Reviewer Agent. It selects the profiles needed for the task; the saved workflow's gates remain mandatory. Full native closure requires workflow-linked Cornell findings and delivers those findings plus actual test reports for separate human release approval. Fresh projects use the full `copilot-native` lifecycle with unsigned execution assurance; optional strict mode retains the signed VS Code Bridge. You do not need to choose specialist roles, maintain documentation, or run record-management commands.

The generated entry point is `.github/agents/neomind-coordinator.agent.md`. Generic intake launches its returned handoff once with the unchanged prompt and waits. A directly selected Coordinator calls `manager_run` once for a new request and continues the returned prompt itself; an already assigned Coordinator continues its packet without another intake call or self-launch. Specialists execute their assigned packets and cannot recursively delegate. A returned handoff or inline role impersonation is not executed delegation.

For example:

```text
Add persistent configuration for intervalMs (100–60000) and retries (0–5).
Reject invalid values without changing the stored configuration.
Preserve configuration across application restarts.
```

The Coordinator owns the increment through requirements, internal specialist discussion, design decisions, implementation, documentation, checks, independent review, task acceptance, and qualified knowledge contribution. Explorer traces repository behavior; Researcher checks primary sources; Planner defines measurable requirements; Architect defines interfaces and contracts. Implementer delivers scoped changes, Debugger diagnoses failures and repairs them, Verifier plans and executes checks, and Reviewer independently assesses the deliverable and evidence. Coordinator consolidates their actual results. It asks for clarification when product intent cannot be inferred, reports the chosen approach and material tradeoffs, then continues within the authorized scope.

Display profiles preserve the twelve core record roles. Coordinator uses `manager` routing, Explorer `codebase-analyst`, Researcher `researcher`, Planner `requirements`, Architect `architect`, Verifier `verifier` and Reviewer `reviewer`. Implementer and Debugger share `developer` routing. Verifier therefore uses the strong default; strict Bridge execution still selects each invocation's actual core role, including `check-executor`. See [model routing](model-routing.md) for defaults and per-role overrides.

## What happens internally

| Stage   | Manager responsibility                                                                                                                     | Persisted result                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Intake  | Read project state, profile, capabilities, constraints, and the requirement; resume matching unfinished work                               | Workflow and measurable requirement records                         |
| Discuss | Obtain current contributions from two specialist roles in distinct native invocations; resolve conflicts against requirements and evidence | Role/invocation discussion summaries, sources, risks                |
| Decide  | Select the approach, rationale, verification strategy, ownership, and dependencies                                                         | Manager decision and child task IDs                                 |
| Execute | Review applicable designs, delegate changes, integrate results, update project documentation, run checks                                   | Implementation/documents, substantive work records, actual evidence |
| Accept  | Obtain separate reviewer invocation, resolve findings, validate current baselines and accepted gates                                       | Current review and accepted task records                            |
| Curate  | Consolidate qualified lessons, generalize public-safe content, obtain independent generalization review                                    | Reviewed project knowledge and contribution candidate               |
| Close   | Apply contribution policy, create the draft PR when enabled, and validate closure                                                          | Contribution disposition, closure state, final user report          |

Internal discussion means concise specialist recommendations with rationale and evidence. It is not a generated transcript claiming agents that never ran. Requested and observed models are recorded separately; unavailable observations stay explicitly unavailable.

The iterative V-model links specification/design to corresponding verification levels. Automotive SPICE 4.1 references guide engineering and cross-cutting responsibilities; these records do not establish an ASPICE capability rating. Read the [full Copilot-native procedure](../resources/guides/copilot-native.md), optional [strict manager procedure](../resources/guides/manager.md), and [process mapping](../resources/guides/process.md) for the actual contracts.

## Documentation and knowledge are deliverables

The manager declares documentation outputs when assigning work. Workers update affected specifications, designs, interfaces, project guides, and seven-section work records. Submission stores substantive content, and review assesses the current implementation/documentation baseline. Missing required documentation keeps the workflow open.

Fresh project records live under `.neomind`; unmigrated projects retain their existing physical managed root. Explicit offline `neomind migrate` renames storage without rewriting historical bytes or logical references. Shared contributions contain only independently reviewed generalized content with public-safe provenance, applicability, assumptions, and limitations. Work that yields no reusable conclusion records a concrete no-lesson reason rather than inventing a lesson.

## Automatic draft PR policy

Installation creates `.neomind/automation.json` (legacy projects retain their managed root). Fresh native policies use `network_policy: local-only` and `automatic_pr: false`; existing saved policies are preserved, and an absent network policy retains legacy remote behavior. Under local-only, research, archives and contributions stay local with no remote requests. Managed installation preserves user edits; update conflicts produce candidates for review.

Later remote publication requires user opt-in to `network_policy: remote-enabled`, a configured destination and current independent generalization/public-safe review. Automatic PR submission additionally requires `automatic_pr: true`; Coordinator follows that saved authorization without another permission question. The contribution core creates a draft PR and records it for recovery; it never merges a PR or publishes an npm package. Human approval remains the merge decision. GitHub authentication and repository write access must already be available for submission.

An authentication, access, native execution-policy, or service failure produces a recorded blocker with the required external action. The manager reports the blocker; it does not invent a PR, broaden native permissions, or replace the user's work with repeated CLI instructions.

## Native execution and honest limits

The package defaults to Copilot workers using standard named VS Code subagents. Codex and Claude Code adapters remain legacy compatibility paths. It does not include a separate model API runtime. MCP exposes manager operations and the engineering core. Agent-operated CLI fallback provides the same workflow when MCP is unavailable; user operation of each command is not part of normal use.

At most three workers run concurrently. Discussion is bounded to three rounds. One repair is permitted before stronger internal escalation or a documented blocker. Independent review uses a separate invocation from implementation. If the native client cannot provide that invocation, acceptance remains open and the manager reports the limitation.

An active native session performs the work. Interruption persists resumable state; automatic background execution requires a separately configured native facility. Generated adapters and deterministic workflow checks do not prove live native skill discovery, effective routing, or successful delegation on every client version. See [compatibility](compatibility.md) and [validation](validation.md).

## Resumption and final response

In a fresh session, say `Continue the configuration requirement`. The manager inspects workflow state, actual files, current evidence and reviews, then resumes the next valid action. It reassesses stale baselines before accepting prior results.

The final response contains decisions and rationale, delivered behavior, actual verification and limits, documentation/record locations, accepted status, and draft PR links. Open blockers are stated precisely. The user receives an outcome they can assess without reconstructing the internal discussion.

## Design basis

NeoMind retains its native clients and adopts CAMEL's separation of role/task context, explicit multi-agent collaboration, coordinator-owned task execution, and recorded lifecycle/termination. The implementation is independent TypeScript; it does not bundle a Python CAMEL runtime. See [CAMEL research](camel-research.md) for source-backed adoption boundaries and licensing.
