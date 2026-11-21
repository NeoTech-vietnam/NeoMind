"""Self-test of langflow in this project: Claude step, script check, gate, Codex step. Read-only.

  langflow start smoke smoke-1 [claude_model=haiku] [codex_model=...]
  langflow approve smoke-1        (in your own terminal)
"""
import sys

from langflow import ai, gate, script

META = {"description": "self-test: claude, script check, gate, codex (read-only)"}
HEADING = {"type": "object", "additionalProperties": False, "required": ["heading"],
           "properties": {"heading": {"type": "string"}}}


def steps(args):
    return [
        ai("claude_read", "List the files in the current folder and return the name of one of them as 'heading'. "
           "Do nothing else.", HEADING, agent="claude", model=args.get("claude_model", "haiku"),
           tools=["Glob", "Read"]),
        script("check_answer", lambda s: [sys.executable, "-c", "import sys; sys.exit(0 if sys.argv[1].strip() else 1)",
                                          s["results"]["claude_read"]["heading"]]),
        gate("go_on", "Claude answered. Run the Codex step?"),
        ai("codex_read", "List the files in the current folder and return the name of one of them as 'heading'. "
           "Do nothing else.", HEADING, agent="codex", model=args.get("codex_model")),
    ]
