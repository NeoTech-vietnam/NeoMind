"""langflow: run a project's process as a fixed workflow with gates for a person.

  langflow init                         create .langflow/ (config, smoke workflow) in the current folder and the
                                        langflow-design skill in .claude/skills and .agents/skills (existing files
                                        are kept; run it again in an older project to add the skill)
  langflow hooks                        print the hook snippets for Claude Code and Codex
  langflow guide                        the workflow design guide (few tokens per run): read it before writing or
                                        changing a workflow; `langflow check` warns about the costly patterns
  langflow list                         workflows and runs
  langflow ui                           terminal UI: runs, steps, live log; approve/reject/continue (needs a console)
  langflow web [--port N] [--open] [--api-only]   web page + JSON API on 127.0.0.1 (see web.py); gates answered
                                        there are logged as by "web:<user>" (or "panel:<user>" from Nimbalyst)
  langflow graph <workflow>             write a Mermaid diagram of the workflow (.md in state_dir/graphs)
  langflow start <workflow> <run> [key=value ...]   also model.<step>= effort.<step>= role.<step>= skills.<step>=
                                        role_mode.<step>=append|agent|prompt contract.<step>=true|false
                                        skill_mode.<step>=inject|system|native|name
                                        native_fallback.<step>=system|inject|fail retry_mode.<step>=fresh|resume
  langflow check <workflow> [key=value ...]   the role and skills of every ai step (code, .langflow/bindings.toml,
                                        run args), the role mode, the skill file each CLI loads (warnings when it
                                        differs from the catalog's copy) and token-cost warnings (`langflow
                                        guide`); exit 1 when a role or skill is missing (cost warnings never fail)
  langflow skills | roles               the project's skills / agent definitions and the steps that use them
  langflow status [<run>]
  langflow watch <run>                  follow the live log (Ctrl-C stops watching, not the run)
  langflow approve <run> [--reject] [--note TEXT]   only from a real console (the approver, not an agent)
  langflow continue <run>               re-run the step that failed, was cut off or was cancelled
  langflow stop <run>                   cancel a run: kills its running agent or script; a gate stops waiting
  langflow rm <run> [...] [--force] [--yes]   delete runs' state (status, log, page, checkpoints); the files they
                                        wrote and the series memory stay; --force for a run waiting at a gate
  langflow prune [--days N] [--status done,cancelled,failed,rejected] [--keep N] [--workflow W] [--yes]
                                        list old runs to delete (keep = newest N per workflow); --yes deletes them
  langflow memory <run> | --series | --clear <workflow> <series>   run and series memory (see memory.py)
  langflow schedule add <name> <HH:MM> [--days MON-FRI] -- <args> | list | remove <name>   timed runs
A run name may contain {date} and {time} (e.g. daily-{date}).
Each run keeps a live page, <state_dir>/runs/<run>.md: diagram coloured by progress, step table, gate, log tail,
tokens and cost.
"""
import getpass
import importlib.util
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

from . import engine, project as projmod
from .project import CONFIG_DIR, CONFIG_FILE

TEMPLATES = Path(__file__).resolve().parent / "templates"


# ---------------------------------------------------------------- workflows

def load_workflow(name: str):
    p = projmod.current()
    for d in (p.checks_dir, p.workflows_dir):
        if d.is_dir() and str(d) not in sys.path:
            sys.path.insert(0, str(d))
    f = p.workflows_dir / f"{name}.py"
    if not f.is_file():
        raise SystemExit(f"no workflow '{name}' in {p.rel(p.workflows_dir)}")
    spec = importlib.util.spec_from_file_location(f"langflow_workflow_{name}", f)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def app_for(workflow: str, args: dict):
    from langgraph.checkpoint.sqlite import SqliteSaver
    mod = load_workflow(workflow)
    p = projmod.current()
    p.state_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p.state_dir / "checkpoints.sqlite", check_same_thread=False)
    graph, _ = engine.build(mod.steps(args))
    return graph.compile(checkpointer=SqliteSaver(conn))


def layout_of(workflow: str, args: dict) -> dict:
    steps = load_workflow(workflow).steps(args)
    graph, kinds = engine.build(steps)
    try:
        rows = step_rows(workflow, steps, args)
    except ValueError:                                  # a broken bindings.toml must not hide the graph
        rows = step_rows(workflow, steps, args, bindings={})
    return engine.layout(graph.compile(), kinds, rows)


