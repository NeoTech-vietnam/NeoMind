# NeoMind-controlled agents in VS Code

NeoMind-controlled workflows run agents through the VS Code Model Bridge. Copilot chat, Codex chat and **NeoMind: Open Workflows** are entrypoints to the same runtime. NeoMind owns worker sessions, tool identity, stage transitions, evidence and recovery.

The setup steps below apply to the client submitting a user request. A backend-owned worker follows its explicit runtime role/stage packet and advertised semantic tools, using the policy, scope and saved state provided by the backend. The host enforces trust and model access; workers report actual host/tool failures and retain private path guards. Project instructions pointing to private `.neomind` setup guides describe client intake and do not add a worker prerequisite. A profile name alone is not proof of a backend-owned session.

## Enable the controlled entrypoint

1. Install the matching NeoMind runtime and VSIX following [the release installation guide](install-release.md). Set the **User** setting `neomind.bridge.runtimePath` to the trusted installed runtime directory; workspace overrides are ignored.
2. Open the exact project folder in VS Code and grant Workspace Trust. Run **NeoMind: Enable Model Bridge**, review the project/runtime paths and grant model access when VS Code requests it. These permissions remain under the user's control.
3. In the project's existing `.neomind/automation.json`, set only the `execution_mode` field to `neomind-controlled`. Preserve network, publication and other authored policy fields. This is an explicit opt-in; installing/upgrading does not silently convert old project policies or workflows.
4. Regenerate the project's client adapters:

   ```powershell
   neomind update --local --project D:\workspace\NeoLearning
   neomind doctor --project D:\workspace\NeoLearning
   ```

5. Review any update candidates. Controlled mode writes a managed exact-project server entry to `.codex/config.toml` and `.vscode/mcp.json`, preserving authored siblings. An edited server entry becomes a review candidate rather than being overwritten. Check for an older duplicate user-profile connection before enabling both registrations.
6. Reload/start the MCP server in the real client and, if necessary, restart the chat/client to refresh discovery. Confirm that `manager_run`, `manager_status` and `manager_control` are actually visible and callable. `doctor` distinguishes matching config from unverified discovery; generated files and agent profile names do not prove a live connection.

Local mode preserves `.gitignore` and existing local exclusions. Git exclusions apply to whole files, not individual JSON server entries. An already tracked `.vscode/mcp.json` remains tracked and follows Git branches. Do not ignore unrelated authored configuration merely to hide the NeoMind server entry.

## Give NeoMind a task

Use **NeoMind: Open Workflows**, or ask the NeoMind Coordinator in Copilot/Codex to submit the complete outcome and constraints.

For VS Code **Local Copilot Chat**, run **NeoMind: Open Local Coordinator** or use the button in Workflows. NeoMind first creates a Local chat, then selects the installed **NeoMind Coordinator Agent** profile. If VS Code cannot create Local Chat, the command stops with an error. It does not substitute an SDK, Auto or cloud session. This opens an empty chat; it does not submit work automatically.

In that chat, check the **Local** label and choose your custom-endpoint/9router model, such as your configured `top-models` alias, in Copilot's model picker. NeoMind leaves the parent chat's model, provider and permissions under your control. The owned workers independently use the role models configured for the Model Bridge. Opening a profile alone does not prove model access or a successful workflow; verify the actual runtime receipt and observed worker vendor/model.

The MCP entrypoint accepts:

```json
{
  "requirement": "Implement the requested change, preserve existing exercises, and verify it independently.",
  "execution_mode": "neomind-controlled"
}
```

`manager_run` returns a saved receipt quickly. NeoMind continues the task independently of the parent chat. Use its returned workflow ID for `manager_status` and for `manager_control` with `pause`, `resume` or `cancel`. Select the intended saved workflow when more than one is open; a recent workflow is not automatically the correct target.

The default execution is Coordinator, Implementer and independent Verifier. Additional specialists and Reviewer are selected by task needs, risk and the saved contract. Workers receive role-local semantic tools; they do not enter assignment tokens or reconstruct task/report IDs. Runtime events drive the Workflows panel and Universe. A configured planet is not a running agent.

Instructions follow each invocation's actual tool list. A plan can describe future producer operations, but the current worker receives only its bound execution steps and eligible procedure. Roles return one substantive result; they do not repeatedly post progress or ask the model which lifecycle operation to perform next.

Prepared research JSON can be passed to the controlled Cornell tool by project-relative `input_path`. NeoMind reads and parses the current scoped file directly instead of asking the model to copy serialized JSON into another payload. Direct authored research remains supported as a separate input form. The two forms cannot be combined with overrides. Source-file reads retain their hash checks, and parsing preserves legitimate escape sequences inside examples.

A declared local script step can also consume an already-readable public JSON file through `task_run` with its step title and `input_path`. NeoMind captures the source hash as a read-only execution input without asking the planner to add the file to frozen `input_paths`. The saved command and authorized outputs stay the same; a prepared-file reference grants no additional read or write scope.

New plan submissions receive backend-generated baseline metadata for delivered outputs, the checker and its declared fixtures. Ordinary source references do not need hidden-file approval. Original continuation check baselines stay exact; previously frozen contracts are not normalized or rewritten. A resumed planner receives bounded, redacted prior validation diagnostics instead of having to rediscover a failed request.

A generic check labelled `intended-use` runs its declared command unchanged. Only an explicitly bound supported continuation adapter adds its own pilot protocol. The LeetCode continuation adapter still requires the separate disposable Cornell/C11/C++17 pilot and actual independent evidence; that contract is not imposed on unrelated Node.js tasks.

