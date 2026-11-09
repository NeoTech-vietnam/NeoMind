---
name: workforce-plugin-connection
description: Inspect this WorkForce plugin's actual workspace and runtime connection, or explain a missing setup prerequisite, without starting engineering work.
---

Call `workforce/workforce_connection` exactly once with `{}`. Return the literal marker `WORKFORCE_PLUGIN_CONNECTION_V1` and the observed connection state, available workspace choices and next action. The tool performs no model inference. State readiness only when supported by its result; setup guidance does not prove a completed workflow.

The launcher exposes only saved status and experience preparation, not product submission or control. A `RUNTIME_NATIVE_MCP_REQUIRED` result requires the matching native runtime/VSIX pair; do not call legacy MCP tools, enable the old Bridge, or rewrite the project configuration to bypass it. Product work uses the installed native extension tools in VS Code Local.