# ---------------------------------------------------------------- role and skill bindings (catalog.py)

def step_rows(workflow: str, steps, args: dict, bindings: dict | None = None) -> list[dict]:
    """catalog.step_rows for a workflow's steps with the project's bindings.toml (ValueError when it is broken)."""
    from . import catalog
    if bindings is None:
        bindings = catalog.read_bindings(projmod.current())
    return catalog.step_rows(workflow, steps, bindings, args)


def binding_problems(workflow: str, mod, args: dict) -> tuple[list[dict], list[str]]:
    """(rows, problems): every role and skill an ai step of the workflow will run with must exist."""
    from . import catalog
    try:
        rows = step_rows(workflow, mod.steps(args), args)
    except ValueError as e:
        return [], [str(e)]
    return rows, catalog.preflight(projmod.current(), rows)


def all_step_rows() -> tuple[list[dict], list[str]]:
    """(rows of every workflow's ai steps, warnings): for `langflow skills|roles` and the web catalog. A workflow
    that does not build without its args is skipped with a warning."""
    from . import catalog
    p, rows, warn = projmod.current(), [], []
    try:
        bindings = catalog.read_bindings(p)
    except ValueError as e:
        bindings, warn = {}, [str(e)]
    for f in sorted(p.workflows_dir.glob("*.py")) if p.workflows_dir.is_dir() else []:
        if f.stem.startswith("_"):
            continue
        args = {"_run": "RUN", "_workflow": f.stem}
        try:
            rows += catalog.step_rows(f.stem, load_workflow(f.stem).steps(args), bindings, args)
        except BaseException as e:  # noqa: BLE001 - one broken workflow must not hide the others
            warn.append(f"workflow {f.stem}: {type(e).__name__}: {e}")
    return rows, warn


def note_binding_drift(run: str, st: dict):
    """On continue: log a `binding changed` event for every step whose role or skill files changed since it ran."""
    for step, changes in engine.binding_drift(st).items():
        engine.write_status(run, event={"step": step, "kind": "ai", "event": "binding changed", "changes": changes})


def _cfg(run):
    return {"configurable": {"thread_id": run}}


def _positive_int(value) -> int | None:
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def concurrency_of(args: dict) -> int | None:
    """How many steps of a run may run at the same time (fan-out workers, parallel branches): the run arg
    `concurrency=N`, else [run] max_concurrency in config.toml, else None (no limit). LangGraph max_concurrency."""
    if "concurrency" in (args or {}):
        n = _positive_int(args["concurrency"])
        if n:
            return n
    return projmod.current().max_concurrency


def advance(app, run, payload) -> tuple[str, str]:
    """Run until the next gate or the end. Returns (state, message); state is waiting, done, rejected, failed,
    cancelled or stopped. Used by the commands, `langflow ui` and `langflow web` (in a worker thread).
    The status keeps this process's pid, so `langflow stop` can tell a live run from one whose process is gone."""
    st = engine.write_status(run, pid=os.getpid())
    cfg = _cfg(run)
    limit = concurrency_of(st.get("args") or {})
    if limit:
        cfg["max_concurrency"] = limit
    try:
        app.invoke(payload, cfg, durability="sync")
    except engine.RunCancelled as e:
        engine.settle_cancel(run)
        return "cancelled", str(e)
    except engine.StepFailed as e:
        if engine.settle_cancel(run):
            return "cancelled", str(e)
        return "failed", str(e)
    s = engine.summary(app.get_state(_cfg(run)))
    if s["state"] in ("done", "rejected"):
        engine.clear_cancel(run)      # a cancel that came after the last step (e.g. after a claimed gate answer)
        engine.write_status(run, status=s["state"], step=None, gate=None,
                            event={"step": None, "kind": "run", "event": s["state"]})
        return s["state"], ""
    if engine.settle_cancel(run):
        return "cancelled", ""
    return s["state"], ""


