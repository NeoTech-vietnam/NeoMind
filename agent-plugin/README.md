# WorkForce Agent Plugin

## Native-core candidate

This package targets **VS Code Local**, using the `vscode-native/v1` contract.
The matching versions are:

| Component | Candidate version |
| --- | --- |
| WorkForce runtime | `0.3.0-alpha.1` |
| WorkForce Universe VSIX | `0.13.0` |
| WorkForce Agent Plugin | `0.2.0-alpha.1` |

The intended matching release is
[workforce-v0.3.0-alpha.1](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/workforce-v0.3.0-alpha.1).
**These versions are candidates until that release is published.** This README
does not establish publication, installed-client acceptance or a completed
engineering request. Check the release assets and validation report before
installing; an older URL-installed package is not the matching native candidate.

WorkForce uses your existing VS Code models, including a configured custom
endpoint or external 9router. No model catalog file or aliases named
`top-models` / `worker-models` are required. This native-core path does not use
OpenCode, **Connect Workspace**, or **Enable Model Bridge**. M7's new native REA
provider and managed gateway are deferred to a later release.

## Install the runtime and VSIX

The Agent Plugin provides agents, skills and MCP integration. It does not
replace the native runtime or VSIX.

1. Install Node.js **24.x or 26+**, and use VS Code **1.143 or newer** with Agent
   Plugins support. Project checks may need their own compiler or toolchain.
2. Download the runtime for your platform and the matching VSIX from the release
   above. Check their hashes against its `SHA256SUMS`, then follow `INSTALL.md`.
   Extract the runtime outside your project and install the VSIX through
   **Extensions: Install from VSIX**.
3. Open **Preferences: Open User Settings (JSON)** and add this setting while
   preserving your existing settings. Adjust the path to your extraction:

   ```json
   {
     "workforce.bridge.runtimePath": "D:\\tools\\WorkForce\\0.3.0-alpha.1\\workforce"
   }
   ```

   The value is a **directory string**, not `true`, an archive or an executable.
   Select the installed `workforce` directory containing `package.json` and
   `dist/cli.js`. Workspace overrides are ignored.
4. Run **Developer: Reload Window** after replacing the VSIX. Initialize a new
   project once with the installed runtime, or update an existing WorkForce
   project using the release instructions. Keep its saved products and history.

## Install the Agent Plugin from GitHub

Use the published source repository URL without a branch fragment:

```text
https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin
```

1. Open the intended project as a trusted VS Code workspace and select **Local**
   in Chat.
2. Run **Chat: Install Plugin from Source**, paste the URL above and approve the
   installation. Check that the installed plugin version matches the table.
   The launcher and its dependencies are bundled; no `npm install`, build or MCP
   path editing is required for this source package.
3. Keep one owner of each WorkForce agent and MCP registration. If the project
   already has installer-generated WorkForce profiles or a `workforce` MCP
   entry, stop active work and disable the duplicate integration before enabling
   the plugin. Preserve unrelated integrations and authored files.
4. In a fresh Local chat, select **WF.PM** and an available model in VS Code's
   native model picker. Your model access and credentials remain with the native
   provider. Grant first-use model, tool or MCP permissions when VS Code asks.
   You may select **Allow all** for ordinary approvals; WorkForce does not change
   Workspace Trust, organizational policy or global security settings.
5. Check the plugin's workspace/runtime lookup with:

   ```text
   /workforce:workforce-plugin-connection
   ```

   Expect `WORKFORCE_PLUGIN_CONNECTION_V1` and the observed connection state.
   With several workspace folders, select a returned `workspace_uri`. A
   connection check performs no model inference and does not prove native
   delegation or product acceptance.
6. Read saved request status with:

   ```text
   /workforce:workforce-plugin-status
   ```

   An empty request list is valid for a new project. Then describe an ordinary
   requirement to WF.PM and attach the relevant folder.

## Agents, model selection and progress

The package contains six visible profiles: **WF.PM**, **WF.SWSD**, **WF.P-RES**,
**WF.FnD**, **WF.Reviewer** and **WF.Tester**, plus five hidden worker profiles,
three skills and one workspace-aware MCP connection. WF.PM delegates the workers
through the installed native extension tools. Chat shows named subagents and
actual tool calls; **WorkForce: Open V-model** observes the same saved request.

WF.PM's model comes from its native chat picker. Specialist models inherit that
selection unless you set a preference through **Role models…** in the V-model
panel. A role preference applies to its next delegation; it does not switch an
active invocation or WF.PM's chat model. Only models available to the current
native host can be selected.

A direct specialist request completes that role's scope. Whole-product
completion still requires the applicable independent review, tests and current
acceptance evidence. Plugin installation or a successful MCP check does not
count as that evidence.

## MCP and workspace selection

The launcher asks its MCP client for actual workspace roots. It does not use the
plugin installation directory as your project. One root is selected
automatically; multiple roots need an explicit selection. A root change
invalidates pending setup.

The runtime MCP exposes **`request_status`** and **`work_prepare`**. The launcher
adds **`workforce_connection`**. They inspect saved status and reusable work;
product submission, delegation and control use the installed native VS Code
tools. A `RUNTIME_NATIVE_MCP_REQUIRED` result means the matching native pair is
needed. Do not enable a historical engine or change saved execution contracts to
bypass it.

Runtime lookup reads bounded VS Code User/profile settings locations on Windows,
Linux and macOS, refusing ambiguous paths. For nonstandard data locations,
`WORKFORCE_VSCODE_USER_DIR` can identify the User directory and
`WORKFORCE_RUNTIME_PATH` can select a runtime. Normal single-runtime setups do
not need these overrides. Locator and core tests alone do not certify Linux
desktop, Remote SSH or other editors.

## Disable, uninstall and update

Use **Chat: Open Customizations → Plugins → workforce** in Local. Disable,
uninstall or update the plugin there. Removing its integration does not delete
project products, saved requests, model-provider configuration or the separately
installed runtime/VSIX. Coordinate changes with active work; do not assume that
removing a plugin cancels an already running agent or an external MCP server.

Install future runtime and VSIX updates as a matching pair, reload VS Code and
check the plugin version before running another request. Read the release's
validation report for what was actually tested on the installed client.

Source and reproducible packaging:
[NeoMind / WorkForce](https://github.com/NeoTech-vietnam/NeoMind).
Bundled dependency licenses are in `THIRD_PARTY_NOTICES.md`.
