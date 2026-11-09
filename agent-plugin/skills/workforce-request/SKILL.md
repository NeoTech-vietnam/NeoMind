---
name: workforce-request
description: Submit an engineering request to WorkForce, inspect its saved deliverables, or control the same request from Copilot Local.
---

## WorkForce native Local entry

Execution contract: vscode-native/v1. VS Code Local owns model/tool execution; WorkForce owns valid request membership, engineering records and acceptance. Use the current model picker; role preferences inherit by default and may be changed through the V-model's native Role models picker. No particular model alias or external catalog file is required.

When the native WorkForce tools are available in the current Local chat, use the WF.PM native profile for an ordinary user requirement. Resolve attached context to actual workspace paths, inspect existing tools with workforcePrepare, then submit one short professional plan through workforceNativeRequest. Keep the user's requirement faithful. Backend-generated specialist calls handle implementation, independent review/testing and actual checks; report their returned artifacts and acceptance. Never submit another request solely to repair or reverify an unfinished one. Use workforceRequestControl with the returned public request_key to inspect results, recheck unchanged reviewed products after an environment correction, or explicitly resume retained findings through fresh specialists and checks. Do not poll while work is running. A request for one named role uses workforceRoleJob and completes only that scope.

Use native Local tools; the historical MCP workflow intake is a separate execution contract.

Native profiles do not use historical assignment authentication or client-generated lifecycle IDs. Existing legacy workflows retain their evidence and separate execution contract. Do not mix their instructions into a native assignment.

WorkForce keeps each request under .workforce/requests. Native V-model stages reflect actual owned calls and current checks; a configured role or a saved report is not a running agent or accepted product. Closing the view does not cancel work; editor shutdown cancels and retains results. Read .workforce/guides/native-local.md for this integration.

## Plugin connection

For installation or MCP connection questions, use the `workforce-plugin-connection` skill from an ordinary Local Agent session with the plugin's MCP tools available. Its check inspects MCP setup without model inference or product submission. MCP readiness does not prove the native extension tools are loaded.

The plugin obtains workspace roots from the connected MCP client. Select only a root it returns. Its MCP surface is exactly `request_status` and `work_prepare`, plus the launcher's `workforce_connection` check. `work_prepare` retrieves prior experience and qualified reusable tools; it does not submit work or launch agents.

Native product submission and control require the matching WorkForce VSIX and runtime exposing `vscode-native/v1`. Local owns model/tool calls and WorkForce owns request state and acceptance. Preserve the native model selection. Use the native instructions above, without a legacy Bridge, Connect Workspace step or assignment authentication. Do not call historical MCP submission/control or generic record tools. If the launcher reports `RUNTIME_NATIVE_MCP_REQUIRED`, explain that the installed runtime and VSIX need a matching native version; never fall back to an older engine or rewrite project history.
