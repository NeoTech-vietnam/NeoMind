# NeoMind

NeoMind embeds a manager-led engineering workflow into existing projects: requirements, design, implementation, checks, immutable evidence, independent review, private project archives, and reviewed reusable knowledge. **GitHub Copilot** is the default runtime. Standard VS Code named subagents perform visible bounded assignments; the [VS Code Model Bridge](docs/vscode-bridge.md) remains optional for signed local execution attestations. Legacy Claude Code and Codex adapters remain compatibility paths.

**Development: `0.1.0-alpha.5`, paired with VS Code extension `0.5.0`.** The published [alpha.4 release](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/v0.1.0-alpha.4) contains runtime alpha.4 and extension0.4.0. This branch adds native Codex profiles, observed lifecycle links, research-note export/publication, optional pinned REA MCP and scheduled upstream candidate checks. See the [agent platform guide](docs/agent-platform.md) for activation and evidence limits. Optional signed Bridge and legacy receipts retain compatibility. See [installation](docs/install-release.md), [compatibility](docs/compatibility.md), [validation](docs/validation.md), and [release criteria](docs/release.md).

Bundled instructions, skills, documentation, CLI output, and generated records are in English. Imported upstream guidance retains its source language.

## Agent map, upstream reuse, and model controls

- **Agent universe:** the VS Code command **NeoMind: Open Agent Map** opens a solar-system observatory with rotating textured role planets, orbiting task moons and recorded communication trails. Its mission-control inspector keeps model policy, 9router controls and signed versus reported provenance visible. [Monitor setup and data contract](docs/agent-map.md).
- **Earth FocusSpace:** choose **Enter Earth · Focus Space** in the universe for a persistent focus countdown, a calendar agenda with suggested focus windows, current-location/city weather, original ambient sound and a visible YouTube player. [Connections and controls](docs/focus-space.md).
- **Reusable agents and skills:** discover GitHub candidates by stars, clone an exact commit without running repository code, and bind selected instruction files to an existing NeoMind role. `neomind upstream watch` continuously checks while its process runs; inspected updates are explicitly adopted with a reviewable pin and history. Run `neomind update` after initial caching or adoption to refresh generated native agents. REA reuse currently supplies guidance; its external analysis runtime is not connected. [Upstream reuse](docs/upstream-agents.md), [REA findings](docs/research/rea-adoption.md).
- **Per-role models and 9router:** change role models from the monitor or `neomind models set`; generated Copilot agents refresh with conflict handling. Configure a local gateway for authenticated health, model listing and inference diagnostics. [Model controls](docs/model-control.md), [9router embedding plan](docs/research/9router-integration.md).

9router currently runs as a separately configured local service. Managed sidecar installation and a direct HTTP agent executor are planned. The [delivery plan](docs/neomind-delivery.md) distinguishes implemented features from those next steps.

New projects use the `neomind` package/CLI, `neomind-*` skills and agents, and `.neomind` storage. For an existing `.taskforces` or `.verythinker` project, stop active work, run `neomind migrate`, then `neomind update`. Historical signed bytes, upstream attribution and archived validation remain unchanged.

## Copilot execution paths

[Copilot runtime guide](docs/copilot-runtime.md) distinguishes MCP transport, native agents and the signed VS Code bridge. Portable behavior now lives in typed source, not installed-runtime patches:

- **Full native workflow (default):** `execution_mode: copilot-native` returns `NeoMind Coordinator Agent`; it selects bounded assignments for eight expert profiles through the standard VS Code agent tool. Full engineering gates, independent review, archives and reviewed knowledge remain required. Execution assurance stays `unsigned-native-report`; a returned handoff alone is not proof that delegation occurred.
- **Lightweight native manager (opt-in):** `execution_mode: lightweight` returns one `NeoMind Coordinator Agent` handoff with the reduced procedure; native tools/subagents perform authorized work. Revision-checked checkpoints save actual checks and risk-based review as unsigned reports, never strict acceptance. No mandatory archive or PR.
- **Strict bridge:** exact registered model selection, scoped manager-to-worker dispatch, compatible Auto tool mode, bounded provider data and sanitized phase diagnostics. Ended coordinators restart within the same workflow after configuration changes; unchanged configuration resumes history.
- **Visible integration:** CLI/MCP checkpoint APIs, generated strong/worker agents, resources and focused regression tests. Existing strict gates remain unchanged. Simulated tests do not prove live provider access.

