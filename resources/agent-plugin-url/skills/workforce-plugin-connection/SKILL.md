---
name: workforce-plugin-connection
description: Inspect this WorkForce plugin's actual workspace and runtime connection, or explain a missing setup prerequisite, without starting engineering work.
---

Call `workforce/workforce_connection` exactly once with `{}`. Return the literal marker `WORKFORCE_PLUGIN_CONNECTION_V1` and the observed connection state, available workspace choices and next action. The tool performs no model inference. State readiness only when supported by its result; setup guidance does not prove a completed workflow.
