# Install or upgrade WorkForce

Status: candidate instructions for the WorkForce release. The release validation report identifies which installation/client/platform combinations have actually passed. This document alone does not establish acceptance.

## Install the matching runtime and extension

Use the paired assets from the WorkForce GitHub prerelease in the existing [project repository](https://github.com/NeoTech-vietnam/NeoMind/releases). Keep the supplied checksums and validation report alongside them. WorkForce requires the Node.js versions declared by its package and a supported VS Code desktop with Local Copilot Chat.

Use the native portable runtime asset for your platform and the matching VSIX. Follow [release installation](install-release.md) to verify checksums, extract the runtime, install the extension and set its trusted User path. The portable archive includes production dependencies and the pinned offline engine bootstrap. Node remains a prerequisite; no source npm tarball is required for the release installation.

For the commands below, use the extracted runtime directly or create a terminal-local helper. Windows PowerShell:

```powershell
$wfRuntime = 'D:\tools\WorkForce\0.2.0-alpha.1\workforce'
function workforce { & node (Join-Path $wfRuntime 'dist\cli.js') @args }
workforce --version
```

The helper does not change your global PATH or install a second runtime. A matching version string is insufficient: the WorkForce setup view must confirm the runtime/extension/engine fingerprints actually loaded and the cached model/tool capability check for that configuration.

## Start in a new project

Open the exact project folder in VS Code, then initialize its local integration:

```powershell
workforce init --local --platforms copilot,codex --project D:\path\to\project
workforce doctor --project D:\path\to\project
```

New WorkForce projects use runtime-owned OpenCode execution and Local intake. Default routing keeps the `customendpoint` provider with `top-models` and `worker-models` aliases. Configure the real 9router endpoint and credential through WorkForce setup; an alias alone is not proof of model access.

Open **WorkForce Universe** and use its setup/connection action. Grant Workspace Trust and model/engine access when the platform requires it. The extension sets the workspace default to **Allow all** where supported and opens a Local chat with **WF.PM**; the effective Local label and permission picker must be checked in the actual client. Global approval settings and organization policy are not overwritten.

Give WF.PM a normal requirement with the relevant file/folder context. The Universe shows the same request, actual V-model stages, products and independent review/test outcomes. No assignment token, internal ID or special protocol prompt is required.

## Upgrade a NeoMind project

Stop active work before migration, and keep the old runtime available until the data upgrade has been verified. The WorkForce setup must prevent the old extension and new extension from controlling the same workspace simultaneously.

```powershell
workforce migrate --project D:\workspace\NeoLearning
workforce update --local --project D:\workspace\NeoLearning
workforce doctor --project D:\workspace\NeoLearning
```

Migration stages the new `.workforce` tree and preserves an original backup outside active discovery. Records are grouped in `.workforce/requests/WF-R0001--request-title/records/`; shared and ambiguous historical records remain separate. Stable record IDs, original bytes, signatures, procedure versions and historical paths are retained through the relocation catalog. A migration interrupted during the root switch is reconciled from its saved baseline before more work is dispatched.

The explicit WorkForce CLI migration also selects OpenCode execution, Local intake and runtime-controlled requests in the staged configuration. It preserves other authored policy fields and routing aliases. The migration receipt stores the before/after configuration hashes, and the original backup permits rollback before subsequent writes. Historical run records keep their original contracts and execution modes; migration does not automatically resume them under a different engine.

An unmodified installer-owned MCP entry is replaced with the `workforce` server. Authored or edited old connections become review conflicts, rather than being overwritten or left silently competing with a second owner. Review these conflicts in setup before enabling inference. Other MCP servers, project settings and user routing remain intact.

Local installation updates `.git/info/exclude`, preserving its existing exclusions and leaving repository `.gitignore` files untouched. WorkForce data, generated profiles, update candidates, migration backups and staging files are locally excluded. Already-tracked shared files remain tracked.

After installing the matching runtime and VSIX, reload VS Code once and complete the setup handshake. The loaded build, exact workspace, MCP discovery and real tool call must be verified before reporting the project ready.

## Recover without discarding work

Use the selected request's pause/resume/cancel controls in the Universe. Closing a chat does not cancel accepted work while VS Code stays open. Closing the owning VS Code host stops execution; reopening reconciles checkpoints and current files before continuing.

Migration rollback is allowed only before new WorkForce writes. The runtime's rollback operation checks the exact completed migration baseline and retains both trees; if new writes exist, preserve them and use forward recovery. Do not rename folders or edit relocation maps, signatures, database rows or counters by hand.

No release is considered accepted merely because configuration files were generated. The installed build must produce and independently verify artifacts from ordinary requests in the user's actual Local client.
