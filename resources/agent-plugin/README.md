# WorkForce Agent Plugin (isolated trial)

This package contributes the current runtime's WF.PM and five specialist profiles, WorkForce request/status skills, and one exact-project stdio MCP connection. WF.PM is the user-selectable intake agent. Specialists remain runtime-owned; their packaged profiles describe those roles and do not create a second native delegation protocol.

The portable Agent Plugins components are `plugin.json`, `skills/`, and `mcp.json`. Copilot agent profiles live under `com.github.copilot/agents/`. The package reuses the selected runtime's profile definitions and entrypoint instructions. The Local chat model stays under the user's model picker; worker routing and credentials remain in the existing project/catalog configuration.

Install standalone Node.js supported by the selected WorkForce runtime and make `node` available on VS Code's PATH. The portable MCP executable is the bare token `node`; its arguments identify the exact installed runtime and project. `binding.json` records the generator's Node executable for diagnosis, without making that absolute path the portable MCP command.

## Install and verify

Use a separate workspace/profile for this trial. Initialize/connect its existing WorkForce runtime and VSIX, then remove only its generated WorkForce client profiles/MCP registration before installing this package. Keep exactly one owner for the `workforce` MCP server. Preserve unrelated registrations and files.

Select **Local** before running **Chat: Install Plugin from Source**. Copilot and Local can use different installation inventories; installing into both can duplicate agents and MCP servers. A local folder installation registers its location in the profile. Use a dedicated test profile, or a unique relative `chat.pluginLocations` directory that exists only in the test workspace when sharing an existing profile. This copy is an exact-project trial, not a global installer.

Start a new **Local** chat with the user's custom-endpoint model. Confirm WF.PM, both skills and the WorkForce MCP server are discovered. Invoke the namespaced slash command `/workforce:workforce-plugin-status` and verify its marker accompanies an actual `request_status` result. Then submit one small request through WF.PM and inspect the saved receipt, actual artifacts and independent evidence.

This trial verifies explicit user invocation of the skill. Automatic model selection/loading of a skill is a separate capability and is not established by that result. WF.PM retains only WorkForce's submit/status/control tools; product editing and execution stay within runtime-owned sessions.

## Disable, uninstall, reinstall

Open **Chat: Open Customizations → Plugins → WorkForce**. Disable for the test workspace, verify the contributed agents/skills/tools disappear from a fresh chat, then enable and verify they return. Uninstall, inspect the inventory again, and reinstall from the package folder. Never delete request history to simulate a clean uninstall. The package contains no project artifacts, catalog credentials or saved request state.

The plugin does not replace the Universe VSIX or the native execution runtime. Installation alone does not prove Local-harness compatibility, endpoint access, successful MCP calls, or completed engineering work. Record each observed result separately. This generated copy is bound to one project rather than deriving authority from an ambiguous working directory or `${workspaceFolder}` substitution.

The current runtime's setup panel checks workspace MCP files and can report this plugin-owned registration as missing despite successful actual MCP discovery. This status adapter still needs alignment before using the plugin as the default installation path.

Primary references: [Agent Plugins specification](https://agent-plugins.org/specification), [VS Code plugin lifecycle](https://code.visualstudio.com/docs/agent-customization/agent-plugins), [VS Code authoring reference](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference).
