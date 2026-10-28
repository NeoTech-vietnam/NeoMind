# MECE

## Core idea

Create categories that are mutually exclusive and collectively exhaustive for the question at hand. MECE is a tool for decomposition, not proof that every listed branch matters.

## Process

1. Write one precise question and one scope boundary.
2. Pick a single basis for the split: mechanism, lifecycle stage, owner, cost type, or another relevant dimension.
3. Make categories non-overlapping at that level.
4. Check whether a plausible item has no home; add or revise a category only when it matters to the scope.
5. Prioritize branches before expanding them.

## Example

**Question:** Why did battery life decline after a release?

Split by mechanism:

- Increased energy consumption per unit time.
- Reduced available battery capacity.

This is cleaner than mixing mechanisms and components:

- BLE activity.
- Battery capacity.
- Firmware changes.

Firmware changes may cause either mechanism, so it overlaps the other two categories.

## Anti-patterns

- Mixing dimensions, such as "software," "high current," and "night mode," in one list.
- Forcing exhaustive taxonomy when only the top two likely contributors need investigation.
- Treating branches as equally likely or equally valuable.
- Adding a catch-all "other" and using it as a substitute for checking the decomposition.

## Stop condition

Stop when every material item fits one category, no category overlaps in the chosen dimension, and the highest-value branches are clear. Then investigate only those branches.

## Distinctions

- **Versus a checklist:** A checklist is an existing list; MECE derives a coherent structure for this question.
- **Versus hypothesis-driven reasoning:** MECE maps the search space; hypotheses predict what evidence should be found within a branch.
- **Versus First Principles:** MECE accepts the framing unless changed deliberately; First Principles tests whether the framing itself is wrong.

## Useful prompt to self

"What single dimension am I using to divide this problem, and where would each material item belong?"
