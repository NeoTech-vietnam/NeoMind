# WorkForce Agent Plugin

Install URL for VS Code **Local**:

```text
https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin
```

This repository is a ready-to-load Agent Plugins package: six profiles, three
skills and one workspace-aware MCP connection. The launcher and its dependencies
are bundled. Installing this repository requires no `npm install`, build command,
per-machine package generation or editing MCP paths.

## Install and connect

1. Use VS Code with Agent Plugins enabled and standalone **Node.js 24.x or 26+**
   available as `node` on PATH. Select **Local** in Chat before installing.
2. Run **Chat: Install Plugin from Source**, paste the URL above and approve the
   installation. Install this package into the Local inventory once.
3. Open your intended WorkForce project folder. For an existing installer-based
   integration, disable its old `workforce` MCP registration before enabling the
   plugin, preserving unrelated servers. Retire only its old WorkForce agent
   profiles if they cause duplicate WF.PM entries.
4. In a fresh Local chat, select **WF.PM** and your customendpoint model, such as
   `top-models`. Run:

   ```text
   /workforce:workforce-plugin-connection
   ```

   Expect `WORKFORCE_PLUGIN_CONNECTION_V1` and `code: CONNECTED`. With several
   workspace folders, select a `workspace_uri` returned by the connection tool.
5. Run **WorkForce: Connect Workspace** and approve the workspace/model connection
   if it has not already been connected. Existing `top-models`/`worker-models`
   routing and model credentials are retained.
6. Verify the actual backend connection with:

   ```text
   /workforce:workforce-plugin-status
   ```

   Expect `WORKFORCE_PLUGIN_STATUS_V1` and the actual saved request status. Then
   submit an ordinary requirement to WF.PM.

The profiles are WF.PM, WF.SWSD, WF.P-RES, WF.FnD, WF.Reviewer and WF.Tester. WF.PM
is the user-selectable intake profile; the existing runtime owns specialist
execution, review, testing and acceptance. Plugin installation is separate from a
completed engineering workflow.

## Runtime prerequisite

The plugin adds the agent/skill/MCP integration. **Universe still needs the
WorkForce VSIX and native runtime.** If they are already installed, retain them.
The launcher reads the User setting `workforce.bridge.runtimePath` automatically.
The value is a directory string pointing at the installed `workforce` package.
Workspace overrides are ignored; catalog credentials are never copied into this
plugin. Missing configuration is reported by the connection tool with setup
instructions, without crashing MCP discovery.

For a new machine, install the matching Windows/Linux runtime and VSIX from the
[WorkForce release](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/workforce-v0.2.0-alpha.2-r1)
and follow its `INSTALL.md`. Initialize a new project once with that runtime's
`init --local --platforms copilot --project <folder>` command before adopting the
plugin; disable the resulting installer-owned WorkForce MCP entry and retire its
generated agent profiles to keep a single owner. Existing initialized projects
need no new package generation.

## How workspace selection works

The launcher asks the MCP client for its actual workspace roots. It never treats
the plugin installation folder or its working directory as your project. One
folder is selected automatically; several folders require an explicit selection.
Changes to workspace roots invalidate pending setup before dispatch.

Runtime lookup checks bounded VS Code User/profile settings locations on Windows,
Linux and macOS, and refuses to guess between different configured runtime paths.
For nonstandard VS Code data locations, `WORKFORCE_VSCODE_USER_DIR` can explicitly
identify the User directory; `WORKFORCE_RUNTIME_PATH` can select a runtime. These
optional environment overrides are not needed for normal single-runtime setups.
Remote SSH and nonstandard editors need their own host-side configuration and
are not established desktop support merely by locator tests.

## Disable, uninstall and update

Use **Chat: Open Customizations → Plugins → workforce** in Local to disable,
uninstall or update. The plugin owns no project history, products, model catalog
or runtime installation. Removing it removes its client integration; it does not
delete those project files. Existing accepted runtime work follows the runtime's
own lifecycle while VS Code remains open.

## Validation and limitations

The URL package is checked through real MCP protocol clients and detached
distribution copies without `node_modules`. Tests include workspace isolation,
root changes, missing configuration, setup recovery and a real runtime status
call. No live VS Code UI or model inference is used for this URL-package update.
Installation via your actual VS Code UI remains a user acceptance step.

Earlier Local testing established plugin lifecycle and actual customendpoint
MCP/skill calls, but its engineering smoke did not finish. This packaging update
does not claim to fix that unfinished model/engine turn. The current runtime's
readiness panel also still checks workspace-file MCP registration and can show a
missing registration even after this plugin's MCP connection succeeds.

Source, reproducible builder and tests:
[NeoMind / WorkForce](https://github.com/NeoTech-vietnam/NeoMind/tree/codex/workforce-agent-plugin).
Bundled dependency licenses are in `THIRD_PARTY_NOTICES.md`.
