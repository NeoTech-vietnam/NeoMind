# One-file model configuration

For an installed project, edit only `.neomind/routing.json` (legacy physical root: `.verythinker/routing.json`) to choose strong and worker defaults or per-core-role overrides. Then run `npx neomind update` in that project to regenerate all nine managed Copilot profiles. Do not edit each generated agent or duplicate model settings in `config.json`.

The [ready-to-use template](../examples/model-routing.json) illustrates provider-qualified model choices; replace its example catalog path with your own:

```json
{
  "schema_version": 1,
  "enabled": true,
  "platform": "copilot",
  "runtime_version": "0.162.1",
  "language_models_file": "C:/Users/TYH5HC/AppData/Roaming/Code/User/chatLanguageModels.json",
  "strong_provider": "9localrouter",
  "strong_model": "company-top-tier-model",
  "worker_provider": "Bosch Model Farm",
  "worker_models": ["gpt 4o-mini", "gemini-2.5-flash-lite"],
  "strong_effort": "high",
  "worker_effort": "low"
}
```

For a project initialized with NeoMind, apply the template in PowerShell (use `.verythinker` instead for an unmigrated legacy root):

```powershell
Copy-Item D:\workspace\NeoMind\examples\model-routing.json .neomind\routing.json
npx neomind update
```

This replaces the selected project's previous routing choices. Change the catalog path when moving to another machine; relative paths resolve from the project root. Installation creates an initial policy when absent and preserves customized policies on subsequent updates. Existing initial Copilot defaults remain unchanged until you edit the policy or apply this template.

## Choosing models

| Field                                | Meaning                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strong_model`                       | Default for Coordinator, Planner, Architect, Verifier and Reviewer. Strict core roles: manager, requirements, architect, component-owner, verifier and reviewer. |
| `worker_models`                      | Ordered defaults for Explorer, Researcher, Implementer and Debugger. Strict core roles: researcher, codebase-analyst, curator, developer, check-executor and release. Use one entry to select a single worker model. |
| `strong_provider`, `worker_provider` | Optional catalog provider name or vendor. Names distinguish Bosch Model Farm and 9localrouter because both have vendor `customendpoint`.                                                                                          |
| `language_models_file`               | Optional path to the existing VS Code model catalog. Model IDs are resolved to client display names; missing or ambiguous entries stop generation. Without a catalog, configured strings are emitted as client model names.       |
| `strong_effort`, `worker_effort`     | Requested effort: `high`, `medium`, or `low`. These are policy requests, not proof that a custom endpoint supports reasoning-effort controls.                                                                                     |
| `role_models`                       | Optional overrides keyed by an existing core role, each with a `model` and optional `provider`/`effort`. The profile's native model-policy role determines which override applies. |

The generated entry point is `.github/agents/neomind-coordinator.agent.md`. Only Coordinator is user-invocable; the remaining eight profiles are delegates with their own declared tools and no recursive delegation. Their model mappings are:

| Native profile | Model-policy role | Default |
| --- | --- | --- |
| NeoMind Coordinator Agent | `manager` | strong |
| NeoMind Explorer Agent | `codebase-analyst` | worker |
| NeoMind Researcher Agent | `researcher` | worker |
| NeoMind Planner Agent | `requirements` | strong |
| NeoMind Architect Agent | `architect` | strong |
| NeoMind Implementer Agent | `developer` | worker |
| NeoMind Debugger Agent | `developer` | worker |
| NeoMind Verifier Agent | `verifier` | strong |
| NeoMind Reviewer Agent | `reviewer` | strong |

Implementer and Debugger share the `developer` override; they cannot select separate native models through profile names. Verifier's native profile uses `verifier`, including when its bounded assignment covers check execution. Strict Bridge invocations retain the actual core role's route, so `check-executor` remains independently configurable as a worker. Coordinator's native profile similarly uses `manager` when coordinating curator/release duties; the signed core roles remain distinct. Display profiles never replace historic role IDs in records or receipts. See [model control](model-control.md) for override syntax and guarded controls.

The template uses the exact Bosch ID `gpt 4o-mini`, including the space. For the `customendpoint` vendor, generated VS Code agents use the qualified display name `GPT-4o mini (customendpoint)`. Likewise, `gemini-2.5-flash-lite` becomes `Gemini 2.5 Flash-Lite (customendpoint)` and `top-tier-model` becomes `top-tier-model (customendpoint)`. An existing vendor suffix is not added twice.

Routing accepts raw catalog IDs, exact display names, and their vendor-qualified forms, so `top-tier-model (customendpoint)` is valid in the single routing file. Provider restrictions still apply: the suffix must match the actual catalog vendor, not the provider group's name. Exact literal IDs take precedence over aliases; ambiguous catalog entries still block generation. The optional Bridge resolves these selections back to canonical vendor/ID values rather than sending the display suffix as part of the ID.

VS Code custom agents support a single `model` name or a prioritized array. Profiles using worker defaults receive the configured list in order; a per-role override selects one model. This is client availability selection, not an assertion of completed inference. The native protocol path permits worker fallback only after explicit model-unavailability evidence, never after missing authentication or permission refusal.

The catalog continues to own endpoint URLs and credentials. NeoMind reads model metadata but does not copy API keys, secret references, or URLs into generated agents. Register new models in VS Code first, then select them in the project's routing file. Changing the catalog alone does not change the project's selected IDs; run `update` after changing a selected model's display name.

## Preservation and execution limits

Updates regenerate untouched managed agents. Manually edited agents remain untouched and receive review candidates; inspect those candidates before claiming the new configuration is active. Legacy `config.json` tier mappings remain preserved but do not override `routing.json`. Legacy projects without a routing policy retain their existing model mappings.

Model-control edits apply to new invocations and refuse changes while signed invocations are starting, running or waiting for native permission. Direct routing edits can invalidate those invocations' configuration hashes; changed routing can also make completed receipts stale for current strict acceptance. Historical records are preserved. Invalid settings, empty models, duplicate worker entries, and unsupported schema/runtime values are rejected without rewriting the policy.

Default `manager_run` returns a `NeoMind Coordinator Agent` handoff. Generic intake launches it once through the standard VS Code agent tool and waits; a directly selected Coordinator continues the returned prompt in its current invocation. An already assigned Coordinator continues its packet without another intake call or self-launch. This native path reports unsigned invocation identities without signed receipts. Only optional `execution_mode: strict` dispatch uses the explicitly enabled [VS Code Model Bridge](vscode-bridge.md), not a headless SDK or Copilot CLI. Existing catalog selections resolve to exact `vscode.lm.selectChatModels({vendor,id})` selectors; provider labels require the catalog. The bridge signs local host attestations and host-issued conversation/turn IDs, not provider identity proofs. It exposes only invocation-bound MCP tools, with no builtin shell/filesystem tools and no pretend sandbox.

Add `"vscode_effort_policy": "allow-unavailable"` only after accepting that the stable API cannot verify reasoning effort. Requested effort remains recorded; confirmed effort stays null. Omission or `"require-verified"` blocks automated execution. Consent refusal, unavailable/ambiguous models, unsupported tools, configuration/catalog changes, and stale hosts also block. See the bridge guide for exact installation, enable/disable, cancellation and resumption instructions.