def answer_gate(run: str, decision: str, note: str | None, by: str, claimed: bool = False) -> tuple[str, str]:
    """Answer the waiting gate. The answer is first claimed under the run lock (engine.claim_answer), so a cancel
    and an answer at the same moment never both win: a cancel first refuses the answer ("error" with the reason);
    an answer first is applied, then a later cancel stops the run before the next step. claimed=True: the caller
    (web) already claimed it."""
    st, app = _load(run)
    if not claimed:
        try:
            engine.claim_answer(run, by)
        except engine.GateClosed as e:
            return "error", str(e)
    from langgraph.types import Command
    answer = {"decision": decision, "note": note, "by": by, "time": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        return advance(app, run, Command(resume=answer))
    finally:
        engine.release_answer(run)


def continue_run(run: str) -> tuple[str, str]:
    st, app = _load(run)
    if st.get("status") == "waiting":
        return "error", f"run '{run}' waits at a gate; answer it instead"
    engine.clear_cancel(run)
    engine.write_status(run, status="running", error=None, answering=None,
                        event={"step": st.get("step"), "kind": "run", "event": "continue"})
    note_binding_drift(run, st)
    return advance(app, run, None)


def _report(run, state, msg):
    if state == "waiting":
        st = engine.read_status(run)
        print(f"[{run}] waiting at gate '{st.get('gate')}': {st.get('question')}")
        print(f"  {projmod.current().approver} answers in their own terminal: langflow approve {run}  (or langflow ui)")
    elif state == "failed":
        print(f"[{run}] FAILED: {msg}\n  fix the cause, then: langflow continue {run}")
        sys.exit(2)
    elif state == "error":
        raise SystemExit(msg)
    elif state == "cancelled":
        print(f"[{run}] cancelled. `langflow continue {run}` re-runs the cut step.")
    else:
        print(f"[{run}] {state}")


def _invoke(app, run, payload):
    _report(run, *advance(app, run, payload))


# ---------------------------------------------------------------- commands

def cmd_init():
    root = Path.cwd()
    d = root / CONFIG_DIR
    (d / "workflows").mkdir(parents=True, exist_ok=True)
    (d / "checks").mkdir(exist_ok=True)
    skill = TEMPLATES / "skills" / "langflow-design" / "SKILL.md"     # points agents to `langflow guide`
    files = [(TEMPLATES / "config.toml", d / CONFIG_FILE), (TEMPLATES / "smoke.py", d / "workflows" / "smoke.py"),
             *((skill, root / folder / "langflow-design" / "SKILL.md")
               for folder in (".claude/skills", ".agents/skills"))]
    for src, dst in files:
        if dst.exists():
            same = dst.read_bytes() == src.read_bytes()
            note = "" if same or src != skill else " (differs from langflow's copy: delete it to update)"
            print(f"kept    {dst}{note}")
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            print(f"created {dst}")
    print(f"\nNext:\n  1. edit {CONFIG_DIR}/{CONFIG_FILE} (approver, models, hook_check)\n"
          f"  2. add '/{CONFIG_DIR}/state/' to .gitignore\n  3. register the hooks: langflow hooks\n"
          "  4. test: langflow start smoke smoke-1, then langflow approve smoke-1 in your terminal")


def cmd_hooks():
    exe = shutil.which("langflow-guard") or "langflow-guard"
    exe = exe.replace("\\", "/")
    claude = {"hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": exe}]}],
        "PreToolUse": [{"matcher": "Bash|PowerShell", "hooks": [{"type": "command", "command": exe}]},
                       {"matcher": "Edit|Write|MultiEdit", "hooks": [{"type": "command", "command": exe}]}]}}
    codex = {"hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": exe + " --codex"}]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": exe + " --codex"}]},
                       {"matcher": "apply_patch|Edit|Write", "hooks": [{"type": "command", "command": exe + " --codex"}]}]}}
    print("# Claude Code: merge into .claude/settings.json (absolute path: works under bash and PowerShell)")
    print(json.dumps(claude, indent=2))
    print("\n# Codex: merge into .codex/hooks.json, then trust the new hooks with /hooks in Codex")
    print(json.dumps(codex, indent=2))


def expand_run_name(run: str) -> str:
    return run.replace("{date}", time.strftime("%Y%m%d")).replace("{time}", time.strftime("%H%M"))


