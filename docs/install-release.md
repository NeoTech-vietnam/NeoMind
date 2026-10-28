# Install the WorkForce runtime and VS Code extension

This guide describes candidate **`workforce-v0.2.0-alpha.1`**: runtime **`workforce@0.2.0-alpha.1`** with extension **`workforce.workforce-model-bridge@0.12.0`**. It is not a claim that the candidate has been publicly released or passed installed-client acceptance. Use the matching assets and validation report once published in the [existing GitHub repository's releases](https://github.com/NeoTech-vietnam/NeoMind/releases). Earlier NeoMind releases remain unchanged.

| Asset | Purpose |
| --- | --- |
| `workforce-runtime-0.2.0-alpha.1-windows-x64.tgz` | Native Windows x64 runtime, dependencies and engine |
| `workforce-runtime-0.2.0-alpha.1-linux-x64.tgz` | Native Linux x64 runtime, dependencies and engine |
| `workforce-model-bridge-0.12.0.vsix` | WorkForce Universe, Local WF.PM and workspace owner |
| `SHA256SUMS` | SHA-256 digests for the paired artifacts/reports |
| `release-manifest.json` and validation reports | Exact versions, engine pins, platform checks and acceptance evidence |

Portable runtimes include the pinned OpenCode **1.19.4** SDK/platform binary and locked engine bootstrap. They do not install a missing engine dependency inside your first request. Node.js **24.x or 26+**, Git, `tar` and VS Code **1.143+** are prerequisites. Optional checkers may need the project's compiler/Python/toolchain; setup must identify such requirements before dispatch. Linux core/package evidence does not establish Linux VS Code desktop support.

## 1. Extract the matching native runtime

Keep the runtime outside your project and use a new versioned directory. Windows PowerShell:

```powershell
Get-FileHash .\workforce-runtime-0.2.0-alpha.1-windows-x64.tgz -Algorithm SHA256
Get-FileHash .\workforce-model-bridge-0.12.0.vsix -Algorithm SHA256
New-Item -ItemType Directory -Path D:\tools\WorkForce\0.2.0-alpha.1 -Force
tar -xzf .\workforce-runtime-0.2.0-alpha.1-windows-x64.tgz -C D:\tools\WorkForce\0.2.0-alpha.1
$wfRuntime = 'D:\tools\WorkForce\0.2.0-alpha.1\workforce'
node "$wfRuntime\dist\cli.js" --version
```

Compare the printed hashes with `SHA256SUMS`. The extracted directory must contain `package.json`, `dist`, `node_modules`, `resources/opencode-bootstrap` and `distribution-manifest.json`. Keep the original archive and checksums for repeatable installation.

Linux shell:

```sh
sha256sum --check SHA256SUMS
mkdir -p "$HOME/.local/share/workforce/0.2.0-alpha.1"
tar -xzf workforce-runtime-0.2.0-alpha.1-linux-x64.tgz -C "$HOME/.local/share/workforce/0.2.0-alpha.1"
wf_runtime="$HOME/.local/share/workforce/0.2.0-alpha.1/workforce"
node "$wf_runtime/dist/cli.js" --version
```

Do not use the Windows engine asset on Linux or the Linux engine asset on Windows. Node remains a separately installed prerequisite.

## 2. Install the paired extension

```powershell
code --install-extension .\workforce-model-bridge-0.12.0.vsix --force
```

Alternatively use **Extensions: Install from VSIX**. Set the VS Code **User** setting `workforce.bridge.runtimePath` to the extracted `workforce` directory, such as `D:\tools\WorkForce\0.2.0-alpha.1\workforce`. Workspace overrides of this trusted runtime path are ignored.

When replacing NeoMind, disconnect its previous owner and disable the previous extension in the intended workspace before connecting WorkForce. The new publisher/extension identity does not share another extension's SecretStorage: reconnect private calendar feeds or YouTube API keys from WorkForce when needed. Provider credentials in your existing custom endpoint catalog are preserved.

## 3. Initialize or migrate the exact project

For a new project:

```powershell
node "$wfRuntime\dist\cli.js" init --local --platforms copilot,codex --name MyProject --project D:\path\to\project
```

For an existing NeoMind project, first stop its active sessions and keep its old runtime/extension available as a backup. Then use the matching WorkForce CLI:

```powershell
node "$wfRuntime\dist\cli.js" migrate --project D:\path\to\project
node "$wfRuntime\dist\cli.js" update --local --project D:\path\to\project
node "$wfRuntime\dist\cli.js" doctor --project D:\path\to\project
```

Explicit WorkForce migration selects its new engine/integration for future execution. Historical workflows retain their saved contract, scope, signatures and provenance. Migration preserves an original hash-bound backup; request records are organized under `.workforce/requests/`, while shared or ambiguous historical records stay separate. See [migration and recovery details](workforce-install.md).

`init --local` and `update --local` add managed rules to `.git/info/exclude`, preserve existing exclusions and leave `.gitignore` untouched. Already tracked files remain tracked. User-edited integrations and MCP entries become review conflicts rather than being silently overwritten. Review any reported conflicts before enabling a competing owner.

## 4. Connect once in Universe

Open the intended folder as a trusted VS Code workspace. Run **Developer: Reload Window** after replacing the VSIX, then **WorkForce: Open Universe**.

Use **Connect WorkForce**. WorkForce binds the exact project and trusted runtime, resolves the selected custom endpoint catalog, and checks the configured aliases through a real bounded model/tool probe. A successful proof is cached against the relevant build/configuration rather than repeating before every request. Configuration or an installed version alone must not appear as successful model access.

Keep your existing `top-models` and `worker-models` choices in 9router. If WorkForce cannot identify a unique existing VS Code catalog, use **Choose model catalog** and select that profile's `chatLanguageModels.json` through the native picker. This retains provider keys in the catalog and stores only its selected path in project routing. It does not require manually copying credentials into chat or editing protocol payloads. Endpoint/model access belongs to your existing provider configuration; an alias does not attest the actual upstream model.

Use **WorkForce: Open Local WF.PM**. The command creates a **Local** Copilot chat with `WF.PM`, preserves your model picker and sets `chat.permissions.default` to `autoApprove` for that workspace where supported. VS Code Trust, first-use approvals and organization policy remain effective. It does not change global approval settings.

Approved exact workspace/runtime/build connections can restore after reload and reconcile saved work. A changed trusted runtime or revoked connection requires the corresponding new approval. **WorkForce: Disconnect Workspace** revokes the owner and stops its execution.

## 5. Give WorkForce a normal request

Write your requirement in Local WF.PM, Codex with the generated MCP integration, or Universe's request box. Relevant attachment context must resolve to real files/folders. Do not supply assignment tokens, synthetic IDs, claim credentials or special protocol prompts.

All entrances submit to the same request runtime. The chat entry submits/follows the request; runtime-owned workers implement, review and test it. The UI displays each request's V-model stages, products, criteria and findings. Draft outputs are accessible while checks continue. Only accepted results are completed.

MCP exposes `request_submit`, `request_status` and `request_control`. The extension's Local tool is **WorkForce Request**. A model may discover that tool and pass the complete ordinary requirement; the user should not have to write JSON. Restart an affected MCP server and use a fresh chat after integration changes so discovery matches the installed version.

Closing chat or switching to Focus Space does not cancel accepted work while VS Code remains open. Closing VS Code stops the model, dispatch and owned checks; reopening reconciles the durable checkpoint before continuing. Ambient audio retains its existing view-switch behavior. YouTube still follows visible-player and provider restrictions.

## Source/npm development installs

The portable GitHub asset is the supported no-deferred-download runtime. From a source checkout, prepare the engine bootstrap before use:

```sh
npm ci
npm run engine:bootstrap
npm test
npm run runtime:package
npm run extension:package
```

An npm tarball installation resolves production dependencies during installation and needs the matching prepared bootstrap; it is not an excuse for downloading missing packages in a request. `npm run package:smoke` checks installed package mechanics without inference. Its pass does not establish Copilot Local/Codex/panel acceptance. The release validation report must separately identify those actual client journeys and remaining incidents.

For the `codex/workforce-vmodel` branch, its normal push CI builds native candidate assets after the same Windows/Ubuntu regression jobs pass. Download the corresponding `workforce-candidate-Windows-*` or `workforce-candidate-Linux-*` CI artifact to inspect its runtime, VSIX, checksums and extracted-package report. These are review candidates; the workflow has read-only repository permissions and does not create a release.
