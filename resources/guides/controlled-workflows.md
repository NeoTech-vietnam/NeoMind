# Controlled software workflows

Use this path when the project explicitly configures `execution_mode: neomind-controlled`, or the user chooses controlled continuation through the backend. Client intake reads the exact project's policy and saved receipt. Backend-owned sessions receive their current policy, assignment and scope from the runtime.

## Backend-owned session

Prepared Cornell research uses `workflow_plan.cornell_input_path` with `cornell_output_dir`. This names professional source data; the backend supplies its hash, source binding and compiler payload. The bound Implementer calls `cornell_research_compile({})` without copying or overriding the source. Native compiler tools are not operating-system commands.

An explicit runtime role/stage packet and bound semantic tools identify this branch. Follow that packet and use the supplied tools for saved context, ordinary project files and the assigned operation. Runtime identities, credentials, authorization and lifecycle remain backend-owned. A generated profile name or project instruction file alone does not establish this context.

Workspace Trust, model-access consent and client MCP discovery belong to client setup. The host enforces them during worker dispatch. Report a specific observed host/tool failure; reading a private `.neomind` guide or configuration is not a prerequisite for an active assignment. When project `AGENTS.md`, generated profiles or other source files describe the client entrypoint, apply those instructions to client intake and continue the worker assignment from its backend-provided state. Private path guards remain in force.

The `runtime_context` result supplies current-session observations and toolchain discovery from the enabled host's PATH. Successful observations establish the current preflight checkpoint; work then proceeds with the assigned implementation, independent verification or review. Optional absolute executable paths come from actual project configuration or documentation. An invalid optional path produces a diagnostic for that tool while authoritative session context and other observations remain available. A toolchain is required only when the assigned operation needs it.

Use the operations advertised for this invocation. Planning describes future execution bindings; an implementation session can execute only the steps and procedure actually supplied to it. A read-only review inspects artifacts and evidence and returns its verdict. Each role saves one compact `assignment_report` when its professional work is ready; runtime events and the saved report drive the next stage.

## Planning boundaries

`execution_steps` describes direct OS processes, such as `node scripts/generate.mjs`, or fixed version observations. The native `cornell_research_compile` and `procedure_run` tools are supplied through the declared Cornell destination or eligible reuse binding; their tool names are not executable argv. A plan needing only those bound tools has no corresponding local-process step.

Producer `outputs` lists product code, requested notes and producer documentation. Checker scripts, negative fixtures and verifier-authored reports stay in `verification_paths` and the independent check contract. Exact hidden skill templates and validator sources belong to read-only `input_paths`; `preservation_paths` identifies existing public files to keep unchanged. Both input groups are fingerprinted by the backend without making them writable.

## Prepared payloads

When research already exists in an ordinary project JSON file, pass its project-relative `input_path` to `cornell_research_compile`. The file contains the semantic fields accepted by the current controlled tool, rather than a standalone CLI recipe envelope. The backend reads, parses and validates the file, captures its source hash and binds the requirement, output folder and provenance. Send either the prepared-file reference or direct semantic research fields. The file form does not merge model-provided overrides into its data.

For an advertised `task_run`, choose the declared step title and supply an already-readable public JSON file as `input_path`. The backend privately captures that source in the execution's read-only hash baseline. The prepared file does not require a new planner declaration or a change to frozen `input_paths`; the declared command and write scope remain unchanged. Scope, file freshness and input validation still apply.

Preserve the distinction between JSON representation and string content. Authored prose contains actual newlines; JSON examples may legitimately contain literal `\n` sequences. The backend parses the source once. Copying serialized tool text into a second request or globally replacing escape sequences changes the content. Private runtime files, linked paths and paths outside the current read scope remain unavailable.

For a primary Cornell deliverable, the Implementer supplies an expected worked result and the Verifier checks the generated bundle independently. A separately assigned post-verification synthesis uses current observed evidence. An expected example, a stored source file or a successful compiler call does not establish execution or acceptance.

## Client entrypoint

1. Submit the complete user requirement once through `manager_run` with `execution_mode: neomind-controlled`. Keep the returned workflow receipt. For existing work, select its actual saved workflow ID and use the backend's resume operation.
2. NeoMind owns the Coordinator, implementation, independent verification and any risk-required review. Let the runtime advance accepted work. Parent chats return the receipt and query `manager_status` when progress is requested.
3. Use `manager_control` for a requested pause, resume or cancel. Every control targets the exact saved workflow; multiple open workflows require an explicit selection.
4. Report actual artifacts, check evidence and the saved final state. Agent completion, report persistence and workflow acceptance are distinct.

