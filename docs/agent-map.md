# NeoMind agent map

Run **NeoMind: Open Agent Map** in a trusted, initialized VS Code workspace after setting the User-level `neomind.bridge.runtimePath` to the trusted NeoMind runtime directory. The monitor can open without enabling the model bridge. It reads local state every 2.5 seconds while visible and disposes its refresh timer when closed or workspace folders change.

The four farm fields group planning/research, implementation/release, verification/review, and blocked/waiting agents. Characters are original procedural artwork. Selecting an item shows its source IDs and requested/observed model metadata. The list beneath the scene includes items omitted from the compact drawing. Configured roles remain available in the model controls even before any signed invocation exists; configured availability does not imply an active agent.

The role picker uses configured model IDs and, when explicitly opened with 9router configured, the router's model catalog. An exact model ID can also be entered. Core policy enforces model changes: changes apply to the next invocation, and any live invocation blocks reconfiguration. The monitor never enables inference or silently restarts an agent.

After saving policy, the monitor calls the existing project updater to refresh generated native agents. Edited generated files are preserved as review candidates; a warning distinguishes saved policy from unresolved generated-file conflicts. If generation fails, the policy remains saved and `neomind update` must be resolved before the next native agent starts.

Strict bridge mode selects all roles independently. Copilot-native mode groups roles into six generated agents: Manager uses `manager` policy (also researcher/codebase-analyst/curator/release), SWSD uses `requirements`, P-RES uses `architect` (also component-owner), FnD uses `developer`, Reviewer uses `reviewer`, and Tester uses `check-executor` (also verifier). Cards identify the controlling policy; secondary-role selections apply independently only in strict bridge mode.

## Snapshot API

`readAgentMap(root)` returns `AgentMapSnapshot` with:

- `schema_version: 1`, project ID/name and `observed_at` in UTC.
- `nodes`: at most 128 agents (verified receipts and explicitly reported native contributors combined) plus 128 task/workflow records. Fields include `id`, `kind`, `label`, `role`, normalized `state`, `source`, `source_id`, `invocation_id`, workflow/task binding, requested/confirmed model, provider, execution mode and update time.
- `edges`: at most 512 explicit relationships, each with endpoints, `kind`, `source`, `evidence_id`, `at`, and `animated`.
- `diagnostics`: counts of invalid receipts and receipts/records/edges omitted by the inspection window. Counts do not leak rejected receipt contents or exception payloads.

Nodes use `running`, `waiting`, `blocked`, `idle`, `completed`, `failed` or `unknown`. Native permission waits map to waiting; interruption/orphaning and missing owner processes map to blocked. Ordinary draft/ready records map to idle and submitted records to waiting. Receipt completion describes an invocation and does not establish task acceptance.

`source: signed-receipt` means `readInvocation` verified the existing trusted local signature and project identity. It is local provenance, and `execution_mode` distinguishes protocol fixtures from execution; it is not remote provider attestation. `source: project-record` describes stored engineering state. In native mode, saved role discussions/reports create explicitly labeled reported agent identities from their workflow, owner and invocation IDs, including covered invocation IDs. Their completed state means a contribution/report was saved; it does not imply model inference completed. Requested/confirmed model and provider stay null, and no live state is inferred. Workflows, tasks and reported identities cannot masquerade as signed receipts. Invalid signatures are counted and omitted. The newest receipt files by filesystem modification time form the bounded inspection window; the displayed timestamp is the signed receipt timestamp. Current receipt-bound work records are prioritized within the record limit.

Relationship kinds are `coordinates`, `participates`, `assignment`, `works-on`, `handoff`, `report`, `contribution` and `depends-on`. Resume handoffs require matching role, workflow and task on both verified receipts. Reports/contributions bind to a signed invocation only when its owner and workflow match; otherwise they use an explicitly reported identity. Their contents remain ordinary project-record claims: the monitor does not re-run engineering acceptance. There is no inferred all-to-all chat or fabricated parent/spawn relationship. Yellow dashed lines show recorded relationships; blue dots replay recorded handoffs/reports/contributions, and do not claim messages are being sent now. Reduced-motion mode disables movement.

Snapshots exclude raw prompts, output, error/permission payloads, record bodies, arbitrary record data, private paths, signing keys, tokens and endpoint credentials. The module does not change receipts or project state. Historical signed receipts can be shown even after configuration changes; they do not authorize new execution.

## Verification and limits

`node --test test/agent-map.test.mjs test/agent-monitor.test.mjs` covers signed provenance, tampering/project mismatch, explicit handoff/report relations, absence of fabricated communication, privacy projection, lifecycle state, snapshot limits, monitor lifecycle and policy-mediated model changes. Build first with `npm run build`.

The monitor reads durable snapshots rather than intercepting arbitrary terminal traffic. Unsigned native sessions show saved contribution/report identities and work records with project-record provenance. A compact map draws at most 24 agents (eight per field) and 12 work items; the full bounded list remains available. Narrow panels scroll horizontally across a 760px scene to preserve label spacing. Invalid model-control state disables controls while preserving the read-only map and its diagnostics. Simulated test receipts and browser fixture screenshots establish rendering and integration behavior, not live provider inference. Installation and account consent are still needed to run actual agents.

The source comparison, pinned revisions and licensing boundaries are recorded in [agent map research](research/agent-map.md).
