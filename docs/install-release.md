# Install WorkForce native-core

This source targets runtime **0.3.0-alpha.1** and extension **workforce.workforce-model-bridge 0.13.0**. Install the matching runtime and VSIX from the same [GitHub release](https://github.com/NeoTech-vietnam/NeoMind/releases), with its checksums and validation report. Candidate files are not a claim of publication or installed-client acceptance.

This edition uses **VS Code Local agents and your existing native model providers**. It does not require OpenCode, an embedded 9router, a model catalog file, or aliases named `top-models` / `worker-models`. M7's new native REA provider and managed gateway are deferred; their source and research remain in the repository. The earlier optional REA plug-in remains available when explicitly configured.

| Asset | Purpose |
| --- | --- |
| `workforce-runtime-0.3.0-alpha.1-windows-x64.tgz` | Windows x64 runtime and production dependencies |
| `workforce-runtime-0.3.0-alpha.1-linux-x64.tgz` | Linux x64 runtime and production dependencies |
| `workforce-model-bridge-0.13.0.vsix` | Native Local tools, agent controls and V-model panel |
| `SHA256SUMS`, release manifest and validation reports | Exact versions, hashes and observed acceptance |

Prerequisites: Node.js **24.x or 26+**, Git, a supported VS Code installation (manifest minimum **1.143**), and access to a native model that supports tools. Project checks may also require C/C++ compilers or another toolchain. Windows/Ubuntu core CI does not certify Linux VS Code desktop operation.

## 1. Extract the runtime outside your project

Download the matching files from one release, then open PowerShell in the download folder:

```powershell
Get-FileHash .\workforce-runtime-0.3.0-alpha.1-windows-x64.tgz -Algorithm SHA256
Get-FileHash .\workforce-model-bridge-0.13.0.vsix -Algorithm SHA256
New-Item -ItemType Directory -Path D:\tools\WorkForce\0.3.0-alpha.1 -Force
& "$env:SystemRoot\System32\tar.exe" -xzf .\workforce-runtime-0.3.0-alpha.1-windows-x64.tgz -C D:\tools\WorkForce\0.3.0-alpha.1
$wfRuntime = 'D:\tools\WorkForce\0.3.0-alpha.1\workforce'
node "$wfRuntime\dist\cli.js" --version
```

Compare both hashes with `SHA256SUMS`. Expected CLI version: `0.3.0-alpha.1`. Select the extracted **workforce** directory containing `package.json`, `dist`, `node_modules` and `distribution-manifest.json`. Do not select the archive or its parent directory. The package contains no OpenCode bootstrap or managed gateway archive.

Linux extraction:

```sh
sha256sum --check SHA256SUMS
mkdir -p "$HOME/.local/share/workforce/0.3.0-alpha.1"
tar -xzf workforce-runtime-0.3.0-alpha.1-linux-x64.tgz -C "$HOME/.local/share/workforce/0.3.0-alpha.1"
wf_runtime="$HOME/.local/share/workforce/0.3.0-alpha.1/workforce"
node "$wf_runtime/dist/cli.js" --version
```

Use the asset built for your platform. Node is not bundled.

## 2. Install the paired VSIX and select its runtime

```powershell
code --install-extension .\workforce-model-bridge-0.13.0.vsix --force
```

Or use **Extensions: Install from VSIX**. Open **Preferences: Open User Settings (JSON)** and preserve your other settings while adding:

```json
"workforce.bridge.runtimePath": "D:\\tools\\WorkForce\\0.3.0-alpha.1\\workforce"
```

This value is a **directory string**, not `true`. Workspace overrides are ignored. Run **Developer: Reload Window** after replacing the extension. Disable an older competing NeoMind/WorkForce extension in the intended workspace.

## 3. Initialize or update your project

For a new project:

```powershell
node "$wfRuntime\dist\cli.js" init --local --platforms copilot --name MyProject --project D:\path\to\project
```

For an existing WorkForce project, finish or stop active work, retain the previous runtime as a backup, then:

```powershell
node "$wfRuntime\dist\cli.js" update --local --project D:\path\to\project
node "$wfRuntime\dist\cli.js" doctor --project D:\path\to\project
```

Use explicit `migrate` first for a project still stored under NeoMind, following [migration details](workforce-install.md). Historical records and execution contracts are preserved; installation does not fabricate a new acceptance result or resume an old engine.

Local init/update preserve `.gitignore` and existing `.git/info/exclude` entries. Already tracked files remain tracked. Edited profiles or integration files are reported as conflicts rather than silently overwritten. Review those conflicts.

## 4. Open Local WF.PM and choose your model

Open the intended folder as a trusted VS Code workspace. Run **WorkForce: Open Local WF.PM**. Confirm the chat is **Local**, selects **WF.PM**, and uses your chosen model in VS Code's native picker. Your existing custom endpoint/9router integration can provide that model; WorkForce does not embed or configure another router.

There is **no Model Bridge connection or model-catalog picker** in this native-core flow. No particular routing alias is required. The native **Role models…** picker in **WorkForce: Open V-model** sets a specialist preference for its next delegation; omitted preferences inherit the native parent. WF.PM's own model stays controlled by its chat picker.

Select **Allow all** in that Local chat if you want execution without repeated ordinary approvals. Workspace Trust, first-use tool/MCP approvals and organizational policies still belong to VS Code. WorkForce does not change global security settings.

## 5. Give a normal request

Describe the result and attach the relevant project folder in your own words. WF.PM discovers reusable tools, submits one professional plan and delegates native workers. The runtime retains request identity, review and current check evidence. Use the native chat to see named subagents and actual tool calls; the V-model panel observes that same saved request.

A direct role selection completes only its assigned scope. Whole-product completion requires independent review/testing and current backend checks. Continue an unfinished request through the native WorkForce control tool with its returned public request key; do not create another request merely to repair the first.

Closing the V-model panel does not cancel work. Closing VS Code cancels owned execution and retains the saved results for reconciliation. The validation report distinguishes actual Local acceptance from package/core checks.

The compatibility MCP connection exposes **request_status** and **work_prepare** only. It cannot replace editor-owned dispatch. A Codex or another client without the native VS Code tools must hand execution to Local WF.PM; generated configuration is not evidence of equivalent execution support.

## Source development

```sh
npm ci
npm run engine:bootstrap
npm test
npm run release:artifacts
npm run package:smoke
```

`engine:bootstrap` is for historical development regression fixtures only. It is not installed in this native-core runtime. Prepack builds the package without fetching or preparing M7's gateway archive. Runtime packaging installs locked production dependencies during the build, and package smoke checks the extracted product outside the source checkout. Neither packaging nor CI alone proves a real model workflow completed.
