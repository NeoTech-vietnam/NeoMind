# WorkForce candidate acceptance

The candidate is runtime `workforce@0.2.0-alpha.1`, VSIX `workforce.workforce-model-bridge@0.12.0`, and pinned OpenCode `1.19.4`. Its intended GitHub tag is `workforce-v0.2.0-alpha.1`. Candidate packaging does not publish that tag or release.

Start a new report from [the acceptance template](validation/workforce-release-acceptance.template.json). Every pending field needs observed evidence or an explicit limitation. Never copy an earlier release's successful result into a new source or artifact baseline.

The same `npm test` command runs locally and in Windows/Ubuntu CI: build succeeds first, then Node runs every `test/*.test.mjs` file with file concurrency `2`. This preserves the complete selected suite and its deadlines. `test/diagnostics/opencode-http-lifecycle.test.mjs` is a separate reproduction of the discontinued synchronous HTTP interface's long timeout; it is intentionally operator-run rather than part of the normal suite. The active asynchronous engine fault regressions remain in the normal suite.

Each native CI job builds its runtime and VSIX, extracts its portable asset, exercises installed-package mechanics, and retains checksums and validation reports. Match both jobs to the same exact source commit. When assembling their artifacts, retain both native runtimes and one reviewed VSIX; verify identically named files instead of overwriting one platform's evidence with another. Keep candidate assets separate from older local builds. See [installation](install-release.md).

Actual Windows acceptance uses those extracted candidate bytes and the installed matching VSIX. Record the expected, configured User, imported, and loaded runtime identities, extension fingerprint, exact project, client versions, original prompt and attachment hashes, request identity, useful final products, independent review/test evidence, preservation and reload behavior. The Local Copilot driver refuses a configured runtime other than its reviewed target and never changes permissions, approves native dialogs, or authorizes inference itself. Its synthetic tests verify driver mechanics only.

The original LeetCode prompt, other representative product families, shared Codex/Universe entrypoints, existing-project upgrade and qualified reuse must meet [the accepted plan](plans/2026-10-28-workforce-final-plan.md). A successful package check or recovered fault cannot substitute for an unfinished ordinary product request. A mandatory journey that still reproduces a backend failure prevents a ready release.

Publish only a sanitized `release-validation.json`: preserve exact hashes, revisions, observed states, limitations and aggregate measurements, while removing credentials, local authentication data, raw chat exports, unrelated conversations, private filesystem paths and unapproved user source contents. Record unavailable token/cost/upstream identity observations as unavailable. Do not turn missing evidence into zero usage or a passing result.

The release report identifies the tested task families, actual clients and platforms. Linux core/package CI supports only that portability claim until Linux VS Code desktop is actually tested. No new publication permission or automated release action is created by this document; use the user's existing authorization and the required observed acceptance gates.
