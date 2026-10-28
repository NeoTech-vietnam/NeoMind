# First Principles

## Core idea

Reduce a problem to facts, physical or logical constraints, and objectives. Then rebuild the solution without treating inherited practice as a requirement.

Use this when a conventional answer is failing, assumptions are expensive, or a design space needs reframing. It is not a ritual for ordinary work.

## Process

1. State the outcome to optimize and its non-negotiable constraints.
2. List the current approach's assumptions separately from observed facts.
3. Identify which assumptions are necessary, testable, or merely conventional.
4. Reconstruct feasible options from the remaining facts and constraints.
5. Compare the promising option with the current approach using real criteria.

## Example

**Question:** How can a pump deliver a very low average flow accurately?

- Fact: continuous operation becomes inaccurate at very low drive rates.
- Constraint: higher burst rates are accurate; the required average flow remains low.
- Assumption to challenge: the motor must run continuously at the target average rate.
- Rebuilt option: run short accurate bursts separated by holds; set the average through duty cycle.

The conclusion is not "pulsing is always better." It is a candidate constrained by burst accuracy, mechanical response, and acceptable delivery variation.

## Anti-patterns

- Renaming common sense as "first principles" without challenging a meaningful assumption.
- Treating a preference, legacy API, or current architecture as a fundamental constraint.
- Rebuilding the entire system when a validated standard solution already fits.
- Ignoring practical constraints such as safety, compatibility, cost, or time to validate.

## Stop condition

Stop when the key assumptions have been tested or explicitly retained, and there is at least one feasible option that can be compared against the existing approach. Move to decision analysis if several feasible options require selection.

## Distinctions

- **Versus MECE:** First Principles changes the framing; MECE organizes a chosen framing.
- **Versus hypothesis-driven reasoning:** First Principles generates or redefines options; hypothesis-driven reasoning tests explanations for an observation.
- **Versus decision analysis:** First Principles discovers what is possible; decision analysis chooses among viable options.
