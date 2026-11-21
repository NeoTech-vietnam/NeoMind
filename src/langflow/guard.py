"""langflow-guard: hook for Claude Code and Codex that keeps agent sessions in step with active langflow runs.

  SessionStart  lists the active runs of the project (running, waiting at a gate, failed), and points a session that
                is not itself a workflow step to the design guide (`langflow guide`, DESIGN.md)
  PreToolUse    denies an edit or a shell command that a run's LOCKS hold until a gate is approved, and denies agent
                edits of the run state (state_dir)

Register it in the project (`langflow hooks` prints the snippets):
  Claude Code  .claude/settings.json: SessionStart, PreToolUse "Bash|PowerShell" and "Edit|Write|MultiEdit"
  Codex        .codex/hooks.json (same events, matcher "Bash" and "apply_patch|Edit|Write"); add `--codex`
The project is found from the hook payload's cwd (nearest .langflow/config.toml). Outside a langflow project, or on
any error, the hook stays silent: it adds checks for runs and never blocks unrelated work.
"""
import fnmatch
import json
import os
import re
import sys
from pathlib import Path

SHELL_TOOLS = ("Bash", "PowerShell")
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "apply_patch", "ApplyPatch")
ACTIVE = ("running", "waiting", "failed")      # done, rejected and cancelled runs hold no locks
PATCH_FILE = re.compile(r"^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$", re.M)


def norm(p) -> str:
    return str(p).replace("\\", "/").lower()


def emit(event, **fields):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, **fields}}, ensure_ascii=False))


def edited_paths(payload, root: Path) -> list[str]:
    ti = payload.get("tool_input") or {}
    if isinstance(ti, str):
        ti = {"command": ti}
    paths = [ti[k] for k in ("file_path", "path") if isinstance(ti.get(k), str)]
    for v in ti.values():
        if isinstance(v, str) and "*** " in v:
            paths += PATCH_FILE.findall(v)
    return [norm(p if Path(p).is_absolute() else root / p) for p in paths]


def active_runs(project) -> list[dict]:
    out = []
    for f in sorted(project.runs_dir.glob("*.json")) if project.runs_dir.exists() else []:
        try:
            st = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if st.get("status") in ACTIVE:
            out.append(st)
    return out


def decide(payload, project, runs) -> str | None:
    tool = payload.get("tool_name")
    if tool in SHELL_TOOLS:
        targets, kind = [norm((payload.get("tool_input") or {}).get("command", ""))], "command"
    elif tool in EDIT_TOOLS:
        targets, kind = edited_paths(payload, project.root), "path"
        state = norm(project.state_dir) + "/"
        if any(t.startswith(state) for t in targets):
            return (f"The langflow run state is written only by langflow; gates are answered with "
                    f"`langflow approve` by {project.approver}.")
    else:
        return None
    for st in runs:
        for lk in st.get("locks", []):
            if lk["until"] in st.get("passed", []):
                continue
            hit = (any(c in t for c in lk.get("commands", []) for t in targets) if kind == "command"
                   else any(fnmatch.fnmatchcase(t, p) for p in lk.get("paths", []) for t in targets))
            if hit:
                return (f"langflow run '{st['run']}' ({st.get('workflow')}) holds this until gate '{lk['until']}' is "
                        f"approved: {lk['reason']} Current step: {st.get('step')} ({st.get('status')}).")
    return None


def handle(payload) -> None:
    from .project import load
    root_hint = payload.get("cwd") or os.getcwd()
    from .project import find_root
    if find_root(root_hint) is None:
        return
    project = load(root_hint)
    runs = active_runs(project)
    event = payload.get("hook_event_name")
    if event == "SessionStart":
        lines = []
        if runs:
            lines.append(f"Active langflow runs in {project.name} (`langflow status <run>`, live page in "
                         f"{project.rel(project.runs_dir)}/<run>.md):")
            for st in runs:
                where = (f"waiting at gate '{st.get('gate')}': {st.get('question')}" if st.get("status") == "waiting"
                         else f"{st.get('status')} at step '{st.get('step')}'"
                         + (f": {st.get('error')}" if st.get("error") else ""))
                lines.append(f"- {st['run']} ({st.get('workflow')}) {where}")
            lines.append(f"Gates are answered only by {project.approver} in their own terminal; "
                         "follow the run's order.")
        if not os.environ.get("LANGFLOW_STEP"):        # not inside a workflow step (agents/base.clean_env)
            lines.append(f"Before writing or changing a langflow workflow ({project.rel(project.workflows_dir)}/), "
                         "read the design guide: `langflow guide` (token-cost rules); then `langflow check <workflow>`.")
        if lines:
            emit("SessionStart", additionalContext="\n".join(lines))
    elif event == "PreToolUse":
        reason = decide(payload, project, runs)
        if reason:
            emit("PreToolUse", permissionDecision="deny", permissionDecisionReason="[langflow] " + reason)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        handle(json.load(sys.stdin))
    except Exception:  # noqa: BLE001 - never block unrelated work because of a hook problem
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