See [lightweight procedure](resources/guides/lightweight.md) and [bridge setup](docs/vscode-bridge.md). Select mode in project policy, then regenerate adapters with `neomind update`.

## Research and reusable Cornell knowledge

The `neomind-knowledge-reuse` skill inspects workspace evidence and local Cornell notes before planning, searches verified local cache with `knowledge_search`, and records applicability and version/feature differences through `knowledge_research`. Similar projects reuse proven framework knowledge, not an entire implementation. Fresh native workflows keep research required before planning and task dispatch.

**New native policies default to `network_policy: local-only` and `automatic_pr: false`.** Research and Cornell findings are saved inside the project with a confirmed note ID/path. Local-only makes zero remote discovery, publication or archive requests; explicit remote tools reject. Scope a local no-match as **upstream not searched**; a 401 or failed request is never no-match. Required checks, independent review and acceptance remain unchanged.

Later publication requires user opt-in to `remote-enabled` and current independent review of **sanitized, public-safe** findings. Automatic knowledge publication additionally requires `automatic_pr: true`; the saved `project-branch` route uses `neomind/knowledge/<stable-project-hash-prefix>` without PR or merge. A branch is not a privacy boundary. Validated local artifacts and verified Git sources retain their authority; SQLite FTS5 is disposable. Existing policies are preserved: absent `network_policy` retains legacy remote behavior. See [knowledge reuse, policy and publication](docs/knowledge-reuse.md).

## Install locally

Use **Node.js 24 LTS**. Build a tarball from this checkout:

```sh
npm ci
npm test
mkdir artifacts
npm pack --pack-destination artifacts
npm run package:smoke
```

In a target project, install that tarball. The following PowerShell example uses this checkout's default path; replace it when needed:

```powershell
npm install --save-dev ./neomind-0.1.0-alpha.4.tgz
npx neomind init --name "My project" --profile software --platforms copilot
```

Choose the platform or platforms you use, then use one native platform per session. Enable its native MCP/hook trust settings as required by that client. Installation preserves existing instructions and configuration.

For a separately installed runtime, `neomind init --local --platforms copilot --project DIRECTORY` selects persistent local Copilot integration. Local-mode initialization and updates automatically maintain Git's local `info/exclude` rules for generated NeoMind files and review candidates, preserving existing exclusion rules and leaving `.gitignore` untouched. Existing tracked files remain tracked. See [local Copilot installation and Git exclusions](docs/local-install.md).

### Replace an existing package

Stop active NeoMind/MCP/native sessions first. From an initialized npm project, replace its old local package and refresh integration with one command:

```powershell
npx neomind upgrade --to /absolute/path/neomind-0.1.0-alpha.4.tgz
```

After registry publication, `--to next`, `--to latest`, or an exact version selects a published `neomind` release. The command validates/stages the target **before** uninstalling local `neomind`/legacy `verythinker`, installs the replacement in the original dependency section, then runs the **new CLI's** conflict-aware `update`. It preserves project records and configured policies; edited integrations produce review candidates instead of being overwritten. Storage migration is a separate explicit operation.

Local tarballs are retained under the selected managed root's `package-cache/<sha256>.tgz`; preserve that archive with the project's `file:` dependency. Registry targets save an exact version. On failure, the command reports the phase and a recovery directory with manifest backups and old-package archives. It stops without automatic rollback; a failed install can leave the package absent. See [package upgrade and recovery](docs/package-upgrade.md).

An older release without `upgrade` must first use the manual bootstrap procedure in that guide. `update` alone only regenerates integrations; it does not reinstall the package. After a manual npm install, or moving the project/package, run `npx neomind update` and inspect conflicts. Global installs, workspaces, scoped packages and non-npm package managers are not supported by automatic replacement.

## Give one requirement

Start a fresh native agent session in the initialized project and describe the outcome:

```text
Add persistent configuration for intervalMs (100–60000) and retries (0–5).
Reject invalid values without changing stored configuration.
Preserve configuration across application restarts.
```

