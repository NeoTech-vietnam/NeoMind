# WorkForce Native Local acceptance — 09/11/2026

## Candidate and scope

- Certified historical source: `b0ec6446a34d491bd1928ef17e395eab3073e8c4`, branch `codex/workforce-vscode-native`.
- Loaded runtime fingerprint: `246f1fb1b88119380b23810220fc2fa294cf636380a05924a6ee47a61772d3df`.
- Actual client: VS Code 1.145.2, chat extension 0.73.0, **Local** in an owned disposable workspace.
- Parent selected `customendpoint/top-models`; FnD preference `worker-models`. These aliases do not establish the actual upstream model/vendor. Defaults in distributed native profiles inherit the native selection and do not require these aliases.
- No production-workspace upgrade or new GitHub runtime/VSIX release is certified by this report.
- Follow-up changes below are uncommitted on HEAD `d02363f`. The historical CI and loaded fingerprint above do not certify those changes.

## Regression and installed-package results

[CI 42589038704](https://github.com/NeoTech-vietnam/NeoMind/actions/runs/42589038704) passed on the exact source above:

| Platform | Passed | Failed | Skipped | Installed package smoke |
| --- | ---: | ---: | ---: | --- |
| Windows | 2,306 | 0 | 10 | Passed |
| Ubuntu | 2,275 | 0 | 34 | Passed |

Ubuntu engine-admission/transport repetitions passed 13/13 on each of three separate repetitions. They are not added to the suite coverage count. Linux core/package portability is verified; Linux desktop behavior was not tested.

Fixes include stale native tool/profile expectations, real Windows NTFS short-path handling, native executables versus receipt-reading scripts, immutable check finalization after lost state-write, and cancellation/checkpoint classification. An earlier intermittent materializer filesystem failure was not reproduced in diagnostic replay or final CI; private original-cause retention was added, without claiming its original cause identified.

## Actual Local cases

| Case | Observed result | What was retained |
| --- | --- | --- |
| WF-R0036: native role cancellation then explicit Resume | Same request accepted; only unfinished Tester called again; actual durable check exit 0 with four assertions | FnD/Reviewer professional contents, cancelled Tester outcome, products, plan, scope and repair allowance |
| WF-R0037: reload during actual checker, then recheck | Same request accepted; stopped receipt imported; one fresh checker exit 0; **zero new worker invocations** | All three actor IDs/reports, old execution/evidence in history, plan/checker, scope and repair allowance |
| WF-R0038: optional marketplace unavailable | One inspect returned `NETWORK_DISABLED`, non-retryable ordinary-work fallback; one Reviewer published a source-grounded report and completed the role scope | Existing files/history, approved sources/cache/skills and exact original project policy bytes |

R0036 independent audit passed 19/19. Reviewer approval changes frontmatter normally; professional body/invocation/content digest remained intact. Do not describe every report file as byte-identical. Original inventory observation 19/20 is retained; its R0036-only inventory assumption was corrected by explicitly attributing concurrent R0037 files, not by deleting the failed observation.

R0037 audit passed 11/11. Actual checker began at `09:07:01.730Z`; the observed native Reload Window command was selected at `09:07:11.259Z`, then Yes at `09:07:12.841Z`. The original guardian receipt authenticated cancellation after 15,966 ms, exit 1, with only START output. After the new host was ready, explicit same-key recheck retained that outcome and ran a new 50,189 ms successful check with four assertions. Workflow accepted at `09:10:33.919Z`. The 50-second wait is an intentional acceptance fixture; the production runner timeout was not increased. The auditor's implementation involvement is recorded; independent code peer review was separate.

R0038 audit passed 18/18. Of 768 baseline files, 766 remained byte-identical and two counter/layout files changed as expected. Project policy was restored byte-for-byte. Effective selected skill contexts were empty; the raw role tool input was not captured, so a literal `skills: []` invocation is not independently asserted. This was a role-only review with Manager hints, not full software acceptance. Source-grounded static findings do not claim compilation/doclint execution, socket telemetry or exclusive tool permissions.

## Uncommitted follow-up: model and capability controls

Three model defects were reproduced before repair: a selection becoming missing/ambiguous while its picker was open, blank inventory identities, and a saved explicit model losing tool-calling capability. Revalidation preserves the last valid preference and declines dispatch before a native call when the explicit selection is unusable. The model/delegation/hook batch passed **28/28**. Schema/model preflight failures keep `invoked:false`; an actual native cost-policy refusal retains its one failed invocation, no automatic retry and unknown upstream identities, without claiming a preference was applied. Native schema/cost-tier failure branches across providers are not universally certified by these seam tests.

**Actual inheritance with hooks disabled:** R0039 and R0040 ran sequentially in Local on runtime `8ab037ecb97d342430272c3a09e3a5a0ad9033477053bc6a1fc1f8497f08da2c`. Each retained exactly one observed `runSubagent` for `WF.P-RES Worker`, a distinct host call/assignment/request identity, a saved report and `role-completed / accepted:false`.

| Request | Native parent and observed child alias | Output |
| --- | --- | --- |
| WF-R0039 | `customendpoint/9router/top-models` | `role-reports/model-inherit-top.md` |
| WF-R0040 | `customendpoint/9router/worker-models` | `role-reports/model-inherit-worker.md` |

The host retained `requested_model: inherit`, empty override policies and null dispatch overrides; the explicit FnD `worker-models/customendpoint` preference stayed equal in the initial and both dispatch inspections. An independent evidence audit passed **26/26**, checking loaded adapter hashes, durable report/publication hashes, unchanged selected source and the requested source facts. Hook inspections were false; the hook log's last-write time `09:19:42.059Z` predates both calls, started at `13:41:49.739Z` and `13:47:03.488Z`. Individual hook lines lack timestamps, so no per-event interval claim is made. The auditor implemented related guards but did not operate these UI runs; this is evidence verification, not independent code peer review. Aliases remain separate from unknown upstream identity, and these direct reports do not constitute software acceptance.

Capability leases now retain exact approved receipt/asset bytes and host-only owners. New admissions stop during pending disable/remove/disconnect; active holders keep their pinned guidance and tool profile until an observed settled outcome. Real-runtime fixtures use actual records, scoped report publication and checker processes, mocking only the VS Code model call. They cover saved variant identities, whole-request and direct-role draining, historical exact reinstall, ordinary asset dependencies, private-field rejection, uncertain outcomes and direct reports with findings. The final private targeted batches passed **7/7 skill controls** and **6/6 session cases**; these overlap other regressions and are not a full-suite total.

Controls defer the actual owned mutator, rather than merely changing a status label. Unknown effects and cancellations without confirmed settlement retain their holders for reconciliation; elapsed time alone never releases them. Archived guidance can bridge only a successful authorized removal of the exact approval. User edits, missing provenance and ordinary receipt/script/asset inputs still invalidate current evidence. Generic MCP binding controls also retain their own origin when their ID matches a built-in provider.

Generic MCP selections bind exact host-approved native tool references and schema fingerprints through the public host inventory. Profile preparation is not proof of MCP execution or server ownership: ownership remains `not-observed`. External MCP servers/connections remain managed natively by VS Code; WorkForce does not promise to freeze every external restart or inventory change.

**Actual MCP and active controls, R0043:** runtime `21379ebcea33f79fe45937047e2a191308a6d7e394c7634cc6d741ce3780420e` and observer hash `a14e0112…` ran one versioned `WF.P-RES Worker MCP` with the exact approved `native-fixture/echo_nonce` reference and selected fixture guidance. Native chat retained one echo tool card; the server recorded one valid nonce start at `14:32:05.392Z` and completion at `14:36:46.261Z`, with the expected returned-output hash. The 300-second gate deliberately allowed UI interaction; this is not a production timeout increase or a latency claim.

Actual **Manage Native Capabilities** UI actions disabled the MCP binding at `14:34:03.939Z` and requested guidance removal at `14:36:31.502Z`. Both recorded command context plus the real manage-function stack, `deferred`, one active holder and denied new admission. The live guidance/receipt still matched their exact lease pins. After the report was saved, both actual automatic-drain stacks ran at `14:37:06Z` with zero holders. The guidance was removed, the own lease released, and current runtime state still returned `role-completed / accepted:false` with the nonce, MCP marker, guidance marker and source facts in `role-reports/native-mcp-active-final.md`. Independent evidence audit **16/16** passed, including profile/source/publication hashes. It is a single owned fixture and direct role, not whole-product or release acceptance.

**Separate active toggle case, R0044:** on the same runtime/observer, one MCP-only worker completed one valid echo between `14:44:50.848Z` and `14:49:04.785Z`. Actual UI Disable at `14:46:03.744Z` deferred with one holder and denied new admission; Enable at `14:47:35.686Z` cancelled that pending action, retaining the same holder and admitting new work; Remove binding at `14:49:03.337Z` deferred again. The actual removal drained at `14:49:19.019Z`, after saved result `14:49:18.542Z`. Current role-only completion and `role-reports/native-mcp-toggle-final.md` remained valid. Its evidence audit passed **12/12**; a separate **3/3 synthesis** checked both successful scopes, unchanged selected artifacts and sequential source-consistent runs. Per-run audit counts overlap and are not pooled into coverage. These prove WorkForce binding and portable-skill controls; full native Agent Plugin package uninstall, external-server ownership and arbitrary external restarts are not certified.

R0041 remains uncertain after native admission rejection; the installed-core validator probe demonstrates the matching fixed-parent-allowlist restriction, but the old raw exception was not retained, so its inference limit is explicit. R0042 retains an honest findings report after the earlier 60-second fixture gate timed out without returning a nonce/marker. Neither is counted as MCP success or rewritten by R0043.

The Windows publication defect was separately reproduced with a real file-sharing handle: staging-to-target rename returned `EPERM`. Publication now retries only bounded sharing failures, revalidating the owned stage and absent destination on every attempt; changed inputs, a racing destination or unknown side effects are preserved rather than overwritten. The complete local materializer/lease batch passed **61/61**, no skips, in 65,148.6424 ms. It used the private compile `artifacts/native-lease-check/dist` and `node --test --test-concurrency=2 artifacts/native-lease-check/test/workspace-skill-components.test.mjs test/native-capability-leases.test.mjs` with `WF_NATIVE_LEASE_MODULE_BASE` pointing at that compile. The result is retained in tool transcript session `26064`, not a persisted TAP file. This proves the sharing-failure mechanism and controls; the external handle owner behind the earlier intermittent failures remains unidentified.

The new full Windows run was stopped after an actual native-admission correction required a coherent replacement build; its partial log and `artifacts/native-m6-full-regression-20261109.partial-summary.json` are retained, without final counts or failure stacks. The stale generated PM-profile mismatch was corrected. The contribution race's earlier 5,502 ms failure remains unconfirmed: one unchanged current-build diagnostic later passed **1/1** in 8,237 ms total, retaining the exact single-POST and shared-operation-ID oracle. No timeout or publication logic was changed on that evidence. This is not full regression, new CI or release certification; remaining native UI/provider failure branches and broader package acceptance stay open. The real NeoLearning workspace was not modified by these owned-fixture cases, and no new runtime/VSIX release is claimed.

The targeted 21-file batch passed **256/256** before the final two-line prototype-ID guard; the subsequent final guard batch passed **30/30**, covering that edge and native controls. They overlap and are not summed, nor do they replace M8 Windows/Ubuntu certification. Logs: `artifacts/native-m6-targeted-regression-20261109.log` and `artifacts/native-m6-final-guards-20261109.log`.

After both successful MCP/control cases, the fixture settings were restored byte-for-byte to SHA256 `8bff3c1003b80d922aae75339f705df468aaf2ecacd31eee43f016bf13e4e03d`. Native inspection `native-m6-final-restored` confirmed hooks enabled again and the original role preferences, with zero new model calls. Receipt: `evidence/ui-model-hook-20261109/settings-restoration.json`. The real NeoLearning workspace was not changed.

## 10 November deterministic UI and packaging follow-up (not desktop certification)

The native V-model client previously never enabled its motion selector: actual client/renderer tests first failed on missing `data-motion` and the absent repair route. The repair arms only explicitly running stages and shows a separate repair return path only when the runtime supplies `coding: repairing`. Queued, interrupted and uncertain states have distinct styles; a generic status or failed review alone does not invent active rework. Renderer/client checks passed **14/14**. The new real-runtime panel integration passed **2/2**: an actual bad arithmetic product fails a Node checker, an independent scoped Reviewer reports the finding, FnD repairs the **same request**, fresh checks pass and acceptance is projected correctly. An external product edit then becomes uncertain without rewriting the saved execution. Only the native model call and editor DOM are simulated; this is not an actual desktop/model run. Logs: `native-vmodel-motion-rework-red-20261110.log`, `native-vmodel-motion-rework-green-20261110.log`, `native-vmodel-rework-domain-20261110.log` under `artifacts/workforce-native-local-proof/`.

A development-only native DOM observer now preserves the client's one API acquisition and original CSP nonce. It records computed styles, native body classes, keyboard focus and a SHA256-correlated runtime snapshot; missing, incomplete or advanced snapshots never become successful evidence. Its **4/4** seam checks do not themselves certify actual native theme/reduced-motion behavior. Those desktop observations remain pending.

Native distribution packaging no longer requires an OpenCode binary, SDK or bootstrap: the old dependencies remain development-only for historical regression. New guards and archive/dependency checks passed **11/11**, actual npm prepack prerequisite/JSON/failure checks **2/2**, and gateway resource publication checks **2/2**, kept as separate scopes. A real offline preparation validated the pinned published `9router@0.5.116` closure with downloads disabled, preserving all **3,701** inventory entries and the exact published MIT notice. Its archive SHA256 is `2a523958afa178a15d5806b498a6bb983e6d20ad89ba675c1b863efd77fad817`; proof and resources are staged in `artifacts/native-packaging-gateway/`. This is archive validation, not provider/model or installed-release acceptance. Public native CLI/MCP and final package smoke still await the coherent replacement build.

The unchanged contribution race passed **1/1** again while real offline gateway extraction/inventory was active (case 4,278 ms; total 6,630 ms), retaining the exact one-POST and shared-operation oracle. Log: `contribution-race-offline-install-load-20261110.log`. The interrupted full-run failure's original cause remains unconfirmed; no timeout or publication logic was changed.

Actual R0045 exposed another native boundary: the installed `runSubagent` returns its `Agent error:` failure as a normal one-text-part result, not a rejected API promise. The old adapter saved a raw provider stack as unverified professional content. Exact installed core bytes and preserved report KNW-0146 were checked before repair. A bare native wrapper now passes through the sanitized failure classifier: `Response contained no choices` becomes `PROVIDER_PROTOCOL`; authorization, quota and model categories remain separate. The one actual call and unknown effects are retained, with no fabricated cancellation, acceptance, automatic retry or new raw-stack copy. Quoted/fenced/structured professional descriptions are negative controls. Two new wrapper cases failed before repair; the delegation suite then passed **21/21**. Diagnostic: `native-returned-error-diagnostic-20261110.json`. The host supplies no unforgeable error-content flag, so literally identical bare prose is indistinguishable from its error wrapper. This does not turn the unsuccessful R0045 REA run into a pass.

**Actual installed npm package smoke:** the coherent `workforce@0.3.0-alpha.1` tarball passed on Windows x64 / Node **24.18.0**, installed in canonical OS-temp storage outside the checkout. Archive SHA256: `5542ea1ec1d42fe9d3122f057fa2279779854823cfbe30538fbaf1043decc4e8`. Its 737-file inventory includes the pinned gateway archive and excludes the legacy engine, SDK, bootstrap and extension entry. A real offline gateway installation and full 3,701-entry verification passed. Both a new native project and an old stored `opencode + Local` configuration exercised the actual installed CLI and MCP: two read-only MCP tools, advisory reuse without execution, native session instructions, and submit/control handoffs without model/engine dispatch. The old config, retained history sentinel and actual pending native execution remained byte-identical; installer update preserved a user-edited profile and Git exclusions. Report/log: `artifacts/native-packaging-gateway/installed-native-smoke-20261110.{json,log}`. Package smoke has no native model invocation and does not certify the final portable asset, VSIX desktop, URL plug-in or release.

## Local evidence ledger

Evidence remains in the owned fixture under `artifacts/workforce-native-local-proof/c3f40d36/evidence/`:

- `native-r36-accepted-independent-audit-final-20261109.json`
- `native-r37-checker-reload-independent-audit-20261109.json`
- `native-r37-checker-reload-observer-20261109.json`
- `native-checker-stop-ui-action-20261109.json`
- `native-optional-fallback-independent-audit-20261109.json`
- `native-optional-fallback-policy-restored-20261109.json`
- `ui-model-hook-20261109/independent-audit.json`
- `native-mcp-active-final-20261109/independent-audit-r43.json`
- `native-mcp-active-final-20261109/independent-audit-r44.json`
- `native-mcp-active-final-20261109/independent-audit.json`

Private keys and authenticated command envelopes are not published here. Earlier R0035 lacks a durable result and remains uncertain; no historical receipt or successful outcome was fabricated.

Targeted follow-up logs are under `artifacts/workforce-native-local-proof/`: `native-ui-model-guards-red-20261109.log`, `native-ui-model-hook-guards-20261109.log`, `native-capability-session-red-20261109.log`, `native-capability-session-restore-red-current-20261109.log`, `native-capability-session-final-targeted-20261109.log`, `native-skill-leases-final-with-publication-fix-20261109.log` and `contribution-race-current-diagnostic-20261109.log`. Failed observations remain alongside their later bounded repairs or unresolved diagnoses.

## Remaining milestones

The [saved checklist](../plans/2026-11-08-workforce-local-milestones.md) remains the scope authority. Remaining UI/native failure branches, broader marketplace/dependency conformance, full native Agent Plugin package lifecycle, actual REA/managed gateway work and final desktop distribution acceptance remain open. This report certifies the cases above, not completion of M1–M8 or a new release.
