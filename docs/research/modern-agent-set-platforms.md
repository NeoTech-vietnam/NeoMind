# Modern NeoMind agent profiles: platform evidence

Reviewed **2026-10-23**. This is research and a NeoMind design recommendation. Official documentation describes capabilities and operating patterns; it does not establish a universally strongest agent pack, model, or configuration. Repository stars are not evidence of correctness, tool compatibility, or domain expertise. No upstream agent package was installed or copied for this report.

## What the platforms actually provide

**Codex:** built-ins distinguish a general default, an execution-focused worker, and a read-heavy explorer. Official custom-agent examples separate repository exploration, review and documentation research. Narrow instructions and a tool surface matching the job are the useful pattern; agent configuration inherits the parent environment rather than creating an independent security sandbox. [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

**Claude Code:** built-in Explore and Plan isolate codebase investigation in separate contexts and deny Write/Edit. General-purpose handles work requiring both investigation and action. Custom subagents configure prompts, models and allowed tools. Current documentation says Explore usually uses the main conversation's model, with connection-dependent exceptions; the older blanket claim that Explore always uses Haiku is no longer accurate. Permission modes can inherit or be overridden by the parent session, so a profile's declared mode alone is insufficient assurance. Keep descriptions short and pass important task constraints explicitly. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).

**Claude Code agent teams:** a lead, independent teammate contexts, shared tasks and direct messages support competing debugging hypotheses, parallel review and independent modules. Teams remain experimental and disabled by default. They cost more tokens than focused subagents; in-process teammates do not survive session resume, and nested teams are unsupported. On Windows and VS Code use in-process presentation: split panes require tmux/iTerm2 and are unsupported in VS Code's integrated terminal and Windows Terminal. These constraints argue against making team mode a prerequisite for NeoMind. [Agent teams](https://code.claude.com/docs/en/agent-teams).

