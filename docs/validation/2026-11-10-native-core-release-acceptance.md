# WorkForce native-core: release acceptance

Scope changed by the user on 10 November 2026 (Asia/Saigon): finish M6 and then M8; defer M7. This release uses VS Code Local and the user's existing model providers, including their external 9router. Native REA analysis and an embedded managed gateway are not release requirements or enabled product entry points.

Candidate: runtime `0.3.0-alpha.1`, VSIX `0.13.0`, URL Agent Plugin `0.2.0-alpha.1`. Status: **not yet accepted or released**.

## Evidence boundaries

- Earlier native software requests, independent review/checks, reuse, concurrency and cancellation/reload proofs remain recorded in the milestone ledger. They are not rewritten as installed-candidate acceptance.
- CI on source `e72e7d0` failed: Ubuntu had nine obsolete contract assertions; Windows had the same nine plus three Windows-specific fixture assertions. Subsequent focused batches passed, including a real Windows 8.3 path reproducer. A new coherent Windows/Ubuntu CI run is still required.
- M6 desktop preparation exposed two real integration errors: `chat.pluginLocations` is machine/User scoped, and the effective VS Code configuration is a noncloneable Proxy. Both were corrected and exercised in the actual source-fixture client below; their simulated configuration tests alone did not establish native loading. Installed-candidate M8 acceptance remains separate.
- The old global `rea` MCP failed to start. WorkForce's new REA facade and narrowed schemas were tested separately, but native REA acceptance remains deferred with M7. Those failures are retained as history and do not gate native-core delivery.
- CI `42722727480` on `a07592f` passed Windows and Ubuntu, including extracted native-core packages. Installed-only observation verified runtime fingerprint `28e8d606…`, VSIX `0.13.0`, ten unique native tools, and no source backend fallback.
- The exact original prompt (SHA256 `e984bd903911eec15cba7a5ecefc4a80b4d1fe004f25313475dafe79dcb18313`) created installed-fixture request `WF-R0001`, LeetCode 344. FnD, Reviewer and Tester returned pass. Its first host compiler check preserved an `ENOENT` receipt: the compiler was installed but absent from the host PATH. The old installed-toolchain resolver was enabled only for the historical engine. A shared native compiler launch correction is being validated; the original request is not yet accepted and no failed receipt is replaced.
- Installed upgrade request `WF-R0050` accepted a fresh natural Cornell request using the existing qualified generator. Its actual host procedure run succeeded before FnD, without regenerating tools; independent review/testing and two host checks passed. Independent audit and final corrected-runtime reconciliation remain separate gates.

## Release gates

- [x] M6 source-fixture full-package registration uses an owned absolute User entry, preserves unrelated settings/registrations, and exposes the actual native MCP tool.
- [x] Actual WorkForce workers use the selected package guidance and MCP in the source fixture. Imported foreign-agent execution is not claimed.
- [x] Source-fixture WorkForce Disable, Enable and Unregister during an active role retain the active package and defer removal until its known outcome.
- [ ] Final installed runtime/VSIX handle the user's original LeetCode prompt with its real folder attachment, produce Cornell/C/C++ artifacts, pass independent review/testing and close accepted.
- [ ] Installed-candidate reuse and relevant native UI/model/lifecycle checks are reconciled with the existing milestone evidence.
- [ ] Current Windows and Ubuntu regression/package checks pass; package contents exclude the new M7 provider entry points and archive.
- [ ] Matching runtime, VSIX and Agent Plugin versions/hashes are recorded and published on GitHub only after the preceding gates pass.

## M6 source-fixture desktop proof — 10 November

In trusted VS Code Local 1.145.2 / Chat 0.73.0, C3 `WF-R0048` and `WF-R0049` each invoked one actual `WF.P-RES Worker MCP dc43885debb06a92`. Public chat observations retain one and two `echo_package_nonce` calls respectively. Both scoped reports are current, verdict `pass`, `role-completed`, and **`accepted:false`**; neither accepts a whole software product. The source baseline is unchanged and both capability leases are released.

Ten named snapshots show Enable; active Disable with User key still true and new admissions closed; disabled drain with zero holders; re-enable; active Disable → Enable cancellation → Unregister with key retained; and final removed/zero holders/User key absent. Seven pinned package files remain byte-identical. All snapshots retain the same semantic hash of 46 other User settings and zero other plugin entries. Receipt history is staged → registered → disabled → registered → removed; source/cache is retained.

Independent read-only audit: C3 `evidence/m6-independent-source-audit-with-ui-witness-20261110.json`. Root additionally visually transcribed the actual B call card in `evidence/m6-native-visible-output-b.json`: input and output nonce `WF_M6_RETAINED_B_20261110`, `wait_ms:120000`, output marker `WF_NATIVE_PACKAGE_MCP_V1`. This is a bounded visual witness, not a raw export or screenshot hash. The other two nonce results have saved-report/call-count evidence only. Raw public chat exports were intentionally deleted; no independent raw-result verification is claimed. Package agent-file presence is pinned, but imported foreign-agent invocation is not established. These proofs are explicitly **source-fixture**, not installed runtime/VSIX M8 acceptance or upstream model attestation.

Linux core/package validation does not certify Linux VS Code desktop. A configured alias identifies the requested VS Code route; it does not prove the model upstream of 9router. Azure GPT-6 Luna is not used for acceptance on this machine.
