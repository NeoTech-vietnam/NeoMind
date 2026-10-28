# Actual Copilot Local acceptance driver

This is a development-only driver, excluded from runtime/VSIX packages. It does not replace Copilot, simulate a model, call `requestSubmit`, or approve platform dialogs. It uses the installed VS Code commands that create a Local chat and submit a normal query, then exports that actual session and observes the shared runtime's saved receipts.

The implementation was checked against installed VS Code **1.143.1**, whose built-in **GitHub.copilot-chat 0.71.0** supplies Local Copilot. Its native command source supports:

- `workbench.action.chat.newLocalChat`, explicitly selecting Local;
- `workbench.action.chat.open` with `mode`, exact `modelSelector`, `query`, `isPartialQuery` and `blockOnResponse`;
- `workbench.action.chat.export` with an explicit output URI. The export contains actual `modelId`, `modeInfo`, tool calls and request text.

`blockOnResponse` returns when the response completes or needs a native confirmation. The driver records that condition and never presses Allow, grants model access, changes approval settings or retries the prompt. Workspace Trust and model/MCP authorization remain actual platform requirements.

The driver rejects `ExtensionMode.Test`; it deliberately does not use `--extensionTestsPath`, `--disable-workspace-trust`, in-memory secrets, imported chat histories or testing/model simulation flags. It requires the WorkForce VSIX installed in the same actual profile. Loading this small driver as a development extension does not make a fixture response count as actual-client evidence.

## Preparation — no inference

```powershell
node test/vscode-client-driver/prepare.mjs
node test/vscode-client-driver/launch.mjs
```

Preparation creates an isolated learning fixture, its normal local integration, config and authorization file under `D:\workspace\NeoMind\artifacts\workforce-client-driver`. It does not open VS Code. Dispatch defaults to **false**. The launcher prints exact arguments and also does not open VS Code unless the operator supplies `--launch`.

The default prompt is the user's original ordinary request: “I want a leetcode exercise and create a cornell note for me in vscode window”. A README attachment supplies the fixture's normal learning context. No protocol prompt or synthetic workflow ID is added. The protected NeoLearning root is refused by the default configuration.

## Actual run — only after explicit authorization

Install the reviewed candidate VSIX, set the User setting `workforce.bridge.runtimePath` to the freshly extracted candidate runtime, reload the VS Code window, then launch this driver with `--launch`. The actual workspace must be trusted. Connect WorkForce through its product setup and complete its genuine cached capability check. Those platform actions may require the user; this driver does not bypass them.

Use `node test/vscode-client-driver/control.mjs inspect` to inspect actual versions, workspace trust, effective workspace permission default, registered model metadata, native commands, runtime build fingerprint and installed WorkForce source fingerprint. The configured User runtime and imported runtime must both resolve to the reviewed candidate directory before dispatch; a source checkout or another installation is refused. Inspection is read-only and sends no chat query. A runtime setting change during observation invalidates client evidence rather than accepting work from a different installation.

`configure-runtime` sets only the User `workforce.bridge.runtimePath` to the approved extracted runtime, through the native VS Code configuration API in the exact trusted fixture window. `connect` invokes the actual WorkForce Connect command and leaves its consent dialog to the user. Neither operation authorizes chat dispatch. The helper activates only in the configured single fixture workspace, so unrelated or empty editor windows cannot take over its control endpoint.

Only after the operator authorizes the reviewed fixture/prompt, set `allow_chat_dispatch` to `true` in that run's authorization file. The run ID, workspace, prompt hash and one-prompt limit must match. Then call `control.mjs run-once` once. It opens Local WF.PM, selects the actual unique registered `customendpoint/top-models`, sends the ordinary prompt and starts receipt observation. A durable exclusive ledger prevents another dispatch, including after driver restart. An uncertain dispatch is never retried automatically.

`control.mjs status` reads the latest evidence. `capture` exports the fresh validation chat and retains only safe metadata/hashes, mode/model identifiers and tool-call identities. It refuses to treat a different focused chat as the issued request. Raw temporary exports are removed after projection. No clipboard is read or replaced.

An `actual-client-request-accepted` result requires exactly one new backend request, verbatim requirement preservation, an actual matching native chat export with the WF.PM mode and a WorkForce tool call, and actual runtime acceptance. The installed `chat.open` handler can ignore an unknown mode name, so successful command return alone is insufficient. Missing/incomplete evidence is reported as such. This still does not prove every request type or replace independent inspection of the delivered products.

Public APIs do not expose the rendered **Local** label or the live permission picker. The report records that limitation instead of pretending to see them. It records the actual native Local command result, requested model metadata, exported model ID and effective workspace default; screenshots/human observation remain separate evidence.
