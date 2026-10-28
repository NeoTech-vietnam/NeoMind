# Workflow

How Alex Doe and the AI work together on Example Project. Load every session. Hard rules stay in `RULES.md`.

## Working style

- **Answer the question asked, then stop.** Offer extra analysis in one line ("Do you want me to compute X?") instead of
  doing it. Give a long treatment only when the owner asks for a review or a design.
- Use a table only for data the owner asked about, not for your own reasoning.
- **Decisions come one cluster at a time.** Ask one or two related decisions per turn, with short options. Keep the full
  list in the tracker or a plan file.
- **Before you rank options, list the limits they rest on** and mark each as checked or assumed (`G11`). Look for the
  source of a "fixed" thing. Add the option that keeps the best of two. Count the whole resource.
- Explain with numbers the owner can measure and with step-by-step chains, not with theory they did not ask for.
- Mark a judgement call as a choice. Say why you chose it.

## Task tiers

```text
N1  the owner decides   ──> direction, results review, sign-off, commit and push
N2  AI with checkpoints ──> design, new code the plan did not specify, anything that touches real equipment
N3  AI end to end       ──> existing data to charts, documents with settled content, scripts, memory updates
```

- A task that mixes tiers splits into one item per tier.
- Adjust the examples above to the project. Record the change in this file.

## Delegation

- **Delegating bounded work usually costs more than it saves.** A child session knows only its prompt. It can repeat
  work, rewrite finished code, or return a confident mistake. Do bounded work directly.
- Delegate when the work is independent and can run in parallel, or when it would otherwise fill the main context with
  file dumps.
- When you do delegate, brief the child like a peer:
  - the goal and what is already ruled out;
  - the files to read, as paths, not pasted text;
  - the scope in one line, and an explicit stop point;
  - the rules that apply (`RULES.md` group or number);
  - "do not start subagents" and "do not commit".
- Put a long brief in a file and point the child at it.
- Verify the child's work by the files it changed, not by its summary.
- One session at a time writes code in a core area. Run sessions in parallel only for independent work.

## Estimating AI work

- AI coding and builds take minutes, not hours. Estimate by what really paces the work: the owner's reviews, cycles that
  need real equipment, and missing facts.
- Give AI work in minutes, and count the review gates.
- A timeline promised to a client is not rewritten from an AI estimate.
