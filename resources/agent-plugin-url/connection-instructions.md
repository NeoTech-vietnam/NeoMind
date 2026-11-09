## Plugin connection

For installation or MCP connection questions, use the `workforce-plugin-connection` skill from an ordinary Local Agent session with the plugin's MCP tools available. Its check inspects MCP setup without model inference or product submission. MCP readiness does not prove the native extension tools are loaded.

The plugin obtains workspace roots from the connected MCP client. Select only a root it returns. Its MCP surface is exactly `request_status` and `work_prepare`, plus the launcher's `workforce_connection` check. `work_prepare` retrieves prior experience and qualified reusable tools; it does not submit work or launch agents.

Native product submission and control require the matching WorkForce VSIX and runtime exposing `vscode-native/v1`. Local owns model/tool calls and WorkForce owns request state and acceptance. Preserve the native model selection. Use the native instructions above, without a legacy Bridge, Connect Workspace step or assignment authentication. Do not call historical MCP submission/control or generic record tools. If the launcher reports `RUNTIME_NATIVE_MCP_REQUIRED`, explain that the installed runtime and VSIX need a matching native version; never fall back to an older engine or rewrite project history.
