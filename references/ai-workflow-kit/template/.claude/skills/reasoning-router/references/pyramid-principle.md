# Pyramid Principle

## Core idea

Communicate the answer before the discovery process. Group supporting points into a small, logical set, then provide evidence or detail only as needed.

Use it for reports, technical updates, recommendations, and explanations. It is a presentation method, not a way to manufacture an answer without analysis.

## Default shape

```text
Answer or recommendation
├── Reason 1
│   └── Evidence / implication
├── Reason 2
│   └── Evidence / implication
└── Reason 3
    └── Evidence / implication
```

The reasons must be parallel and collectively answer "why should I accept the top line?"

## Example

**Root cause:** The boot failure is caused by insufficient HF crystal startup latency.

1. Affected boards stabilize after the configured 800 microseconds.
2. The MPSL assertion occurs during the startup window.
3. Increasing latency to 1500 microseconds removes the failure.

**Action:** Set the validated latency margin and confirm it across the affected hardware population.

This is preferable to a chronological log dump that makes the reader wait for the conclusion.

## Process

1. Write the single answer the audience needs first.
2. Group the two to four strongest supporting points by one logic: deduction, chronology, mechanism, or priority.
3. Add only evidence that verifies each point or changes the action.
4. Move background, raw data, and implementation detail below the main message or into an appendix.

## Anti-patterns

- Leading with generic background the audience already knows.
- Making every paragraph a new "main point."
- Mixing causes, recommendations, and observations in one support list.
- Presenting the full investigation chronology when the result is what matters.
- Using a pyramid to conceal uncertainty; put material uncertainty near the conclusion.

## Stop condition

Stop when a reader can understand the conclusion, why it is supported, what remains uncertain, and what they should do without reading the supporting detail. Add detail only for a likely reviewer question.

## Distinctions

- **Versus Toulmin:** Pyramid decides the order for the reader; Toulmin checks the integrity of a claim and its rebuttal.
- **Versus MECE:** MECE creates clean groups; Pyramid turns the relevant groups into a conclusion-first narrative.
- **Versus a summary:** A summary compresses content; a pyramid gives the content a logical hierarchy.
