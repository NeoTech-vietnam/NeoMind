---
description: Start a NeoMind flow for a task and follow it
---

Run a NeoMind flow for: $ARGUMENTS

NeoMind runs agent flows in an isolated Git worktree of this project: a plan, an approval, the implementation, checks and an independent review, depending on the flow. You start the flow and follow it with the NeoMind tools; you do not do the work yourself, and you never edit the files the run is changing.

1. If the task above is empty, ask the user what the flow should do. If the user did not name a flow, use `fast` for a small, contained change and `dev` for anything that should be reviewed and committed; say which one you chose.
2. Call `neomind_preview` for that flow. If it lists blockers, show them and stop. Tell the user briefly which runner and model each step uses and any exceptions the flow declares. If the checkout has uncommitted changes, ask whether to bring them into the run (`importDirty`); by default the run starts from HEAD without them.
3. Call `neomind_start` with the flow and the task in the user's words.
4. Follow the run with `neomind_wait` (not repeated `neomind_status`). Report progress briefly when the phase changes.
5. When the phase is `waiting_approval`, show the plan from the result (goal, approach, acceptance criteria, scope, checks) and ask the user with your interactive question tool: approve, ask for changes, or decide in the NeoMind panel. Only after an explicit yes, call `neomind_approve` with the `planHash` you showed and `confirmed: true`. For changes, pass the user's own words to `neomind_request_changes`.
6. When the phase is `completed`: with a commit, report it and its `git cherry-pick` command; with changed files (Fast), list them and ask whether to apply them to the checkout, and only after a yes call `neomind_apply` with `confirmed: true`.
7. When the phase is `blocked`, report the reason. `neomind_session` shows what each agent did if the user wants details.
