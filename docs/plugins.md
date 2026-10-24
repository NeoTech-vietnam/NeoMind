# Plug-in control panel

Open **NeoMind: Manage Plug-ins** from VS Code's command palette, or choose **Plug-ins** in NeoMind Universe. The panel requires a trusted workspace and a current installed runtime configured through the User setting `neomind.bridge.runtimePath`.

Introduced in runtime alpha.6 / extension 0.6.0, this feature is included in the paired **NeoMind runtime `0.1.0-alpha.8` and VS Code extension `0.8.0`** release. Follow the [matching package installation](install-release.md) before looking for the command; downloading or viewing these instructions does not upgrade an existing installation. Alpha.5 and extension 0.5.0 do not contain the panel.

The four catalog entries are REA, CodeGraph, Context7 and Playwright. Each card separates the NeoMind provider setting, installed package readiness, recorded direct MCP probe and client configuration. A saved connection does not prove a running client has used it.

## Activate a plug-in

1. Finish or stop active NeoMind invocations.
2. Choose **Enable** to approve the provider for NeoMind agents.
3. Choose **Install pinned version** if missing. Installation respects the existing project network policy and uses only the reviewed catalog package. It does not silently enable downloads.
4. Choose **Probe MCP** to run a direct server handshake and record its result. CodeGraph's **Verify setup & MCP** also runs isolated C/C++ conformance checks on Windows. Its first setup indexes only the temporary fixture project used for verification. See [CodeGraph](codegraph.md).
5. Choose **Connect** for Codex, Copilot in VS Code, or Copilot CLI.
6. Restart the affected MCP server/client and start a fresh chat. An actual client conversation is a separate verification.

Initialization and profile refresh may already register ready plug-ins in project-owned Codex and standard Copilot MCP files when no explicit disconnect preference exists. Check each connection row and use **Connect** for the disconnected clients you want. User-profile Copilot and Copilot CLI entries require explicit connection. An explicit **Disconnect** remains respected by later updates.

The Codex target is the selected project's `.codex/config.toml`. Copilot CLI uses your home `.copilot/mcp-config.json`. For Copilot in VS Code, choose an existing or new MCP JSON settings file for your **active profile** using the native file picker; the default suggestion is the standard User `mcp.json`. Choosing a file only remembers its target; **Connect** performs the configuration change. The selected target is remembered for this workspace. Custom profiles and portable installations may use a different location. The webview cannot supply arbitrary executable commands, paths or packages.

## Deactivate or disconnect

**Disconnect** removes an owned registration for just that client while leaving the NeoMind provider setting unchanged. **Disable** first adopts any exact existing legacy registrations, then disables the NeoMind provider before attempting cleanup of its owned registrations across all three selected clients. If active work prevents provider revocation, client registrations remain intact. Conflicting or authored entries are preserved and shown for manual review. A cleanup failure does not re-enable the provider. Restart clients to close already-running MCP processes.

Connection changes preserve unrelated servers, settings, comments where supported, and user-owned edits. Generated native profiles are refreshed; edited generated files produce update candidates for review. Project trust, active invocation and routing guards still apply. Configuration and probe errors are shown with fixed messages so provider logs or credentials do not enter the webview.

Installation or verification that you already started may finish after closing the panel. Closing or losing trust prevents further actions from that panel; it does not imply that an already-started operation was canceled.

Local installation remains local: exclusions live in `.git/info/exclude`, and this panel does not edit `.gitignore`. It does not change your notes, activate the model bridge, or start agent inference.
