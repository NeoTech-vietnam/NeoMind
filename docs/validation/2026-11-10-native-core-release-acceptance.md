# WorkForce native-core: release acceptance

Scope changed by the user on 10 November 2026 (Asia/Saigon): finish M6 and then M8; defer M7. This release uses VS Code Local and the user's existing model providers, including their external 9router. Native REA analysis and an embedded managed gateway are not release requirements or enabled product entry points.

Released pair: runtime `0.3.0-alpha.1`, VSIX `0.13.0`, URL Agent Plugin `0.2.0-alpha.1`. **Native-core accepted and published:** [workforce-v0.3.0-alpha.1](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/workforce-v0.3.0-alpha.1), 10 November 2026 (Asia/Saigon). All fourteen uploaded assets were verified against GitHub's SHA-256 digests, and the remote tag resolves to the exact CI source `f552a54`. This is not a claim that deferred M7 or the original unrestricted desktop/provider matrix passed.

## Evidence boundaries

- Earlier native software requests, independent review/checks, reuse, concurrency and cancellation/reload proofs remain recorded in the milestone ledger. They are not rewritten as installed-candidate acceptance.
- CI on source `e72e7d0` failed: Ubuntu had nine obsolete contract assertions; Windows had the same nine plus three Windows-specific fixture assertions. Those failures remain historical evidence. Final CI `42733222585` on `f552a54` passed Windows (2,497 pass, 0 fail, 14 skip) and Ubuntu (2,454 pass, 0 fail, 45 skip), including extracted native-core package smoke; Agent Plugin CI `42733222714` passed both platforms.
- M6 desktop preparation exposed two real integration errors: `chat.pluginLocations` is machine/User scoped, and the effective VS Code configuration is a noncloneable Proxy. Both were corrected and exercised in the actual source-fixture client below; their simulated configuration tests alone did not establish native loading. Installed-candidate M8 acceptance remains separate.
- The old global `rea` MCP failed to start. WorkForce's new REA facade and narrowed schemas were tested separately, but native REA acceptance remains deferred with M7. Those failures are retained as history and do not gate native-core delivery.
- CI `42722727480` on `a07592f` passed Windows and Ubuntu, including extracted native-core packages. Installed-only observation verified runtime fingerprint `28e8d606…`, VSIX `0.13.0`, ten unique native tools, and no source backend fallback.
- The exact original prompt (SHA256 `e984bd903911eec15cba7a5ecefc4a80b4d1fe004f25313475dafe79dcb18313`) created installed-fixture request `WF-R0001`, LeetCode 344. Its first host compiler check preserved an `ENOENT` receipt: the compiler was installed but absent from the host PATH. The old installed-toolchain resolver was enabled only for the historical engine. The shared compiler launch correction is in the final CI runtime. The same request now closes **accepted** after an actual Local recheck: three original FnD/Reviewer/Tester reports and the plan remain byte-identical, no worker is replayed, all four host checks exit 0, and all four old check entries remain in history. This is a repaired continuation, not a fresh first-pass success.
- The current Cornell/C/C++ files match the independent copied-source oracle: 98,565 cases per language and four deliberately wrong/no-op mutants rejected. All 118 original files remain unchanged; the five additions are the three requested products and two check executables. The final independent certificate checks current accepted hashes, receipts, logs and evidence without rerunning the model or oracle.
- Installed upgrade request `WF-R0050` accepted a fresh natural Cornell request using the existing qualified generator. Its actual host procedure run succeeded once before FnD; independent review/testing and two host checks passed. The original nine-check audit and six-check public-chat supplement retain their `28e8d606` scope. Six corrected-runtime reconciliation checks confirm current acceptance, twenty preservation hashes, qualified procedure pins and no recorded generator/model replay on `c73c5613`.

## Release gates

- [x] M6 source-fixture full-package registration uses an owned absolute User entry, preserves unrelated settings/registrations, and exposes the actual native MCP tool.
- [x] Actual WorkForce workers use the selected package guidance and MCP in the source fixture. Imported foreign-agent execution is not claimed.
- [x] Source-fixture WorkForce Disable, Enable and Unregister during an active role retain the active package and defer removal until its known outcome.
- [x] Final installed runtime/VSIX close the user's original attached-folder LeetCode request accepted, with Cornell/C/C++, independent review/testing and current checks; the preserved compiler failure and same-request continuation are explicit.
- [x] Installed-candidate reuse and relevant native UI/model/lifecycle checks are reconciled with the existing milestone evidence, without relabeling earlier source proof as installed proof.
- [x] Current Windows and Ubuntu regression/package checks pass; package contents exclude the new M7 provider entry points and archive.
- [x] Installed native package guidance/MCP and active Disable, Enable cancellation and Unregister finish with known role outcomes and released leases, in the distinct cases described below.
- [x] Matching runtime, VSIX and Agent Plugin versions/hashes are recorded and published on GitHub after the preceding gates passed; all fourteen remote asset digests match.

## M6 source-fixture desktop proof — 10 November

