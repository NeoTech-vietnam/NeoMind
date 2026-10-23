# NeoMind Agent Monitor

A universe of agent roles, recorded activity, guarded model controls, and an optional signed language-model bridge for NeoMind projects.

Choose **Enter Earth · Focus Space** to enter the personal focus dashboard, then **Back to Universe** to return. A wall-clock countdown survives view changes; calendar gaps can set a focus duration. Connect a private Google/Outlook ICS feed through the secure VS Code prompt or import an ICS file. Weather uses an explicit city selection or browser location permission. Original ambient sound works offline; YouTube links use a visible player and optional Data API search. Playback begins only after a gesture and stops when leaving FocusSpace. See the runtime's `docs/focus-space.md` for setup and provider limits.

Primary planets use the installed profile names, including Explorer and Planner. **Agent interactions** shows reported running assignments, dispatch attempts and dispatch/report history as updated native profiles call `agent_activity`. Unsigned updates expire after five minutes; existing chats are not automatically intercepted. Restart the NeoMind MCP server and load updated profiles after upgrading. Event files use the already ignored `.neomind/runs/agent-activity/` directory without changing `.gitignore`.

1. Install/build the trusted NeoMind runtime, then initialize the intended project with `neomind init`.
2. Set VS Code **User Settings** `neomind.bridge.runtimePath` to the absolute runtime directory containing `package.json` and built `dist`. Workspace overrides are ignored.
3. Open the initialized project as a trusted workspace folder.
4. Run **NeoMind: Open Agent Map**. Role planets surround the NeoMind hub; task moons and invocation/report stations show their saved work. Select an object or list item to inspect its provenance. Selection remains stable during refresh.
5. Use the role's model control to select its next-invocation policy. Changes refresh generated agents while preserving edited files as review candidates. Active invocations block reconfiguration.

For a local 9router service, configure `neomind router configure --base-url http://127.0.0.1:20128/v1` and register its custom endpoint/models in VS Code. Credentials stay in the provider configuration or the named process environment variable. Native Copilot uses nine expert profiles over twelve stable core roles; the inspector names their shared model policies. Strict bridge mode selects core roles independently.

Orbital tracks organize the scene. Communication signals replay recorded relationships and do not claim that agents are chatting now. Signed invocations and unsigned native reports have separate labels. Pause motion and the system reduced-motion preference freeze animation without changing agent execution or project state.

The monitor does not enable inference automatically. To use the strict execution path, explicitly run **NeoMind: Enable Model Bridge** and accept its separate consent prompt; **NeoMind: Disable Model Bridge** revokes it.

For browser visual QA, build the runtime and run `node scripts/preview-monitor.mjs` from its repository. The printed loopback URL uses clearly labeled fixture data with all 12 roles, sample task states and recorded replay events. It contacts no models and cannot change real model policies. Add `?fixture=small`, `?fixture=empty` or `?fixture=error` to exercise alternate states.

Full documentation is in the NeoMind runtime's `docs/agent-map.md`, `docs/vscode-bridge.md` and `docs/model-control.md`. Gateway bundling and a direct HTTP agent executor remain planned.

To build the VSIX from a source checkout, run `npm run extension:package` at the repository root. This invokes Microsoft's pinned `@vscode/vsce@4.0.0` packager through npm's cache, includes only the manifest's explicit runtime file list, and writes `artifacts/release-v<runtime-version>/neomind-agent-monitor-<extension-version>.vsix`. The first build requires access to the public npm registry; it does not install a root dependency or publish to the Marketplace. Use `npm run extension:package -- --out <path.vsix>` to choose another output. Identical source and `SOURCE_DATE_EPOCH` produce the same ZIP; its default is 2000-01-01 UTC. The generated VSIX metadata comes from the current extension manifest and needs no earlier release artifact. See the repository's `docs/install-release.md` for installing the matching runtime and VSIX from a GitHub release.
