# Agent platform update

Source branch: `codex/procedure-automation`. This release pairs runtime `0.1.0-alpha.8` with extension `0.8.0`; earlier releases remain available on GitHub. Read [Reusable project automation](procedures.md) for the new procedure and assignment interfaces and [installation](install-release.md) for the matching packages.

| Requirement | Implementation | Activation or limit |
| --- | --- | --- |
| Codex agent parity | Coordinator, Explorer, Researcher, Planner, Architect, Implementer, Debugger, Verifier and Reviewer profiles; `codex-native` workflow mode | Generate Codex integration and start a new trusted Codex session. Native child permissions inherit the parent. |
| Accurate Universe | Current observations by default; explicit static history; native session/parent links from lifecycle hooks | Client must support and trust hooks and supply agent identity. Missing identity is ignored; unsigned reports remain a separate fallback. |
| Linux | Portable runtime, VSIX, hook commands and Windows/Ubuntu CI | Node 24 or 26+, Git and VS Code; REA requires Node 24.11+ or 26+. |
| GitHub Actions | Daily public upstream metadata check; manual dedicated self-hosted Linux verification | Schedule runs from the default branch after merge. Register your own labeled runner for manual self-hosted jobs. |
| Notes publication | Preview, immutable local export and separate create-only remote branch | Explicit export/publish commands; remote-enabled policy, existing Git remote and current independent note review. |
| Research format | Requirement-bound abstract, objectives, methods, findings, discussion, worked example, questions, practice and separate answers | Compiler validates structure and references. Independent review assesses factual quality. |
| REA reuse | Original pinned skill with references/license, observed native MCP registration and bounded strict-role adapter | Explicit install and real handshake; candidate updates never execute or replace the adopted pin automatically. |
| Repeated work | Existing recipes plus deterministic research compiler, input/requirement/source fingerprints and validation skill | Inspect matching tools first; changed inputs or contract require fresh preparation. |

## Install and activate

Install the matching runtime outside your notes repository and install the matching VSIX in VS Code. For the development checkout, build/package it using the repository scripts. Release installation is documented in [install-release.md](install-release.md).

```powershell
neomind update --local --project D:\workspace\NeoLearning
neomind validate --project D:\workspace\NeoLearning --json
```

To add Codex to the existing project's selected platforms, run `neomind init --platforms codex,copilot --local --project D:\workspace\NeoLearning`. Inspect any update candidates rather than replacing authored configuration. Existing workflows retain their saved execution mode; begin a new `codex-native` workflow through the generated coordinator. Restart the NeoMind MCP server, reload VS Code and start a new native chat. Enable hook execution through the client's normal trust controls.

On Linux the same commands use an absolute Linux project path. Local Copilot integration preserves `.gitignore` and adds its generated files to `.git/info/exclude`. Existing tracked files still follow Git branch changes; exclusions do not convert tracked files to local files. Codex configuration remains the ordinary repository integration; inspect conflicts when combining local Copilot with authored Codex files.

## Native models and activity

Codex inherits its parent model/provider by default. Configure the 9router endpoint first, then explicitly select it:

```text
neomind router configure --base-url http://127.0.0.1:20128/v1 --api-key-env NEOMIND_ROUTER_API_KEY --project PROJECT
neomind codex configure --data '{"mode":"9router"}' --project PROJECT
```

Use the endpoint and model IDs from your actual 9router setup; port 20128 above is an example. Codex's gateway must support the Responses API. Keep the key in the named environment variable. GUI model changes regenerate profiles for subsequent invocations; they do not switch an already running native conversation. Inspect [Codex runtime](codex-runtime.md) for inheritance and model controls.

Planet orbits are decorative. Only fresh activity observations produce pulses. Native hook observations, agent-reported assignments and signed receipts are labeled separately and may describe the same agent. The monitor does not inspect arbitrary chat transcripts. Stop means that a native turn stopped; task acceptance still requires the workflow gates. Hooks lacking explicit session and agent IDs are ignored. Unsigned observations expire after five minutes without an update, so a long quiet tool can become unknown. See [Codex hooks](https://learn.chatgpt.com/docs/hooks) and [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference).

## Notes and scheduled work

The default destination is `00_note/NeoMind`. Follow the [Cornell workflow](cornell-workflow.md) for a complete compile, review, export-preview, copy and explicit branch-publication sequence. No existing user notes are automatically committed, pushed or overwritten.

The GitHub workflows are editor-independent. They work whether you use Codex or Copilot. Native VS Code automations are an optional preview feature, with separate local/cloud constraints; installing NeoMind does not enable them. Read the [VS Code automation documentation](https://code.visualstudio.com/docs/agents/run/automations) before choosing that route. GitHub schedules execute only on the [default branch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Use `neomind validate` / `platform_validate` and the generated `neomind-validate` skill to distinguish configured support, observed execution and missing prerequisites. Validation does not download upstream code, call a model, launch a runner or publish notes.
