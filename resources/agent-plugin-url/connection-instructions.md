## Plugin connection

For installation or MCP connection questions, use the `workforce-plugin-connection` skill from an ordinary Local Agent session with the plugin's MCP tools available. Its check inspects MCP setup without model inference or product submission. MCP readiness does not prove the native extension tools are loaded.

The plugin obtains workspace roots from the connected MCP client. Select only a root it returns. Native product execution requires the matching WorkForce VSIX and runtime exposing `vscode-native/v1`; Local owns model/tool calls and WorkForce owns request state and acceptance. Preserve the native model selection. Product requests use the native instructions above, without legacy Bridge or assignment authentication. The compatibility MCP intake is not a fallback execution path for native requests.
