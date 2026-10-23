# One-file model configuration

For an installed project, edit only `.taskforces/routing.json` (legacy physical root: `.verythinker/routing.json`) to choose strong and worker models. Then run `npx taskforces update` in that project to regenerate all six managed Copilot agents. Do not edit each generated agent or duplicate model settings in `config.json`.

The [ready-to-use template](../examples/model-routing.json) selects the models in this machine's VS Code catalog:

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

For a project initialized with TaskForces, apply the template in PowerShell (use `.verythinker` instead for an unmigrated legacy root):

```powershell
Copy-Item D:\DevCloud\TaskForces\examples\model-routing.json .taskforces\routing.json
npx taskforces update
```

This replaces the selected project's previous routing choices. Change the catalog path when moving to another machine; relative paths resolve from the project root. Installation creates an initial policy when absent and preserves customized policies on subsequent updates. Existing initial Copilot defaults remain unchanged until you edit the policy or apply this template.

## Choosing models

| Field                                | Meaning                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strong_model`                       | Copilot: Manager Agent, SWSD Agent, P-RES Agent and Reviewer Agent. Strict core roles: manager, requirements, architect, component-owner, verifier and reviewer. Change to `top-tier-model` to use the other 9localrouter choice. |
| `worker_models`                      | Copilot: FnD Agent and Tester Agent. Strict core roles: researcher, codebase-analyst, curator, developer, check-executor and release. Use one entry to force a single choice; reverse the order to prefer Gemini.                 |
| `strong_provider`, `worker_provider` | Optional catalog provider name or vendor. Names distinguish Bosch Model Farm and 9localrouter because both have vendor `customendpoint`.                                                                                          |
| `language_models_file`               | Optional path to the existing VS Code model catalog. Model IDs are resolved to client display names; missing or ambiguous entries stop generation. Without a catalog, configured strings are emitted as client model names.       |
| `strong_effort`, `worker_effort`     | Requested effort: `high`, `medium`, or `low`. These are policy requests, not proof that a custom endpoint supports reasoning-effort controls.                                                                                     |

The template uses the exact Bosch ID `gpt 4o-mini`, including the space. For the `customendpoint` vendor, generated VS Code agents use the qualified display name `GPT-4o mini (customendpoint)`. Likewise, `gemini-2.5-flash-lite` becomes `Gemini 2.5 Flash-Lite (customendpoint)` and `top-tier-model` becomes `top-tier-model (customendpoint)`. An existing vendor suffix is not added twice.

Routing accepts raw catalog IDs, exact display names, and their vendor-qualified forms, so `top-tier-model (customendpoint)` is valid in the single routing file. Provider restrictions still apply: the suffix must match the actual catalog vendor, not the provider group's name. Exact literal IDs take precedence over aliases; ambiguous catalog entries still block generation. The optional Bridge resolves these selections back to canonical vendor/ID values rather than sending the display suffix as part of the ID.

VS Code custom agents support a single `model` name or a prioritized array. Worker agents receive the configured list in order. This is client availability selection, not an assertion of completed inference. The native protocol path permits worker fallback only after explicit model-unavailability evidence, never after missing authentication or permission refusal.

The catalog continues to own endpoint URLs and credentials. TaskForces reads model metadata but does not copy API keys, secret references, or URLs into generated agents. Register new models in VS Code first, then select them in the project's routing file. Changing the catalog alone does not change the project's selected IDs; run `update` after changing a selected model's display name.

## Preservation and execution limits

Updates regenerate untouched managed agents. Manually edited agents remain untouched and receive review candidates; inspect those candidates before claiming the new configuration is active. Legacy `config.json` tier mappings remain preserved but do not override `routing.json`. Legacy projects without a routing policy retain their existing model mappings.

Changing routing invalidates prior signed invocations for current strict acceptance. Historical records are preserved. Invalid settings, empty models, duplicate worker entries, and unsupported schema/runtime values are rejected without rewriting the policy.

Default `manager_run` returns a `Manager Agent` handoff for the standard VS Code agent tool; the host must launch it and wait. This native path reports unsigned invocation identities without signed receipts. Only optional `execution_mode: strict` dispatch uses the explicitly enabled [VS Code Model Bridge](vscode-bridge.md), not a headless SDK or Copilot CLI. Existing catalog selections resolve to exact `vscode.lm.selectChatModels({vendor,id})` selectors; provider labels require the catalog. The bridge signs local host attestations and host-issued conversation/turn IDs, not provider identity proofs. It exposes only invocation-bound MCP tools, with no builtin shell/filesystem tools and no pretend sandbox.

Add `"vscode_effort_policy": "allow-unavailable"` only after accepting that the stable API cannot verify reasoning effort. Requested effort remains recorded; confirmed effort stays null. Omission or `"require-verified"` blocks automated execution. Consent refusal, unavailable/ambiguous models, unsupported tools, configuration/catalog changes, and stale hosts also block. See the bridge guide for exact installation, enable/disable, cancellation and resumption instructions.
