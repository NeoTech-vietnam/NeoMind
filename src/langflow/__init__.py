"""langflow: fixed, gated workflows for coding agents.

A workflow is a list of steps, run in order by LangGraph:
  ai(...)      one headless agent call (Claude Code `claude -p`, Codex `codex exec`) with a JSON schema for the answer
  script(...)  one command; a non-zero exit stops the run
  write(...)   a file written by the runner from the state (agents stay read-only)
  gate(...)    waits for a person: `langflow approve <run>` from a real console
Each project keeps its own settings and workflows in `.langflow/` (see `langflow init`).
"""
from .engine import StepFailed, ai, fanout, gate, loop, parallel, remember, route, script, write  # noqa: F401
from .project import current  # noqa: F401

__version__ = "0.1.0"
