# WorkForce implementation plans

## Active plan

- [Plug-in agent helpers, 10 November 2026](2026-11-10-plugin-agent-helpers-plan.md): approved next feature; WF.PM selects an original plug-in agent, the backend invokes it, and WF roles consume its results. Start with **H1**, then H2 and H3; implementation has not started.
- [WorkForce Local final plan, 8 November 2026](2026-11-08-workforce-local-final-plan.md): approved scope and requirements for the native Local refactor.
- [Milestones and acceptance checklist](2026-11-08-workforce-local-milestones.md): implementation order, dependencies, deliverables and evidence.

Implementation branch: `codex/workforce-vscode-native`.

The native-core release is [workforce-v0.3.0-alpha.1](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/workforce-v0.3.0-alpha.1); see the [current acceptance report](../validation/2026-11-10-native-core-release-acceptance.md) for verified scope. M7/REA remains deferred. The next feature is the plug-in agent helper plan above; its proposed implementation branch is `codex/plugin-agent-helpers`, while this handoff is saved on the current branch.

## Historical plans

- [WorkForce plan, 28 October 2026](2026-10-28-workforce-final-plan.md): superseded by the active Local plan. Retained as historical design context.
- [Runtime reliability plan, 28 October 2026](2026-10-28-runtime-reliability-plan.md): historical OpenCode reliability work; it does not define the new native Local execution path.
- [Agent protocol and procedure reuse](agent-protocol-and-procedure-reuse.md): supporting background. The active plan governs execution ownership, interfaces and acceptance.