def prepare_start(workflow: str, run: str, args: dict) -> tuple[str, object, dict]:
    """Check the run name and args, write the first status. Returns (run, app, first payload) for advance().
    Used by `langflow start` and `langflow web`."""
    run = expand_run_name(run)
    if engine.status_path(run).exists():
        raise SystemExit(f"run '{run}' already exists; runs are never reused, pick a new name")
    mod = load_workflow(workflow)
    missing = [k for k in getattr(mod, "REQUIRED", []) if k not in args]
    if missing:
        raise SystemExit(f"workflow '{workflow}' needs: {', '.join(missing)}\n{(mod.__doc__ or '').strip()}")
    if "concurrency" in args and not _positive_int(args["concurrency"]):
        raise SystemExit(f"concurrency={args['concurrency']}: give a whole number of 1 or more")
    _, problems = binding_problems(workflow, mod, {**args, "_run": run, "_workflow": workflow})
    if problems:
        raise SystemExit(f"workflow '{workflow}' cannot start: a role or skill it binds is missing\n  "
                         + "\n  ".join(problems) + f"\nDetails: langflow check {workflow}")
    app = app_for(workflow, args)
    series = getattr(mod, "MEMORY_SERIES", None)
    series = series.format(**args) if series else None
    sargs = {**args, "_run": run, "_workflow": workflow, **({"_series": series} if series else {})}
    graph = layout_of(workflow, sargs)
    engine.write_status(run, workflow=workflow, args=args, series=series, status="running",
                        started=time.strftime("%Y-%m-%d %H:%M:%S"), approver=projmod.current().approver, passed=[],
                        locks=engine.locks_for(mod, args), graph=graph,
                        event={"step": None, "kind": "run", "event": "start"})
    return run, app, {"args": sargs, "results": {}, "decisions": {}, "log": [], "memory": {}}


def cmd_start(workflow, run, pairs):
    args = dict(p.split("=", 1) for p in pairs)
    run, app, payload = prepare_start(workflow, run, args)
    print(f"[{run}] live page: {engine.page_path(run)}\n  follow it: langflow watch {run}")
    if payload["args"].get("_series"):
        from . import memory
        print(f"  series memory '{payload['args']['_series']}': {len(memory.series_entries(payload['args']))} "
              "entries from earlier runs")
    _invoke(app, run, payload)


def cmd_schedule(a: list[str]):
    """langflow schedule add <name> <HH:MM> [--days MON-FRI|MON,WED|DAILY] -- <langflow args ...>
       langflow schedule list
       langflow schedule remove <name>
    Windows Task Scheduler task "langflow\\<project>\\<name>", run as you, only while you are logged on; it starts
    `langflow <args>` in the project root and appends the output to <state_dir>/schedule.log. A run name may use
    {date} and {time}. Gates still wait for a person. Other systems: prints a crontab line instead."""
    from . import schedule
    p = projmod.current()
    if not a or a[0] not in ("add", "list", "remove"):
        raise SystemExit(cmd_schedule.__doc__)
    try:
        if a[0] == "list":
            tasks = schedule.list_tasks(p)
            if not tasks:
                print(f"no langflow tasks for this project (folder {schedule.folder(p)})")
            for t in tasks:
                print(f"{t['name']:18} {t['days']:12} {t['time'] or '?':5}  next {t['next_run'] or '-':19}  "
                      f"last {t['last_run'] or '-':19} {t['last_result'] or '':10} [{t['state'] or '?'}]\n"
                      f"{'':18} langflow {' '.join(t['args']) or t['command']}")
            return
        if a[0] == "remove" and len(a) == 2:
            schedule.remove_task(p, a[1])
            print(f"removed task {schedule.folder(p)}\\{a[1]}")
            return
        if a[0] != "add" or "--" not in a or len(a) < 4:
            raise SystemExit(cmd_schedule.__doc__)
        cut = a.index("--")
        days = a[a.index("--days") + 1] if "--days" in a[:cut] else "DAILY"
        t = schedule.add_task(p, a[1], a[2], days, a[cut + 1:])
        print(f"task {schedule.folder(p)}\\{t['name']}: {t['days']} at {t['time']}, next {t['next_run']}\n"
              f"  {t['command']}")
    except schedule.ScheduleError as e:
        raise SystemExit(str(e))


