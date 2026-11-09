# WorkForce Native Local acceptance — 09/11/2026

## Candidate and scope

- Source: `b0ec6446a34d491bd1928ef17e395eab3073e8c4`, branch `codex/workforce-vscode-native`.
- Loaded runtime fingerprint: `246f1fb1b88119380b23810220fc2fa294cf636380a05924a6ee47a61772d3df`.
- Actual client: VS Code 1.145.2, chat extension 0.73.0, **Local** in an owned disposable workspace.
- Parent selected `customendpoint/top-models`; FnD preference `worker-models`. These aliases do not establish the actual upstream model/vendor. Defaults in distributed native profiles inherit the native selection and do not require these aliases.
- No production-workspace upgrade or new GitHub runtime/VSIX release is certified by this report.

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

## Local evidence ledger

Evidence remains in the owned fixture under `artifacts/workforce-native-local-proof/c3f40d36/evidence/`:

- `native-r36-accepted-independent-audit-final-20261109.json`
- `native-r37-checker-reload-independent-audit-20261109.json`
- `native-r37-checker-reload-observer-20261109.json`
- `native-checker-stop-ui-action-20261109.json`
- `native-optional-fallback-independent-audit-20261109.json`
- `native-optional-fallback-policy-restored-20261109.json`

Private keys and authenticated command envelopes are not published here. Earlier R0035 lacks a durable result and remains uncertain; no historical receipt or successful outcome was fabricated.

## Remaining milestones

The [saved checklist](../plans/2026-11-08-workforce-local-milestones.md) remains the scope authority. Extended UI/model/hook cases, generic MCP capability plans, active-invocation plug-in lifecycle, actual REA/managed gateway work and final desktop distribution acceptance remain open. This report certifies the cases above, not completion of M1–M8 or a new release.
