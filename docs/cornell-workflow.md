# Research notes, practice and publication

NeoMind turns supplied research into the existing Cornell note format. Each research input binds one current requirement revision to an abstract, learning objectives, methods, explanations, results, discussion, worked example, research questions, practice and reference answers. The compiler arranges and validates that material; the agent or author supplies the research and sources.

The resulting `note.md`, `exercises.md` and `answers.md` remain ordinary readable project files. Questions use Q1-style IDs, practice uses P1-style IDs, and both map to O1-style objectives. Every objective needs an assessment. Reference answers stay separate so the learner can attempt the exercise first. An optional solution file belongs to the learner and remains untouched.

## Prepare and generate

Start from the saved requirement and its actual revision. Use one input per requirement and an unused visible `output_dir`. All paths inside the research input are relative to the source project. This reduced example illustrates the complete required shape; replace the record IDs and revision with the saved project values before using it:

```json
{
  "schema_version": 1,
  "requirement_id": "PROJECT-REQ-0001",
  "expected_requirement_revision": 1,
  "workflow_id": "PROJECT-KNW-0001",
  "topic": "Counting a finite Cartesian product",
  "date": "2026-10-24",
  "output_dir": "docs/research/cartesian-product",
  "context": "Count ordered pairs chosen from two finite sets.",
  "constraints": ["Elements are distinct and order between the two sets matters."],
  "abstract": "Enumerating ordered pairs explains why finite set sizes multiply [S1].",
  "learning_objectives": [
    {"id": "O1", "text": "Enumerate the pairs and explain the resulting count."}
  ],
  "methods": "[inferred] Enumerate each row independently and compare row lengths [S1].",
  "explanations": [
    {"heading": "Pairs and multiplication", "body": "[inferred] Each first-set element pairs with every second-set element [S1]."}
  ],
  "results": "[expected] Three letters and two digits give six ordered pairs [S1].",
  "discussion": "[inferred] This finite example depends on distinct elements and ordered choices [S1].",
  "questions": [
    {"id": "Q1", "prompt": "Why does each row contain the same number of pairs?", "objective_ids": ["O1"], "answer": "Each row pairs one letter with every digit, so all rows have equal length [S1]."}
  ],
  "worked_example": {
    "body": "Enumerate (a,1), (a,2), (b,1), (b,2), (c,1) and (c,2).",
    "expected": "The explicit list contains six distinct ordered pairs."
  },
  "practice": {
    "questions": [
      {"id": "P1", "prompt": "List and count the pairs for four letters and two digits.", "objective_ids": ["O1"], "answer": "Four rows with two pairs each give eight ordered pairs [S1]."}
    ],
    "procedure": ["Write the two sets separately, then enumerate all ordered pairs.", "Compare the count with multiplication and explain why it agrees."],
    "solution_path": "docs/research/cartesian-product/my-solution.md"
  },
  "sources": [
    {"id": "S1", "title": "Saved finite-product research requirement", "uri": "record:PROJECT-REQ-0001", "record_id": "PROJECT-REQ-0001", "retrieved_at": "2026-10-24T00:00:00Z"}
  ],
  "failure_cases": ["Repeated elements or unordered choices require a different counting model."],
  "summary": "A rectangular enumeration explains multiplication for two finite sets."
}
```

This teaching example cites its saved requirement as its scope source. For substantive research, collect the actual primary references and cite the sources that support each claim. Sources may be project files, saved records or HTTPS references. Local files and records are fingerprinted; an HTTPS citation records retrieval metadata and does not prove that the remote content was fetched or verified. Unknown source IDs, duplicate IDs, missing answers, unmapped objectives, placeholders and stale requirement revisions are rejected.

Save the authored input as `research.json`, then inspect the compiled note envelope before preparing records:

```powershell
neomind cornell compile --data-file research.json
neomind cornell prepare --data-file research.json
```

`compile` is read-only. `prepare` calls the existing `cornell-evidence-note` recipe and returns its instance, design, task and check bindings. Obtain the existing required design/check reviews, start the assigned task, and run that saved instance through `recipe_run` or the existing recipe CLI. It generates the note and format evidence under the normal workflow gates. Identical preparation reuses the saved recipe; a generated note is reused only while its validation remains current.

MCP offers read-only `cornell_research_compile`, which returns `recipe_input`. Pass that envelope to the existing `recipe_prepare`, then use `recipe_run` after the normal reviews and task gates. Mutation stays behind the existing Cornell ownership rules; strict workflows retain invocation-bound authorization. The CLI `cornell prepare` provides deterministic preparation/reuse directly. The original `note_create` and `note_validate` paths and legacy Cornell inputs remain supported.

