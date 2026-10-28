# Decision Analysis

## Core idea

Choose among feasible alternatives by making objectives, constraints, trade-offs, and uncertainty explicit. A decision matrix is optional; it is useful only when the criteria are genuinely competing.

## Process

1. State the decision, decision owner, timing, and non-negotiable constraints.
2. List feasible alternatives, including "do nothing" when it is real.
3. Define a small set of decision-relevant criteria before scoring options.
4. Compare alternatives with evidence. Weight criteria only when relative importance is known or can be agreed.
5. Test the recommendation against sensitivity: would a reasonable change in key assumptions reverse it?
6. State the choice, trade-offs accepted, and a fallback or trigger to revisit it.

## Example

**Decision:** Select an approach for accurate low-flow delivery.

| Option | Accuracy at target | Delivery smoothness | Firmware change | Validation burden |
|---|---|---|---|---|
| Continuous low-rate drive | Poor | Smooth | Low | Low |
| Fixed burst/hold schedule | Promising | Lower | Medium | Medium |
| Closed-loop pulsed control | Potentially best | Configurable | High | High |

If low-flow accuracy is the hard constraint, continuous drive can be eliminated before numerical scoring. The remaining choice depends on near-term scope, required control, and validation capacity.

## Anti-patterns

- Scoring options before defining the decision or hard constraints.
- Giving false precision to subjective scores such as 7.3 versus 7.1.
- Treating all criteria as equal without a reason.
- Comparing infeasible options as though they were viable.
- Hiding a value judgment inside a "neutral" matrix.

## Stop condition

Stop when one option is preferred under the agreed criteria, the pivotal assumptions are visible, and the result is robust enough for the cost of being wrong. If two options remain indistinguishable, identify the one experiment or stakeholder decision needed to separate them.

## Distinctions

- **Versus First Principles:** First Principles can create new options; decision analysis selects among options.
- **Versus Toulmin:** Decision analysis compares alternatives; Toulmin makes the chosen recommendation defensible.
- **Versus MECE:** MECE can structure criteria or options; it does not evaluate their trade-offs.