For that adapter, the runtime supplies a fresh owned pilot directory and nonce to the intended-use command and its associated negative controls. The saved planned argv remains unchanged. A negative control must produce its expected failing exit code and never supplies positive pilot proof; the positive pilot still requires independent canonical note validation and fresh C11/C++17 builds and execution.

When a committed legacy contract requires review before checks execute, that review assesses checker readiness: the exact oracle, negative controls and safe bounded execution. Results from those unrun checks are not prerequisites for readiness. Passing this review authorizes checks; it does not accept the product. The separate final product review still requires fresh execution evidence and every committed acceptance condition.

Reviewers can read the backend-owned workflow evidence view for the frozen preservation paths, expected/current hashes, current check coverage and report lifecycle. This view establishes only the captured scope. A changed protected input still blocks acceptance; a missing whole-repository snapshot is not a new criterion unless the saved contract requires it.

An authored report file named in the plan is a product deliverable. It must describe the required final outcome before review can pass. The runtime's separate final workflow record is written after accepted verification and review; a report at implementation handoff is not that final record. Reviewers distinguish these responsibilities rather than requiring premature workflow closure or accepting an unfinished requested report.

For a final report that must cite actual independent results, the plan marks its exact `evidence_report_paths` as both producer outputs and documentation paths. NeoMind completes the implementation, obtains an independent verification checkpoint, and then assigns only the promised report files for factual completion from that evidence. It runs fresh independent verification after the report changes and performs the required final review. The report assignment cannot edit code, checkers or Cornell bundles, and its completion does not close the workflow. This planned handoff preserves the acceptance criteria and avoids using a failed review merely to request the results report.

A new plan may mark a check that depends on the completed results report with `after_evidence_reports: true`. At least one product check and its negative controls run before the report handoff. The later fresh Verifier runs all planned checks and negative controls, including those report-dependent checks; only then can final review and acceptance proceed. Existing frozen plans and unflagged checks keep their original conditions. An initial report truthfully labels pending verification, while the report-only assignment records actual checkpoint results without claiming future review or closure.

## Models, recovery and limits

- Workers use the role/vendor/model configured for the VS Code Bridge, including a registered 9router custom provider. Codex remains a submission client; its parent provider/model is not rewritten by controlled adapter generation.
- Requested model, Bridge-observed vendor/model and actual upstream identity are different observations. A 9router alias and unavailable reasoning-effort metadata remain visibly limited.
- A model picker entry or `/v1/models` result confirms discovery, not a successful model request. `MODEL_NOT_SUPPORTED` means the endpoint rejected the configured target. Keep your chosen alias and correct its upstream chain in 9router, then resume the same workflow. NeoMind stops this configuration failure without silently replacing the model or spending its repair budget on repeated calls.
- Closing chat or the panel does not stop accepted work while VS Code stays open. During orderly shutdown, closing VS Code or disabling the Bridge cancels owned sessions/checks and waits for their actual result persistence before closing the Bridge. Repeated disposal and deactivation share the same close operation. Reopen, enable the Bridge and explicitly resume the same workflow from its durable checkpoint.
- A crash or persistence failure can leave a command outcome unknown. Neither `manager_run` nor `manager_control` may automatically replay that command. Trusted local maintenance must assess its process identities, unchanged inputs and effects first; the separate immutable assessment preserves UNKNOWN and creates no execution verdict or passing evidence. Continuation then needs a new independent Verifier and fresh checks. This maintenance operation is not exposed to workers as a tool.
- Existing legacy workflows preserve their saved mode, history and committed acceptance conditions. Controlled continuation adds execution lineage rather than rewriting old evidence or manufacturing completion.
- Product/checker repair defaults to one attempt. A project owner can explicitly configure `repair_attempts` from 1 to 3 in `.neomind/config.json`, preserving its other fields. Increasing this limit does not reset saved usage or accept failed artifacts; resume the same blocked workflow for a new bounded attempt and fresh independent verification. NeoMind does not increase the limit automatically. Role-model changes apply only to subsequent invocations.
- Contract reads, Universe projections, acceptance and Cornell validation each share one fresh record inventory within their synchronous read. Each new call reloads the current bytes and checks duplicate IDs; changes, deletions and ownership updates remain visible. This keeps history rendering and evidence lookup from repeatedly scanning the entire store while workers are using the Bridge.
- Preservation capture inventories paths before reading content, yields during planning and checks cancellation/ownership before saving a task. Its bounds are 4,096 files, 8,192 directory entries, 8 MiB per file and 32 MiB total. Planning scans have a 10-second budget; each synchronous evidence scan has a 2-second budget, within an 8-second shared acceptance budget. Oversized inputs fail with a diagnostic rather than silently skipping files. Select the actual protected exercise/assets scope instead of whole curriculum, dependency or cache trees. Scope mediation does not prevent an arbitrary reviewed script from accessing the host.
- The first controlled executor requires VS Code. Headless/daemon execution and Linux desktop support require their own actual-client conformance; Ubuntu core tests alone are not desktop inference evidence.
- Network/publication policy still applies. The controlled runner's tool mediation and output checks are not a general OS sandbox for arbitrary scripts.

For the runtime-facing sequence and evidence rules, see [the controlled workflow guide](../resources/guides/controlled-workflows.md). Release acceptance requires actual successful calls through each claimed entrypoint and a complete verified workflow, not configuration checks alone.
