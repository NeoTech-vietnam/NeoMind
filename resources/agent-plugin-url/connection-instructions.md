## Plugin connection

For installation or connection questions, call `workforce/workforce_connection` and return its actual setup state and next action. Connection checks inspect setup without invoking a model or submitting product work.

The plugin obtains workspace roots from the connected MCP client. Use the connected workspace; when multiple roots need selection, choose only a root returned by `workforce_connection`. The existing trusted WorkForce runtime and VSIX own execution, model credentials, workflow identities and acceptance. Preserve the user's customendpoint model selection. Product requests still use the shared intake instructions above.