**GitHub Copilot CLI:** official built-ins distinguish fast `explore`, source-citing `research`, full-capability `general-purpose`, command-running `task`, read-only `code-review`, and read-only `security-review`. A complementary-model `rubber-duck` critiques proposals and implementations. Review agents perform their own reviews rather than recursively forwarding the entire review; they can delegate narrow fact-finding, and code review can request a security specialist. These are useful responsibility boundaries, not proof that copying a built-in name reproduces its implementation or quality. [Copilot CLI built-in agents](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#built-in-agents).

**VS Code custom agents:** recurring responsibilities can have different instructions, tools and models. Official examples separate a read-only planner/reviewer from implementation and use focused research subagents to protect main-context capacity. Explicit least-privilege tool lists are recommended. [Custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents).

**OpenCode:** its built-in build/plan and general/explore responsibilities make the same distinction between execution and investigation. Explore is a read-only codebase subagent; general can perform multi-step work with file changes. This supports a separate Explorer in NeoMind without introducing another orchestrator. [OpenCode agents](https://opencode.ai/docs/agents/).

**REA:** this is a specialist investigation toolset for binaries, JavaScript/Electron applications, .NET and runtime behavior. It registers MCP tools plus matching guidance; native analysis may require an existing Hopper, Ghidra or IDA installation. Reusing instructions alone does not install those tools. Use reviewed REA guidance for applicable artifact investigations, while keeping NeoMind assignments, model policy and evidence ownership. Its popularity does not establish general coding-team superiority. [REA repository and setup](https://github.com/morluto/rea).

## Recommended NeoMind profiles

This table is a synthesis for this repository, not an upstream ranking. Expose nine understandable profiles and invoke only the ones the task needs. Keep specialized expertise in reviewed skills rather than multiplying permanent agents for every language or framework.

| Profile | Useful capability and concrete output | Default boundary | Existing signed role |
| --- | --- | --- | --- |
| Coordinator | Decompose work, assign ownership, integrate results and resolve blockers; saved task/evidence ledger | Delegate within budget; serialize shared-state operations | `manager`; explicit `curator`/`release` duties |
| Explorer | Trace entrypoints, dependencies and behavior; file-linked repository map | Read/search; no edits or shell | `codebase-analyst` |
| Researcher | Verify APIs, upstream agents, versions and licenses; citations plus adoption constraints | Read/search/web; retrieved instructions are reference material | `researcher` |
| Planner | Translate intent into measurable acceptance, scope and dependencies | Read/search; no production edits | `requirements` |
| Architect | Define interfaces, data flow, failure behavior and component contracts | Read/search; experiments need a separate execution assignment | `architect`, `component-owner` |
| Implementer | Deliver a bounded patch, relevant documentation and meaningful checks | Edit/execute within owned paths; preserve unrelated work | `developer` |
| Debugger | Establish a reproducible failure, discriminate hypotheses and deliver a minimal repair with regression evidence | Edit/execute within the repair assignment | `developer` |
| Verifier | Define independent expectations, run prescribed checks and inspect actual results | Plan as `verifier`; execute as `check-executor`; protect reviewed expectations | `verifier`, `check-executor` |
| Reviewer | Independently inspect correctness, security, compatibility and evidence; actionable findings | Read/search; separate invocation from producer; no production edits | `reviewer` |

Planner and Architect are distinct when acceptance or interfaces are consequential; a small edit can proceed without invoking either. Debugger shares Implementer's permissions and underlying role but has a different procedure: reproduce, isolate, repair, rerun. Verifier proves behavior through execution; Reviewer assesses whether the patch and evidence justify acceptance. Neither replaces the other.

For authentication, secrets, network exposure, dependency installation or untrusted-input changes, assign an additional **security-focused Reviewer invocation** with a threat model and explicit attack surfaces. Add performance, accessibility, embedded/HDL or release expertise as scoped skills when applicable. A permanent security profile is justified only after recurring work demonstrates the need for distinct permissions or evaluations.

## Delegation, cost and evidence

Anthropic's architecture guidance favors the simplest sufficient composition: routing for distinct task classes, parallel workers for independent work, and evaluator/optimizer loops when evaluation criteria are clear. Its December 2024 article explicitly warns that tooling has changed; these remain architecture patterns rather than a current runtime specification. [Building effective agents](https://www.anthropic.com/research/building-effective-agents).

The 2025 Research system used an orchestrator with parallel researchers and explicit objectives, output formats, tool/source guidance and boundaries. Its reported 90.2% improvement was an internal research evaluation using particular models, not a general coding benchmark. Reported token use was about 4 times chat for agents and 15 times chat for multi-agent systems; those observations are not a NeoMind cost forecast. The authors identify fewer independent parallel tasks in coding. [Multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system).

For NeoMind, start with at most three independent workers as a project policy, not a claimed platform limit. Each assignment should carry baseline, goal, owned paths, allowed actions, acceptance criteria, evidence format, budget and stop/escalation conditions. Parallelize independent investigation or separate modules; avoid concurrent ownership of the same files. Track retries, elapsed time, tool calls, token/cost data when available, and actionable review findings. A separate context does not itself establish an unbiased or correct review. [VS Code subagent guidance](https://code.visualstudio.com/docs/agents/run/subagents).

## Windows, VS Code and 9router integration constraints

The selected VS Code harness determines delegation behavior: **Copilot uses native `task`; Local uses `runSubagent`**. Local invocations are stateless and do not inherit the main conversation history. Nested delegation and model selection differ by harness. Validate actual installed capabilities before generating coordinator instructions. [Subagents by harness](https://code.visualstudio.com/docs/agents/run/subagents#subagents-by-harness).

Agent file locations do not imply portable semantics. Current VS Code documentation supports model preferences and harness-dependent tool names; Local handoffs do not apply to the Copilot harness. Agent-scoped MCP configuration for the cloud target is not the VS Code MCP configuration. Unavailable tools can be ignored, so conformance must check the resolved tool set. A profile with shell access can still write files even if an edit tool is absent; enforce consequential boundaries through NeoMind capabilities and execution policy. [Custom agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference).

Keep NeoMind's twelve persisted core role IDs and historic signed receipts unchanged. Display profiles compose those duties; each managed invocation still records its actual core role. In particular, Implementer and Debugger share `developer` routing, while Verifier/check-executor retain separate core policies. Current source contains the nine profiles in `src/agent-profiles.ts`; reading that source is not evidence that every client has regenerated or executed them.

Use 9router for inference routing while NeoMind owns authorization, assignments and evidence. Select available exact catalog IDs and compatible tools per role; benchmark a strong model on difficult planning/debugging/review and a cheaper model on bounded exploration/check execution. A gateway alias or fallback combo is not proof of an exact responding backend. Keep requested, selected and reported model identities distinct and retain guarded next-invocation changes. See [the verified local 9router contract](9router-integration.md) for endpoint and provenance limits.

## Reuse and next improvements

Adopt small reviewed skills, pinned by repository commit and content digest, with license notices and an update diff. GitHub's Awesome Copilot collection is MIT licensed and requires its copyright/permission notice with copies or substantial portions; individual imported dependencies still require inspection. Documentation about a proprietary built-in agent is not evidence of a portable licensed prompt package. This research copies no upstream prompts. [Awesome Copilot license](https://github.com/github/awesome-copilot/blob/main/LICENSE).

Prioritize a harness conformance check, reusable bounded assignment packets, role/model benchmark fixtures and security-focused review criteria. Evaluate the profiles on this project's real Windows packaging, persistence/concurrency, VS Code bridge and HDL/toolchain tasks. Measure completion, regressions, false-positive findings, latency and cost before changing defaults or declaring a profile/model combination better.
