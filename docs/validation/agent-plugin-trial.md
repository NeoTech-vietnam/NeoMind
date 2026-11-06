# Agent Plugin trial — 2026-11-06

This is an experimental packaging seam around the existing WorkForce runtime and
VSIX. It has not been adopted as the default installer or migrated into NeoLearning.

## Verified

- VS Code 1.144.1, Copilot **Local**, configured `customendpoint` alias `top-models`.
  The upstream model behind the alias was not attested.
- Local-source installation, disable/re-enable, uninstall and reinstallation.
- Six agent profiles and two skills discovered. WF.PM selected and used; the five
  specialists retain the existing runtime-owned execution contract.
- `/workforce:workforce-plugin-status` loaded its skill instructions, called the
  actual MCP `request_status` tool and returned `WORKFORCE_PLUGIN_STATUS_V1` with
  zero saved requests and no tool error.
- WF.PM submitted one small Python addition/unittest request through the plugin
  MCP connection and received a durable receipt.
- Three automated tests passed, including real stdio initialization, discovery of
  exactly the three intake tools, and an empty-project status call from the
  packaged server configuration. These tests perform no model inference.
- Trial registration and temporary keybindings removed after testing. Existing
  User settings, NeoLearning routing and MCP configuration restored byte-for-byte.
  Credentials and raw native transcripts are excluded from this repository change.

## Not accepted

The engineering smoke workflow was paused by the test owner during design. It
produced no requested Python files and no independent checks; it was not closed or
accepted. Planning and requirements completed in separate authenticated sessions;
the architect session was interrupted by the supported pause operation.

The ended provider relay recorded 607,899 ms, 30,295 semantic events and 1,059,197
semantic bytes. The retained `wf_project_read` tool call was still pending. Because
semantic streaming continued until cancellation, this is evidence of an incomplete
high-volume model/engine turn, not proof of a provider stall. Two earlier tool
schema errors were corrected within their original attempts.

Runtime version: `0.2.0-alpha.2`; tested build:
`07bb8fbffb31b2212e1a5ba8d105fccd335df102f90ebb96389e2f79b893403d`.

## Remaining integration work

The runtime readiness adapter currently recognizes workspace-file MCP
registration, so it reports plugin-owned registration as missing even after actual
plugin MCP discovery. Align that adapter and resolve the unfinished engineering
smoke before promoting this installation path. Automatic model-selected skill
loading and complete execution of all five specialists were not established by
this trial.

See [build and installation instructions](../agent-plugin.md).
