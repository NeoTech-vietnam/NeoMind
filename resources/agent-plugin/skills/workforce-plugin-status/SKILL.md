---
name: workforce-plugin-status
description: Check that this WorkForce plugin's MCP connection returns actual saved request status, without submitting or running work.
---

Call the connected WorkForce `request_status` tool exactly once with `{}`. It lists saved requests in the project's bound runtime and does not start model inference or a new request.

Return the literal marker `WORKFORCE_PLUGIN_STATUS_V1`, followed by the observed request count and any reported error. An empty list is a successful connection to an empty project. Claim success only after receiving the tool result. If the tool is unavailable, report that missing connection without creating a task.
