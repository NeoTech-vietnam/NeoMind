# Toulmin Argument Model

## Core idea

Build a defensible claim by making the bridge from evidence to conclusion visible, and by stating the scope and meaningful objections.

Use it when a recommendation, risk assessment, or conclusion can reasonably be challenged. Do not use it to make settled facts look more debatable than they are.

## Structure

| Element | Question it answers |
|---|---|
| Claim | What should the reader accept or do? |
| Grounds | What facts, data, or observations support it? |
| Warrant | Why do those grounds support this claim? |
| Backing | What supports the warrant, if it is not obvious? |
| Qualifier | How certain is the claim and under what conditions? |
| Rebuttal | What material exception or objection could weaken it? |

## Example

**Claim:** Expose vent duration as a firmware register before using duty-cycle control in production.

- **Grounds:** The current sweep can change controller gains, but vent-open duration is fixed. The target pulse shape requires control of both ON and OFF timing.
- **Warrant:** A parameter cannot reliably shape a timing dimension it does not control.
- **Qualifier:** This is necessary if the characterization confirms that vent duration materially changes average flow or delivery variance.
- **Rebuttal:** If fixed vent duration meets all target duty cycles across tolerances, a register is unnecessary.

## Process

1. Write one falsifiable, decision-relevant claim.
2. Add only evidence that bears on that claim.
3. State the warrant; do not assume the reader will infer it.
4. Qualify the claim by scope, confidence, or conditions.
5. Address the strongest material rebuttal, not every imaginable objection.

## Anti-patterns

- Using a conclusion as evidence for itself.
- Hiding the warrant when it contains the real assumption.
- Adding weak or irrelevant evidence to create the appearance of rigor.
- Treating any counterargument as equally important.
- Adding caveats until no actionable conclusion remains.

## Stop condition

Stop when the claim, evidence, inference, uncertainty, and material exception are clear enough for a reasonable reviewer to accept, reject, or request a specific missing fact.

## Distinctions

- **Versus evidence mapping:** Toulmin answers "why does this evidence justify this claim?" Evidence mapping answers "what supports, contradicts, or qualifies each claim?"
- **Versus decision analysis:** Toulmin defends one conclusion; decision analysis compares alternatives before choosing one.
- **Versus Pyramid Principle:** Toulmin tests argument quality; Pyramid Principle orders the communication.
