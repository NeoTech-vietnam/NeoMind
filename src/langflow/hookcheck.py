"""Confirm that the project's own hooks ran inside an agent session, so a step whose guards were off is not trusted.

Agents started headless can come up without the hooks (example: Claude Code on Windows without Git Bash runs its
tools and hooks through PowerShell, and hook commands written for bash fail "non-blocking"). Configure in
config.toml [hook_check]; kind "none" skips the check and says so in the run log.
"""
import json
from pathlib import Path

from .project import Project


def mark(project: Project) -> int:
    hc = project.hook_check
    if hc.get("kind") != "jsonl_log":
        return 0
    p = project.root / hc["path"]
    return p.stat().st_size if p.exists() else 0


def verify(project: Project, since: int, session: str | None, client: str) -> tuple[bool, int | None, str]:
    """(ok, number of hook calls seen, message)."""
    hc = project.hook_check
    if hc.get("kind") != "jsonl_log":
        return True, None, "hooks not checked (hook_check.kind = none)"
    p = project.root / hc["path"]
    if not session or not p.exists():
        return False, 0, f"no hook log {p} or no session id"
    with open(p, "rb") as f:
        if p.stat().st_size < since:          # log was rotated or emptied: read it all
            since = 0
        f.seek(since)
        lines = f.read().decode("utf-8", "replace").splitlines()
    sf, cf, ef = hc.get("session_field", "session"), hc.get("client_field", "client"), hc.get("event_field", "event")
    seen = []
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get(sf) == session and (not cf or d.get(cf) in (client, None)):
            seen.append(d)
    need = hc.get("required_event", "SessionStart")
    ok = any(d.get(ef) == need for d in seen)
    return ok, len(seen), "" if ok else f"project hooks did not run in {client} session {session}; result not trusted"
