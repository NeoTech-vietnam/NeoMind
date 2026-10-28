# Reasoning Router

A compact skill for selecting the smallest reasoning method that improves a technical answer. It
routes to focused references instead of forcing every framework onto every task.

Runtime-neutral. `SKILL.md` carries only `name` and `description` in its frontmatter and every link
is relative, so Claude Code and Codex both load it from the same folder. `agents/openai.yaml`
supplies the Codex display name and is ignored elsewhere.

## Contents

```text
reasoning-router/
├── SKILL.md
├── README.md
├── agents/openai.yaml
└── references/
    ├── first-principles.md
    ├── mece.md
    ├── hypothesis-driven.md
    ├── evidence-mapping.md
    ├── toulmin.md
    ├── decision-analysis.md
    └── pyramid-principle.md
```

## Install

The canonical copy lives in this repository at `.claude/skills/reasoning-router`, which Claude Code
reads directly. Codex reads only `$CODEX_HOME/skills/` (default `~/.codex/skills`), so link it there
rather than copying, to keep one source of truth:

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.codex\skills\reasoning-router" `
  -Target "<repo>\.claude\skills\reasoning-router"
```

Link each skill on its own. Do not link `~/.codex/skills` as a whole, because that hides Codex's
preinstalled `.system` skills.

Both runtimes then select the skill automatically for analysis, investigations, decisions, and
structured technical explanations. Codex also accepts `$reasoning-router` explicitly.

## How it behaves

- A simple question gets a direct answer.
- A root-cause investigation routes to hypothesis-driven reasoning, and evidence mapping only when traceability matters.
- A trade-off routes to decision analysis.
- A report normally uses Pyramid Principle after the reasoning is complete.

The skill does not prescribe verbose step-by-step reasoning or reveal private working. It asks for only the evidence and explanation the reader needs.

## Customize

Adjust `SKILL.md` if you have local conventions, such as a mandatory risk matrix or review template. Keep the router short; add domain-specific detail to a separate reference instead of turning the router into a checklist.

## Scope

This is a reasoning and information-structure skill. It decides *what* to say and in what order, and
sets no rules for word choice or tone. Pair it with a writing skill when the wording matters:
`no-ai-slop` for punctuation and rhetoric, `asd-ste100` for sentence structure. Run the writing skill
after the reasoning is settled.
