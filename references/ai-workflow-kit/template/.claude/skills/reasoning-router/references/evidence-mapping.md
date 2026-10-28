# Evidence Mapping

## Core idea

Make the relationship between a conclusion and its supporting material explicit. An evidence map prevents a relevant observation from being silently treated as proof.

Use it when traceability, reviewability, conflicting sources, or a high-consequence conclusion matters. Do not use it for a simple answer with one clear source.

## Minimal map

| Item | Type | Relationship | Confidence / limitation |
|---|---|---|---|
| "Startup latency is insufficient" | Claim | — | Medium until measured on affected boards |
| Measured ramp-up exceeds 800 microseconds | Measurement | Supports | Sample size and conditions matter |
| 1500 microseconds removes assertion | Experiment | Supports / qualifies | Shows mitigation; not alone the mechanism |
| Boot logs show MPSL assertion | Observation | Consistent with | Does not identify the cause alone |

Use precise relationship labels: **supports**, **contradicts**, **qualifies**, **is consistent with**, or **is missing for**. "Related to" is usually too vague.

## Process

1. State the decision or claim the map must support.
2. Extract observations, measurements, test results, source statements, and assumptions.
3. Link each item to a claim using a relationship label.
4. Record scope, recency, source quality, and contradictions.
5. Identify the smallest missing evidence that could change the decision.

## Anti-patterns

- Presenting a source citation as proof without explaining what it establishes.
- Counting multiple copies of the same underlying evidence as independent support.
- Hiding contradictory evidence or treating it as irrelevant without rationale.
- Using confidence scores with no stated basis.
- Making an evidence map so detailed that it obscures the actual decision.

## Stop condition

Stop when a reviewer can trace each material claim to the relevant evidence and see the important gaps or contradictions. Add more detail only if it can change the decision or confidence.

## Distinctions

- **Versus Toulmin:** Evidence mapping is a traceability artifact; Toulmin structures a persuasive argument, including the warrant that connects evidence to claim.
- **Versus hypothesis-driven reasoning:** Evidence mapping organizes evidence already available; hypothesis-driven reasoning designs the next test.
- **Versus a bibliography:** A bibliography lists sources; an evidence map states what each source does and does not support.