def cmd_memory(a: list[str]):
    """langflow memory <run>               run memory and its series memory
       langflow memory --series            list series
       langflow memory --clear <workflow> <series>"""
    from . import memory
    if a and a[0] == "--series":
        for ns in memory.list_series():
            print(f"  {ns[1]:16} {ns[2]}")
        return
    if a and a[0] == "--clear" and len(a) == 3:
        print(f"removed {memory.clear_series(a[1], a[2])} entries")
        return
    if len(a) != 1:
        raise SystemExit(cmd_memory.__doc__)
    st, app = _load(a[0])
    values = app.get_state(_cfg(a[0])).values
    print(memory.as_json(values))


def _load(run):
    st = engine.read_status(run)
    if not st:
        raise SystemExit(f"no run '{run}'")
    return st, app_for(st["workflow"], st.get("args", {}))


def cmd_continue(run):
    st, app = _load(run)
    if st.get("status") == "waiting":
        raise SystemExit(f"run '{run}' waits at a gate; it goes on with `langflow approve {run}`")
    engine.clear_cancel(run)
    engine.write_status(run, status="running", error=None, answering=None,
                        event={"step": st.get("step"), "kind": "run", "event": "continue"})
    note_binding_drift(run, st)
    _invoke(app, run, None)


def _is_console() -> bool:
    """A real console only. On Windows isatty() is also True for NUL, which is what agent shells get."""
    if os.name != "nt":
        return sys.stdin.isatty()
    import ctypes
    import msvcrt
    try:
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except (OSError, ValueError):
        return False
    mode = ctypes.c_uint32()
    return bool(ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)))


def cmd_approve(run, reject, note):
    st, app = _load(run)
    if st.get("status") == "cancelled":
        raise SystemExit(f"run '{run}' was cancelled; the answer was not applied. `langflow continue {run}` makes gate "
                         f"'{st.get('step')}' wait again")
    if st.get("status") != "waiting":
        raise SystemExit(f"run '{run}' is not waiting at a gate (status: {st.get('status')})")
    p = projmod.current()
    console = _is_console()
    if not console and not p.allow_agent_approval:
        raise SystemExit(f"approve needs an interactive console: gates are answered by {p.approver}, not by an agent "
                         "(on Windows use PowerShell / Windows Terminal, not mintty). Demo/test projects can set "
                         "[project] allow_agent_approval = true")
    decision = "reject" if reject else "approve"
    print(f"Run {run} ({st['workflow']}), gate '{st['gate']}':\n  {st['question']}\nDecision: {decision.upper()}")
    if note:
        print(f"Note: {note}")
    if console:
        if input("Type the run name to confirm: ").strip() != run:
            raise SystemExit("not confirmed; nothing changed")
        by = getpass.getuser()
    else:
        by = "agent"
        print("No console: answered as 'agent' (allow_agent_approval = true in this project).")
    try:
        engine.claim_answer(run, by)      # under the run lock: a cancel that came first wins (see answer_gate)
    except engine.GateClosed as e:
        raise SystemExit(str(e))
    answer = {"decision": decision, "note": note, "by": by, "time": time.strftime("%Y-%m-%d %H:%M:%S")}
    from langgraph.types import Command
    try:
        _invoke(app, run, Command(resume=answer))
    finally:
        engine.release_answer(run)


def _opt(a: list[str], name: str, default=None):
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else default


def _confirm(question: str, yes: bool) -> bool:
    """--yes, or a y answer in a real console; anything else is no."""
    if yes:
        return True
    if not _is_console():
        print("not a console: add --yes to confirm")
        return False
    return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")


def _print_deleted(r: dict):
    print(f"  deleted {r['run']}: {len(r['removed'])} files/folders, {r['checkpoints']} checkpoints"
          + (f"; kept outputs: {', '.join(r['kept_outputs'])}" if r["kept_outputs"] else ""))


