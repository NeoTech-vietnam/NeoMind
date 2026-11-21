"""Agent adapters. Each one runs a headless agent session for one prompt and returns
{"result": <JSON matching the schema>, "session": id, "hooks": n|None, "transcript": path|None, "usage": {...}}.
Register a new agent by adding a module with run(...) and an entry in AGENTS."""
from . import claude, codex, opencode

AGENTS = {"claude": claude.run, "codex": codex.run, "opencode": opencode.run}
