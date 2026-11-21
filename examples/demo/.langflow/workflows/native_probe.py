"""Probe for skill / role delivery (langflow phase 2b tests). Not a real workflow.

  langflow start native_probe <run> [agent=claude|codex|opencode] [fail_first=1] [role_mode.probe=...] [skills.probe=...]
"""
from langflow import ai

META = {"description": "probe: does the bound role / skill reach the model (canaries)"}
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["answer", "canaries"],
          "properties": {"answer": {"type": "string"},
                         "canaries": {"type": "array", "items": {"type": "string"}}}}
READ = ["Read", "Glob", "Grep"]


def steps(args):
    state = {"n": 0}

    def check(result):
        state["n"] += 1
        if args.get("fail_first") and state["n"] == 1:
            return False, "Forced first-attempt failure (probe). Answer again the same way."
        return True, ""

    agent = args.get("agent", "claude")
    return [
        ai("probe", "Answer in one line: what is 2+2? List every canary you were told to include.", SCHEMA,
           agent=agent, tools=READ if agent == "claude" else None, effort="low", check=check,
           role="lf-probe-role", skills=["lf-probe"]),
    ]