def cmd_rm(a: list[str]):
    """langflow rm <run> [<run> ...] [--force] [--yes]: delete runs' state (outputs and series memory stay)."""
    runs = [x for x in a if not x.startswith("--")]
    if not runs:
        raise SystemExit("usage: langflow rm <run> [<run> ...] [--force] [--yes]")
    if not _confirm(f"Delete {len(runs)} run(s): {', '.join(runs)}? (outputs and series memory stay)", "--yes" in a):
        raise SystemExit(1)
    by = getpass.getuser() if _is_console() else "agent"
    bad = 0
    for run in runs:
        try:
            _print_deleted(engine.delete_run(run, force="--force" in a, by=by))
        except (engine.RunBusy, LookupError, ValueError, TimeoutError) as e:
            bad += 1
            print(f"  skipped {run}: {e}")
    if bad:
        raise SystemExit(1)


def cmd_prune(a: list[str]):
    """langflow prune [--days N] [--status done,cancelled,...] [--keep N] [--workflow W] [--yes]: without --yes it
    only lists what would be deleted."""
    days = int(_opt(a, "--days", 0)) or None
    statuses = [s for s in (_opt(a, "--status") or ",".join(engine.PRUNE_STATUSES)).split(",") if s]
    keep, wf = int(_opt(a, "--keep", 0)), _opt(a, "--workflow")
    cand = engine.prune_candidates(days, statuses, keep, wf)
    if not cand:
        print("nothing to prune")
        return
    for r in cand:
        print(f"  {r['run']:<24} {str(r['workflow']):<18} {str(r['status']):<10} {r['updated']}")
    if "--yes" not in a:
        print(f"{len(cand)} run(s) would be deleted (outputs and series memory stay). Add --yes to delete them.")
        return
    res = engine.prune_runs(days, statuses, keep, wf, by=getpass.getuser() if _is_console() else "agent")
    for r in res["deleted"]:
        _print_deleted(r)
    for s in res["skipped"]:
        print(f"  skipped {s['run']}: {s['reason']}")


def cmd_stop(run):
    """Cancel a run (any process may ask; the run's own process stops it within about a second)."""
    try:
        state = engine.request_cancel(run, by=getpass.getuser() if _is_console() else "agent")
    except ValueError as e:
        raise SystemExit(str(e))
    if state == "cancelled":
        print(f"[{run}] cancelled. `langflow continue {run}` re-runs the cut step.")
        return
    print(f"[{run}] cancel requested; waiting for the run to stop ...")
    for _ in range(60):
        time.sleep(1)
        st = engine.read_status(run)
        if st.get("status") != "running" and not (st.get("status") == "waiting" and st.get("answering")):
            break                         # (waiting with an answer being applied: the run stops after the gate)
    st = engine.read_status(run)
    print(f"[{run}] {st.get('status')} at step '{st.get('step')}'"
          + ("" if st.get("status") == "cancelled" else " (the request stays until the run's process sees it)"))


def cmd_status(run):
    if not run:
        return cmd_list()
    st = engine.read_status(run)
    if not st:
        raise SystemExit(f"no run '{run}'")
    show = {k: v for k, v in st.items() if k not in ("history", "steps", "locks", "graph")}
    print(json.dumps(show, ensure_ascii=False, indent=2))
    if st.get("totals"):
        from . import view
        print("spend:", view.totals_line(st["totals"]))
    print(f"page: {engine.page_path(run)}\nlog:  {engine.log_path(run)}")
    for h in st.get("history", [])[-12:]:
        print(" ", h["time"], h.get("step"), h.get("kind"), h.get("event"),
              {k: v for k, v in h.items() if k not in ("time", "step", "kind", "event")} or "")


