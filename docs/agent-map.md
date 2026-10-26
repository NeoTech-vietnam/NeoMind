# NeoMind agent universe

Run **NeoMind: Open Agent Map** in a trusted, initialized VS Code workspace after setting the User-level `neomind.bridge.runtimePath` to the trusted NeoMind runtime directory. The monitor can open without enabling the model bridge. It reads local state every 2.5 seconds while visible and disposes its refresh timer when closed or workspace folders change.

The universe places NeoMind at the center and gives each configured core role its own planet. Procedural surface textures distinguish the planets without external image requests. Tasks appear as moons associated with their role, and recorded invocation/report identities appear as stations. A configured planet can exist before any task or signed invocation; it represents a role policy, not proof that an agent is running.

Primary planet labels use the installed profile names: Coordinator (`manager`), Explorer (`codebase-analyst`), Planner (`requirements`), and Implementer / Debugger (`developer`). The twelve underlying role IDs and saved record bindings remain stable. Secondary duties such as Curator, Release and Check Executor retain their own policy planets and identify the controlling profile in the inspector.

## Native assignment interactions

The **Agent interactions** panel shows fresh native progress reports, dispatch attempts, waiting/blocked work and the direction of dispatch/report events. Updated Coordinator and specialist instructions call `agent_activity` before work and at meaningful milestones, without waiting for a final assignment report. A configured planet is distinct from an actual reported assignment station.

These observations are unsigned. A dispatch means an attempted launch; `running` means the agent reported work started. Active reports expire after five minutes without an update and become unknown. No activity state confirms a responding model, test result, task acceptance or continuing inference. The reader inspects a bounded event window and reports invalid/omitted observations. It preserves all engineering records and receipts.

Existing Copilot chats are not automatically intercepted. Reload the updated monitor, restart the NeoMind MCP server and resume through the updated Coordinator/profile instructions. Old conversations and agents that never report activity cannot acquire a reliable live status retroactively. The CLI fallback is `neomind activity report --project PROJECT --data JSON`, with `workflow_id`, `assignment_id`, `profile_id`, `state` and a short non-sensitive `summary`. Only saved native/lightweight workflows are accepted; strict sessions retain their signed receipt path. Activity events are stored separately under `.neomind/runs/agent-activity/`.

Select a planet, moon, station or list item to open its inspector. Roles show configured policy; saved items show their source identity, with requested/observed model metadata on invocation/report stations. Selection follows the item's stable ID across refreshes instead of jumping to another object. The work list remains available for navigating bounded records that are not currently prominent in the scene.

Orbital tracks are visual organization. Communication paths come from saved snapshot edges. Moving signals replay recorded handoffs, reports and contributions; they do not indicate that a message is being sent now. Pause motion freezes the presentation without stopping agents or changing project state. The operating system's reduced-motion preference also disables motion while retaining selection, labels and inspection.

The role picker uses configured model IDs and, when explicitly opened with 9router configured, the router's model catalog. An exact model ID can also be entered. Core policy enforces model changes: changes apply to the next invocation, and any live invocation blocks reconfiguration. Planet selection and motion controls do not enable inference or restart an agent.

After saving policy, the monitor calls the existing project updater to refresh generated native agents. Edited generated files are preserved as review candidates; a warning distinguishes saved policy from unresolved generated-file conflicts. If generation fails, the policy remains saved and `neomind update` must be resolved before the next native agent starts.

Strict bridge mode selects all twelve core roles independently. Copilot-native mode exposes nine expert profiles: Coordinator, Explorer, Researcher, Planner, Architect, Implementer, Debugger, Verifier and Reviewer. The monitor reads their mappings from runtime profile metadata instead of maintaining a separate role list. Cards and the inspector identify applicable profiles and the controlling native model policy. Implementer and Debugger share developer; Verifier/check-executor uses the strong verifier route in native mode. Secondary-role selections apply independently only in strict bridge mode. Core role planets preserve saved record identities; nine profiles do not create nine new core role IDs. See [the complete mapping](roles.md).

## Snapshot API

`readAgentMap(root)` returns `AgentMapSnapshot` with:

