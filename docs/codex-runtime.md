# Codex native agents

`neomind init --platforms codex --project DIRECTORY` installs nine custom profiles, project instructions, skills and a parent NeoMind MCP connection. Fresh Codex-only projects select `codex-native`, local-only research and no automatic publication. Updates preserve an existing automation policy and every saved workflow's execution mode. Installing files establishes configuration; it does not establish client discovery, authentication or executed inference.

Install a supported Node runtime (24 or 26+) on the native client's PATH. CLI generation records its Node executable. Regeneration inside Electron reuses an unchanged installer-owned Node connection when available, and otherwise uses portable `node`; it never writes the editor executable as the stdio server command.

| Codex agent name | Human profile | Persisted core responsibilities | Model role |
| --- | --- | --- | --- |
| `neomind-coordinator` | NeoMind Coordinator Agent | manager, curator, release | manager |
| `neomind-explorer` | NeoMind Explorer Agent | codebase-analyst | codebase-analyst |
| `neomind-researcher` | NeoMind Researcher Agent | researcher | researcher |
| `neomind-planner` | NeoMind Planner Agent | requirements | requirements |
| `neomind-architect` | NeoMind Architect Agent | architect, component-owner | architect |
| `neomind-implementer` | NeoMind Implementer Agent | developer | developer |
| `neomind-debugger` | NeoMind Debugger Agent | developer | developer |
| `neomind-verifier` | NeoMind Verifier Agent | verifier, check-executor | verifier |
| `neomind-reviewer` | NeoMind Reviewer Agent | reviewer | reviewer |

Names live in `.codex/agents/neomind-<profile>.toml`. Use the exact `name` with `spawn_agent.agent_type`; the visible human title is in its description. Coordinator delegates; specialist packets carry bounded scope, core role, workflow/assignment IDs, allowed paths and acceptance evidence. Implementer and Debugger deliberately share `developer`; Verifier uses the strong `verifier` route. The twelve historical record/receipt role IDs do not change.

Codex standalone agent files accept name, description, developer instructions and supported model settings. Children inherit parent permissions, provider and MCP servers; child `sandbox_mode`, `approval_policy`, `model_provider` and `mcp_servers` overrides are ineffective. NeoMind therefore describes role duties without presenting them as independent sandboxes. Native source inspection, terminal/edit work and network access remain subject to parent permissions and the saved assignment. [Official custom-agent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Saved execution and evidence

Generic intake calls `manager_run` once and passes the returned handoff to `neomind-coordinator`. Assigned agents continue their packet directly. Full `codex-native` workflows retain engineering gates, actual specialist reports, independent checks/review and Cornell closure. Invocation IDs and progress are reported observations with `unsigned-native-report` assurance. They are not signed bridge receipts or confirmed model/provider observations. Existing `strict` workflows keep their signed runtime and role gateway.

Lightweight work can choose `native_client: "codex"`; its saved `backend: "codex-native"` is immutable. Old lightweight records without a backend retain Copilot semantics. A lightweight increment uses risk-based checks/review and `lightweight_checkpoint`, without full assignment-report or Cornell closure requirements. Use a new increment to change clients or execution mode.

## Optional 9router control

The default is `codex_routing: "inherit"` (also the behavior when absent). It emits no provider or role-policy model override. Generic legacy model tiers are ignored for Codex; an explicitly authored platform-specific tier such as `models.strong: {"codex": "exact-model-id"}` applies under the parent's provider.

After configuring the local router, run `neomind codex configure --data '{"mode":"9router"}' --project DIRECTORY`. It persists `codex_routing: "9router"` in `.neomind/config.json` and regenerates the managed files. This requires `.neomind/router.json` with the validated local base URL and API-key environment variable name. NeoMind generates a parent `neomind_9router` Responses provider and each profile's first configured core-role model/effort. It copies no VS Code catalog credentials and stores no key value in generated files. The environment variable must be available to the parent Codex process. Model changes through NeoMind's controls apply to regenerated files and new invocations, never an already running conversation. Use `{"mode":"inherit"}` to restore inheritance.

The installer preserves authored settings. A pre-existing parent provider choice or conflicting provider table produces a review candidate. Resolve those candidates before relying on the new route. Opting back into inheritance removes only unchanged installer-owned provider blocks; edited blocks remain for explicit review. A provider still referenced by a preserved parent selection stays available with a review warning.

Configuration, `/health` and `/models` do not prove a gateway can execute Codex. Validate the actual selected route with a Responses request, streamed completion, continuation and a real tool-call/tool-result roundtrip. Native child profiles share the parent's provider; they cannot independently select a different provider. [Official gateway compatibility requirements](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).

## Hooks and optional upstream tools

NeoMind merges supported Codex lifecycle events into `.codex/hooks.json`, preserving unrelated events and edited handlers as conflicts. Review project configuration and changed hook definitions through Codex's normal trust flow. Hooks observe native lifecycle; they do not grant permissions, bind arbitrary sessions to a workflow or establish acceptance. Raw transcripts, prompts, tool arguments and assistant output are excluded from the observation store. [Official hook configuration and trust](https://learn.chatgpt.com/docs/hooks).

REA is optional and registers only after its pinned local package, saved Node launcher and actual discovery observation are verified. Codex receives the reviewed tool allowlist at its parent MCP layer. Researcher/Explorer duties can use the original `reverse-engineer-anything` skill for an authorized assignment; its referenced files, MIT notice and provenance are installed without rewriting upstream text. Direct native tools remain unsigned; strict capability invocations keep their existing binding and receipt checks. Missing optional tools never count as successful analysis.

Updates retire obsolete Codex role files only when their current bytes still match the install manifest. Edited or unowned custom agents and historical records remain intact. Review upgrade warnings: a retained edited legacy file can remain discoverable until its owner resolves it.