The client entrypoint supplies user intent. The runtime binds role, workflow, task, invocation, credentials, report targets and operation identity. Worker tools receive semantic content and scoped paths; their actor context remains private. Ordinary progress is produced from runtime events rather than model bookkeeping.

Supply the full product goal in `requirement` or `requirements`, retaining every acceptance, process, scope, preservation and safety obligation. Runtime dispatch belongs in `execution_mode`; status uses `manager_status`, and pause/resume/cancel uses `manager_control` with the exact `workflow_id` and `action`. These client operations do not request changes to product orchestration. Actual authentication, storage, execution and orchestration changes remain product requirements subject to the backend minimum risk policy. When product and operating instructions cannot be separated unambiguously, retain the complete request. Opaque input remains conservative; this guidance neither strips keywords nor changes a saved contract or its required review.

## Model access and lifetime

Before client submission, the trusted project must be open in VS Code with its NeoMind Model Bridge enabled. The user grants Workspace Trust and model-access consent through VS Code. Even when Codex submits the request, workers use the VS Code LM Bridge and the project's role/model policy. The parent Codex provider stays independent.

Closing the parent chat or Workflows panel leaves accepted work running while VS Code remains open. Disabling the Bridge or closing VS Code stops dispatch, model requests and owned check processes. After reopening, reconcile the most recent durable checkpoint and any uncertain effects before retrying. An abrupt crash cannot guarantee a final checkpoint.

Record requested and Bridge-observed vendor/model separately. A 9router alias does not establish its actual upstream model, and reasoning effort unavailable through the VS Code API remains unverified.

## Verification and recovery

Implementation and checker paths remain disjoint. Producers edit implementation; Verifier edits its checker scope. Scope and compare-and-write checks preserve user edits. Checks execute reviewed argument arrays with bounded output, time and cancellation. This mediation is not an OS security sandbox for arbitrary trusted scripts.

Final review uses `check_evidence({"kind":"workflow"})` for the backend's current scoped preservation comparison, check freshness and report lifecycle, and the ordinary check-evidence view for actual bounded execution output. Judge the files and conditions in the frozen plan; the backend observation covers those captured inputs rather than an invented whole-repository historical baseline.

Keep the two report responsibilities separate. A user-requested report file is a producer deliverable and must meet its saved criteria before it can pass review. The backend's final workflow record is created only after required verification and review pass. Its expected absence during review is not missing execution evidence and does not excuse an incomplete producer report.

When the requested final report needs actual independent results, planning declares its exact `evidence_report_paths` within both `outputs` and `documentation_paths`. Primary Cornell `note.md`, `exercises.md` and `answers.md` remain separate deliverables. After an independent verification checkpoint, the backend assigns the Implementer only those final report files. This assignment reads the supplied checkpoint and bound evidence, records factual results and limitations, and saves one compact result. Product code, checkers and Cornell files remain read-only. A fresh Verifier then checks the completed delivery before required final review. This is the normal report handoff; the earlier checkpoint does not accept or close the workflow.

For a new plan, a check that needs the completed evidence report can declare `after_evidence_reports: true`. At least one product check remains before that handoff, and each initial check still runs its required negative controls. The first Verifier establishes only that product checkpoint. After the report is written, a fresh Verifier runs every planned check, including the deferred report checks and their negative controls, before final review. Unflagged checks and existing frozen plans retain their original execution conditions. No check is waived.

During a planned report handoff, the initial report describes implementation status and labels genuinely unrun verification as pending. The report-only assignment replaces that intermediate account with already observed results and remaining limitations. It cannot claim the following verification, review or closure has already succeeded.

Classify failures before repair: product defects go to implementation, checker defects go to independent verification with negative controls, protocol defects go to runtime reconciliation, and missing environment/provider access produces a specific setup condition. Preserve existing worker and repair limits. Repeated identical failures cannot create an unbounded retry loop.

Find applicable existing scripts and eligible procedures before writing new automation. FTS5 retrieval is advisory; applicability and current execution evidence come from the authoritative contract and files. Cornell output, when required, uses the existing research template and `00_note/NeoMind` destination.

## Registration and old workflows

Controlled adapter generation registers the exact-project MCP server in `.codex/config.toml` and, for VS Code Copilot, `.vscode/mcp.json`. Local controlled mode preserves unrelated entries and produces review candidates for edited owned entries. `.neomind/mcp-server.json` records the workspace registration destination; it is not independently discovered as client configuration.

Generated files prove configuration only. Confirm that the real client loaded `manager_run`, `manager_status` and `manager_control` and performed a successful call. A missing tool should trigger connection/setup inspection rather than native worker fallback.

Saved legacy mode, history, acceptance conditions and prior evidence remain intact. A controlled continuation records new execution lineage. Existing reviews and reports never become current execution evidence merely because a new runtime is installed.
