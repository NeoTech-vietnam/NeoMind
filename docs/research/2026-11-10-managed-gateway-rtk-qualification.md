# Managed gateway RTK: controls and bounded qualification

WorkForce reuses RTK from the exact published `9router@0.5.116` closure, source
commit `1339107e624d1ab150c6a0c2c2ee22caa7e9db2f`. It does not implement another
compressor or infer billed-token savings from output length.

## Upstream behavior

- [`compressMessages`](https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/rtk/index.js)
  changes tool-result text in the request sent to the model. It does not compress
  ordinary system/user messages through this function.
- [`chatCore`](https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/handlers/chatCore.js)
  checks `settings.rtkEnabled` and the per-request
  `x-9router-token-saver: off` opt-out. The opt-out also disables other upstream
  token savers for that call.
- The pinned
  [`build-output` filter](https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/rtk/filters/buildOutput.js)
  retains a finite set of npm/cargo/Maven diagnostic patterns. This does not
  establish preservation of arbitrary C compiler, assertion or acceptance text.

## Product policy

The native host reads the machine/User setting `workforce.gateway.tokenSaving`.
The client accepts `off` or `upstream-rtk`, defaulting to `off`. WorkForce sends
the original native messages and tool results unchanged to the gateway.

Only tool results consisting entirely of recognized `Compiling`, `Downloading`
or `Fetching` progress lines qualify for the upstream RTK opt-in. Diagnostics,
assertions, acceptance/check/evidence markers, source text, mixed prose, unknown
tool shapes and media force the opt-out. System/user criteria are retained.
This conservative classifier is not a semantic guarantee for arbitrary text;
unqualified input takes the ordinary uncompressed path.

`configureTokenSaving(mode, expectedFingerprint?)` changes only the owned
gateway's RTK setting. It checks the current policy fingerprint, an exclusive
private control lock, service generation and active leases. A pending optional
change, active invocation, changed policy, other upstream saver or unavailable
administrative control produces `effective: off` with truthful deferred
metadata. It does not block delivery solely to enable compression, replay a
model request, alter an active call's configuration or replace other settings.
The selected effective mode belongs to the next invocation's lease.

The client emits hashes, byte counts and the selected policy. Actual outbound
compressed size is unknown in ordinary model calls; reported gateway usage is
separate. Raw engineering evidence remains authoritative. The independent
before/after assessor checks explicitly marked diagnostics and acceptance
lines; it does not claim universal equivalence.

## Qualification

`test/managed-gateway-service.test.mjs` installs and launches the real verified
published standalone service, then connects an owned local deterministic HTTP
fixture through its ordinary compatible-provider API. It checks:

1. RTK off preserves the original tool-result bytes.
2. The actual upstream RTK reduces qualified progress output with RTK enabled.
3. Compiler errors, assertions and acceptance evidence use the guarded opt-out
   and remain byte-for-byte intact.
4. An intentionally unguarded request to this fake provider exposes dropped
   diagnostic markers, which the independent assessor rejects.
5. Active leases defer a policy change, and a stale fingerprint cannot mutate
   the policy. No actual model, provider account or paid inference is used.

These checks measure bytes, not tokens or model quality. Provider-free fixture
qualification is separate from real account authentication and native model
execution. The post-prepack CI step runs this service test on Windows and Ubuntu
with `WF_REQUIRE_GATEWAY_ARCHIVE=1`, so a missing pinned archive fails rather
than silently skipping qualification.

Observed local run on 2026-11-10, Windows with Node **24.18.0**:

| Observation | Actual result |
| --- | --- |
| Published standalone service test | 1 passed, 0 failed, 0 skipped; 202.1 seconds including private archive installation/copy |
| Qualified synthetic progress text | **8,590 → 21 bytes**, 8,569 bytes removed by the actual upstream RTK |
| Guarded compiler/assertion/acceptance text | Original tool-result bytes preserved exactly |
| Intentionally unguarded negative control | Two dropped diagnostic markers detected; the final assessor additionally protects acceptance/evidence/verdict lines |
| Real model/account inference | **None**; owned deterministic HTTP fixture only |
| Billed token savings | **Not measured** |

The retained local log is
`artifacts/managed-gateway-rtk-service-proof-20261110.log`. The final acceptance
line-assessor addition followed that process's module load; its focused negative
control passed, and final Windows/Ubuntu CI must qualify the complete final
source. These measurements do not establish savings on ordinary user requests.
