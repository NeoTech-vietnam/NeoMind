# WorkForce native-core: release acceptance

Scope changed by the user on 10 November 2026 (Asia/Saigon): finish M6 and then M8; defer M7. This release uses VS Code Local and the user's existing model providers, including their external 9router. Native REA analysis and an embedded managed gateway are not release requirements or enabled product entry points.

Candidate: runtime `0.3.0-alpha.1`, VSIX `0.13.0`, URL Agent Plugin `0.2.0-alpha.1`. Status: **not yet accepted or released**.

## Evidence boundaries

- Earlier native software requests, independent review/checks, reuse, concurrency and cancellation/reload proofs remain recorded in the milestone ledger. They are not rewritten as installed-candidate acceptance.
- CI on source `e72e7d0` failed: Ubuntu had nine obsolete contract assertions; Windows had the same nine plus three Windows-specific fixture assertions. Subsequent focused batches passed, including a real Windows 8.3 path reproducer. A new coherent Windows/Ubuntu CI run is still required.
- M6 desktop preparation exposed a real integration error: the installed VS Code declares `chat.pluginLocations` at machine/User scope, whereas the first package host wrote workspace scope. Mock configuration tests did not establish native loading. The correction must be exercised in the actual client before M6 can be checked off.
- The old global `rea` MCP failed to start. WorkForce's new REA facade and narrowed schemas were tested separately, but native REA acceptance remains deferred with M7. Those failures are retained as history and do not gate native-core delivery.

## Release gates

- [ ] Native full-package registration uses an owned absolute User entry, preserves unrelated registrations, and is observed by VS Code.
- [ ] Package agent and skill are actually loaded/used; the package MCP answers through an actual native role call.
- [ ] WorkForce Disable, Enable and Unregister during an active role retain the active package and defer removal until its known outcome.
- [ ] Final installed runtime/VSIX handle the user's original LeetCode prompt with its real folder attachment, produce Cornell/C/C++ artifacts, pass independent review/testing and close accepted.
- [ ] Installed-candidate reuse and relevant native UI/model/lifecycle checks are reconciled with the existing milestone evidence.
- [ ] Current Windows and Ubuntu regression/package checks pass; package contents exclude the new M7 provider entry points and archive.
- [ ] Matching runtime, VSIX and Agent Plugin versions/hashes are recorded and published on GitHub only after the preceding gates pass.

Linux core/package validation does not certify Linux VS Code desktop. A configured alias identifies the requested VS Code route; it does not prove the model upstream of 9router. Azure GPT-6 Luna is not used for acceptance on this machine.
