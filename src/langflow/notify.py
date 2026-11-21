"""Notify a person when a gate starts waiting: the optional [notify] command of config.toml.

  [notify]
  command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".langflow/notify.ps1"]
  timeout = 10            # seconds to wait for the command; after that it keeps running on its own

The command is an argv list run without a shell, in the project root. Placeholders, each replaced inside any
argument: {run} {gate} {question} {workflow} {page} (the run's live page). The same values are in the environment
as LANGFLOW_RUN, LANGFLOW_GATE, LANGFLOW_QUESTION, LANGFLOW_WORKFLOW, LANGFLOW_PAGE, LANGFLOW_PROJECT: a script
should read them from there (a question may hold any text, so never paste {question} into a shell or a
PowerShell -Command string). Failures are written to the run log and never stop the run. INSTALL.md has a Windows
toast example.
"""
import os
import shutil
import subprocess
import time

PLACEHOLDERS = ("run", "gate", "question", "workflow", "page")


def _log(run: str, gate: str, text: str):
    try:
        from . import engine
        engine.log_line(run, gate, text, page=False)
    except Exception:  # noqa: BLE001
        pass


def gate_waiting(project, run: str, gate: str, question: str, workflow: str | None = None) -> bool:
    """Run the [notify] command for a gate that starts waiting. Returns True when it started (or none is set)."""
    cfg = project.notify or {}
    cmd = cfg.get("command")
    if not cmd:
        return True
    try:
        from . import engine
        page = str(engine.page_path(run))
    except Exception:  # noqa: BLE001
        page = ""
    values = {"run": run, "gate": gate, "question": question or "", "workflow": workflow or "", "page": page}
    if isinstance(cmd, str):
        cmd = [cmd]
    argv = []
    for a in cmd:
        a = str(a)
        for k in PLACEHOLDERS:
            a = a.replace("{" + k + "}", values[k])
        argv.append(a)
    if argv and not any(sep in argv[0] for sep in ("/", "\\")):
        argv[0] = shutil.which(argv[0]) or argv[0]       # see engine.script: bare names resolve on PATH
    env = dict(os.environ, LANGFLOW_PROJECT=project.name,
               **{f"LANGFLOW_{k.upper()}": v for k, v in values.items()})
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        p = subprocess.Popen(argv, cwd=project.root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, creationflags=flags)
    except OSError as e:
        _log(run, gate, f"notify: cannot start {argv[0]}: {e}")
        return False
    try:
        out, _ = p.communicate(timeout=float(cfg.get("timeout", 10)))
    except subprocess.TimeoutExpired:
        _log(run, gate, "notify: command still running; left alone")
        return True
    except Exception as e:  # noqa: BLE001
        _log(run, gate, f"notify: {type(e).__name__}: {e}")
        return False
    if p.returncode != 0:
        text = (out or b"").decode("utf-8", "replace").strip()[-300:]
        _log(run, gate, f"notify: exit {p.returncode}: {text}")
        return False
    _log(run, gate, f"notify: sent ({time.strftime('%H:%M:%S')})")
    return True
