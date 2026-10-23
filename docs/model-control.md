# Per-role models and the local 9router endpoint

NeoMind keeps model policy in `.neomind/routing.json`. `strong_model`, `worker_models`, and tier effort/provider settings remain defaults. Optional `role_models` overrides select a model for one role:

```json
{
  "role_models": {
    "developer": { "model": "provider/model-id", "provider": "9Router", "effort": "low" },
    "reviewer": { "model": "another-model-id", "provider": "copilot", "effort": "high" }
  }
}
```

Merge this fragment into a complete routing policy. Each override has one model; roles without an override retain the ordered tier model list. Effort records a request. The stable VS Code bridge continues to record confirmed effort as unavailable under the explicit `allow-unavailable` policy.

Strict bridge invocations select all 12 core roles independently. The six generated Copilot agents combine some core roles and select their representative role's model: Manager uses `manager`, SWSD uses `requirements`, P-RES uses `architect`, FnD uses `developer`, Reviewer uses `reviewer`, and Tester uses `check-executor`. A merged agent cannot change models when it performs another core responsibility inside the same editor conversation.

The model-control operation requires `.neomind/routing.json` `language_models_file` for custom providers, verifies the selection against that catalog, preserves exact vendor/ID identity and rejects ambiguous entries. Registering a custom endpoint in VS Code or receiving an ID from `router models` does not populate this catalog automatically. The operation stores the canonical model ID and extracts no credentials. Copilot IDs are verified when the editor selects a live model. An unavailable or ambiguous live model still blocks execution.

Policy edits apply to **new invocations**. The model-control operation refuses an edit while any signed invocation is starting, running, or waiting for native permission, because a configuration change would invalidate that invocation's hashes. Interrupt or reconcile the current invocation before switching. Completed receipts remain historical records; edited routing can make them stale for current acceptance. The CLI setter and monitor attempt conflict-aware agent regeneration after saving policy; inspect their refresh results and any review candidates. Direct routing edits or calls to `setRoleModel` require `neomind update` before generated native agents use the new selection. A successful policy write can coexist with an adapter-refresh blocker.

## Configure the gateway

Start and configure a separate 9router service, then register it in VS Code's **Manage Language Models → Add Models → Custom Endpoint**. Use Chat Completions with endpoint `http://127.0.0.1:20128/v1` and the exact IDs exposed by that instance. Keep provider account management and credentials in 9router/VS Code. [Official VS Code model configuration](https://code.visualstudio.com/docs/agent-customization/language-models), [9router research and embedding plan](research/9router-integration.md).

Before `models set --provider 9Router`, set `language_models_file` in the complete routing policy to your existing VS Code catalog and ensure its `9Router` group contains the intended exact ID/vendor entry. See [model routing and catalog resolution](model-routing.md). Router configuration alone does not configure this prerequisite.

Copy [the example configuration](../examples/9router.json) to `.neomind/router.json`, or use the NeoMind router configuration command. This file accepts only:

| Field | Meaning |
| --- | --- |
| `schema_version` | `1` |
| `base_url` | Local HTTP origin, optionally ending in `/v1`; default example uses port 20128. |
| `api_key_env` | Process environment variable containing the inference key; default `NEOMIND_ROUTER_API_KEY`. |
| `catalog_provider` | VS Code catalog group name; default `9Router`. Select this provider when assigning a custom model. |

```powershell
neomind router configure --base-url http://127.0.0.1:20128/v1
neomind router health
neomind router models
neomind models status
neomind models set --role developer --model provider/model-id --provider 9Router --effort low
neomind update
neomind router probe --model provider/model-id
```

For CLI diagnostics, make the key available to the NeoMind process through the named environment variable. No key value is written to routing/configuration files or diagnostic results. If the variable is absent, diagnostics send no key; a server requiring authentication responds with a visible HTTP refusal. Invalid credentials are never retried as anonymous access. The editor bridge uses the editor's separately configured endpoint secret.

Diagnostics call `GET /api/health`, `GET /v1/models`, and a bounded `POST /v1/chat/completions` probe. Model discovery returns safe ID/owner metadata. The probe can consume provider tokens and reports the requested alias, response model, and completion status. Health and catalog discovery do not prove usable provider access. Probe results do not attest reasoning effort, tool authorization, sandboxing, or exact backend identity.

## Programmatic API

```javascript
import {
  configureRouter, modelControlStatus, setRoleModel,
  routerHealth, routerModels, routerProbe,
} from 'neomind';

configureRouter(projectRoot, { base_url: 'http://127.0.0.1:20128/v1' });
await routerHealth(projectRoot);
const models = await routerModels(projectRoot);
setRoleModel(projectRoot, {
  role: 'developer', model: models[0].id, provider: '9Router', effort: 'low',
});
const status = modelControlStatus(projectRoot);
const diagnostic = await routerProbe(projectRoot, models[0].id);
```

Use a model that is also registered in the configured VS Code catalog. The API does not silently add router IDs to that catalog. After this direct API example, run `neomind update` and resolve its conflict candidates before starting a generated native agent. Model policy selection remains separate from installation, editor consent, live inference, and task acceptance.

The current integration connects to a user-managed service. Bundling/launching 9router and a direct HTTP agent executor remain planned phases in the [integration research](research/9router-integration.md).
