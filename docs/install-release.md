# Install the NeoMind runtime and VS Code extension

Release `v0.1.0-alpha.4` contains two matching packages:

| Download | Purpose |
| --- | --- |
| `neomind-0.1.0-alpha.4.tgz` | NeoMind CLI, MCP server and shared runtime |
| `neomind-agent-monitor-0.4.0.vsix` | VS Code agent universe, model controls and Earth FocusSpace |
| `SHA256SUMS.txt` | SHA-256 digests for the installable assets |

Download both packages from the [same GitHub release](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/v0.1.0-alpha.4). These packages do not require npm registry or VS Code Marketplace publication. Node.js 24 or 26+, npm, Git and desktop VS Code 1.109+ are required. Detailed compatibility evidence remains in [validation](validation.md); current changes were verified on Windows, while Linux CI is reported separately.

## 1. Install the runtime

Open a terminal in the download directory. On Windows PowerShell:

```powershell
Get-FileHash ./neomind-0.1.0-alpha.4.tgz -Algorithm SHA256
Get-FileHash ./neomind-agent-monitor-0.4.0.vsix -Algorithm SHA256
npm install --global ./neomind-0.1.0-alpha.4.tgz
neomind --help
npm root --global
```

Compare the hashes with `SHA256SUMS.txt`. The last command prints the global module directory; the runtime directory is its `neomind` child. Keep the downloaded tarball for repeatable offline installation. Bash users can verify with `sha256sum --check SHA256SUMS.txt`, then run the same npm/NeoMind commands.

## 2. Install the VS Code extension

```powershell
code --install-extension ./neomind-agent-monitor-0.4.0.vsix --force
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

The extension's model bridge remains an explicit opt-in. Installing the extension does not enable automated inference. Current Copilot activity is reported by updated profiles; saved trails are historical relationships rather than a live interception of arbitrary chats. Full Codex parity, revised activity synchronization, new Cornell publication workflows and scheduled upstream adoption are later work, not features of this release.