def cmd_watch(run):
    if not engine.read_status(run):
        raise SystemExit(f"no run '{run}'")
    log = engine.log_path(run)
    print(f"page: {engine.page_path(run)}   (Ctrl-C stops watching, not the run)")
    for line in (log.read_text(encoding="utf-8").splitlines() if log.exists() else [])[-20:]:
        print(line)
    pos, last = (log.stat().st_size if log.exists() else 0), None
    try:
        while True:
            if log.exists() and log.stat().st_size > pos:
                with open(log, "rb") as f:
                    f.seek(pos)
                    chunk = f.read()
                pos += len(chunk)
                print(chunk.decode("utf-8", "replace"), end="", flush=True)
            st = engine.read_status(run)
            state = (st.get("status"), st.get("gate"))
            if state != last and st.get("status") in ("done", "rejected", "failed", "waiting", "cancelled"):
                print(f"--- {run}: {st.get('status')}" + (f" at gate '{st.get('gate')}'" if st.get("gate") else ""),
                      flush=True)
                if st.get("status") in ("done", "rejected", "cancelled"):
                    return
            last = state
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def cmd_graph(workflow):
    from . import view
    mod = load_workflow(workflow)
    graph = layout_of(workflow, {"_run": "RUN"})
    out = projmod.current().state_dir / "graphs" / f"{workflow}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"# Workflow `{workflow}`\n\n{getattr(mod, 'META', {}).get('description', '')}\n\n"
                   f"```mermaid\n{view.mermaid(graph)}\n```\n\nColours: blue = AI step, grey = script, "
                   "green = file written by the runner, orange = gate for a person, purple = route or loop check, "
                   "yellow = fan-out, parallel and join. Dotted arrows are conditional.\n\n"
                   f"```text\n{(mod.__doc__ or '').strip()}\n```\n", encoding="utf-8")
    print(out)


def cmd_check(workflow: str, pairs: list[str]) -> int:
    from . import catalog, design
    n_cost = 0
    mod = load_workflow(workflow)
    args = {**dict(p.split("=", 1) for p in pairs), "_run": "RUN", "_workflow": workflow}
    try:
        rows, problems = binding_problems(workflow, mod, args)
    except Exception as e:  # noqa: BLE001 - steps(args) may need the workflow's REQUIRED args
        raise SystemExit(f"cannot build workflow '{workflow}' ({type(e).__name__}: {e}); "
                         f"give its args: langflow check {workflow} key=value ...")
    p = projmod.current()
    cm = catalog.config_modes(p)
    print(f"workflow {workflow}: {len(rows)} ai steps (skill_mode {catalog.skill_mode(p)}, role_mode "
          f"{cm.get('role_mode', 'auto')}, retry_mode "
          f"{cm.get('retry_mode', catalog.DEFAULTS['retry_mode'])}, contract "
          f"{'on' if cm.get('contract', True) else 'off'}"
          + (f", native_fallback {cm['native_fallback']}" if cm.get("native_fallback") else "")
          + (", contract in the agent system prompt" if cm.get("contract_system") else "") + ")")
    for r in rows:
        eff = r["effective"]
        d = catalog.step_detail(p, r)
        agent, m = r["agent"] or "claude", d["modes"]
        how = ""
        if d["role"]:
            src = "--agent" if m["role_mode"] == "agent" and agent == "claude" else f"{d['role']['source']} file"
            how = f" [{m['role_mode']} · {src}]"
        elif eff["role"]:
            how = " [MISSING]"
        frm = eff["from"]["role"]
        if m["from"]["role_mode"] not in (None, "default"):
            frm += f", mode {m['from']['role_mode']}"
        role = f"{eff['role']}{how} ({frm})" if eff["role"] else "-"
        sfrm = eff["from"]["skills"]
        if eff["skills"] and m["from"]["skill_mode"] not in (None, "default", "config"):
            sfrm += f", {m['skill_mode']} {m['from']['skill_mode']}"
        skills = f"{', '.join(eff['skills'])} ({sfrm})" if eff["skills"] else "-"
        step = f"{r['step']}[*]" if r.get("fanout") else r["step"]
        print(f"  {step:20} {str(agent):9} role {role:42} skills {skills}"
              + (f"  (fan-out workers, binding {r['fanout']})" if r.get("fanout") else "")
              + ("" if m["contract"] or not (eff["role"] or eff["skills"]) else "  (no step contract)")
              + (f"  (retry {m['retry_mode']}, {m['from']['retry_mode']})"
                 if m["from"]["retry_mode"] not in ("default", "config") else ""))
        for s in d["skills"]:
            cli = s["cli"]
            line = f"{s['via']} {s['path']} #{s['sha256'][:8]}"
            if cli and (cli["path"] != s["path"] or cli["sha256"] != s["sha256"]):
                line += f"; {agent} loads {cli['path']} #{cli['sha256'][:8]}"
            elif cli is None and agent in catalog.CLI_SKILL_DIRS:
                line += f"; {agent} has no copy of its own"
            print(f"  {'':20}   skill {s['id']} [{line}]")
        for w in d["warnings"]:
            print(f"  {'':20}   warning: {w}")
        for w in design.cost_warnings(p, r, m, args):
            print(f"  {'':20}   cost: {w}")
            n_cost += 1
    for w in catalog.scan_skills(p)[1] + catalog.scan_roles(p)[1]:
        print(f"  warning: {w}")
    if n_cost:
        print(f"{n_cost} cost warning(s): see `langflow guide`; explain in the workflow's docstring any you keep")
    if problems:
        print("MISSING:\n  " + "\n  ".join(problems))
        return 1
    print("OK: every role and skill exists")
    return 0