- `schema_version: 1`, project ID/name and `observed_at` in UTC.
- `nodes`: at most 128 agents (verified receipts and explicitly reported native contributors combined) plus 128 task/workflow records. Fields include `id`, `kind`, `label`, `role`, normalized `state`, `source`, `source_id`, `invocation_id`, workflow/task binding, requested/confirmed model, provider, execution mode and update time.
- `edges`: at most 512 explicit relationships, each with endpoints, `kind`, `source`, `evidence_id`, `at`, and `animated`.
- `diagnostics`: counts of invalid receipts and receipts/records/edges omitted by the inspection window. Counts do not leak rejected receipt contents or exception payloads.

Nodes use `running`, `waiting`, `blocked`, `idle`, `completed`, `failed` or `unknown`. Native permission waits map to waiting; interruption/orphaning and missing owner processes map to blocked. Ordinary draft/ready records map to idle and submitted records to waiting. Receipt completion describes an invocation and does not establish task acceptance.

`source: signed-receipt` means `readInvocation` verified the existing trusted local signature and project identity. It is local provenance, and `execution_mode` distinguishes protocol fixtures from execution; it is not remote provider attestation. `source: project-record` describes stored engineering state. In native mode, saved role discussions/reports create explicitly labeled reported agent identities from their workflow, owner and invocation IDs, including covered invocation IDs. Their completed state means a contribution/report was saved; it does not imply model inference completed. Requested/confirmed model and provider stay null, and no live state is inferred. Workflows, tasks and reported identities cannot masquerade as signed receipts. Invalid signatures are counted and omitted. The newest receipt files by filesystem modification time form the bounded inspection window; the displayed timestamp is the signed receipt timestamp. Current receipt-bound work records are prioritized within the record limit.

Relationship kinds are `coordinates`, `participates`, `assignment`, `works-on`, `handoff`, `report`, `contribution` and `depends-on`. Resume handoffs require matching role, workflow and task on both verified receipts. Reports/contributions bind to a signed invocation only when its owner and workflow match; otherwise they use an explicitly reported identity. Their contents remain ordinary project-record claims: the monitor does not re-run engineering acceptance. There is no inferred all-to-all chat or fabricated parent/spawn relationship. Decorative orbit lines remain separate from recorded communication paths.

Snapshots exclude raw prompts, output, error/permission payloads, record bodies, arbitrary record data, private paths, signing keys, tokens and endpoint credentials. The module does not change receipts or project state. Historical signed receipts can be shown even after configuration changes; they do not authorize new execution.

## Verification and limits

`node --test test/agent-map.test.mjs test/agent-monitor.test.mjs test/universe-renderer.test.mjs test/universe-monitor-ui.test.mjs` covers signed provenance, tampering/project mismatch, explicit handoff/report relations, privacy projection, snapshot bounds, monitor lifecycle and guarded model changes. It also checks scene identity/projection, recorded-edge preservation, controller selection and focus across polling, stale state, pause/reduced motion, and the preview's unsigned fixtures and HTTP assets. These tests do not measure rendered pixel quality. Build first with `npm run build`.

The monitor reads durable snapshots rather than intercepting arbitrary terminal traffic. Unsigned native sessions show saved contribution/report identities and work records with project-record provenance. The universe and full bounded list present the same snapshot. Invalid model-control state disables model controls while preserving the read-only scene and its diagnostics. Simulated test receipts and browser fixture screenshots establish rendering and integration behavior, not live provider inference. Installation and account consent are still needed to run actual agents.

## Local visual preview

After `npm run build`, run `node scripts/preview-monitor.mjs` and open its printed loopback URL. The preview serves the same renderer, controller and stylesheet used by the extension. It uses deterministic in-memory fixture records, creates no project, and contacts no router or model. All 12 configured role planets use the sample provider label `9Router` and explicit `demo/…` model IDs. These are illustrative selections, not a discovered catalog.

The default fixture includes working, waiting, blocked, idle and completed tasks, unsigned saved report stations, and labeled sample recorded handoff arcs. Every sample source is `project-record`; no signed receipt or live model identity is fabricated. Model buttons explain that no change was made. `?fixture=small`, `?fixture=empty` and `?fixture=error` exercise a smaller scene, configured roles without recorded work, and an intentional local-state error. The preview banner stays visible so screenshots cannot be mistaken for live execution evidence.

The source comparison, pinned revisions and licensing boundaries are recorded in [agent map research](research/agent-map.md).
