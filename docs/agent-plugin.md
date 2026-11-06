# WorkForce Agent Plugin trial

The Agent Plugins package contributes WF.PM, five specialist profiles, two skills
and one project-bound MCP connection. It reuses the selected installed runtime's
profile definitions and intake instructions. Universe and execution still require
the existing WorkForce VSIX and native runtime.

See the [actual trial results and remaining issues](validation/agent-plugin-trial.md)
before adopting this as an installation path.

## Build for a separate initialized project

Run the generator with standalone Node supported by the installed runtime:

```powershell
npm run agent-plugin:package -- `
  --runtime 'D:\tools\WorkForce\0.2.0-alpha.2\07bb8fbf\workforce' `
  --project 'D:\workspace\WorkForce Plugin Trial' `
  --out 'D:\packages\workforce-agent-plugin'
```

The output must be new or empty and separate from the runtime and project.
`binding.json` identifies the exact project and runtime. Generate a different copy
for another project. The package contains no model credentials, request history or
runtime binaries. `node` must be available on VS Code's PATH.

## Try in Copilot Local

Select **Local** before running **Chat: Install Plugin from Source**. VS Code's
Copilot and Local harnesses can use different installation inventories. Installing
the same package in both can produce duplicate agents and MCP registrations.

Use a disposable workspace and keep one registration owner: remove or archive only
the trial project's installer-generated WorkForce agent profiles and MCP entry
before testing plugin discovery. Preserve unrelated servers. A local-source
installation registers the package location; it does not necessarily copy it.

Open **Chat: Open Customizations** and inspect the plugin, its six profiles, both
skills and the `workforce` MCP server. WF.PM is user-selectable. The five specialist
profiles preserve the current runtime-owned contract; listing them is not proof
that five Copilot delegates executed.

Use the existing customendpoint model in Local. Invoke `/workforce:workforce-plugin-status`
and require an actual `request_status` response with its skill marker. Then submit
a small request once through WF.PM; inspect its receipt, products and independent
checks before claiming full runtime acceptance.

The explicit slash command attaches the skill instructions through VS Code. The
trial does not establish automatic model-selected skill loading. WF.PM keeps its
three intake MCP tools; workers retain the existing runtime-owned tools.

The existing runtime's setup panel checks workspace MCP files, so a plugin-owned
connection can still be reported as missing there. Check actual MCP discovery and
the saved request separately. This registration-status adapter must be aligned
before making the plugin the default installation path.

## Disable and remove

Use the same Local inventory in Agent Customizations to disable, re-enable and
uninstall. In a fresh chat, check that plugin agents, skills and MCP registration
disappear and return as expected. Uninstalling a local-source package removes its
registration; authored source files and project deliverables should remain.

For a shared profile, `chat.pluginLocations` also supports a unique relative folder
that exists only in the trial workspace. VS Code resolves it per workspace and
skips absent directories. This is a documented development registration, distinct
from a copied marketplace installation. Do not register an exact-project plugin
globally by an absolute path while other projects are using the same profile.

Compatibility references: [Agent Plugins specification](https://agent-plugins.org/specification),
[VS Code plugin authoring](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference),
[VS Code lifecycle](https://code.visualstudio.com/docs/agent-customization/agent-plugins).
