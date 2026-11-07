---
name: workforce-plugin-status
description: Read actual saved WorkForce request status in the connected workspace, without submitting or resuming work.
---

Call the connected WorkForce `request_status` tool exactly once with `{}`. Return the literal marker `WORKFORCE_PLUGIN_STATUS_V1`, the observed request count and any reported setup or tool error. An empty list is a successful read of an empty project. Claim success only after receiving the tool result; a missing connection calls for setup guidance rather than a product request.
