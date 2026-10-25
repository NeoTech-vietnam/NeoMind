# NeoMind-controlled agents in VS Code

NeoMind-controlled workflows run agents through the VS Code Model Bridge. Copilot chat, Codex chat and **NeoMind: Open Workflows** are entrypoints to the same runtime. NeoMind owns worker sessions, tool identity, stage transitions, evidence and recovery.

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

New plan submissions receive backend-generated baseline metadata for delivered outputs, the checker and its declared fixtures. Ordinary source references do not need hidden-file approval. Original continuation check baselines stay exact; previously frozen contracts are not normalized or rewritten. A resumed planner receives bounded, redacted prior validation diagnostics instead of having to rediscover a failed request.

A generic check labelled `intended-use` runs its declared command unchanged. Only an explicitly bound supported continuation adapter adds its own pilot protocol. The LeetCode continuation adapter still requires the separate disposable Cornell/C11/C++17 pilot and actual independent evidence; that contract is not imposed on unrelated Node.js tasks.

## Models, recovery and limits

- Workers use the role/vendor/model configured for the VS Code Bridge, including a registered 9router custom provider. Codex remains a submission client; its parent provider/model is not rewritten by controlled adapter generation.
- Requested model, Bridge-observed vendor/model and actual upstream identity are different observations. A 9router alias and unavailable reasoning-effort metadata remain visibly limited.
- A model picker entry or `/v1/models` result confirms discovery, not a successful model request. `MODEL_NOT_SUPPORTED` means the endpoint rejected the configured target. Keep your chosen alias and correct its upstream chain in 9router, then resume the same workflow. NeoMind stops this configuration failure without silently replacing the model or spending its repair budget on repeated calls.
- Closing chat or the panel does not stop accepted work while VS Code stays open. Closing VS Code or disabling the Bridge stops owned sessions/checks. Reopen and resume from the last durable checkpoint after uncertain effects have been reconciled.
- Existing legacy workflows preserve their saved mode, history and committed acceptance conditions. Controlled continuation adds execution lineage rather than rewriting old evidence or manufacturing completion.
- Preservation capture inventories paths before reading content, yields during planning and checks cancellation/ownership before saving a task. Its bounds are 4,096 files, 8,192 directory entries, 8 MiB per file and 32 MiB total. Planning scans have a 10-second budget; each synchronous evidence scan has a 2-second budget, within an 8-second shared acceptance budget. Oversized inputs fail with a diagnostic rather than silently skipping files. Select the actual protected exercise/assets scope instead of whole curriculum, dependency or cache trees. Scope mediation does not prevent an arbitrary reviewed script from accessing the host.
- The first controlled executor requires VS Code. Headless/daemon execution and Linux desktop support require their own actual-client conformance; Ubuntu core tests alone are not desktop inference evidence.
- Network/publication policy still applies. The controlled runner's tool mediation and output checks are not a general OS sandbox for arbitrary scripts.

For the runtime-facing sequence and evidence rules, see [the controlled workflow guide](../resources/guides/controlled-workflows.md). Release acceptance requires actual successful calls through each claimed entrypoint and a complete verified workflow, not configuration checks alone.
