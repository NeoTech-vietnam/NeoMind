# Copilot delay and repeated Cornell creation failure

Investigated **2026-10-23**, using existing local logs and isolated MCP replay. Times below use UTC+07 unless marked UTC. No inference was requested, no provider credentials were read, and no user service, configuration, saved conversation or NeoLearning record was changed by this investigation.

## Findings

The screenshot's “taking a little longer” message does not identify a root cause. The inspected Local Copilot session was continuing model and tool rounds through 22:24, and the router recorded further token-producing requests through 22:28. The strongest demonstrated NeoMind defect is a repeated **optional Cornell revision placeholder failure**, which prevents required note creation and can keep the workflow retrying. A separate renderer network-abort error remains unresolved; this repair does not establish that every conversation delay is fixed.

The active project configuration selects Copilot **Local** integration and `copilot-native` execution. Current installed profiles contain the Coordinator self-intake/recursion restrictions. NeoMind's MCP server entered Running at 22:08:16 and discovered 67 tools at 22:08:17. Successful subsequent calls show that the server was responding rather than universally blocked during the inspected interval.

## Evidence and feedback loop

The diagnostic [script](../../artifacts/focus-space/copilot-stall-probe.mjs) reads existing hook/renderer metadata, performs a four-second-deadline local health GET and invokes the real MCP SDK against a disposable project beneath `artifacts/focus-space`. Every replay tool call has a five-second deadline and cancellation signal. It retains event names, times, tool names, hashed session identifiers and fixed error categories; it excludes tool arguments, response bodies, prompts, credentials and transcript contents.

```powershell
node artifacts/focus-space/copilot-stall-probe.mjs
# Before repair: blank revision_id reproduces the live error; omitted succeeds.

node artifacts/focus-space/copilot-stall-probe.mjs --expect-fixed
# After repair: blank, null and omitted each create a fresh fixture note.
```

The first command's original expectations intentionally describe the pre-repair behavior; use `--expect-fixed` against the repaired build. Archived results are [before](../../artifacts/focus-space/copilot-stall-probe-before.json) and [after](../../artifacts/focus-space/copilot-stall-probe-after.json).

| Probe | Observation |
| --- | --- |
| Existing hook log replay | 29 `note_create` responses classified as empty optional revision ID, across two hashed sessions, from 18:30:40 to 22:24:22. |
| Pre-repair real MCP call with `revision_id: ""` | Same error as the live log in 27 ms; no new record. |
| Pre-repair call with `revision_id: null` | Input-schema refusal in 26 ms; no new record. |
| Pre-repair call omitting revision fields | Fresh note created in 393 ms. |
| Post-repair blank/null/omitted calls | Fresh notes created in 427/517/607 ms respectively. |
| Router `GET /api/health` | HTTP 200 and `ok: true`; sampled at 54–166 ms. This proves HTTP readiness, not upstream inference quality. |
| Existing router usage metadata | Read-only SQLite projection of timestamps and token counts showed continuing output-producing requests. Status values were not interpreted as proof of success. No keys, endpoint credentials or request content were selected. |
| Router file logs | The configured application log directory was empty; no upstream error trace was available there. |
| Advisory post-tool hooks | Live samples completed in roughly 0.9–3.0 seconds, with one 7.7-second sample. Isolated no-op CLI hook samples took 772/896/1316 ms and returned `{}`. This adds cumulative latency but did not reproduce an infinite wait. |
| Renderer network path | Stream “network request aborted” at 22:18:13; independent EOF events also occurred. A later series of completed rounds prevents treating that one error as proof of an ongoing global outage. |

The existing log sources were VS Code session `20261023T180514`, window 1, `GitHub Copilot Chat Hooks.log`, `GitHub Copilot Chat.log`, `renderer.log`, and the user-local NeoMind MCP server log. The saved artifact records source line numbers without copying private bodies. Router metadata is summarized separately in [router-stall-metadata.json](../../artifacts/focus-space/router-stall-metadata.json).

## Ranked hypotheses and falsifiable checks

| Rank | Hypothesis | Prediction and result |
| --- | --- | --- |
| 1 | Native clients serialize unused optional Cornell revision fields as blank/null, causing a mandatory documentation retry loop. | Keeping the note identical and omitting only that placeholder should succeed. Real MCP replay confirms this; existing logs show repeated corresponding refusals. This explains that workflow blocker, not every generic UI wait. |
| 2 | An aborted provider/network stream interrupted an individual turn. | The affected turn should have an abort/cancellation event and matching transport failure. Renderer logs establish an abort, but no matching upstream trace was available. Cause and relationship to the screenshot remain unconfirmed. |
| 3 | Repeated full-CLI advisory hook startup adds visible delay to many tool rounds. | A no-op hook should still incur startup cost. Local measurement and hook completion logs confirm subsecond-to-several-second overhead; samples completed rather than hanging. |
| 4 | Coordinator re-intake or recursive delegation prevents progress. | Logs should show repeated `manager_run`/self-launch without useful results. Installed instructions prohibit these paths; the inspected late sequence instead showed completed source reads and repeated note errors. No recursion root cause was established. |
| 5 | NeoMind MCP initialization or strict Bridge timeout traps the active Local chat. | Startup/tools should remain pending, or the active path should be strict. The server discovered tools and returned requests; saved mode is `copilot-native`. Changing strict Bridge timers would not target the observed Local tool-contract failure. |

## Approved repair and preserved boundaries

At the MCP `note_create` boundary only, `revision_id` and `revision_reason` now accept null or whitespace-only placeholders and normalize them to absence. `expected_revision: null` likewise becomes absent. Nonempty revision targets are retained exactly and still require current revision, substantive rationale and original workflow ownership. Substantive revision companions without a target still fail; required ownership/source IDs remain strict. No generalized empty-ID coercion or core revision-validator relaxation was introduced.

The new [MCP regression suite](../../test/mcp-cornell-placeholders.test.mjs) first failed against the old behavior, then passed all four tests after repair. It covers six fresh-note placeholder variants, required-ID rejection, stale/wrong-workflow/noninteger/missing-rationale refusals, valid owned revision, and prevention of creation when actual revision companions are supplied. Failure checks compare every fixture file's bytes, including protected records and history. Build passed. The existing Cornell MCP suite also passed all three tests after its discovery assertion was updated for the nullable schema; [saved result](../../artifacts/focus-space/mcp-cornell-existing.log).

Strict Bridge request transport has a 15-second wire timeout, a 10-second selection deadline, a 75-second MCP tool timeout and a 30-minute invocation deadline in `src/vscode-wire.ts`, `src/vscode-host.ts` and `src/vscode-session.ts`. These are not general deadlines for native Local Copilot conversations. The active native route has no NeoMind-owned model request timer, because the editor and endpoint own inference.

A future bounded no-progress policy could stop automatic retries after repeated identical validation errors and return a concrete blocker. It must preserve saved requirements, review and Cornell gates, native cancellation, and unsigned provenance. This investigation did not implement that policy, optimize hook startup, restart the MCP server, or confirm repair activation inside the already-running user conversation. Deployment/reload and any live provider validation remain separate from the local regression result.