def cmd_catalog(kind: str):
    from . import catalog
    rows, warn = all_step_rows()
    c = catalog.catalog(projmod.current(), rows)
    for e in c[kind]:
        used = ", ".join(f"{u['workflow']}.{u['step']}" for u in e.get("used_by", [])) or "-"
        if e.get("missing"):
            print(f"  {e['id']:28} MISSING (used by {used})")
        elif kind == "skills":
            extra = f", shadows {', '.join(s['source'] for s in e['shadowed'])}" if e["shadowed"] else ""
            print(f"  {e['id']:28} [{e['source']}{extra}] {e['description'][:70]}\n  {'':28} used by: {used}")
        else:
            print(f"  {e['id']:28} [{', '.join(e['sources'])}] {e['description'][:70]}\n  {'':28} used by: {used}")
    for w in warn + c["warnings"]:
        print(f"  warning: {w}")


def cmd_list():
    p = projmod.current()
    print(f"project: {p.name} ({p.root})\nworkflows:")
    for f in sorted(p.workflows_dir.glob("*.py")) if p.workflows_dir.exists() else []:
        if f.stem.startswith("_"):
            continue
        print(f"  {f.stem:16} {getattr(load_workflow(f.stem), 'META', {}).get('description', '')}")
    print("runs:")
    for f in sorted(p.runs_dir.glob("*.json")) if p.runs_dir.exists() else []:
        st = json.loads(f.read_text(encoding="utf-8"))
        cost = (st.get("totals") or {}).get("cost_usd")
        print(f"  {st['run']:16} {st.get('workflow', ''):14} {st.get('status', ''):9} step={st.get('step')} "
              f"updated={st.get('updated')}" + (f" cost=${cost:.2f}" if cost is not None else ""))


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    if a[0] in ("-V", "--version", "version"):
        from . import __version__
        print(f"langflow {__version__}")
        return
    c = a[0]
    if c == "init":
        return cmd_init()
    if c == "hooks":
        return cmd_hooks()
    if c == "guide":
        from . import design
        print(f"# {design.GUIDE}\n\n{design.guide_text()}")
        return
    projmod.set_current(projmod.load())
    os.chdir(projmod.current().root)
    if c == "list":
        cmd_list()
    elif c == "start" and len(a) >= 3:
        cmd_start(a[1], a[2], a[3:])
    elif c == "status":
        cmd_status(a[1] if len(a) > 1 else None)
    elif c == "memory":
        cmd_memory(a[1:])
    elif c == "schedule":
        cmd_schedule(a[1:])
    elif c == "ui":
        from . import tui
        tui.main()
    elif c == "web":
        from . import web
        web.main(a[1:])
    elif c == "watch" and len(a) == 2:
        cmd_watch(a[1])
    elif c == "check" and len(a) >= 2:
        sys.exit(cmd_check(a[1], a[2:]))
    elif c in ("skills", "roles") and len(a) == 1:
        cmd_catalog(c)
    elif c == "graph" and len(a) == 2:
        cmd_graph(a[1])
    elif c == "continue" and len(a) == 2:
        cmd_continue(a[1])
    elif c == "stop" and len(a) == 2:
        cmd_stop(a[1])
    elif c == "rm" and len(a) >= 2:
        cmd_rm(a[1:])
    elif c == "prune":
        cmd_prune(a[1:])
    elif c == "approve" and len(a) >= 2:
        note = a[a.index("--note") + 1] if "--note" in a else None
        cmd_approve(a[1], "--reject" in a, note)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
