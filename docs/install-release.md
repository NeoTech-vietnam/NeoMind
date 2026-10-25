# Install the NeoMind runtime and VS Code extension

Candidate `v0.1.0-alpha.11` pairs the packages below. Publication is pending completion of the actual Local Copilot validation; source-branch packages are not a published release.

| Download | Purpose |
| --- | --- |
| `neomind-0.1.0-alpha.11.tgz` | NeoMind CLI, MCP server and shared runtime |
| `neomind-agent-monitor-0.11.0.vsix` | Agent universe, Automation Library, plug-in controls and Earth FocusSpace |
| `SHA256SUMS.txt` | SHA-256 digests for the installable assets |

Download both packages from the [same GitHub release](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/v0.1.0-alpha.11). These packages do not require npm registry or VS Code Marketplace publication. Node.js 24 or 26+, npm, Git and desktop VS Code 1.109+ are required. The release's `release-validation.json` identifies its Windows and Ubuntu CI results and remaining native-client verification gaps. Optional REA requires Node 24.11+ or 26+.

## 1. Install the runtime

Open a terminal in the download directory. On Windows PowerShell:

```powershell
Get-FileHash ./neomind-0.1.0-alpha.11.tgz -Algorithm SHA256
Get-FileHash ./neomind-agent-monitor-0.11.0.vsix -Algorithm SHA256
npm install --global ./neomind-0.1.0-alpha.11.tgz
neomind --help
npm root --global
```

Compare the hashes with `SHA256SUMS.txt`. The last command prints the global module directory; the runtime directory is its `neomind` child. Keep the downloaded tarball for repeatable offline installation. Bash users can verify with `sha256sum --check SHA256SUMS.txt`, then run the same npm/NeoMind commands.

## 2. Install the VS Code extension

```powershell
code --install-extension ./neomind-agent-monitor-0.11.0.vsix --force
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

## 5. Enable the new agent and notes features

Add Codex alongside Copilot when needed:

```powershell
neomind init --local --platforms copilot,codex --project D:/path/to/project
neomind validate --project D:/path/to/project --json
```

Existing workflows keep their saved execution mode. A new Codex-native workflow uses the nine generated expert profiles and inherits the parent model/provider by default. Optional Codex 9router routing requires a Responses-compatible gateway; see the [agent platform guide](agent-platform.md).

Cornell notes use `00_note/NeoMind` beneath the current project by default. For a separate notes repository, configure its existing root explicitly, then preview the reviewed note before copying it:

```powershell
neomind cornell configure --project D:/path/to/project --data '{"notes_root":"D:/workspace/NeoLearning","directory":"00_note/NeoMind"}'
neomind cornell export-plan --project D:/path/to/project --data '{"note_id":"PROJECT-KNW-0002","expected_revision":1}'
```

Replace the example note ID/revision with the saved note's values. Follow the [Cornell workflow](cornell-workflow.md) for deterministic research generation, independent review, export application and an explicit push to a separate review branch. The [REA guide](rea.md) covers optional analysis installation; [upstream checks](upstream-checks.md) covers GitHub schedules and manual self-hosted Linux runners. Schedules become active only after their workflow reaches the repository's default branch.
