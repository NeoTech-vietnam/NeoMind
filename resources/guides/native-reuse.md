# Native Local reusable tools

WorkForce searches accepted experience and the existing procedure registry before implementation. A matching request is a useful reference; a script runs automatically only when its contract, hashes, parameters, environment, effects and qualification are current. The host runs an exact eligible procedure once, supplies its actual outcome to WF.FnD, and still requires fresh independent review and checks.

When the first request benefits from reusable tooling, deliver a generator, a distinct verifier and an ordinary file ending in `.procedure.json`. Include those files in the plan outputs or inspected context, alongside the requested product. The backend captures a valid manifest after product acceptance. An invalid optional manifest is reported as a learning issue; it does not remove the verified product or trigger model retries.

The manifest uses the existing procedure definition. Registration identity, version and author are backend-owned. For example:

```json
{
  "title": "Generate a research practice note",
  "description": "Render a supplied topic using the project note template",
  "task_family": "practice-note",
  "script": "scripts/generate-note.cjs",
  "verification_script": "scripts/check-note.cjs",
  "dependencies": ["scripts/note-template.md"],
  "parameters": {
    "destination": {"type": "string", "path": true},
    "topic": {"type": "string"}
  },
  "outputs": [{"path": "{destination}/note.md", "min_bytes": 20}],
  "environment": {"platforms": ["win32", "linux"], "clients": ["copilot"], "node_major_min": 24},
  "effects": {"write_roots": ["{destination}"], "network": false, "publication": false}
}
```

Both scripts consume one UTF-8 JSON object from stdin, followed by EOF. Task values are in `packet.parameters`; `packet.outputs` is an array of resolved path strings, not objects with a `path` property. The backend supplies the actual example in each native tool-building handoff. The same packet is supplied to both scripts. `schema_version` identifies the supported envelope; `request_id`, `procedure_id` and `version` are backend metadata which scripts may ignore. They are not application inputs or credentials to authenticate. Emit concise diagnostics and return a nonzero exit status for a real failure. Generation must preserve existing files and stay within declared effects; verification must independently reject incorrect output.

Manifest `outputs` are future generated products, not the tooling files being delivered now. Explicitly declare template/import dependencies so their hashes are pinned. Only the existing Node `.mjs`/`.cjs` procedure runner is supported; arbitrary project scripts can still be used directly by ordinary implementation.

Capture creates a candidate, with no fabricated review or execution history. Automatic reuse still requires independent passing contract review with negative-case evidence and three successful actual process runs covering at least two non-destination parameter sets. Existing qualifications are preserved. Scripts run as the current OS user; effect declarations are not an OS sandbox.
