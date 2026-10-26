# Local Copilot installation

`neomind init --local --platforms copilot --project DIRECTORY` persists `copilot_integration: "local"`. For an initialized project, `neomind update --local --project DIRECTORY` selects the same mode. Later updates, including the monitor's model-change regeneration, retain it.

```powershell
neomind init --local --platforms copilot --project D:\workspace\MyProject
neomind update --project D:\workspace\MyProject
```

`--local` selects the Copilot integration layout. It is separate from the saved execution mode and `network_policy: "local-only"`; review those policies independently.

Local Copilot mode writes `.github/instructions/neomind.instructions.md` with a description and `applyTo: "**"`, nine NeoMind expert agent files, hooks and skills. It preserves existing `.github/copilot-instructions.md`, `.vscode/mcp.json` and `.mcp.json`, including historically managed entries. Warnings identify that an older integration may still need review; local mode does not silently disable it.

The installer emits **no discoverable workspace MCP configuration**. `.neomind/mcp-server.json` is an example for registering the external runtime in VS Code's user-profile MCP configuration. Its `--project` argument contains the absolute path of the installed project, so startup does not depend on an open VS Code folder or workspace-variable resolution. Review and copy its `servers.neomind` entry through the supported user-profile MCP setup. The example itself does not register or start a server. VS Code distinguishes user-profile `mcp.json` (`servers`) from portable workspace `.mcp.json` (`mcpServers`). [Official MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

The registered server remains bound to that project when another folder is open. For a different project, use its generated example with a distinct user-profile server name. If the project moves, run `neomind update --project NEW_DIRECTORY` and replace the registered entry from the regenerated example.

Install the runtime outside the source repository and call its CLI with `--project` to avoid project `package.json`, lockfile and `node_modules` changes. The CLI has no `--mcp-command` option: generated hooks and metadata use the executing Node binary and installed CLI path. Choosing additional platforms still generates their ordinary agent/instruction files; use Copilot alone when preserving existing Codex/Claude files is required.

## Automatic Git-local exclusions

Local-mode `init` and `update` automatically add repository-local exclusions for generated NeoMind files. The saved local mode also applies this behavior to later updates without repeating `--local`. NeoMind leaves the repository's `.gitignore` and any existing `.neomind/.gitignore` unchanged in this mode; a missing managed `.neomind/.gitignore` may be created during initialization.

For a project at the Git worktree root, the default rules are:

```gitignore
/.neomind/
/.github/agents/neomind-*.agent.md
/.github/agents/neomind-*.agent.md.neomind-update*
/.github/hooks/neomind.json
/.github/hooks/neomind.json.neomind-update*
/.github/skills/neomind-*/
/.github/instructions/neomind.instructions.md
/.github/instructions/neomind.instructions.md.neomind-update*
```

The candidate patterns cover both the initial `.neomind-update` review file and numbered variants such as `.neomind-update.1`. A project nested below the Git worktree root receives the corresponding project-relative prefix, so sibling projects are outside these rules.

NeoMind asks Git for the worktree root and actual `info/exclude` path. It does not assume `.git` is a directory: linked worktrees can use a `.git` pointer file and a common exclude file shared with other worktrees. Changes to that shared file can therefore affect matching paths in those worktrees too. If Git or valid repository metadata is unavailable, installation reports a warning and skips exclusion setup; it does not initialize a Git repository.

Only missing exact positive rules are added, under `# NeoMind local installation: generated files`. They are prepended after any UTF-8 byte-order mark. Existing exclude bytes, comments, line endings and rule order remain intact; existing negations follow the new defaults and retain normal Git precedence. Re-including a file inside an ignored directory may also require re-including its parent directories. Repeated updates do not duplicate existing rules. A shared exclude-file lock serializes NeoMind installs across worktrees, and a readback comparison reports detected concurrent edits without overwriting them.

Exclusions affect untracked files; they cannot hide or protect tracked files. Audit historical branches before relying on them: a file tracked on an older branch can overwrite a same-path ignored file on checkout. A historical branch with tracked `.verythinker` or `.taskforces` project state requires a separate worktree when the current checkout has its own `.neomind` state. NeoMind retains dual-root refusal and never selects or merges an ambiguous store automatically.

`init` creates installation/configuration data and the basic knowledge pack; it does not create an engineering workflow. Inspect and resume existing workflow records explicitly. Storage migration remains a separate byte-preserving operation and refuses active work, locks, links and multiple managed roots.