The managed instructions launch `NeoMind Coordinator Agent` through VS Code's standard agent tool and resume saved execution mode. A failed handoff remains blocked; running manager steps inline does not establish delegation. Fresh Copilot projects use the full native lifecycle, not lightweight mode. Both full native and strict workflows retain requirements, specialist discussion, engineering decisions, bounded assignments, documentation, checks, independent review, acceptance, archives and qualified knowledge contributions. Strict mode additionally requires signed invocation receipts. It asks for missing product intent or an actual external blocker; routine decisions and record-management commands remain internal.

Give one requirement or several related requirements in the same request. Copilot generates nine expert profiles: **Coordinator**, **Explorer**, **Researcher**, **Planner**, **Architect**, **Implementer**, **Debugger**, **Verifier**, and **Reviewer**, each named `NeoMind <profile> Agent`. Only Coordinator is user-invocable; it delegates applicable work to the eight specialists. Profiles have distinct procedures and native tool scopes. Coordinator, Planner, Architect, Verifier and Reviewer select strong policy; Explorer, Researcher, Implementer and Debugger select worker policy. Implementer and Debugger share the existing `developer` route. Existing project model choices, all twelve core role IDs and signed history remain intact. Model IDs and effort come from your routing policy; generated model preferences do not prove effective runtime selection or reasoning-effort support. See the [capabilities and model-role mappings](docs/roles.md) and [primary-source research](docs/research/modern-agent-set-platforms.md).

**Configure models in one file:** `.neomind/routing.json` (legacy: `.verythinker/routing.json`) is authoritative for strong/worker selection. Change it and run `npx neomind update`; generated agents and task context follow that policy, while legacy tier mappings remain preserved but inactive. See [model configuration](docs/model-routing.md) and the [Bosch/9localrouter template](examples/model-routing.json) for worker choices `gpt 4o-mini` / `gemini-2.5-flash-lite` and strong choices `company-top-tier-model` / `top-tier-model`, resolved through your existing VS Code model catalog without copying credentials.

**Assignment flow:** Coordinator selects source exploration, primary-source research, requirements/design, implementation or diagnosis as needed; separate Verifier and Reviewer invocations supply applicable evidence and independent assessment. Independent work may run in parallel, bounded to three workers. Existing full-workflow gates still apply; research-only requests do not invent implementation or simulation. Software, embedded/HDL and learning guidance use project tools when available. Native closure requires a valid workflow-linked Cornell note. Final delivery includes actual test reports and full Cornell findings; engineering completion never grants human release approval. See [full lifecycle and role mappings](resources/guides/copilot-native.md).

**Optional signed VS Code execution:** select `execution_mode: strict`, install and explicitly enable the [Model Bridge](docs/vscode-bridge.md), then use existing MCP `manager_run` or CLI `workflow run`. It selects exact registered vendor/model IDs, exposes only invocation-bound role-scoped MCP tools, and persists signed **local host attestations**, not provider-issued model/session proof. No builtin shell/filesystem tools or fabricated sandbox/effort acknowledgments. Stable VS Code cannot verify effort: explicitly set `vscode_effort_policy` to `allow-unavailable` after reviewing that ceiling, or keep execution blocked. Missing consent, unavailable models, stale host, and policy changes remain blockers. Historical Sol/Luna validation documents describe the earlier Codex policy, not live validation of this bridge.

