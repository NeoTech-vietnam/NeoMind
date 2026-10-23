# REA adoption findings

Inspected on 23 October 2026 (Asia/Saigon). This is source research, not a claim that REA has executed inside NeoMind.

## What REA supplies

REA is a local reverse engineering tool server and CLI, published as `rea-agents`. It exposes artifact, binary, JavaScript/Electron, managed-code and runtime inspection capabilities through MCP. It complements an existing coding agent; it does not supply NeoMind's manager, task lifecycle or model router. The official entry points are [morluto/rea](https://github.com/morluto/rea) and [rea.tools](https://rea.tools/). Its [workflow skill](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/.agents/skills/reverse-engineer-anything/SKILL.md) explicitly routes ordinary source-repository architecture work to normal repository tools.

The [GitHub repository API](https://api.github.com/repos/morluto/rea) returned 368,420 stars and 92,298 forks at `2026-10-23T07:18:40Z`. These are a popularity snapshot, not a quality or compatibility verdict. Main was `e073f64be0a5a30c32d8b3cec23f9bd411080903`. The [npm registry](https://registry.npmjs.org/rea-agents/6.7.0) independently reported release `6.7.0`, requiring Node `^22.19.0 || ^24.11.0 || >=26.0.0`. Its package integrity was:

```text
sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==
```

The repository's package version also read `6.7.0`, but npm supplied no `gitHead`; this does not prove that current main and the published package contain identical files. Pair the published runtime with its own bundled skill when integrating it.

REA-authored code has the [MIT license](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/LICENSE), copyright 2026 morluto. Preserve that notice when copying. [Third-party notices](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/THIRD_PARTY_NOTICES.md) and separately acquired analysis engines have their own terms.

## Reuse without a fork

Use a pinned REA MCP process as an optional capability of NeoMind's researcher/codebase analyst. Keep NeoMind's role, assignment, permissions and model selection authoritative. Import the upstream workflow as attributed prompt data, with its reference files available on demand. Skill text alone cannot register a server, provide tools or prove runtime readiness. The source skill references six Markdown guides; copying only `SKILL.md` leaves those links unresolved. [Skill source](https://github.com/morluto/rea/tree/e073f64be0a5a30c32d8b3cec23f9bd411080903/.agents/skills/reverse-engineer-anything)

REA also advertises six provider-neutral [MCP prompts](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/docs/mcp-prompts.md), including feature investigation, version comparison and reconstruction verification. They are investigation guidance, not autonomous workers. NeoMind can retrieve applicable guidance while retaining its own orchestration.

Normal GitHub repositories should first use Git/source inspection. Run REA when a question actually depends on shipped artifacts, missing source, decompilation or observed application behavior. Native engines, browser connections and runtime execution have separate prerequisites. A successful source clone does not establish those prerequisites. [Installation and prerequisites](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/docs/installation.md)

## Concrete NeoMind integration seam

At inspection, `src/tools.ts` has a closed provider catalog, exact versions/integrities and per-role tool allowlists. It already checks invocation scope and records capability calls. Extend that seam for REA instead of replacing the orchestrator or copying its entire implementation. The following changes are needed before claiming integration:

1. Add a pinned optional provider and supported Node preflight. Use the installed package's trusted entry script with the `mcp` argument. Existing generic provider launch omits this argument. The official [manual registration](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/docs/installation.md#manual-mcp-registration) uses `npx -y rea-agents@6.7.0 mcp`.
2. Keep a REA process per invocation. `invokeCapability` currently keeps only Playwright persistent; other providers close after each call. REA target state and retained Evidence live on a connection. Avoid sharing one active binary between concurrent workers. Its [MCP contracts](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/docs/mcp-contracts.md) describe state, transport, discovery, cancellation and result identity.
3. Discover actual advertised tools and grant a small reviewed subset. Static artifact inspection and target execution need distinct role permissions. Capability resolution must report missing engines instead of implying that package installation proves availability.
4. Replace the gateway's fixed 60-second call deadline with bounded provider-specific controls before native analyses. Preserve REA `isError`, partial Evidence, limitations and untrusted-content provenance. Negotiate against the actual server; NeoMind and REA use different major MCP SDK packages, so protocol compatibility needs a real test.
5. Preserve upstream skill bytes. `src/adapters.ts` currently rewrites bundled Copilot skills and emits only `SKILL.md`; a dedicated imported-instruction wrapper should preserve upstream identity and describe missing references rather than passing the source through that rewrite.

The preferred first acceptance exercise is a small operator-supplied JavaScript fixture: one persistent MCP connection, discovery, static analysis, retained Evidence follow-up and cleanup. Then test two concurrent NeoMind invocations for isolation. Native-engine and Windows runtime acceptance remain separate work.

The [real upstream source smoke evidence](../validation/neomind-upstream-smoke.json) separately confirms tracking, bare caching and hash-verified role guidance for the exact REA seed on Windows. The selected skill was 31,067 bytes; the bounded role prompt explicitly reported an excerpt. A live check observed a newer head while preserving the adopted source pin. This did not install or execute the REA runtime.

## Tracking strategy

Discover repositories using configurable star thresholds, then record the exact repository, observed star count/date, license, default branch and full commit SHA. Popularity only qualifies candidates for inspection. Cache an immutable commit without running upstream setup, package scripts, hooks or submodules. Select only explicit instruction paths, hash their bytes and wrap them with source and commit provenance.

Checking for updates must record a candidate head while preserving the adopted pin. Adoption should require the expected current pin, cache and validate the candidate, and fail if another writer changed the pin. Keep the previous commit cache for rollback. Separately pin the REA npm version and integrity when its runtime adapter is implemented. Updating source instructions alone must never silently upgrade that runtime.

NeoMind's local-only network policy applies to discovery, cloning and remote update checks; verified cached instructions can still be read offline. A persistent process watcher now checks sources immediately and at a configured interval, reporting changed heads and failure transitions while preserving the adopted pins. It reloads the registry per tick and stops through cancellation. No app automation or operating-system service was registered during this work.
