# REA skills and MCP

NeoMind can reuse the published `rea-agents@6.7.0` MCP server and its original `reverse-engineer-anything` skill, six reference guides and MIT notice. REA is optional and disabled by default. It supplies specialist reverse engineering tools; NeoMind retains its profiles, model routing, workflow gates and evidence ownership. Ordinary source architecture work should use normal repository tools first. [REA installation](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/docs/installation.md)

## Configure the reviewed package

Use the supported NeoMind Node CLI in an initialized project. The published pin accepts Node `^22.19.0 || ^24.11.0 || >=26.0.0`; NeoMind itself requires Node 24 or 26+. The project policy must permit a remote package download, or the verified installation must already be cached. Local-only policy refuses downloads.

```powershell
neomind rea status --project D:/path/to/project
neomind rea configure --data '{"enabled":true,"install":true}' --project D:/path/to/project
neomind rea probe --project D:/path/to/project
neomind update --project D:/path/to/project
```

Configuration installs only the fixed reviewed version, with lifecycle scripts disabled, and checks its SHA-512 package integrity and dependency baseline. It records the actual CLI Node launcher, entry-file hash and original skill-file hashes in `.neomind/rea.json`. It never chooses an arbitrary package or command from a target's output. Active or malformed native receipts block configuration changes. A changed entry or skill cannot be silently accepted by reconfiguring it.

`configure` performs a target-free probe when the pinned installation is available. A later `probe` refreshes the saved observations; run `update` afterward to regenerate native tool entries. `status` reads saved configuration and observations without launching a server. To disable the integration, use the same configure command with `{"enabled":false}`, then run `update`. Edited managed files are preserved as review candidates under the existing installer rules.

No Marketplace account, model inference or 9router key is needed for these checks. REA does not select a model; the existing NeoMind model policy remains responsible for agents that use it.

## Original skill and direct registration

Generated platform skills retain the upstream name and exact UTF-8 bytes, including BOM/newlines, relative reference files and license. `ORIGIN.json` records the package version and integrity. npm supplies no `gitHead` for this release, so NeoMind does not assert that its bundled skill equals an arbitrary repository commit. The published skill and its references are used together with the matching runtime.

Ready registration resolves the verified installed script and passes `mcp` to it over stdio. The source [server manifest](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/server.json) documents that transport and argument. Workspace integrations generate direct MCP configuration; local Copilot mode supplies registration examples and leaves user-profile installation to its existing flow. Codex uses the parent MCP stanza, rather than unsupported per-agent server overrides.

Researcher and Explorer/codebase-analyst profiles receive the reviewed static tool subset. Native direct MCP calls follow the client's actual permissions and remain unsigned. Their registration does not create signed NeoMind receipts, and inherited client tools may have broader permissions than the strict gateway.

## Strict gateway contract

The existing `capability_resolve` and `capability_invoke` operations support provider `rea` for `researcher` and `codebase-analyst`. Invocation remains bound to a real signed receipt, the assigned role and its workflow/task. The default approved-provider list does not enable REA; explicit configuration opts in. The gateway rechecks current provider approval before connecting and before each dispatch, including existing sessions. Revocation also invalidates an invocation's saved configuration hash.

The initial reviewed subset is:

| Tool | Purpose |
| --- | --- |
| `binary_session` | Observe target-free session/server identity and availability |
| `analyze_javascript_application` | Static analysis of a selected JavaScript/Electron artifact |
| `inspect_analysis_view` | Read a view of retained Evidence from the same connection |
| `get_evidence_bundle` | Inspect that session's retained Evidence |

NeoMind initializes the actual server and discovers schemas through `tools/list`. Arguments are validated against the observed schema before dispatch; output schemas are validated on return. Unknown/unreviewed tool names are refused. Availability is separate from catalog membership: REA advertises tools whose external engines may be missing. Hopper, Ghidra, IDA and other engine/runtime prerequisites are not installed or verified by this integration. [REA MCP contracts](https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/docs/mcp-contracts.md)

Strict analysis accepts an explicit artifact directory below the project root; archive/ASAR and standalone-file inputs are unsupported by this initial gateway. It refuses hidden/private paths, dependency directories, symbolic links and special files. Initial bounds are 512 files, 8 MiB per file, 32 MiB total, 2,048 traversed entries and 32 directory levels. Source selections are regular files inside that directory. The adapter defaults to summary delivery, a 45-second provider budget and 256 MiB analyzer heap; it caps these at 45 seconds and 512 MiB, with a 60-second client deadline. Inputs are limited to 256 KiB and returned gateway results to 1 MiB. Use a smaller retained-evidence view if complete output exceeds that boundary.

REA connections persist per strict invocation, preserving retained Evidence while isolating concurrent assignments. Closing capability sessions closes their child processes. Server stderr is drained privately; router keys are not copied into the strict provider environment. Returned `isError`, partial Evidence, limitations and `_meta.provenance.untrusted_content` remain intact. Invalid arguments should be corrected against the observed schema, rather than retried unchanged. A client deadline is an unknown execution/cleanup outcome, not a successful analysis.

## Verification and updates

Focused tests exercise real stdio fixtures, schema/path rejection before dispatch, secret filtering, receipt guards, byte-preserving skills, tamper refusal and session isolation. A separate genuine npm-pinned REA smoke on Windows observed server `rea` 6.7.0 and 207 tools, analyzed an isolated two-file JavaScript application, read retained Evidence, and confirmed that another connection could not access its Evidence ID. It made no model inference request and does not establish native-engine readiness.

Git-pinned upstream skills can also be read with `readUpstreamSkillBundle`: the adopted commit, selected instruction hash, reference Git blobs and license are verified without executing source. The commit already binds its reference files, so reading a bundle does not change the adopted pin or historical receipt hash format. Missing, escaping or oversized references fail closed.

[Scheduled candidate checks](upstream-checks.md) compare source and npm updates separately. A source-head change does not silently update the installed package or original skill. Review the candidate, license and tests before changing either pin.
