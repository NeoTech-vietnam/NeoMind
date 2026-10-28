# WorkForce Universe

WorkForce provides one place to submit an engineering request, follow its V-model stages, open the resulting files and inspect their review and verification. It uses WF.PM with five specialists: WF.SWSD, WF.P-RES, WF.FnD, WF.Reviewer and WF.Tester.

Install the VSIX together with its matching trusted WorkForce runtime from the same GitHub release. Set the **User** setting `workforce.bridge.runtimePath` to the runtime directory containing its `package.json` and built `dist`. Workspace overrides of this machine-level path are ignored. Initialize or update the intended project with `workforce init --local` or `workforce update --local`, then open it as a trusted VS Code folder.

Run **WorkForce: Open Universe** and connect that workspace. The setup card distinguishes installed/configured components from a successful engine/tool capability check. A configured model alias alone does not establish readiness or attest which upstream model 9router actually used.

Choose **Open Local WF.PM** to open Copilot Local with the installed `WF.PM` profile. WorkForce sets `chat.permissions.default` to `autoApprove` for that workspace and reads back the effective setting. It preserves your model picker selection. Existing chat permissions, Workspace Trust, first-use prompts and organization policies remain controlled by VS Code. WorkForce does not enable global auto-approval.

Submit a request in your own words in Local chat or Universe. Both use the same backend intake and saved request identity. The chat entry submits and follows the request; the WorkForce runtime owns worker sessions and execution through the OpenCode engine and your configured 9router endpoint. Close chat or switch views without creating a second implementation of the same accepted request. VS Code must remain open for work to continue.

Each request has its own entry, stage diagram, products, criteria and findings. Stage colors come from backend milestones. Draft outputs stay accessible while review and checks continue; only accepted runtime results are presented as completed. Pause, resume and cancel act on the selected request. A genuine pending question can be answered in the same view. Internal records, raw communication history and runtime journals are not part of the ordinary Universe interface.

The six model controls preserve the configured provider and model identity. Model changes apply to the next invocation; active work keeps its selected configuration. `top-models` and `worker-models` remain aliases managed by your 9router configuration. Credentials and raw provider payloads are not sent to the webview.

**Plug-ins** opens the existing REA, CodeGraph, Context7 and Playwright connection controls for Codex and Copilot. Pinned installation obeys the project download policy. Saved MCP configuration describes a connection; actual client invocation is required to establish that it works. Because WorkForce has a new extension identity, reconnect calendar and YouTube credentials in WorkForce rather than assuming another extension's SecretStorage is shared.

**Reusable tools** opens the Automation Library to discover scripts, register project manifests and inspect qualification evidence. The library cannot execute arbitrary commands supplied by its webview. Automatic reuse still requires the saved procedure and its inputs, versions, permissions and checks to qualify.

**Focus Space** preserves the existing countdown, calendar import/read-only feeds, weather and music features. Original ambient sound continues when returning to Universe or another editor tab and stops when paused or the panel closes. YouTube playback uses a visible local HTTP player, starts after a user gesture and stops when leaving Focus Space. Some videos or remote forwarded origins require opening YouTube in the external browser.

For source-only visual QA, run `node scripts/preview-monitor.mjs` from the runtime repository. Its loopback page uses explicitly labeled fixture requests, weather and calendar data. It calls no model and cannot create requests or mutate project files. Alternate states: `?fixture=small`, `?fixture=empty`, `?fixture=question` and `?fixture=error`.

Build the VSIX with `npm run extension:package` at the repository root. This packages the manifest's explicit file list and does not publish to the Marketplace. The first build needs the pinned VSIX packager available in npm's cache or registry. See the matching runtime's `docs/install-release.md` for the release installation procedure.
