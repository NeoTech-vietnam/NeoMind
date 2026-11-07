# URL-installable Agent Plugin — 2026-11-07

Distribution: <https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin>

The default branch of the distribution repository contains a standard
`plugin.json`, portable `mcp.json`, six agent profiles, three skills and a
self-contained Node ESM executable. Installation requires no npm commands or
per-machine generation. The existing runtime and Universe VSIX remain separate.

## Automated verification

`npm run agent-plugin:test` passed **32 tests, zero failures and zero skips** on the
Windows development host with Node 24. It builds the source, checks the generated
distribution for drift and exercises these paths:

- Runtime selection from bounded User/profile JSONC settings, spaces, canonical
  aliases, explicit overrides, missing/invalid/ambiguous settings and redaction.
- Rejection of workspace-only runtime pointers and escaping linked paths.
- Actual MCP Roots discovery, no-folder behavior, multiple-folder selection and
  two independent clients bound to distinct projects.
- Roots changes during discovery, runtime lookup and backend startup; stale work
  is rejected before dispatch.
- Concurrent setup deduplication, setup recovery and uncertain-delivery handling
  without automatic mutation replay.
- Real installed-runtime MCP initialization and `request_status` through stdio.
- A detached distribution copy with spaces in its path and no `node_modules`:
  startup with missing runtime remains usable, then a temporary User setting
  selects a runtime and actual MCP status succeeds without changing workspace
  registration or installing dependencies.
- Compatibility of the earlier optional exact-project materializer.

The detached test caught an initial JSONC UMD bundling problem; the final builder
selects ESM package entrypoints and the detached execution now passes. Third-party
license texts are retained with the executable.

These tests use temporary fixture projects/settings only. They do not control
desktop applications, edit live VS Code configuration, read catalog credentials
or perform model inference. The focused GitHub Actions workflow repeats this
scope on Windows and Ubuntu; its remote result is separate from the local pass.

## Published-package round trip

The public repository was created with default branch `main` and cloned from its
actual GitHub URL. All 16 distribution files matched the canonical package after
normalizing Git text line endings. The clone contained no `node_modules`.

Using the clone's exact MCP manifest command, an actual stdio client connected it
to the installed native WorkForce `0.2.0-alpha.2` release in an isolated fixture.
`workforce_connection` returned `CONNECTED`; discovery returned the three runtime
intake tools plus the connection tool; `request_status` returned
`{ "requests": [] }`. No model was called and no live User/workspace settings
were changed. Distribution commit:
[`f1c7f34`](https://github.com/NeoTech-vietnam/WorkForce-Agent-Plugin/commit/f1c7f34).

## Acceptance boundary

This update establishes the machine-independent URL package and automated MCP
connection paths. Actual installation through VS Code's UI is intentionally left
to the user. It does not claim a new live Local/Codex/panel engineering acceptance.

The [earlier live engineering smoke](agent-plugin-trial.md) remains unfinished;
its high-volume model/engine turn and the runtime's workspace-file-only readiness
adapter are not changed by this installation update. No NeoLearning migration or
new model-based workflow was run.
