# Upstream agent and skill reuse

NeoMind can discover popular GitHub projects, track an exact source commit, cache it without checking out or executing its code, and supply selected upstream instruction text to a NeoMind role. NeoMind retains orchestration, model routing, task scope and capability controls.

`neomind upstream` and the matching `upstream_*` MCP tools provide this workflow. Remote discovery, first-time caching and remote checks honor `.neomind/automation.json` `network_policy`. Under `local-only`, use existing verified caches; opt in to `remote-enabled` when remote research is intended. No recurring app automation is created by these commands.

## Discover and select

```powershell
neomind upstream discover --data '{"query":"agent skills","min_stars":1000,"limit":10}'
neomind upstream list
```

Stars qualify candidates for inspection. Inspect license, maintenance, format, runtime requirements and relevance before selecting a source. GitHub rate-limit or network errors are reported without adopting anything. The persistent discovery default is `minimum_stars` in `.neomind/upstreams.json` (1000 when absent); `min_stars` overrides it for one search or track operation.

Track with a project-owned ID, a branch to follow, and optionally an exact initial commit. Choose explicit `SKILL.md` or `*.agent.md` paths. Leaving the path list empty caches a source for inspection without adding guidance to a role. The cache command returns up to 256 available instruction paths.

```powershell
neomind upstream track --data '{"id":"rea","repository":"morluto/rea","ref":"main","commit":"e073f64be0a5a30c32d8b3cec23f9bd411080903","role":"researcher","instructions":[".agents/skills/reverse-engineer-anything/SKILL.md"]}'
neomind upstream clone rea
neomind upstream instructions rea
neomind update
```

This REA seed was verified on 23 October 2026. It is an example to inspect, not an automatic installation. [REA findings](research/rea-adoption.md) explain the observed popularity, MIT license, runtime requirements and integration limits. Track preserves GitHub metadata and license attribution, but does not perform a full license review.

## Check and adopt updates

```powershell
neomind upstream check rea
neomind upstream watch --wait-ms 900000
```

A check updates `latest_commit`, metadata and observation time while preserving `commit` and instruction hashes. Inspect the candidate changes, then adopt the exact candidate with the current expected pin:

```powershell
neomind upstream adopt rea --data '{"expected_commit":"CURRENT_40_CHARACTER_SHA","commit":"CANDIDATE_40_CHARACTER_SHA"}'
```

Both values must be real complete lowercase commit SHAs. Adoption can include an `instructions` array to change the selected paths. It fetches and validates the candidate before replacing the pin; a missing file, changed expected pin or failed fetch preserves the previous adoption. Previous commits remain in `previous_commits` and in cache. To roll back, explicitly adopt a previous commit using the current expected pin.

After initial caching or adoption, run `neomind update` and inspect any conflict candidates before starting a new native Copilot agent. The source commands update the registry and cache; they do not regenerate existing agent files. Strict bridge invocations read verified guidance at invocation construction. An editor conversation that is already open does not gain new guidance automatically.

`watch` runs continuously while its process stays open. It immediately checks all tracked sources, then polls every 15 minutes by default (minimum one minute). It reloads the tracked source list on each tick, so added sources are included. After the first observation it reports changed heads, update status, failures or recovery; unchanged observations stay quiet. Stop with Ctrl+C. The watcher records candidate changes and never adopts them silently. Have the orchestrator inspect and explicitly adopt suitable changes within the authorized scope. This is a deterministic process watcher, independent of Codex app automations.

Instruction mutations use the same `native-dispatch` operation lock as signed dispatch, then the upstream registry lock. They refuse active native receipts. Remote observation alone can continue while an invocation runs. Strict routing records an optional hash of the adopted instruction projection; ordinary metadata checks do not change that projection. Existing receipts without upstream configuration retain their old shape.

## How reuse works

The registry is `.neomind/upstreams.json`; immutable source caches live under `.neomind/cache/upstreams/<id>/<commit>/repository.git`. NeoMind uses bare Git, disables hooks and inherited Git configuration, fetches a full pinned commit through an HTTPS GitHub URL, and reads selected blobs without checkout, submodules, install scripts or a source runtime. It never runs upstream setup or copies upstream tool grants into its own capability policy.

Each selected file has its Git blob identity, SHA-256 and byte count in the project registry. Reads verify those hashes again. Symlink entries and path traversal are rejected. A file may be at most 128 KiB; combined selected guidance is at most 384 KiB with at most 24 files. Imported text is UTF-8. The role prompt is at most 16 KiB and labels excerpts or omitted files. `upstream_instructions` returns the full bounded verified text with provenance when needed.

An upstream agent file becomes supplemental guidance for the selected existing NeoMind role. Its model, tools, delegation rules and setup commands are not promoted to NeoMind policy. Relative reference links remain unresolved until separately retrieved and verified. In particular, REA's main skill references additional guides; this first importer selects instruction entrypoints and does not claim those referenced guides are bundled.

REA's external MCP runtime remains planned. Its npm package, native engines, MCP session lifetime and actual tool availability require a separate adapter and live acceptance tests. Source skill reuse alone does not provide REA tools or prove binary-analysis capability.

## Library contract

All operations accept the project root first. Remote operations return Promises; local reads are synchronous.

| Function | Purpose |
| --- | --- |
| `listUpstreams(root)` | Read validated registry; an absent registry returns an empty default. |
| `discoverUpstreams(root, {query, min_stars?, limit?}, deps?)` | Query GitHub, return eligible metadata, adopt nothing. |
| `trackUpstream(root, {id, repository, ref?, commit?, role?, instructions?, min_stars?}, deps?)` | Resolve a commit and add a new tracked ID. |
| `cloneUpstream(root, id, deps?)` | Cache the adopted commit and record selected instruction hashes. |
| `checkUpstream(root, id, deps?)` | Record current head and `update_available`, preserve adoption. |
| `watchUpstreams(root, {interval_ms?, signal?}, deps?)` | Async generator: immediate checks, quiet unchanged polls, bounded events and prompt cancellation. |
| `adoptUpstreamUpdate(root, id, {expected_commit, commit, instructions?}, deps?)` | Cache and validate a candidate; compare current pin before replacing it. |
| `readUpstreamInstructions(root, id)` | Read full verified text, provenance and a supplemental prompt wrapper. |
| `readRoleUpstreamInstructions(root, role)` | Build bounded verified guidance for matching role sources. |

`UpstreamDependencies` injects trusted HTTP and Git transports for tests. Dependencies are code-level test seams and are never read from project JSON or upstream content. Production operations require Git on PATH. The current tracker targets public GitHub repositories; it does not configure GitHub credentials or install source dependencies. The watcher requires its CLI process or another generator consumer to remain running; it is not registered as an operating-system service.
