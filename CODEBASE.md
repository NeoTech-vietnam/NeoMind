# Repository map

- TypeScript ESM CLI/library; `package.json` exposes `dist/cli.js`, `src/cli.ts` dispatches commands, `src/index.ts` exports API, `src/mcp.ts` serves MCP.
- Core records and storage: `src/storage.ts`, engineering gates: `src/engineering.ts`, manager orchestration: `src/managed.ts` and `src/manager.ts`.
- Native bridge: `src/native.ts` speaks pinned Codex app-server RPC; `src/routing.ts` validates policy and signed receipts. `src/router-probe.ts` probes local router for diagnostics only; neither probe nor Codex proves Copilot execution.
- Project installation/adapters: `src/installer.ts`, `src/adapters.ts`, generated resources in `resources/`; `docs/`, `examples/`, `scripts/` provide documentation/pilots/utilities.
- Tests: `test/*.test.mjs` via Node test runner. `package.json` scripts: `npm run build` runs `tsc`; `npm test` builds then runs `node --test test/*.test.mjs`.
- `dist/` is build output, `node_modules/` dependencies, `artifacts/` packaging; avoid hand edits. Existing branch has user edits: preserve unrelated diffs.
- Unknown: actual Copilot runtime session/turn, sandbox and model attestation via installed SDK/CLI; require verified evidence before strict acceptance.
