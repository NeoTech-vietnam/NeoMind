# Scheduled upstream candidate checks

`scripts/check-upstreams.mjs` reads the public, versioned [watch manifest](../examples/upstream-watch.json), checks GitHub repository/head/license metadata and npm version/integrity/Node requirements, and writes JSON plus Markdown candidate reports. Discovery queries use explicit star thresholds and bounded result counts. Stars qualify a repository for research; they do not establish quality, license suitability or permission to execute it.

```powershell
node scripts/check-upstreams.mjs --manifest examples/upstream-watch.json --out artifacts/upstream-candidates/report.json
```

The checker fetches metadata only. It does not clone repositories, install packages, run upstream code, change project records or adopt pins. Source and package updates are distinct. A changed license, archived source, pinned-integrity mismatch or failed request is visible in the report; a failed check is not reported as no update. A pinned-integrity mismatch also produces a failing CLI exit code.

The manifest accepts exact GitHub owner/repository names, full commit SHAs, exact npm versions and SHA-512 integrity. Arbitrary endpoints, version ranges and unbounded discovery are rejected. Requests use fixed GitHub/npm hosts, deadlines and 2 MiB response limits. An optional `GITHUB_TOKEN` is sent only to the GitHub API; no token or provider response body is included in errors/reports. Responses marked private or non-public are refused even if that token can read them. Output contains public metadata and candidate links.

## GitHub Actions

`upstream-check.yml` runs at **03:37 UTC daily** and supports manual dispatch. Scheduled runs use `ubuntu-latest`; a manual operator can select a self-hosted Linux runner. The job has read-only repository permissions, needs no model account, installs no dependencies, and retains candidate report artifacts for 14 days, including failed checks. Official checkout/setup/upload actions are pinned to reviewed commit SHAs.

The workflow must exist on the repository's default branch before its schedule becomes active. GitHub may delay or drop scheduled jobs during high load; manual dispatch remains available. This is a periodic check, not an exact-time watcher. [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

Reports prepare evidence for a review PR. They do not automatically open/merge a PR or adopt unknown source. Review the candidate diff, license, source/package compatibility and tests, then use the existing explicit upstream adoption flow with `expected_commit` and the reviewed candidate SHA. Runtime package pins/integrities require a separate reviewed source change. Keep the previous pin/cache for rollback.

## Optional self-hosted Linux

The existing CI continues to test GitHub-hosted Windows and Ubuntu. `self-hosted-linux.yml` adds an explicitly dispatched verification job for a registered Linux x64 runner labeled `neomind-ci`. The metadata checker uses a separate `neomind-upstreams` label. Add those labels only to a runner intended for the corresponding job; no runner was provisioned or registered by this code.

Use a dedicated runner account/workspace with Git, the current GitHub Actions runner and access to the public package registries. The verification job installs locked NeoMind dependencies, runs the repository tests and checks the installed package lifecycle. It has a 45-minute deadline, read-only repository permissions and no pull-request trigger. Checkout disables persisted credentials. It does not need a local model provider or 9router service.

Self-hosted runners preserve more machine state than fresh hosted runners and require operator maintenance. Keep untrusted fork pull requests off persistent personal/project machines. GitHub's runner software does not maintain the host OS or third-party analysis engines. [Self-hosted runner responsibilities](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners), [runner security boundaries](https://docs.github.com/en/actions/concepts/security/compromised-runners)

Tests use injected public-metadata responses and validate workflow trigger/permission semantics. A real metadata-only invocation also returned a REA candidate report with zero adoptions. These checks do not prove that an organization's self-hosted runner is available or that an undispatched workflow has run.
