# Install WorkForce Agent Plugin from GitHub

> Native Local candidate: on `codex/workforce-vscode-native`, both plugin builders now generate the shared `vscode-native/v1` profiles and request instructions. This is source work, not a published matching release. The native package requires the matching runtime/VSIX; it uses native extension tools, without the legacy Bridge connection or required routing aliases. The published installation flow below remains historical until paired release acceptance is complete.

Paste this URL into **Chat: Install Plugin from Source** in VS Code **Local**:

```text
https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin
```

The repository's default branch contains a complete plugin, including the bundled
MCP launcher. Do not use the NeoMind source repository or a branch URL as the plugin
source. You do not need to clone/build it yourself, run npm, generate a package or
edit MCP paths on each machine.

## Connect

1. Retain your installed WorkForce runtime and Universe VSIX. The User setting
   `workforce.bridge.runtimePath` must point at the installed `workforce` package
   directory. Node.js 24.x or 26+ must be available as `node` on PATH.
2. Open your intended initialized WorkForce project folder. Select **Local** in
   Chat, then install the Git URL above. If you already have installer-generated
   WorkForce integration, disable that old `workforce` MCP registration and retire
   its generated WF.PM profile to avoid duplicate entries. Preserve other servers
   and your `.workforce` project history.
3. In a fresh Local chat select **WF.PM** and your existing customendpoint model,
   for example `top-models`.
4. Send `/workforce:workforce-plugin-connection` and approve its connection check
   if asked. Expect `WORKFORCE_PLUGIN_CONNECTION_V1` and `code: CONNECTED`.
   If multiple folders are open, select a `workspace_uri` returned by the tool.
5. Run **WorkForce: Connect Workspace** and approve the workspace/model connection.
   The existing runtime owns this connection and any real model capability probe.
6. Send `/workforce:workforce-plugin-status`. Its actual response must contain
   `WORKFORCE_PLUGIN_STATUS_V1` and the saved request count/status. Then give WF.PM
   an ordinary requirement.

For a new machine, use the matching runtime and VSIX from the
[WorkForce release](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/workforce-v0.2.0-alpha.2-r1)
and follow its `INSTALL.md`. A new project still needs one-time runtime
initialization; an already initialized project needs no new package generation.

## What the plugin resolves

MCP Roots supplies the actual workspace folders from the client. The plugin
installation path and subprocess cwd do not select your project. Roots changes
invalidate pending setup before tool dispatch. Runtime discovery reads only
bounded VS Code User/profile configuration locations, validates the selected
WorkForce package and refuses ambiguous runtime choices. It reads no model
catalog credentials and writes no client configuration.

Normal setups need no environment variables. Nonstandard editor data locations
can explicitly select `WORKFORCE_VSCODE_USER_DIR`; distinct runtime installations
can select `WORKFORCE_RUNTIME_PATH`. Remote-host setup remains separate.

Disable, uninstall or update through **Chat: Open Customizations → Plugins →
workforce** in the same Local inventory. Removing the plugin preserves project
products/history, the native runtime, the VSIX and model settings.

## Verification boundary

This URL-package update uses automated real MCP protocol/stdio tests and detached
distribution copies without installed npm dependencies. It does not control your
desktop or call your models. Your first Local installation is the client acceptance
step; installing the plugin is not proof that an engineering workflow completed.

The [earlier live trial](validation/agent-plugin-trial.md) passed plugin lifecycle
and actual customendpoint MCP/skill calls, but its engineering smoke did not
finish. That unresolved execution issue is not fixed by this packaging change.
The existing runtime's readiness panel can also still report missing
workspace-file MCP registration for this plugin-owned connection; use the actual
connection/status tools as separate evidence.

## Build from source

Maintainers of the NeoMind source repository can run:

```sh
npm ci
npm run build
npm run agent-plugin:build
npm run agent-plugin:test
```

The generated `agent-plugin/` directory is the distribution root. Its executable
contains the pinned MCP SDK and JSONC parser; licenses are retained in
`THIRD_PARTY_NOTICES.md`. `npm run agent-plugin:check` detects generated-file drift.
