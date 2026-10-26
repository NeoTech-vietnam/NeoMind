# Role catalog

Copilot exposes nine profiles over twelve persisted core roles. **NeoMind Coordinator Agent** is the sole user-invocable entry; the other eight profiles are delegates with bounded assignments. Profile names describe how work is presented in the editor. Core IDs identify record authorship, permissions and routing, and remain compatible with saved workflows.

| Copilot profile | Use and required result | Persisted core roles | Native model role / default tier |
| --- | --- | --- | --- |
| NeoMind Coordinator Agent | Intake, scope, specialist selection, decisions, blockers and final evidence consolidation. | `manager`, `curator`, `release` | `manager` / strong |
| NeoMind Explorer Agent | Trace local source, dependency boundaries and existing behavior; return file/revision evidence and unknowns. | `codebase-analyst` | `codebase-analyst` / worker |
| NeoMind Researcher Agent | Check primary external sources and reusable upstream guidance; return versions, applicability, provenance and limitations. | `researcher` | `researcher` / worker |
| NeoMind Planner Agent | Formalize scope, measurable requirements, acceptance criteria, task boundaries and verification needs. | `requirements` | `requirements` / strong |
| NeoMind Architect Agent | Define module contracts, interfaces, tradeoffs, failure behavior and applicable software/hardware allocations. | `architect`, `component-owner` | `architect` / strong |
| NeoMind Implementer Agent | Deliver scoped code and documentation against reviewed contracts, with actual build/check results. | `developer` | `developer` / worker |
| NeoMind Debugger Agent | Reproduce a defect, compare hypotheses, establish cause and produce a bounded repair/regression when assigned. | `developer` | `developer` / worker |
| NeoMind Verifier Agent | Own verification strategy, independent expected outcomes, coverage and evidence analysis; execute reviewed procedures under the matching core role. | `verifier`, `check-executor` | `verifier` / strong |
| NeoMind Reviewer Agent | Independently assess requirements, design, implementation, documentation and evidence on the current baseline. | `reviewer` | `reviewer` / strong |

Choose profiles by the actual question and completion criteria. Full native workflows retain at least two distinct specialist contributions from actual invocations, independently reviewed design/check plans, scoped tasks, evidence, seven-section reports, Cornell delivery and closure gates. A research request uses appropriate exploration, research or independent review assignments without inventing implementation or simulation. Lightweight remains a separate saved mode with its own risk-based procedure. See the [native lifecycle and entry rules](../resources/guides/copilot-native.md) and [lightweight procedure](../resources/guides/lightweight.md).

Use inexpensive worker routes for bounded search, source tracing, routine execution and well-specified implementation. Strong routes own consequential planning, architecture, verification strategy and independent review. If cheap reconnaissance leaves a decision unresolved, return concrete evidence and the unresolved question for stronger analysis; a role name does not prove model competence. The separate Reviewer invocation must never have implemented or repaired the assignment. Debugger is a producer/diagnostic profile and cannot review its own repair independently.

## Routing and profile limits

One `.neomind/routing.json` controls exact models, providers, requested effort and per-role overrides; defaults in the table are tiers, not fixed model IDs. Run `npx neomind update` after a policy change and resolve generated-file review candidates. Changes apply to the next invocation and cannot modify active signed work. Custom-provider choices require an unambiguous configured VS Code model catalog. See [model control](model-control.md) and [model routing](model-routing.md).

A native profile selects one model for its entire invocation. Coordinator uses the `manager` route even while carrying curator/release responsibilities; Architect uses `architect` for component ownership; Verifier uses the strong `verifier` route for both strategy and prescribed execution. Implementer and Debugger share `developer`, so changing that route changes both profiles. These aliases do not introduce a `debugger` core ID or a separate model control. The optional strict Bridge still routes all twelve core roles individually, including worker `check-executor`, `curator` and `release`.

