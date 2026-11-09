# Native Local capability discovery: source findings

Checked 2026-11-08 for M6/M7 of the [current plan](../plans/2026-11-08-workforce-local-final-plan.md). These findings are research, not installation or runtime acceptance.

## Host-owned installation and observation

VS Code provides the Agent Customizations editor for browsing, reviewing, installing, disabling and uninstalling agent plugins. Repository/local-folder installation also has a native command. Available components depend on harness and format. Installation alone does not establish actual skill or MCP use; verify the intended component in a fresh session and inspect its actions. New marketplace trust can require a host prompt. WorkForce must preserve that boundary. [VS Code agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)

Marketplace configuration and local plugin locations are documented as experimental. The documentation distinguishes the inventories managed by native customization UI and `/plugin` commands; WorkForce must not treat those inventories as interchangeable. Project recommendations are also supported. [VS Code agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)

The checked documentation describes user installation flows. This research has not established a stable public extension API for arbitrary plugin installation or per-invocation skill activation. Command identifiers or settings used by an adapter need installed-host capability checks and versioned acceptance; reading or modifying private plugin caches is not an acceptable substitute.

The documented `vscode://chat-plugin/install` deep link does not resolve Local automation: it requires Copilot Agent Host support, installs into that harness, and always prompts for confirmation. Do not silently switch a Local request to that harness to make installation appear successful. Local source installation/registration must be tested separately. [Deep-link requirements](https://code.visualstudio.com/docs/agent-customization/agent-plugins#deep-link-requirements-and-security)

## Portable package and runtime boundaries

Agent Plugins 1.0 specifies portable skills and MCP configuration; it does not guarantee how a client exposes every component to a model. VS Code documents custom agents and hooks as client-specific components. A capability resolver must inspect actual package contents and compatible namespaces, rather than infer portability from the presence of `plugin.json`. [Agent Plugins specification](https://agent-plugins.org/specification), [VS Code authoring reference](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference)

The official extension API includes language-model provider registration and MCP definition providers. A managed gateway can supply native-picker models through the former; MCP definitions can be contributed through the latter. Neither registration is proof of successful model/tool execution. [VS Code API](https://code.visualstudio.com/api/references/vscode-api), [provider contribution](https://code.visualstudio.com/api/references/contribution-points#contributes.languageModelChatProviders)

## Implementation implications

1. Keep capability discovery/cache separate from authorization and execution. Inspect several configured sources when a domain lacks suitable cached capabilities; use package content, compatibility, license, dependencies and permissions as evidence.
2. Save a role-specific capability plan with distinct selected, installed, loaded, used and verified observations. A repository hit is only a candidate.
3. Install through a verified host adapter in permitted scope. Pin the candidate version/commit. Preserve current invocations' capability snapshots during updates or uninstall.
4. Use ordinary implementation when optional discovery or a plugin is unavailable. A missing optional plugin is not missing product input from the user.
5. Test different domains against different discovered packages. Humanizer and Ponytail are examples, not a fixed catalogue.

M6 remains incomplete until packages are actually installed/loaded/used in Local and the resulting products are independently checked. M7 additionally requires actual REA and gateway execution evidence.

## Installed-host observation and initial source comparison

Read-only public API inspection on VS Code 1.145.2 returned native plugin management commands, including `workbench.action.chat.installPluginFromSource`, `workbench.action.chat.managePlugins`, marketplace refresh and update commands. The language-model registry contains the native `skill` tool with a `skill` input, `copilot_fetchWebPage` with `urls`/`query`, and search tools. This establishes available registrations, not their permission in a particular role, argument contracts for commands, successful installation or actual skill use. The proof fixture still has plugins disabled; no marketplace was trusted or installed by this inspection. Evidence: `artifacts/workforce-native-local-proof/c3f40d36/evidence/native-capability-host-inventory.json`.

The global registry also contains historical NeoMind MCP tools. Capability assignment must preserve the native profiles' narrow tool scope; exposing every global tool would bring the old claim/record/lifecycle protocol back into workers.

Two actual catalogs were read before selecting examples:

| Source | Observed main revision | Initial findings |
| --- | --- | --- |
| [github/awesome-copilot](https://github.com/github/awesome-copilot/blob/797337f33f73e35d08d82f840e21c4b8c4932d88/.github/plugin/marketplace.json) | `797337f33f73e35d08d82f840e21c4b8c4932d88` | Documentation, frontend, testing and security candidates; both local package paths and external GitHub package references occur. |
| [github/copilot-plugins](https://github.com/github/copilot-plugins/blob/b0216dbc8f6f7ac1cfce85e925dfa5d5e423876a/.github/plugin/marketplace.json) | `b0216dbc8f6f7ac1cfce85e925dfa5d5e423876a` | Build/C++, security and domain integrations; many catalog entries refer to a separate repository, so a catalog pin alone does not pin their code. |

Four package manifests from the pinned awesome-copilot revision were inspected: `project-documenter`, `testing-automation`, `security-best-practices` and `frontend-web-dev`. They declare MIT licensing and contribute different agent/skill sets through `com.github.awesome-copilot`; this declaration still needs license-file and Local namespace verification. The documenter includes draw.io/Markdown-to-DOCX skills and is excessive for a plain text note. Testing/frontend packages share Playwright-oriented skills; the security package contributes a prompt-safety review skill. These are candidates for different tasks, not mandatory defaults or proof of suitability. No package instructions, scripts, hooks or MCP were executed during this comparison.

## Source packages versus published packages — 09/11 correction

The actual pinned `main` tree does not contain the declared package-local skill files. They are absent, not symlinks. The repository documents `com.github.awesome-copilot` as build-time composition metadata: source components live at repository root; its publishing script copies them into packages and removes that composition namespace from the served manifest. A strict reader must not silently resolve an absent package path to a guessed root skill. [Contribution layout](https://github.com/github/awesome-copilot/blob/797337f33f73e35d08d82f840e21c4b8c4932d88/CONTRIBUTING.md), [materializer](https://github.com/github/awesome-copilot/blob/797337f33f73e35d08d82f840e21c4b8c4932d88/eng/materialize-plugins.mjs), [publishing workflow](https://github.com/github/awesome-copilot/blob/797337f33f73e35d08d82f840e21c4b8c4932d88/.github/workflows/publish.yml).

The published `marketplace` branch was independently resolved to `02466d1eb70b841c90717b0fc2dc9457aa6f606f`. Its documenter and security package manifests and declared skill files are ordinary Git blobs; the served manifests omit the composition namespace. This is a separate distribution pin, not evidence that it was built from the previously inspected `main` pin. Use this complete, independently inspected package layout for host trials. No package has yet been installed or loaded by this audit.

Evidence: `marketplace-source-audit-20261109.json` and `marketplace-alias-audit-20261109.json` under the owned native fixture's evidence directory. The latter records honest `not-found` results for absent source-package paths; unit-tested symlink resolution must not be described as an observed upstream symlink chain.
