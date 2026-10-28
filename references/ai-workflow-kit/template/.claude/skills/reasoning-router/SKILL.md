---
name: reasoning-router
description: Select the smallest useful reasoning method for technical analysis, investigation, decisions, and structured explanations. Use when the task needs more than a direct answer; do not use merely to rewrite prose.
---

# Reasoning Router

Choose only the reasoning structure that materially improves the answer. Frameworks guide the work; do not expose them as headings unless the user asks for methodology.

## Start here

1. Define the question, decision, or claim to resolve.
2. Classify the task using the table below.
3. Read only the relevant reference file(s).
4. Stop when the requested conclusion or decision is adequately supported.
5. Present the result for the audience, normally conclusion first.

| If the task needs… | Read | Use it for |
|---|---|---|
| A challenge to inherited assumptions or a novel design | [first-principles.md](references/first-principles.md) | Rebuild from facts and constraints |
| A complete, non-overlapping decomposition | [mece.md](references/mece.md) | Scope causes, options, risks, or workstreams |
| A testable explanation for an observed problem | [hypothesis-driven.md](references/hypothesis-driven.md) | Debugging, root cause analysis, experiments |
| Traceability from a conclusion to supporting material | [evidence-mapping.md](references/evidence-mapping.md) | Reviews, investigations, audit-sensitive work |
| A defensible claim with uncertainty or objections | [toulmin.md](references/toulmin.md) | Recommendations, risk arguments, disputed conclusions |
| A choice among alternatives and trade-offs | [decision-analysis.md](references/decision-analysis.md) | Architecture, priority, supplier, or plan selection |
| A concise, reader-first explanation | [pyramid-principle.md](references/pyramid-principle.md) | Reports, updates, design summaries, recommendations |

## Complexity gate

| Level | Signal | Default action |
|---|---|---|
| 0 — Direct | Established fact, simple definition, narrow request | Answer directly. No framework. |
| 1 — Focused | One cause, claim, or choice | Use one method. |
| 2 — Multi-factor | Several plausible causes, criteria, or evidence sources | Use one primary method and, if needed, one supporting method. |
| 3 — Investigation | Competing hypotheses, high impact, traceability needed | Use hypothesis-driven or decision analysis, plus evidence mapping; use Pyramid for delivery. |

## Combination rules

- Start with the method that solves the core problem, not with a presentation method.
- Use MECE to organize a space; do not mistake it for proof.
- Use hypothesis-driven reasoning to test explanations; use evidence mapping when the evidence chain must be inspectable.
- Use Toulmin to make an argument robust; use decision analysis when selecting among alternatives.
- Use Pyramid Principle after the reasoning is complete, not as a substitute for it.
- First Principles is exceptional: use it only when conventional framing is likely wrong or constraining.

## Reasoning discipline

- Separate observations, assumptions, inferences, and decisions.
- Do not invent evidence or convert correlation into causation.
- Name a material uncertainty or alternative explanation when it could change the conclusion.
- Prefer the smallest test, decomposition, or comparison that can resolve the question.
- Do not stack frameworks for formality. Remove any method that adds no decision value.

## Output

Unless the user asks to see the analysis process, lead with the answer, then give the minimum reasons, evidence, uncertainty, and next action needed to verify it. Read [pyramid-principle.md](references/pyramid-principle.md) when the result must be communicated to others.
