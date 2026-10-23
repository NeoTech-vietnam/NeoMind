# NeoMind Agent Monitor

An animated agent map, role model controls, and an optional signed language-model bridge for NeoMind projects.

1. Install/build the trusted NeoMind runtime, then initialize the intended project with `neomind init`.
2. Set VS Code **User Settings** `neomind.bridge.runtimePath` to the absolute runtime directory containing `package.json` and built `dist`. Workspace overrides are ignored.
3. Open the initialized project as a trusted workspace folder.
4. Run **NeoMind: Open Agent Map**. Select an agent or work item to inspect its saved provenance. Role model choices apply to new invocations and refresh generated agents while preserving edited files as review candidates.

For a local 9router service, configure `neomind router configure --base-url http://127.0.0.1:20128/v1` and register its custom endpoint/models in VS Code. Credentials stay in the provider configuration or the named process environment variable. Native Copilot uses six grouped agents; strict bridge mode selects roles independently.

The map shows saved activity and recorded relationship replay. Signed invocations and unsigned native reports have separate labels. It does not enable inference automatically. To use the strict execution path, explicitly run **NeoMind: Enable Model Bridge** and accept its separate consent prompt; **NeoMind: Disable Model Bridge** revokes it.

Full documentation is in the NeoMind runtime's `docs/agent-map.md`, `docs/vscode-bridge.md` and `docs/model-control.md`. Gateway bundling and a direct HTTP agent executor remain planned.