For executable practice, supply `practice.command`, an argument array such as `["node", "examples/count-pairs.mjs"]`. Supply `practice.procedure` for descriptive steps, or provide both: the compiler keeps the runnable command and renders every supplied step in the exercise. At least one form is required. Preparation and format validation execute neither form. Complete discussion of TODO or placeholder validation is allowed; unfinished markers and unexpanded templates are rejected. An observed worked result still requires actual passing evidence; expected results and supplied reference answers cannot establish execution, independent correctness or learner completion.

## Preview a local notes copy

The default destination is `00_note/NeoMind` beneath the current project. Configure an existing external notes repository explicitly when needed. Configuration is stored locally in `.neomind/cornell.json`; this example chooses a repository without embedding a personal machine path in the shared project:

```powershell
neomind cornell destination
neomind cornell configure --data '{"notes_root":"D:/workspace/MyNotes","directory":"00_note/NeoMind"}'
neomind cornell export-plan --data '{"note_id":"PROJECT-KNW-0002","expected_revision":1}'
```

The preview contains exact destination paths, bytes, hashes and provenance. It creates no files in the destination. An unreviewed or stale note produces a concrete **blocked** preview, including the reason. Apply requires a currently validated note, current independent review and same-workflow requirement links. Review the actual generated narrative and answers before applying the saved plan:

```powershell
neomind cornell export-apply --data '{"plan_hash":"<export-plan-sha256>"}'
```

A copy uses a new revision directory beneath `00_note/NeoMind/<project>/<requirement>/<note>/`. It preserves the source relative tree so note, exercise and answer links continue to resolve. The bundle includes an entry README and provenance, while the source project keeps the export plan and receipt. Machine-local destination configuration is excluded from the bundle provenance.

Generated note, exercise and answer artifacts are included by default. Authored solutions stay in the source workspace. Explicit `include_paths` on `export-plan` can include selected visible project files, such as a public runnable example or a solution the user has chosen to share. Missing local link dependencies block the plan until explicitly included. Managed directories, linked paths and recognized sensitive filenames are refused. Review included contents for private material; filename screening does not establish public safety.

Apply rechecks the source note, requirement fingerprints, independent review, configuration and target hashes. Existing target directories are preserved. A completed identical apply is idempotent; an interrupted owned copy can resume only while its existing files match the recorded hashes. Any authored changes remain untouched. The operation uses multiple exclusive file writes with a recovery receipt rather than a filesystem transaction. Source changes require a fresh preview and reviewed revision; copying a bundle adds no acceptance or execution evidence.

## Preview and push a separate branch

Remote publication is an explicit CLI operation. First complete and verify the local copy, configure the intended Git remote and author in the notes repository, and explicitly enable the source project's existing `remote-enabled` policy. The destination must already belong to a Git repository. Choose the remote name and base branch:

```powershell
neomind cornell publish-plan --data '{"plan_hash":"<export-plan-sha256>","remote":"origin","base_branch":"main"}'
```

This prepares the exact commit, changed paths, diff summary and new `codex/neomind-notes/...` branch. It reads the chosen remote base and constructs the commit in a temporary bare repository with an isolated index. Review the resulting files and diff before the explicit push:

```powershell
neomind cornell publish --data '{"publication_hash":"<publication-plan-sha256>"}'
```

Only that planned bundle is pushed. The user's worktree, existing index, local branch and unrelated staged, unstaged or untracked notes remain untouched. The publisher executes no checkout filters or repository hooks. It checks the remote URL, Git identity, source/export hashes and remote base again, and uses create-only branch publication. An advanced base, changed content or different existing branch blocks the push. A verified retry of the same published commit returns the same receipt.

The result includes the branch and commit, plus a compare URL for supported GitHub remotes. Creating a PR, merging, pushing the default branch and committing unrelated work remain separate actions. No agent-facing MCP operation pushes notes automatically. Supported remotes are configured HTTPS/SSH URLs without embedded credentials or URL parameters, or an explicit local Git repository path. Git credential helpers or SSH handle authentication; a missing noninteractive credential is a blocker.

## Implementation and limits

`compileCornellResearch` builds `CornellInput` and `RecipeInput`; `prepareCornellResearch` reuses the existing recipe engine. `prepareCornellExport` / `applyCornellExport` handle hash-checked local copies. `prepareCornellPublication` / `publishCornellExport` handle the isolated Git branch workflow. Existing note history, source freshness and engineering gates remain authoritative.

Inputs are capped at 512 KiB. Export previews contain at most 100 files, 2 MiB per file and 8 MiB total; explicit additional paths are capped at 64. Git operations have time and output limits. Sources and generated prose still require independent semantic review. HTTPS citations retain a retrieval snapshot rather than ongoing remote verification. The publisher creates a review branch and does not provide PR review, remote acceptance or conflict resolution.

Focused regression coverage is in `test/cornell-workflow.test.mjs`, `test/cornell-publication.test.mjs` and the existing `test/notes.test.mjs` / `test/recipes.test.mjs` suites.