The Coordinator's generated file is `neomind-coordinator.agent.md`; its skill ID remains `neomind-manager`. Update retires the previous manager agent only when its installed ownership hash still matches; edited files retain the installer's review/conflict treatment. Displayed names do not replace record IDs or `manager_*` operations. Native configured models and reported invocation IDs are observations, not signed execution proof. Strict work requires the current signed native acknowledgments and inference evidence demanded by its selected adapter; unconfirmed observations block strict gates. Preserve recorded fallback requirements and the one-repair escalation boundary.

## Core contracts

Installed contracts live under `.neomind/roles/` (legacy: `.verythinker/roles/`). Each core role retains its required/optional capabilities, scoped gateway operations and output contract.

| Role ID | Contract | Default tier |
| --- | --- | --- |
| `manager` | [Manager / Orchestrator](../resources/roles/manager.md) | strong |
| `researcher` | [Research Analyst](../resources/roles/researcher.md) | worker |
| `codebase-analyst` | [Codebase Analyst](../resources/roles/codebase-analyst.md) | worker |
| `requirements` | [Requirements Engineer](../resources/roles/requirements.md) | strong |
| `architect` | [System Designer / Architect](../resources/roles/architect.md) | strong |
| `component-owner` | [Component Owner](../resources/roles/component-owner.md) | strong |
| `developer` | [Developer](../resources/roles/developer.md) | worker |
| `verifier` | [Verification Strategy](../resources/roles/verifier.md) | strong |
| `check-executor` | [Prescribed Check Executor](../resources/roles/check-executor.md) | worker |
| `reviewer` | [Independent Reviewer](../resources/roles/reviewer.md) | strong |
| `release` | [Configuration / Release Engineer](../resources/roles/release.md) | worker |
| `curator` | [Knowledge Curator](../resources/roles/curator.md) | worker |

Doctor distinguishes enforced restrictions from instruction-only limits. Required missing tools block the affected assignment. Use the project's configured procedures and applicable domain gates; naming a tool in guidance does not install it, grant access or establish execution.

## Recommended domain packs

The following are recommendations for selecting reviewed guidance and project tools, not additional installed agents, bundled integrations or newly granted capabilities.

| Domain pack | Guidance to select | Evidence needed for a credible result |
| --- | --- | --- |
| Software and services | Repository navigation, API/database contracts, frontend accessibility, security review, performance diagnosis and deployment procedures appropriate to the stack. | Current source baseline, executable tests, contract checks and real browser/service observations where required. |
| Embedded and digital hardware | Firmware interfaces, timing/concurrency, resource budgets, HDL/testbench design, waveform interpretation, hardware configuration and applicable safety requirements. | Actual compiler/simulator results, identified waveform signals, hardware/firmware revisions, and separately labeled simulation, bench, SIL or HIL observations. Commercial tools apply only when configured and required by the project. |
| Learning and technical explanation | Source-backed explanations, diagrams, concrete numerical examples, progressive exercises and user-appropriate language. | Linked sources, definitions versus derived claims, a reproducible demonstration, exercise/answer artifacts and honest experimental limits. |
| Artifact investigation | Reviewed REA guidance when the question depends on a shipped binary, package or runtime behavior unavailable from source. | Exact source/runtime pins, license attribution, available engine/tool evidence and retained findings. Guidance reuse alone does not provide the REA runtime. |

Imported guidance must retain source, license, exact commit and content hashes. NeoMind's [upstream importer](upstream-agents.md) preserves orchestration and tool permissions; checking an update does not adopt it. Pack selection never overrides local-only policy, native permissions, saved execution mode or engineering gates.

Every specialist records its actual assignment and limitations through the required [standard work record](../resources/templates/work-record.md) and assignment report. Consolidate substantive findings into [Cornell notes](cornell.md), linked to the saved workflow, requirements, tasks and actual evidence. Notes preserve readable guidance and learning; work records preserve what each invocation did.
