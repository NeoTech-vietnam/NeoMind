---
name: langflow-design
description: Design rules for langflow workflows that spend few tokens. Use before writing, changing or reviewing a workflow in .langflow/workflows/ (ai, script, fanout, loop, gate steps), and when a run cost more than expected.
---

# Designing a langflow workflow

1. Run `langflow guide` and read the whole guide before you write or change the workflow. It is the source of the
   rules; this skill only points to it (it is installed by `langflow init` and updated with langflow).
2. Design with the guide's rules: input prepared by a `script` step and given in the prompt, each source read once,
   tools limited to the job, model and effort chosen per step, cheap guardrails with `retry_mode` resume, files
   written by `write` / `script` steps.
3. Run `langflow check <workflow> [args]`. Fix every `cost:` line, or explain in the workflow's docstring why it
   stays.
4. Before a fan-out over many items, run a pilot on one or two items, read the tokens and cost per step on the run's
   page, and write the estimate in the docstring.
5. When you tell the person what the workflow does, give the estimate and the expensive steps.
