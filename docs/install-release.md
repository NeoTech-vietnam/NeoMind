# Install the NeoMind runtime and VS Code extension

Candidate `v0.1.0-alpha.14` pairs the packages below. It remains a source-branch candidate until the GitHub release and its validation report are published after actual-client acceptance.

| Download | Purpose |
| --- | --- |
| `neomind-0.1.0-alpha.14.tgz` | NeoMind CLI, MCP server and shared runtime |
| `neomind-agent-monitor-0.11.5.vsix` | Agent universe, Automation Library, plug-in controls and Earth FocusSpace |
| `SHA256SUMS.txt` | SHA-256 digests for the installable assets |

When published, download both packages from the [same GitHub release](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/v0.1.0-alpha.14). These packages do not require npm registry or VS Code Marketplace publication. Node.js 24 or 26+, npm, Git and desktop VS Code 1.109+ are required. The release's `release-validation.json` identifies its Windows and Ubuntu CI results and remaining native-client verification gaps. Optional REA requires Node 24.11+ or 26+. Workflows using the approved LeetCode Cornell format also require Python 3 on the enabled VS Code Bridge process PATH; generic research notes do not require that optional validator.

## 1. Install the runtime

Open a terminal in the download directory. On Windows PowerShell:

```powershell
Get-FileHash ./neomind-0.1.0-alpha.14.tgz -Algorithm SHA256
Get-FileHash ./neomind-agent-monitor-0.11.5.vsix -Algorithm SHA256
npm install --global ./neomind-0.1.0-alpha.14.tgz
neomind --help
npm root --global
```

Compare the hashes with `SHA256SUMS.txt`. The last command prints the global module directory; the runtime directory is its `neomind` child. Keep the downloaded tarball for repeatable offline installation. Bash users can verify with `sha256sum --check SHA256SUMS.txt`, then run the same npm/NeoMind commands.

## 2. Install the VS Code extension

```powershell
code --install-extension ./neomind-agent-monitor-0.11.5.vsix --force
```

Alternatively use **Extensions: Install from VSIX** in VS Code. Set the **User** setting `neomind.bridge.runtimePath` to the absolute runtime directory from step 1. It must contain `package.json` and `dist`; workspace overrides are ignored. For a typical Windows global npm installation, this is `%APPDATA%/npm/node_modules/neomind`. Use your actual path rather than copying someone else's username or drive.

## 3. Initialize or update your project

Open the intended project folder as a trusted VS Code workspace. For a new installation:

```powershell
neomind init --local --platforms copilot --project D:/path/to/project
```

For an existing NeoMind project:

```powershell
neomind update --local --project D:/path/to/project
```

Use the matching path on your system. `--local` adds managed exclusions to `.git/info/exclude`, preserves existing exclusions and leaves `.gitignore` untouched. Edited generated integrations are preserved as conflicts with review candidates. Inspect the command output before replacing an edited candidate. Existing records and model policies are retained.

## 4. Configure MCP and open the universe

Keep your existing NeoMind MCP definition when upgrading and restart that server after installation. New Copilot projects receive a project MCP definition during initialization. If configuring MCP yourself, invoke the installed `dist/cli.js` using Node with `mcp --project /absolute/project/path`; an explicit project path also works when the client cannot resolve `${workspaceFolder}`.

Run **Developer: Reload Window**, then **NeoMind: Open Agent Map**. Choose **Enter Earth · Focus Space** for the countdown, calendar, weather and music controls. Use the universe inspector for existing 9router model controls; this release does not replace your provider credentials. [FocusSpace setup](focus-space.md) explains calendar feeds, optional YouTube search keys and browser location permission.

The extension's model bridge remains an explicit opt-in. Installing the extension does not enable automated inference. The Universe shows fresh identified native hook observations and reported activity, with optional static history. Reload the client and start a new session after regenerating profiles; hooks require the client's normal trust controls.

### NeoMind-owned workflows with Local Copilot or Codex

Run **NeoMind: Enable Model Bridge** in the exact project window. Enable the trusted installed runtime and approve model access when VS Code requests it. A reload stops the Bridge; enable it again afterwards.

- **Local Copilot:** run **NeoMind: Open Local Coordinator**, check that the chat says **Local**, and choose your custom-endpoint alias, such as `top-models`. This command preserves your model and permission choices.
- **Codex:** use the generated NeoMind instructions to discover the MCP management tools. Submit through `manager_run`; inspect through `manager_status` and pause, resume or cancel through `manager_control`.
- **Panel:** run **NeoMind: Open Workflows** to submit work and inspect the same saved workflows and runtime journal.

For projects using `neomind-controlled`, these are three entrances to the same VS Code-owned runtime. Closing a chat or panel does not stop accepted work. Closing VS Code stops its owned sessions and checks; reopening requires Bridge activation and checkpoint reconciliation. The chat's selected model handles intake; workers use the configured role models through the Bridge. An observed `customendpoint / top-models` identifies the selected alias, not proof of the router's upstream model.

Public management calls need the request or workflow ID, not assignment credentials. Workers receive private backend bindings and semantic tools; do not copy legacy claim tokens or `reported_assignment` into management calls. Use the receipt's actual workflow ID to continue existing work.

## 5. Enable the new agent and notes features

Add Codex alongside Copilot when needed:

```powershell
neomind init --local --platforms copilot,codex --project D:/path/to/project
neomind validate --project D:/path/to/project --json
```

Existing workflows keep their saved execution mode. Workflows explicitly using `codex-native` use the generated expert profiles and inherit the parent model/provider by default. Optional direct Codex 9router routing requires a Responses-compatible gateway; see the [agent platform guide](agent-platform.md). This is separate from NeoMind-owned workers using the VS Code Bridge described above.

Cornell notes use `00_note/NeoMind` beneath the current project by default. For a separate notes repository, configure its existing root explicitly, then preview the reviewed note before copying it:

```powershell
neomind cornell configure --project D:/path/to/project --data '{"notes_root":"D:/workspace/NeoLearning","directory":"00_note/NeoMind"}'
neomind cornell export-plan --project D:/path/to/project --data '{"note_id":"PROJECT-KNW-0002","expected_revision":1}'
```

Replace the example note ID/revision with the saved note's values. Follow the [Cornell workflow](cornell-workflow.md) for deterministic research generation, independent review, export application and an explicit push to a separate review branch. The [REA guide](rea.md) covers optional analysis installation; [upstream checks](upstream-checks.md) covers GitHub schedules and manual self-hosted Linux runners. Schedules become active only after their workflow reaches the repository's default branch.
