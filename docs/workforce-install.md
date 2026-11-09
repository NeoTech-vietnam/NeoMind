# Install or upgrade WorkForce

Status: candidate instructions for the WorkForce release. The release validation report identifies which installation/client/platform combinations have actually passed. This document alone does not establish acceptance.

## Install the matching runtime and extension

Use the paired assets from the WorkForce GitHub prerelease in the existing [project repository](https://github.com/NeoTech-vietnam/NeoMind/releases). Keep the supplied checksums and validation report alongside them. WorkForce requires the Node.js versions declared by its package and a supported VS Code desktop with Local Copilot Chat.

Use the native-core portable runtime for your platform and its matching VSIX. Follow [release installation](install-release.md) to verify checksums, extract the runtime, install the extension and set its trusted User path. The archive includes production dependencies, without an OpenCode bootstrap or embedded managed gateway. M7's new native REA/gateway activation is deferred; existing optional REA plug-in support is retained. Node remains a prerequisite.

For the commands below, use the extracted runtime directly or create a terminal-local helper. Windows PowerShell:

```powershell
$wfRuntime = 'D:\tools\WorkForce\0.3.0-alpha.1\workforce'
function workforce { & node (Join-Path $wfRuntime 'dist\cli.js') @args }
workforce --version
```

The helper does not change your global PATH or install a second runtime. A version string confirms the CLI only; actual Local delegation and independent checks establish execution support.

## Start in a new project

Open the exact project folder in VS Code, then initialize its local integration:

```powershell
workforce init --local --platforms copilot,codex --project D:\path\to\project
workforce doctor --project D:\path\to\project
```

New WorkForce projects use the native VS Code Local model/tool loop. Choose a model from the native chat picker, including your existing custom endpoint/9router provider. No fixed model alias, separate catalog file or background engine connection is required.

Open **WorkForce: Open Local WF.PM** and confirm Local, WF.PM, the model and the chat's permission mode. Choose **Allow all** there if desired; Workspace Trust, first-use tool consent and organizational policies still apply. **WorkForce: Open V-model** observes the saved request without a legacy Connect handshake. Global approval settings are not changed.

Give WF.PM a normal requirement with the relevant file/folder context. The Universe shows the same request, actual V-model stages, products and independent review/test outcomes. No assignment token, internal ID or special protocol prompt is required.

## Upgrade a NeoMind project

Stop active work before migration, and keep the old runtime available until the data upgrade has been verified. The WorkForce setup must prevent the old extension and new extension from controlling the same workspace simultaneously.

```powershell
workforce migrate --project D:\workspace\NeoLearning
workforce update --local --project D:\workspace\NeoLearning
workforce doctor --project D:\workspace\NeoLearning
```

Migration stages the new `.workforce` tree and preserves an original backup outside active discovery. Records are grouped in `.workforce/requests/WF-R0001--request-title/records/`; shared and ambiguous historical records remain separate. Stable record IDs, original bytes, signatures, procedure versions and historical paths are retained through the relocation catalog. A migration interrupted during the root switch is reconciled from its saved baseline before more work is dispatched.

The current explicit CLI migration selects native Local execution for future work while retaining authored policies and historical evidence. Its receipt stores before/after configuration hashes, and the original backup permits rollback before subsequent writes. Existing WorkForce configuration may retain its historical engine value; public native entry points do not restart that engine. Migration does not relabel old runs as new native acceptance.

An unmodified installer-owned MCP entry is replaced with the `workforce` server. Authored or edited old connections become review conflicts, rather than being overwritten or left silently competing with a second owner. Review these conflicts in setup before enabling inference. Other MCP servers, project settings and user routing remain intact.

Local installation updates `.git/info/exclude`, preserving its existing exclusions and leaving repository `.gitignore` files untouched. WorkForce data, generated profiles, update candidates, migration backups and staging files are locally excluded. Already-tracked shared files remain tracked.

After installing the matching runtime and VSIX, reload VS Code and test an ordinary requirement in Local WF.PM. Compatibility MCP supplies status and advisory reuse discovery only; generated registration is not editor-owned dispatch or proof of a completed product.

## Recover without discarding work

Use the native chat's stop control to cancel an active call and preserve its results. Continue the same unfinished request through the native WorkForce control tool and its public request key. Closing the V-model view does not cancel work. Closing VS Code cancels owned execution; retained checkpoints and current files must be reconciled before continuation.

Migration rollback is allowed only before new WorkForce writes. The runtime's rollback operation checks the exact completed migration baseline and retains both trees; if new writes exist, preserve them and use forward recovery. Do not rename folders or edit relocation maps, signatures, database rows or counters by hand.

No release is considered accepted merely because configuration files were generated. The installed build must produce and independently verify artifacts from ordinary requests in the user's actual Local client.
