# Controlled software workflows

Use this path when the project explicitly configures `execution_mode: neomind-controlled`, or the user chooses controlled continuation through the backend. Read the exact project's policy and saved receipt first.

## Client entrypoint

1. Submit the complete user requirement once through `manager_run` with `execution_mode: neomind-controlled`. Keep the returned workflow receipt. For existing work, select its actual saved workflow ID and use the backend's resume operation.
2. NeoMind owns the Coordinator, implementation, independent verification and any risk-required review. Let the runtime advance accepted work. Parent chats return the receipt and query `manager_status` when progress is requested.
3. Use `manager_control` for a requested pause, resume or cancel. Every control targets the exact saved workflow; multiple open workflows require an explicit selection.
4. Report actual artifacts, check evidence and the saved final state. Agent completion, report persistence and workflow acceptance are distinct.

The client entrypoint supplies user intent. The runtime binds role, workflow, task, invocation, credentials, report targets and operation identity. Worker tools receive semantic content and scoped paths; their actor context remains private. Ordinary progress is produced from runtime events rather than model bookkeeping.

## Model access and lifetime

The trusted project must be open in VS Code with its NeoMind Model Bridge enabled. The user grants Workspace Trust and model-access consent through VS Code. Even when Codex submits the request, workers use the VS Code LM Bridge and the project's role/model policy. The parent Codex provider stays independent.

Closing the parent chat or Workflows panel leaves accepted work running while VS Code remains open. Disabling the Bridge or closing VS Code stops dispatch, model requests and owned check processes. After reopening, reconcile the most recent durable checkpoint and any uncertain effects before retrying. An abrupt crash cannot guarantee a final checkpoint.

Record requested and Bridge-observed vendor/model separately. A 9router alias does not establish its actual upstream model, and reasoning effort unavailable through the VS Code API remains unverified.

## Verification and recovery

Implementation and checker paths remain disjoint. Producers edit implementation; Verifier edits its checker scope. Scope and compare-and-write checks preserve user edits. Checks execute reviewed argument arrays with bounded output, time and cancellation. This mediation is not an OS security sandbox for arbitrary trusted scripts.

Classify failures before repair: product defects go to implementation, checker defects go to independent verification with negative controls, protocol defects go to runtime reconciliation, and missing environment/provider access produces a specific setup condition. Preserve existing worker and repair limits. Repeated identical failures cannot create an unbounded retry loop.

Find applicable existing scripts and eligible procedures before writing new automation. FTS5 retrieval is advisory; applicability and current execution evidence come from the authoritative contract and files. Cornell output, when required, uses the existing research template and `00_note/NeoMind` destination.

## Registration and old workflows

Controlled adapter generation registers the exact-project MCP server in `.codex/config.toml` and, for VS Code Copilot, `.vscode/mcp.json`. Local controlled mode preserves unrelated entries and produces review candidates for edited owned entries. `.neomind/mcp-server.json` records the workspace registration destination; it is not independently discovered as client configuration.

Generated files prove configuration only. Confirm that the real client loaded `manager_run`, `manager_status` and `manager_control` and performed a successful call. A missing tool should trigger connection/setup inspection rather than native worker fallback.

Saved legacy mode, history, acceptance conditions and prior evidence remain intact. A controlled continuation records new execution lineage. Existing reviews and reports never become current execution evidence merely because a new runtime is installed.