In trusted VS Code Local 1.145.2 / Chat 0.73.0, C3 `WF-R0048` and `WF-R0049` each invoked one actual `WF.P-RES Worker MCP dc43885debb06a92`. Public chat observations retain one and two `echo_package_nonce` calls respectively. Both scoped reports are current, verdict `pass`, `role-completed`, and **`accepted:false`**; neither accepts a whole software product. The source baseline is unchanged and both capability leases are released.

Ten named snapshots show Enable; active Disable with User key still true and new admissions closed; disabled drain with zero holders; re-enable; active Disable → Enable cancellation → Unregister with key retained; and final removed/zero holders/User key absent. Seven pinned package files remain byte-identical. All snapshots retain the same semantic hash of 46 other User settings and zero other plugin entries. Receipt history is staged → registered → disabled → registered → removed; source/cache is retained.

Independent read-only audit: C3 `evidence/m6-independent-source-audit-with-ui-witness-20261110.json`. Root additionally visually transcribed the actual B call card in `evidence/m6-native-visible-output-b.json`: input and output nonce `WF_M6_RETAINED_B_20261110`, `wait_ms:120000`, output marker `WF_NATIVE_PACKAGE_MCP_V1`. This is a bounded visual witness, not a raw export or screenshot hash. The other two nonce results have saved-report/call-count evidence only. Raw public chat exports were intentionally deleted; no independent raw-result verification is claimed. Package agent-file presence is pinned, but imported foreign-agent invocation is not established. These proofs are explicitly **source-fixture**, not installed runtime/VSIX M8 acceptance or upstream model attestation.

## Installed native-core acceptance — 10 November

The actual Windows editor uses the CI runtime fingerprint `c73c56134da71512dd972d0b9e7a6098f045250e0c87d95148e9ea2b1db7ae4d` and the installed VSIX `0.13.0`. The VSIX archive is byte-identical to the previously installed CI archive. The pure observer verifies installed executable pins, ten unique product tools, User runtime selection and no source backend fallback. The observed route is `customendpoint/9router/top-models` in VS Code Local 1.145.2 / Chat 0.73.0.

M6 uses the existing pinned seven-file full package, with its skill and real native MCP server. `WF-R0051` honestly returned findings because the test fixture's separate User MCP binding had not been configured; its zero-call outcome remains saved. The authorized test setup then added only the exact fixture tool reference for `WF.P-RES`; native permission/security settings and unrelated configuration were not changed.

| Installed case | Actual result |
| --- | --- |
| `WF-R0052` | Skill read and two actual MCP calls; active Disable keeps User registration/resource, then drains to disabled/zero holders after the passing scoped report. |
| `WF-R0053` | Active Disable followed by Enable clears pending Disable while retaining the same live holder. Two MCP calls and a passing scoped report complete. The interrupted Unregister UI action is not counted here. |
| `WF-R0054` | Actual Unregister during a live MCP worker queues removal with User key still true and new admissions closed. The same backend-issued lease persists through pending removal; two MCP calls and the passing scoped report finish before removed/zero holders/User key absent. |

These are distinct scoped jobs, each `role-completed`, verdict `pass`, **`accepted:false`**; they do not accept a software product. Snapshots retain current seven-file hashes, source/cache, other User entries and other plugin entries. Native public chat observations establish actual worker/tool calls; nonce results are report-backed unless a separately identified tool-card witness exists. No independent raw-result verification or imported foreign-agent invocation is claimed.

Independent installed M6 audit: `m6-finalci-installed-independent-audit-20261110.json`, SHA256 `f76770ddffc5c5190fcb88a379b33db902c54b2c5cf363be143332c3e2d73089`, binds twenty-five immutable evidence digests. The exact temporary User fixture binding was removed afterwards; its original absent-key state and all other settings were preserved. No model request was needed for cleanup.

The exact URL Agent Plugin commit/archive is checked separately with the final installed runtime: eleven provider-free public SDK checks exercise `workforce_connection`, `request_status` and `work_prepare` in a new temporary Git project. No request, model inference or authored-file/config/exclusion changes occur. This is actual shipped-plugin protocol proof; generic full-package native lifecycle uses the owned fixture above, not a claimed separate URL-specific installer UI run.

Windows cleanup-only test commit `6d0756f` follows the executable source freeze; it yields during the existing bounded teardown retries and passes the isolated case and all eight durable tests. It changes no product code or runtime fingerprint. Release binaries remain the exact `f552a54` CI artifacts.

The URL plug-in repository's `main` now resolves to `fc75c6fcd6c56fcb00322e9aad677decf380dac9`, matching the twenty-one verified archive Git blobs. Attached `native-local-acceptance.json` / `.md`, `asset-provenance.json`, `ci-validation.json`, `release-manifest.json` and `SHA256SUMS` are the sanitized publication evidence. The runtime build snapshot inside the archive precedes final desktop qualification; the attached acceptance report records that later qualification without rebuilding or replacing the tested binaries.

Linux core/package validation does not certify Linux VS Code desktop. A configured alias identifies the requested VS Code route; it does not prove the model upstream of 9router. Azure GPT-6 Luna is not used for acceptance on this machine. Earlier source UI/model/recovery proofs and deterministic negative tests retain their recorded scope; this release does not claim every provider, unclean crash or third-party package has been tested on a desktop.
