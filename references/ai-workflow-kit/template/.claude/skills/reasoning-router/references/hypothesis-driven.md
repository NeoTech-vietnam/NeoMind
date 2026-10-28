# Hypothesis-Driven Reasoning

## Core idea

Turn an observation into competing, testable explanations. Prefer the test that most efficiently separates the plausible explanations.

Use this for debugging, root-cause analysis, experiments, and factual investigations. A hypothesis is not a conclusion or a fact.

## Process

1. Record observations without interpretation: what, where, when, and under what conditions.
2. Form a small set of plausible hypotheses, including a baseline or null explanation when useful.
3. For each hypothesis, state a discriminating prediction: what evidence would support it, contradict it, or leave it unresolved?
4. Run or request the smallest reliable test; control confounders where needed.
5. Update confidence, reject contradicted hypotheses, and state the best-supported result with remaining uncertainty.

## Example

**Observation:** Some boards fail during boot with an MPSL assertion. Raising crystal startup latency from 800 to 1500 microseconds removes the failure.

| Hypothesis | Prediction | Result |
|---|---|---|
| Startup latency is insufficient | Affected boards take longer than 800 microseconds; increasing latency removes the assertion | Supported |
| BLE initialization is independently faulty | Failures persist at 1500 microseconds | Contradicted by the change |

Conclusion: insufficient startup latency is the best-supported cause for the observed failure, subject to confirming the measurement across affected boards.

## Anti-patterns

- Calling the first plausible story the root cause.
- Creating generic hypotheses that make no testable prediction.
- Testing several variables at once and attributing the result to one of them.
- Treating a workaround as proof of a mechanism without checking its prediction.
- Continuing to test after the decision threshold is met and no material risk remains.

## Stop condition

Stop when one explanation accounts for the material observations better than its alternatives and has passed the needed verification threshold. If uncertainty still affects a decision, report it and define the next discriminating test.

## Distinctions

- **Versus MECE:** MECE organizes possible cause categories; hypothesis-driven reasoning tests specific causes.
- **Versus evidence mapping:** Hypothesis-driven reasoning decides what evidence to seek; evidence mapping records what existing evidence supports.
- **Versus First Principles:** It explains an observed outcome; First Principles rethinks the design or problem framing.
