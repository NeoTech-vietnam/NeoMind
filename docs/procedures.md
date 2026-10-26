# Reusable project automation

NeoMind can discover existing scripts, register versioned procedures, index their capabilities with SQLite/FTS5, review and pilot them, and reuse eligible procedures for compatible typed requests. This complements the three built-in engineering recipes. A project registry can register new automation without changing NeoMind's source catalog.

In VS Code, choose **NeoMind: Open Automation Library**, or **Automation** in the Universe. The library shows script paths, versions, qualification, review/run counts and suspension reasons. Discover executes nothing. Register selects a project JSON manifest. Check eligibility evaluates existing evidence; it cannot manufacture missing review or pilot runs. Suspend prevents future automatic use.

## First request

The Coordinator searches existing tools first. The assigned worker reuses one or creates a parameterized Node script and independent verification script. Register the files as a candidate with a manifest. The normal editor creates script content; the database indexes it and the runner executes only reviewed versions. Existing Cornell generation/export tools remain the formatting authority; a new subject still needs fresh content reasoning and verification.

Registration through an authenticated native MCP assignment also saves an idempotent `procedure-candidate` knowledge record linking the manifest contract to its originating workflow/task and actual reported actor. This preserves the first procedure's traceability without rewriting its historical engineering records. Direct local CLI registration remains explicit operator administration.

```powershell
neomind procedure discover --project D:\workspace\NeoLearning
neomind procedure register --data-file procedure.json --project D:\workspace\NeoLearning
neomind procedure list --project D:\workspace\NeoLearning
```

Registration input includes `id`, `version`, `title`, `description`, `task_family`, `keywords`, `author`, project-relative `script` and `verification_script`, typed `parameters`, declared `dependencies`, `outputs`, `environment`, `effects`, and optional timeout/output limits. Scripts receive JSON on stdin: `{schema_version, request_id, procedure_id, version, parameters, outputs}`. The runner uses Node directly with no shell interpolation. Check scripts receive the same packet and exit nonzero on failure. Environment credentials and Node preload options are not forwarded.

Example manifest:

```json
{
  "id": "cornell-artifact-inventory",
  "version": "1.0.0",
  "title": "Inventory Cornell learning artifacts",
  "description": "Record current note, practice and answer hashes without changing their content.",
  "task_family": "cornell-inventory",
  "keywords": ["cornell", "notes", "inventory", "ghi chu"],
  "author": "actual-producer-identity",
  "script": "scripts/automation/cornell-inventory.mjs",
  "verification_script": "scripts/automation/cornell-inventory-check.mjs",
  "parameters": {
    "note": {"type": "string", "required": true, "path": true},
    "practice": {"type": "string", "required": true, "path": true},
    "answers": {"type": "string", "required": true, "path": true},
    "output": {"type": "string", "required": true, "path": true},
    "include_bytes": {"type": "boolean", "default": true}
  },
  "outputs": [{"path": "{output}", "min_bytes": 100}],
  "environment": {"platforms": ["win32", "linux", "darwin"], "clients": ["codex", "copilot", "cli"], "node_major_min": 24},
  "effects": {"write_roots": ["{output}"], "network": false, "publication": false}
}
```

Working scripts are in `examples/procedures`. Copy them to the manifest paths through the normal project change process. They audit an existing note/practice/answers bundle; they do not claim semantic approval or change the Cornell format. The inventory and check refuse overwrite and validate actual bytes. Registering a manifest leaves it a candidate.

## Qualification and later requests

An independent Reviewer records its identity, pass/fail rationale and actual negative-case evidence through `procedure review ID --data-file review.json`. The runner permits reviewed pilots. A pilot input specifies `parameters`, unique `request_id`, actual `actor`, `client`, `mode: "pilot"`, and `authorized_effects` containing explicit write roots and network/publication permission. Use `observation: "fixture"` for synthetic fixtures. Qualify with `procedure qualify ID --data '{"actor":"coordinator"}'` after three checked real local-process runs over at least two substantive parameter sets; changing only output destinations does not supply another variant. Local review identities are unsigned declarations; qualification does not attest separate native processes.

For a later request:

```json
{
  "request": "Inventory this Cornell note and its practice and answers",
  "request_id": "inventory-learning-bundle-004",
  "intent_id": "cornell-inventory",
  "parameters": {
    "note": "00_note/NeoMind/topic.md",
    "practice": "00_note/NeoMind/topic-practice.md",
    "answers": "00_note/NeoMind/topic-answers.md",
    "output": "00_note/NeoMind/inventory-004.json"
  },
  "environment": {"client": "cli"},
  "scope": {"allowed_paths": ["00_note/NeoMind"], "network": false, "publication": false}
}
```

Run `neomind work prepare --data-file request.json` for the compact `exact`, `adapt`, `new` or `blocked` explanation. For explicit automatic mechanical execution, add `actor` and `authorized_effects` to that input and use `work run`. Only an eligible compatible match executes. Otherwise it returns `executed: false` and the expert/prerequisite action. Match quality depends on supplying the real intent, required outputs and constraints; lexical similarity cannot verify every requirement in arbitrary prose.

## Integrity and recovery

The runner preserves pre-existing outputs, pins script/check/dependency hashes, records each request before side effects, and refuses conflicting retries. After an interrupted uncertain run, inspect its effects and prepare a newly reviewed version or perform explicit manual recovery; there is no automatic same-version uncertainty reset. A saved successful retry revalidates its outputs and returns historical execution with `replayed: true`; the `work run` wrapper also returns `executed: false`. This is not a fresh pass. Drift, failed checks and invalid review evidence prevent qualification/reuse. Updating a script requires a new immutable version and fresh review.

Trusted local scripts run with the operating-system user's filesystem and network access. Declared effects constrain dispatch but do not create a sandbox; actual client trust and host permissions remain authoritative. Match-based automatic execution requires the Coordinator to supply an explicit `intent_id` or `procedure_id`, typed parameters and authorized effects after accounting for the request's semantic constraints.

Canonical manifests, review evidence references and run records live under `.neomind/procedures`; they survive SQLite rebuilds. Search projections live in `.neomind/cache/procedures.sqlite`. Corruption produces an actionable repair error; `neomind procedure index` rebuilds explicitly. Local initialization continues to use `.git/info/exclude` and leaves `.gitignore` untouched.

Codex and Copilot receive the same MCP interfaces and client-specific generated guidance. Full native assignments use `assignment_open`, derived context/progress and typed results to avoid manually constructing IDs and protected lifecycle patches. Full/strict gates remain mandatory. In-memory MCP and subprocess tests verify these interfaces; actual editor launch/trust/model observations remain separate evidence.