Native local-only policy retains project records, research, Cornell findings and qualified contributions locally; remote archive and knowledge publication are deferred. Remote-enabled archive snapshots use the separately configured private project namespace and preserve implementation/evidence paths and hashes. Saved legacy policies retain their publication route; a private archive or public-safe review does not itself authorize a remote request. Read [knowledge policy and local resumption](docs/knowledge-reuse.md#resume-an-existing-increment-locally) and [the manager-first workflow](docs/autonomous-manager.md) for lifecycle limits.

The manager applies an iterative V-model:

```text
Requirement <-> Design <-> Implementation <-> Check <-> Evidence <-> Review
```

| Gate           | What it evaluates                                                             |
| -------------- | ----------------------------------------------------------------------------- |
| `ready`        | Measurable requirements, scope, dependencies, and checks                      |
| `design-ready` | Applicable design allocations, interfaces, and review                         |
| `verified`     | Passing evidence on the relevant source/configuration baseline                |
| `accepted`     | Submission, current independent review, traceability, and applicable evidence |

Workers submit substantive work records and affected project documentation; the core evaluates completion. Review uses a separate invocation from implementation and assesses the current implementation/documentation baseline. Hooks assist the process; the manager still validates completion through core operations when hooks fail or are disabled.

To resume in another session, use ordinary language:

```text
Continue the configuration requirement from its saved NeoMind workflow.
```

The manager inspects saved state and actual baselines, resumes valid evidence, and handles repair or stronger internal escalation. To resume an older project locally, explicitly save `network_policy: local-only` in its automation policy; missing legacy fields do not opt in. Intake/selected Manager resumes with `workflow_id`, while an already assigned Manager continues directly and specialists keep their bounded assignments. Keep the saved mode, route and acceptance gates. Pass the saved ID inside `note.workflow_id` with same-workflow record references; older external notes are historical context, not current evidence. Confirm the saved Cornell ID/path and report remote work deferred. Native session restrictions remain visible blockers; saved state does not imply a background process.

| Profile    | Use                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `basic`    | Requirements, tasks, checks, evidence, review, and lessons                                      |
| `software` | Add architecture/interfaces and verification levels                                             |
| `embedded` | Add hardware/software allocation, hardware-software interfaces, and reproducible configurations |

The process mapping references **Automotive SPICE 4.1** and an iterative V-model. It provides engineering guidance; it does not establish an ASPICE capability rating. Read the [process guide](docs/process.md) for profile coverage and evidence limits.

## Core tools and roles

The CLI and local stdio MCP server share the same core. Commands return structured JSON; `--project` selects another project root.

| Command group                        | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `init`, `doctor`, `update`           | Install, inspect capabilities, and update managed resources                |
| `record`, `task`, `context`          | Maintain engineering records and bounded assignments                       |
| `workflow`                           | Record manager intake, internal discussion, decisions, status, and closure |
| `check`, `review`, `trace`, `verify` | Execute checks, review, inspect impact, and evaluate gates                 |
| `memory`, `pack`, `index`            | Retrieve history, manage knowledge, and rebuild the index                  |
| `native`, `capability`               | Dispatch native roles, observe model receipts, and resolve approved tools  |
| `archive`                            | Prepare, publish, inspect, and restore private project increments          |
| `note`, `recipe`                     | Cornell knowledge and reviewed parameterized engineering procedures        |
| `mcp`                                | Start the local MCP server                                                 |

The manager uses MCP or the CLI internally. `npx neomind --help` remains available for debugging and direct inspection; the user does not need to run each workflow step.

Twelve [role contracts](docs/roles.md) include a dedicated codebase analyst and check executor. Verification strategy belongs to the strategic model; prescribed execution belongs to a cheaper worker. Run at most three workers and escalate repeated failure after one repair attempt. This branch defaults to Copilot model mappings. Strict automated execution requires the explicitly enabled VS Code Model Bridge and its compatibility policy; full native and lightweight execution use the client's available tools and remain unsigned.

## Persistent records and reusable knowledge

Fresh projects store authoritative Markdown/YAML records under `.neomind/records`. Existing `.taskforces` or `.verythinker` storage stays in its original directory until explicit migration. Stop all writers and native sessions, back up the project, then run `npx neomind migrate --project <path>`. Migration atomically renames the storage directory; it never merges roots or rewrites historical record/receipt bytes. Historical logical paths, signature issuers and managed markers remain readable, and saved remote archive/knowledge destinations are preserved. Active Bridge protocol and extension IDs use NeoMind: reinstall the extension, set the new User setting and explicitly enable a new host session. Conflicting storage roots, active locks or unknown receipt states block migration. No remote repository is renamed. Per-run JSONL events capture execution. SQLite/FTS5 is a rebuildable search index. Raw runs, cache, and prepared contributions are excluded from Git by default; preserve required execution logs separately when sharing verification records.

The manager archives required evidence logs/receipts under `.neomind/evidence` (legacy logical path: `.verythinker/evidence`) before final review and inspects their contents before sharing.

Each request batch receives a stable increment ID and individually traceable requirement IDs. Accepted releases use project SemVer, initially `1.0.0`, under `codex/projects/<name>-<project-id>/baseline`, `increments/<increment-id>`, and `releases/<version>`. Working checkpoints append to increment history; accepted release snapshots are immutable. A private archive includes related records, changed implementation, verification inputs, and pack/tool/recipe locks. Local-only defers remote archive requests. When remote archival is authorized, sensitive content and inaccessible private upstreams produce explicit publication blockers.

Every assignment writes a substantive standard work record: Objective, Inputs and Sources, Decisions and Rationale, Results, Evidence, Limitations, and Lessons. Required project documentation is part of the reviewed deliverable. A new session resumes using current workflow/task records.

Knowledge packs carry provenance, applicability, assumptions, limitations, dependencies, and locked versions/hashes. Similarity suggests candidates; the manager assesses applicability. The built-in `engineering-basics` pack supplies a starting checklist.

[Cornell notes](docs/cornell.md) turn research, analysis, guidance, root causes, and lessons into visible source-backed documents with concrete demonstrations and separate runnable practice/answer artifacts. The quote **“DO NOT JUST TALK ABOUT IT — SHOW IT”** appears in every note. Generated knowledge records reference the authoritative narrative and its hashes; user-written practice solutions are preserved.

[Versioned recipes](docs/recipes.md) provide Cornell evidence notes, scalar configuration persistence, and embedded hysteresis load control. A strategic specialist reviews and freezes parameters, coverage, expected outcomes, oracle rationale, and tolerances before a worker executes them. A developer generates implementation; an independent check executor records actual checks. Changed acceptance artifacts require reviewed reassessment.

The curator derives generalized candidates from reviewed project lessons and obtains a current separate generalization/public-safe review after sanitization. `.neomind/automation.json` (legacy: `.verythinker/automation.json`) controls network access, automatic knowledge publication and its upstream, with legacy destination `VuThach3001/VeryThinker`. New native policies keep candidates local. Later user opt-in to `remote-enabled` permits authorized remote operations; automatic publication additionally requires `automatic_pr: true` and follows the saved project-branch or legacy draft-PR route. Preserve confirmed receipts for recovery. Authentication/write failures block that remote operation, not authorized local research, and never establish no-match. Submission never merges or publishes a package. Tests use a simulated GitHub API, and local packaging creates no real upstream PR.

The role-scoped gateway installs only applicable approved providers into an isolated tool cache: CodeGraph `1.6.2`, Context7 `4.3.0`, and Playwright MCP `0.0.83`, with version/integrity locks. Required missing capabilities block dispatch; optional substitutions are recorded. Existing CodeGraph conformance remains a twelve-check Windows fixture; project freshness and native tool discovery still need applicable evidence. Code-context discovery complements reviewed requirements traceability.

## Pilots and validation

The [software pilot](examples/software/README.md) implements persistent validated configuration. The [embedded pilot](examples/embedded/README.md) supplies a hysteretic sensor/load controller, portable C firmware, a behavioral model, and a SPICE netlist.

```sh
npm test
node examples/verify.mjs
node scripts/evaluate.mjs matrix
```

Automated coverage includes record integrity, stale evidence/reviews, dependency handling, adapter preservation, MCP core operations, and pilot behavior. `examples/verify.mjs` records actual pilot results; compiler and ngspice checks require their tools to be supplied. Embedded results demonstrate their stated simulation/compilation environment, with physical testing recorded separately.

The historical evaluation matrix plans **18 native agent trials**: two pilots, three configurations, and three repetitions. One alpha.2 trial was blocked by native execution policy; seventeen remain unrecorded. Alpha.3's selected routing default is an engineering policy; measured cost/time benefits remain unverified. See the [validation report](docs/validation.md) and [evaluation guidance](docs/release.md#agent-evaluation).

## Design basis and license

Read [research](docs/research.md), [CAMEL adoption research](docs/camel-research.md), and [architecture](docs/architecture.md) for decisions and primary sources. The project learns scoped context and memory practices from Trellis, task-graph/context-pointer practices from Matt Pocock, code-context ideas from CodeGraph, and role/task collaboration with coordinator-owned execution from CAMEL.

NeoMind is [MIT licensed](LICENSE). Its code and templates are independently written; AGPL-licensed Trellis code/templates are not bundled. Third-party dependencies retain their own licenses.
