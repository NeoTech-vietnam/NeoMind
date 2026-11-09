# Native Local full-package lifecycle

Checked against installed stable VS Code **1.145.2**, commit
`c4453f8ea430795f941c1b2ff6c9321135a74a02`. This note distinguishes source
inspection and automated tests from native desktop acceptance.

## Supported boundary

`workbench.action.chat.installPluginFromSource` is a native interactive command.
Its handler creates an input box; the supported argument controls reveal behavior,
not an arbitrary silent install.
[Native source-install command](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/src/vs/workbench/contrib/chat/browser/actions/chatPluginActions.ts#L77-L129).
Native enable/disable/uninstall controls are
workbench `Action` objects holding internal plugin service instances. Their UI
action IDs are not extension command contracts. The service itself exposes
source installation and URI-based uninstall internally.
[Native actions](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/src/vs/workbench/contrib/chat/browser/agentPluginActions.ts),
[internal installation service](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/src/vs/workbench/contrib/chat/common/plugins/pluginInstallService.ts).

For an owned, pinned local package, VS Code documents `chat.pluginLocations`.
WorkForce uses the public workspace configuration API for exactly its own key:
Workspace scope for a single-folder window, WorkspaceFolder for a multi-root
window. Disabling sets that key to false; unregistering removes it. Source/cache,
license and provenance remain. This is **owned local package registration**,
distinct from a Git-source marketplace installation or deletion of a native
installation cache. WorkForce does not modify global enablement or security
settings. Authored entries, inherited registrations and path aliases are not
adopted or removed.
[Documented local plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins#use-local-plugins),
[configured discovery](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts).

## Implementation and limits

Production preparation reads each file through the existing qualified source
transport and checks host-approved repository, commit, source path, size and hash.
The separate fixture seam is explicitly local content pinned by its tree hash;
it never claims Git provenance. Whole canonical packages preserve portable
skills/MCP and client-specific agents. Package agents or model rules do not
replace WorkForce's professional roles. MCP tools still require their separate
exact approved native references.
[Native format handling](https://github.com/microsoft/vscode/blob/c4453f8ea430795f941c1b2ff6c9321135a74a02/src/vs/workbench/contrib/chat/common/plugins/AGENTS_PLUGINS.md).

The backend resolves model-supplied package names to immutable receipts and adds
package resources to the workflow lease. Pending controls close new admission.
Active holders retain the native registration. After a known-ended outcome is
saved, the host applies deferred configuration changes using asynchronous
tickets; it holds no synchronous backend lock across an awaited host operation.
Lost responses are reconciled from actual configuration, without replaying
uncertain effects. Source changes deny new execution but do not prevent safe
unregistration of an owned key. Unavailable selections stay frozen as ordinary
work for that workflow.

Configuration observation is not proof that native agents, skills or MCP loaded
or ran. External native UI actions cannot be deferred by WorkForce; those remain
native and can change availability immediately. The desktop acceptance must
inspect the full package inventory and observe actual component use and controls
while a native call is active. User/native trust prompts remain host-owned.

The test fixture contains one skill with a reference, one nonrecursive agent and
one self-contained MCP server. Automated checks exercise actual MCP stdio and
real backend/filesystem state; simulated configuration and native model calls
do not establish desktop acceptance. Logs and final scope belong in the
acceptance ledger after the corresponding run.
