# Designing a langflow workflow that spends few tokens

Read this before you write or change a workflow. `langflow guide` prints it; `langflow check <workflow>` warns
about the patterns marked **[check]**.

## Where the tokens go

Every `ai` step is one agent session (`claude -p`, `codex exec`, OpenCode). The agent works in turns, and every
turn sends the whole conversation so far again. Most of it comes from the prompt cache, so one turn is cheap, but the
total grows with the number of turns times the size of the context:

```
step = background context (system prompt, project instructions, hook output, skills, your prompt)
       ──> turn 1: search ──> turn 2: read a file ──> turn 3: read more ──> ... ──> answer
           every turn re-sends everything before it (cache read); every new file is written to the cache once
```

A measured run (2026-11-18): a fan-out of 17 Claude Sonnet workers at effort `high`, each told to "read what you
need" from a change list, a requirements document and the source code, cost USD 27.4:

| Kind | Tokens | Cost at Sonnet prices |
|---|---:|---:|
| Cache read (context re-sent each turn) | 74.6 M | about USD 7.5 |
| Cache write (new files and answers added to the context) | 3.0 M | about USD 7.6 |
| Output (answers and thinking at effort `high`) | 0.77 M | about USD 7.7 |

Each worker re-read the same three sources by itself (1.8 to 6.5 M cache-read tokens per worker) and wrote 32 to
58 k output tokens, most of it thinking. Guardrail retries started from scratch and read everything again.

So the cost of a step depends on **how much it reads**, **how many turns it takes**, **how many times the same
reading is repeated across steps**, and **how much it thinks**. The rules below act on these four.

## Rules

1. **Prepare the input in a `script` step; put it in the prompt.** A script cuts out exactly what each AI step
   needs (the paragraphs, the requirement rows, the code lines) and the prompt carries it. An agent that gets its
   input in the prompt answers in one or two turns; an agent that searches takes ten or more, each re-sending the
   context. Name the source of every excerpt in the prompt so the answer can cite it.

2. **Read a shared source once.** When several steps need the same source, extract it once (rule 1) and hand each
   step its part. When items share most of their sources, give one worker 3 to 5 related items instead of one worker
   per item. Fewer workers that each read once beat many workers that each read everything.

3. **Limit the tools to the job.** [check] With the input in the prompt, most steps need no tools: `tools=[]`.
   Otherwise list only what the step needs, and point it at exact paths, not a search over the tree. A `Grep` or
   `Glob` in a fan-out worker is repeated by every worker.
   Claude: `tools=[]` only stops the agent asking for permission; read-only tools (Read, Grep, Glob) stay available
   unless the step runs as an agent (`role_mode="agent"` with a role in `.claude/agents/`), where `--tools` removes
   the others. So the prompt must also say "everything you need is above; do not read files".

4. **Choose model and effort by the job, not one level for all.** [check] Effort mostly sets how long the agent
   thinks, which is output, the most expensive token. Use:
   - a strong model at `high` for planning, judgement, final review and cross-checks (few calls);
   - a mid model at `medium` for the many calls that fill a template from given input (fan-out workers);
   - a small model at `low` for format conversion and extraction.
   A run can raise one step without editing the workflow: `effort.<step>=high`.

5. **Make guardrails cheap.** [check] Check the answer in Python first (`check=fn`: schema, required IDs, forbidden
   words) so most rounds never reach an AI reviewer. Keep `retry_mode="resume"` (the default): a retry continues the
   same session with only the feedback, instead of a new session that reads everything again (measured: about 1.4 k
   cache-write tokens against 9 to 15 k for a fresh retry). Keep `retries` at 1 or 2 and make the feedback name the
   exact problem.

6. **Keep the background context small.** Skills and roles bound to a step are sent on every turn of that step. Bind
   only what the step uses; a long skill the step only needs to follow by name can use `skill_mode="name"`.
   `memory=` adds the memory notes to the prompt: use it only on steps that need them.

7. **Let scripts write files.** Ask the agent for a JSON answer (the schema) and write the files in a `write` or
   `script` step. An agent that writes and re-reads files spends turns on it, and a read-only step is safer.

8. **Cross-check only what matters.** A second agent that re-reads every source doubles the cost. Give the checker
   the answers plus the same prepared excerpts, or only the items a script flagged.

9. **Pilot before the fan-out, and write the estimate down.** Run the workflow on one or two items first (give it an
   arg such as `only=<id>` that `items()` honours), read the tokens and cost per step on the run's page or in
   `GET /api/stats`, and multiply. Put the estimate in the workflow's docstring ("about USD x per item, y items").
   Set the fan-out `limit` so a mistake cannot start dozens of sessions at once, and `[run] max_concurrency`
   (or `concurrency=N` for one run) so the workers do not all hit the provider's rate limit together.

10. **Keep partial results.** Fan-out results are kept per worker in the checkpoint: a stopped run continues with
    `langflow continue <run>` without paying again for the workers that finished. Write each item's result in a
    form you can use even when the run stops before the end.

## Checklist before the first real run

- [ ] Every AI step gets its input in the prompt, prepared by a script; no step searches a large tree.
- [ ] No source is read by more than one step without need; fan-out workers take related items together.
- [ ] Each step has the tools it needs and no more; fan-out workers have `tools=[]` or a short list.
- [ ] Model and effort are set per step: `high` only where judgement is needed.
- [ ] Guardrails check in Python first; `retry_mode` is `resume`; `retries` is 1 or 2.
- [ ] Only the skills, roles and memory the step uses are bound.
- [ ] Files are written by `write` / `script` steps.
- [ ] A pilot on one or two items was run, and the cost estimate is in the docstring.
- [ ] `langflow check <workflow>` shows no cost warning, or each one is explained in the docstring.
