"""Engine: LangGraph keeps the order of the steps and the gates; agents or scripts do the work in each step.

Step kinds (a workflow module returns a list of them from steps(args)):
  ai(name, prompt, schema, agent="claude"|"codex"|"opencode", model=None, tools=..., permission_mode=..., sandbox=...,
     check=None, retries=2, transient=None, role=None, skills=None)
                              one agent call; the answer must match `schema`; `check(result) -> (ok, feedback)` is a
                              deterministic guardrail (the agent retries with the feedback, then the step fails);
                              a transient agent error (rate limit, overload, 5xx, network) is retried after a wait
                              ([retry] in config.toml; transient=N overrides the number of retries, 0 = none);
                              role = an agent definition id, skills = skill ids (catalog.py; overridable in
                              .langflow/bindings.toml and by run args role.<step>= / skills.<step>=)
  script(name, argv)          one command; non-zero exit stops the run
  write(name, path, content, keep_existing=False)   a file written by the runner from the state
  gate(name, question, show=None)   waits for `langflow approve <run>` from a real console; reject ends the run;
                              show = files the person should read (path, list, or callable(state)) -> gate_files;
                              an answer and a cancel at the same moment: the first to take run_lock wins
                              (claim_answer / request_cancel)
  Patterns: route, parallel, fanout(name, items, worker, limit, role=, skills=, agent=), loop (see below).
State: a SQLite checkpoint per run plus a readable status file, a live log and a live page, all in the project's
state_dir. A step cut off by a crash or a cancel runs again from its start on `langflow continue`: keep every step
repeatable.
Usage: every ai step's done/failed event carries `usage` (tokens, cost_usd, cost_source) and the status keeps
`totals`. Cancel: request_cancel(run) (`langflow stop <run>`) writes <runs_dir>/<run>.cancel; the engine checks it
before each node and every second while an agent or a script runs (the process tree is killed), then the status is
`cancelled`.
"""
import getpass
import json
import operator
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any, Callable, TypedDict

import jsonschema
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send, interrupt

from . import catalog
from . import memory as mem
from . import notify
from .agents import AGENTS
from .agents.base import CTX as AGENT_CTX
from .agents.base import AgentCancelled, AgentError, add_usage, is_transient, kill_tree, popen_flags
from .project import current

_LOCK = threading.RLock()   # parallel branches and fan-out workers write the same status file and log


class StepFailed(Exception):
    pass


class RunCancelled(Exception):
    """The run was cancelled (request_cancel). Not a failure: the status is already `cancelled`."""


def _merge(a: dict, b: dict) -> dict:
    return {**(a or {}), **(b or {})}


def _merge_lists(a: dict, b: dict) -> dict:
    out = {k: list(v) for k, v in (a or {}).items()}
    for k, v in (b or {}).items():
        out[k] = out.get(k, []) + list(v)
    return out


class State(TypedDict, total=False):
    args: dict                              # workflow arguments, plus "_run" (the run name)
    results: Annotated[dict, _merge]        # step name -> result
    decisions: Annotated[dict, _merge]      # gate name -> {"decision", "note", "by", "time"}
    fan: Annotated[dict, _merge_lists]      # fan-out name -> [{"index", "item", "result"}, ...]
    memory: Annotated[dict, _merge]         # run memory: key -> {"text", "step", "run", "scope", "time"}
    log: Annotated[list, operator.add]
    item: Any                               # set only in a fan-out worker's input
    index: int


# ---------------------------------------------------------------- status, log, page

def status_path(run: str) -> Path:
    return current().runs_dir / f"{run}.json"


def log_path(run: str) -> Path:
    return current().runs_dir / f"{run}.log"


def page_path(run: str) -> Path:
    return current().runs_dir / f"{run}.md"


def read_status(run: str) -> dict:
    p = status_path(run)
    for i in range(40):     # on Windows an open fails for a moment while a writer replaces the file (_replace)
        try:
            return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        except PermissionError:
            if i == 39:
                raise
            time.sleep(0.025)


def _replace(src: Path, dst: Path, tries: int = 40):
    """os.replace that waits out a reader: on Windows the replace fails while another thread or process (the web
    server, `langflow watch`, the TUI) has the target open for a moment."""
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.025)


def write_status(run: str, **fields) -> dict:
    with _LOCK:
        return _write_status(run, **fields)


def _write_status(run: str, **fields) -> dict:
    current().runs_dir.mkdir(parents=True, exist_ok=True)
    st = read_status(run)
    event = fields.pop("event", None)
    st.update(fields, run=run, updated=time.strftime("%Y-%m-%d %H:%M:%S"))
    if event:
        st.setdefault("history", []).append({"time": st["updated"], **event})
    tmp = status_path(run).with_suffix(".tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    _replace(tmp, status_path(run))
    if event:
        extra = {k: v for k, v in event.items() if k not in ("step", "kind", "event") and v not in (None, "")}
        log_line(run, event.get("step") or "run", f"{event.get('kind')} {event.get('event')}"
                 + (f" {json.dumps(extra, ensure_ascii=False)[:300]}" if extra else ""), page=False)
    render_page(run, st)
    return st


def log_line(run: str, step: str, text: str, page: bool = True):
    with _LOCK:
        current().runs_dir.mkdir(parents=True, exist_ok=True)
        with open(log_path(run), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {step:<14} {' '.join(str(text).split())[:400]}\n")
    if page:
        render_page(run)


def render_page(run: str, st: dict | None = None):
    """Rewrite the live page. A view only: it never fails the run."""
    try:
        from . import view
        with _LOCK:
            st = st or read_status(run)
            tail = log_path(run).read_text(encoding="utf-8").splitlines()[-20:] if log_path(run).exists() else []
            tmp = page_path(run).with_suffix(".mdtmp")
            tmp.write_text(view.page(st, tail), encoding="utf-8")
            os.replace(tmp, page_path(run))
    except Exception:  # noqa: BLE001
        pass


def _run_id(config: RunnableConfig) -> str:
    return config["configurable"]["thread_id"]


_SAY = threading.local()


def say(text: str):
    """Live log line for the ai step running in this thread."""
    target = getattr(_SAY, "target", None)
    if target:
        log_line(target[0], target[1], text)


# ---------------------------------------------------------------- cancel

FINAL = ("done", "rejected", "cancelled")


def cancel_path(run: str) -> Path:
    return current().runs_dir / f"{run}.cancel"


def cancel_requested(run: str) -> dict | None:
    """The cancel request of a run ({"by", "time"}), or None."""
    p = cancel_path(run)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}


def clear_cancel(run: str):
    try:
        cancel_path(run).unlink()
    except FileNotFoundError:
        pass


def _pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if sys.platform == "win32":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)       # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259   # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


_HELD = threading.local()      # run -> depth of run_lock held by this thread


@contextmanager
def run_lock(run: str, timeout: float = 15.0):
    """Lock one run's gate / cancel transitions across threads and processes (<runs_dir>/<run>.lock, held for a
    status read and write only). Re-entrant in a thread. A gate answer and a cancel both take it, so the first one
    decides: see claim_answer and request_cancel."""
    held = getattr(_HELD, "runs", None)
    if held is None:
        held = _HELD.runs = {}
    with _LOCK:
        if held.get(run):
            held[run] += 1
            try:
                yield
            finally:
                held[run] -= 1
            return
        current().runs_dir.mkdir(parents=True, exist_ok=True)
        fd = os.open(current().runs_dir / f"{run}.lock", os.O_RDWR | os.O_CREAT, 0o644)
        try:
            end = time.time() + timeout
            while True:
                try:
                    if sys.platform == "win32":
                        import msvcrt
                        os.lseek(fd, 0, 0)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() > end:
                        raise TimeoutError(f"run '{run}': lock {run}.lock held by another process for {timeout:.0f} s")
                    time.sleep(0.05)
            held[run] = 1
            try:
                yield
            finally:
                held[run] = 0
                if sys.platform == "win32":
                    import msvcrt
                    os.lseek(fd, 0, 0)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def mark_cancelled(run: str, step: str | None, by: str | None):
    """Status `cancelled` with one `cancelled` event (idempotent: parallel branches may all see the request)."""
    with _LOCK:
        st = read_status(run)
        if st.get("status") == "cancelled":
            return
        write_status(run, status="cancelled", gate=None, question=None, gate_files=None, error=None, answering=None,
                     **({"step": step} if step else {}),
                     event={"step": step, "kind": "run", "event": "cancelled", "by": by})


def _live_claim(st: dict) -> dict | None:
    """The gate answer claimed by a live process (claim_answer) while the status still says waiting, or None."""
    c = st.get("answering")
    return c if st.get("status") == "waiting" and isinstance(c, dict) and _pid_alive(c.get("pid")) else None


def request_cancel(run: str, by: str | None = None) -> str:
    """Ask a run to stop. Writes <runs_dir>/<run>.cancel ({"by", "time"}). A run waiting at a gate, a failed run, or a
    `running` run whose process is gone is cancelled at once (returns "cancelled"); a run being worked on by a live
    process stops within about a second, at the next node or from the watch on its agent or script (returns
    "requested"). Raises ValueError when there is no such run or it is done, rejected or already cancelled.
    `langflow continue <run>` re-runs the cut step (a gate waits again).
    Against a gate answer, the first to take run_lock wins: a cancel first refuses the answer (claim_answer); an
    answer already claimed is applied, then the run stops before the next step ("requested")."""
    by = by or getpass.getuser()
    if not status_path(run).exists():
        raise ValueError(f"no run '{run}'")
    with run_lock(run):
        st = read_status(run)
        if not st:
            raise ValueError(f"no run '{run}'")
        status = st.get("status")
        if status in FINAL:
            raise ValueError(f"run '{run}' is {status}; nothing to cancel")
        cancel_path(run).write_text(json.dumps({"by": by, "time": time.strftime("%Y-%m-%d %H:%M:%S")}),
                                    encoding="utf-8")
        claim = _live_claim(st)
        if not claim and (status in ("waiting", "failed") or (status == "running" and not _pid_alive(st.get("pid")))):
            mark_cancelled(run, st.get("step"), by)
            clear_cancel(run)
            return "cancelled"
    log_line(run, st.get("step") or "run", f"cancel requested by {by}" + (
        f" (gate answer by {claim.get('by')} came first: it is applied, then the run stops)" if claim else ""))
    return "requested"


# ---------------------------------------------------------------- delete and prune

PRUNE_STATUSES = ("done", "cancelled", "failed", "rejected")


class RunBusy(ValueError):
    """A run that may not be deleted now (running, an answer being applied, or waiting without force)."""


def _safe_run_name(run: str):
    if not run or any(c in run for c in "\\/:*?\"<>|") or ".." in run:
        raise ValueError(f"bad run name {run!r}")


def run_outputs(st: dict) -> list[str]:
    """Files a run wrote or showed at a gate (history events with `path`, gate_files): kept by delete_run."""
    out = [h["path"] for h in st.get("history") or [] if isinstance(h.get("path"), str)]
    out += [f for f in st.get("gate_files") or [] if isinstance(f, str)]
    return list(dict.fromkeys(out))


def delete_run(run: str, force: bool = False, by: str | None = None) -> dict:
    """Delete a run's state: <runs_dir>/<run>.json/.log/.md/.cancel/.lock, the <runs_dir>/<run>/ folder, its
    checkpoints (checkpoints.sqlite, thread = run) and its OpenCode transcript copies (<state_dir>/opencode/<session>.json).
    Keeps what the run wrote (outputs, e.g. reports) and the series memory (memory.sqlite), so later runs of the same
    series still see it. Refuses (RunBusy) a run whose process is working on it or whose gate answer is being applied;
    a run waiting at a gate needs force=True (its gate is dropped). Raises LookupError for an unknown run. Each delete
    is logged to <state_dir>/deleted.log."""
    _safe_run_name(run)
    p = current()
    sp, folder = status_path(run), p.runs_dir / run
    if not sp.exists() and not folder.exists():
        raise LookupError(f"no run '{run}'")
    with run_lock(run):
        st = read_status(run) if sp.exists() else {}
        status = st.get("status")
        if status == "running" and _pid_alive(st.get("pid")):
            raise RunBusy(f"run '{run}' is running (pid {st.get('pid')}); stop it first (langflow stop {run})")
        if _live_claim(st):
            raise RunBusy(f"run '{run}': a gate answer is being applied; try again in a moment")
        if status == "waiting" and not force:
            raise RunBusy(f"run '{run}' is waiting at gate '{st.get('gate')}'; use force to delete it")
        removed = []
        for f in (sp, log_path(run), page_path(run), cancel_path(run)):
            try:
                f.unlink()
                removed.append(p.rel(f))
            except FileNotFoundError:
                pass
        if folder.is_dir():
            import shutil
            shutil.rmtree(folder, ignore_errors=True)
            removed.append(p.rel(folder))
        oc = p.state_dir / "opencode"
        for h in st.get("history") or []:
            sid = h.get("session")
            f = oc / f"{sid}.json" if isinstance(sid, str) and sid.startswith("ses_") else None
            if f and f.is_file():
                f.unlink()
                removed.append(p.rel(f))
        checkpoints = 0
        db = p.state_dir / "checkpoints.sqlite"
        if db.is_file():
            import sqlite3
            from langgraph.checkpoint.sqlite import SqliteSaver
            conn = sqlite3.connect(db, check_same_thread=False)
            try:
                try:
                    checkpoints = conn.execute("SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?",
                                               (run,)).fetchone()[0]
                except sqlite3.OperationalError:
                    checkpoints = 0
                if checkpoints:
                    SqliteSaver(conn).delete_thread(run)
            finally:
                conn.close()
    try:
        (p.runs_dir / f"{run}.lock").unlink()
    except OSError:
        pass
    kept = [p.rel(Path(f)) for f in run_outputs(st) if Path(f).exists()]
    try:
        with open(p.state_dir / "deleted.log", "a", encoding="utf-8") as f:
            f.write(json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "run": run, "workflow": st.get("workflow"),
                                "status": status, "by": by or getpass.getuser(), "checkpoints": checkpoints,
                                "kept_outputs": kept}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"run": run, "removed": removed, "checkpoints": checkpoints, "kept_outputs": kept}


def list_runs() -> list[dict]:
    """{run, workflow, status, updated} of every run with a status file, newest first."""
    d = current().runs_dir
    out = []
    for f in d.glob("*.json") if d.is_dir() else []:
        st = read_status(f.stem)
        if st:
            out.append({"run": f.stem, "workflow": st.get("workflow"), "status": st.get("status"),
                        "updated": st.get("updated") or st.get("started") or ""})
    return sorted(out, key=lambda r: r["updated"], reverse=True)


def prune_candidates(days: int | None = None, statuses=PRUNE_STATUSES, keep: int = 0,
                     workflow: str | None = None) -> list[dict]:
    """Runs to delete: status in `statuses`, not updated for `days` days (when given), of `workflow` (when given),
    leaving the newest `keep` runs of each workflow (counted over all its runs, whatever their status)."""
    statuses = tuple(statuses or PRUNE_STATUSES)
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - days * 86400)) if days else None
    seen: dict = {}
    out = []
    for r in list_runs():
        n = seen[r["workflow"]] = seen.get(r["workflow"], 0) + 1
        if workflow and r["workflow"] != workflow:
            continue
        if n <= keep or r["status"] not in statuses or (cutoff and r["updated"] > cutoff):
            continue
        out.append(r)
    return out


def prune_runs(days: int | None = None, statuses=PRUNE_STATUSES, keep: int = 0, workflow: str | None = None,
               dry_run: bool = False, by: str | None = None) -> dict:
    """prune_candidates, then delete_run on each. A waiting run is a candidate only when "waiting" is in `statuses`
    (then it is deleted with force). Returns {candidates, deleted, skipped}."""
    cand = prune_candidates(days, statuses, keep, workflow)
    deleted, skipped = [], []
    if not dry_run:
        for r in cand:
            try:
                deleted.append(delete_run(r["run"], force=r["status"] == "waiting", by=by))
            except (RunBusy, LookupError, OSError, TimeoutError) as e:
                skipped.append({"run": r["run"], "reason": str(e)})
    return {"candidates": cand, "deleted": deleted, "skipped": skipped}


class GateClosed(ValueError):
    """A gate answer that cannot be applied: the run is not waiting, was cancelled first, or is being answered."""


def claim_answer(run: str, by: str) -> dict:
    """Reserve the waiting gate of a run for one answer, under run_lock, before the graph resumes. Raises GateClosed
    when the run is not waiting, when a cancel came first (status cancelled, or a cancel request pending), or when
    another live process already claimed it. Returns the status read. The gate node clears the claim when it takes
    the answer; release_answer clears a claim the gate never took."""
    if not status_path(run).exists():
        raise GateClosed(f"no run '{run}'")
    with run_lock(run):
        st = read_status(run)
        flag = cancel_requested(run)
        if st.get("status") == "cancelled" or flag is not None:
            who = (flag or {}).get("by") or next((h.get("by") for h in reversed(st.get("history", []))
                                                  if h.get("event") == "cancelled"), None)
            raise GateClosed(f"run '{run}' was cancelled{f' by {who}' if who else ''} before this answer; the answer "
                             f"was not applied. `langflow continue {run}` makes gate '{st.get('step')}' wait again")
        if st.get("status") != "waiting":
            raise GateClosed(f"run '{run}' is not waiting at a gate (status: {st.get('status')})")
        claim = _live_claim(st)
        if claim:
            raise GateClosed(f"gate '{st.get('gate')}' of run '{run}' is already being answered by {claim.get('by')}")
        write_status(run, pid=os.getpid(), answering={"by": by, "pid": os.getpid(), "gate": st.get("gate"),
                                                      "time": time.strftime("%Y-%m-%d %H:%M:%S")})
        return st


def release_answer(run: str):
    """Clear this process's gate claim when the gate did not take the answer (an error before it ran)."""
    with run_lock(run):
        st = read_status(run)
        c = st.get("answering")
        if isinstance(c, dict) and c.get("pid") == os.getpid():
            write_status(run, answering=None)


def check_cancel(run: str, step: str | None):
    """Raise RunCancelled (after marking the status) when a cancel was requested."""
    flag = cancel_requested(run)
    if flag is not None:
        mark_cancelled(run, step, flag.get("by"))
        raise RunCancelled(f"run '{run}' cancelled by {flag.get('by') or '?'} at step '{step}'")


def settle_cancel(run: str) -> bool:
    """After the graph stopped (any reason): apply a cancel request that is still pending and remove the flag.
    Returns True when the run is cancelled."""
    flag = cancel_requested(run)
    st = read_status(run)
    if flag is not None:
        if st.get("status") in ("running", "waiting", "failed"):
            mark_cancelled(run, st.get("step"), flag.get("by"))
        clear_cancel(run)
        st = read_status(run)
    return st.get("status") == "cancelled"


def _sleep_or_cancel(run: str, step: str, seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        check_cancel(run, step)
        time.sleep(min(1.0, max(0.0, end - time.time())))
    check_cancel(run, step)


# ---------------------------------------------------------------- usage and cost

TOTAL_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")


def price(project, models: list, use: dict) -> float | None:
    """Cost in USD from [pricing."<model>"] (USD per million tokens), or None when the model has no price.
    A missing cache_read / cache_write price counts as the input price."""
    p = project.price_of(*models)
    if not p:
        return None
    inp = float(p.get("input", 0))
    return (use.get("input_tokens", 0) * inp + use.get("output_tokens", 0) * float(p.get("output", 0))
            + use.get("cache_read_tokens", 0) * float(p.get("cache_read", inp))
            + use.get("cache_write_tokens", 0) * float(p.get("cache_write", inp))) / 1e6


class _Spend:
    """Tokens and cost of one ai step over all its agent calls (guardrail rounds and transient retries)."""

    def __init__(self, project, models: list):
        self.project, self.models = project, models
        self.use = add_usage({}, {})
        self.cost, self.sources, self.calls = 0.0, set(), 0

    def add(self, use: dict | None, cost: float | None, model_used: str | None = None):
        self.calls += 1
        use = add_usage({}, use)
        self.use = add_usage(self.use, use)
        if cost is None and any(use.values()):
            cost = price(self.project, [model_used, *self.models], use)
            src = "pricing"
        else:
            src = "agent"
        if cost is not None:
            self.cost += float(cost)
            self.sources.add(src)

    def event(self) -> dict:
        known = bool(self.sources)
        return {**self.use, "cost_usd": round(self.cost, 6) if known else None,
                "cost_source": ("agent" if "agent" in self.sources else "pricing") if known else None}


def _totals(old: dict | None, use: dict, seconds: float) -> dict:
    t = dict(old or {})
    out = {k: int(t.get(k) or 0) + int(use.get(k) or 0) for k in TOTAL_KEYS}
    cost = t.get("cost_usd")
    if use.get("cost_usd") is not None:
        cost = round((cost or 0) + use["cost_usd"], 6)
    out.update(cost_usd=cost, ai_seconds=round(float(t.get("ai_seconds") or 0) + seconds, 1),
               steps=int(t.get("steps") or 0) + 1)
    return out


def _step_end(run: str, event: dict, seconds: float, **fields):
    """Write an ai step's done/failed event and add its spend (event["usage"]) to the status totals in one update."""
    with _LOCK:
        totals = _totals(read_status(run).get("totals"), event.get("usage") or {}, seconds)
        return write_status(run, totals=totals, event=event, **fields)


# ---------------------------------------------------------------- step kinds

def ai(name: str, prompt: str | Callable[[State], str], schema: dict, agent: str = "claude", model: str | None = None,
       tools: list[str] | None = None, permission_mode: str | None = None, sandbox: str = "read-only",
       cwd: Path | None = None, timeout: int = 1800, check: Callable[[dict], tuple[bool, str]] | None = None,
       retries: int = 2, memory: list[str] | None = None, effort: str | None = None, transient: int | None = None,
       role: str | None = None, skills: list[str] | None = None, role_mode: str | None = None,
       contract: bool | None = None, skill_mode: str | None = None, native_fallback: str | None = None,
       retry_mode: str | None = None):
    """role: an agent definition id (.claude/agents/<id>.md, .codex/agents/<id>.toml, .langflow/agents/<id>.md);
    skills: skill ids (<skills dir>/<id>/SKILL.md). See catalog.py. Overridden per project in .langflow/bindings.toml
    and per run with role.<step>= / skills.<step>= (run arg > bindings.toml > code). The skills are put before the
    prompt; the role reaches the CLI its own way (role_mode, catalog.modes: "append" = the CLI's system / developer
    prompt, "agent" = Claude --agent, "prompt" = before the prompt; default: Claude --agent when its own file exists,
    else the system prompt; Codex and OpenCode: before the prompt). A native role's model / effort are defaults under
    the step's; its tools only under role_mode "agent" when the step has none, and never Write / Edit / Bash when
    sandbox is "read-only" (role tools never widen the step's rights).
    contract (default true, [catalog] contract): with a role or skills bound, the step contract (catalog.CONTRACT) is
    the prompt's last block (after memory and after guardrail feedback).
    role_mode / contract: per run role_mode.<step>= / contract.<step>=, per project in bindings.toml.
    skill_mode ([catalog] skill_mode, default "inject"): "inject" = the skill text before the prompt, "name" = the
    ids only, "system" = the CLI's system / developer channel (Claude system file, Codex developer_instructions;
    other CLIs: inject), "native" = the CLI loads the skill by itself (Claude agent preload or Skill tool, Codex
    linked $mention, OpenCode skill attachment) and the adapter proves it after the call (`skills_loaded`); a skill
    that cannot be native, or did not load on the first call, uses native_fallback ("system" default, "inject",
    "fail": the step fails) and the step is called again once with it.
    retry_mode ("resume" default, "fresh"): a guardrail retry continues the same CLI session with only the feedback and
    the contract ("resume", Claude, Codex, OpenCode; a failed resume falls back to one fresh call), or starts a new
    session with the whole prompt plus the feedback ("fresh").
    All five mode keys: per run <key>.<step>=, per project in bindings.toml, in [catalog] of config.toml.
    What the step used (paths and sha256) is in its start event as `binding`; a missing role or skill fails the step
    (and `langflow start` / `langflow check` refuse the workflow before it runs).
    memory: scopes the step reads and writes, ["run"] or ["run", "series"] (see memory.py).
    retries: guardrail rounds (check failed). transient: retries of a transient agent error (None = [retry] attempts
    in config.toml, default 3, waits [retry] delays = [15, 60, 180] s); each one is a `retry` event.
    model / effort: for this step; a run can override them at start without editing the workflow:
    `langflow start <wf> <run> model.<step>=opus effort.<step>=high` (or model.*= / effort.*= for every ai step;
    for fan-out workers use the fan-out name). effort: low, medium, high, xhigh, max (mapped per agent).
    Order: run override for the step > run override * > the step's value > [agents.<agent>] default in config."""
    opts = {"tools": tools, "permission_mode": permission_mode, "sandbox": sandbox}

    def pick(state, key, own):
        args, base = state.get("args", {}), name.split("[")[0]
        return args.get(f"{key}.{name}") or args.get(f"{key}.{base}") or args.get(f"{key}.*") or own

    use_schema = mem.augment(schema) if memory else schema
    given = {"role_mode": role_mode, "skill_mode": skill_mode, "native_fallback": native_fallback,
             "retry_mode": retry_mode}
    for k, v in given.items():
        if v is not None and v not in catalog.MODE_VALUES[k]:
            raise ValueError(f"{name}: {k} must be one of {', '.join(catalog.MODE_VALUES[k])}")
    code_binding = {"role": role or None, "skills": list(skills or []),
                    **{k: v for k, v in given.items() if v is not None},
                    **({"contract": bool(contract)} if contract is not None else {})}

    def node(state: State, config: RunnableConfig):
        run, project = _run_id(config), current()
        if agent not in AGENTS:
            raise StepFailed(f"{name}: unknown agent {agent} (known: {', '.join(AGENTS)})")
        meta = getattr(node, "langflow_step", None) or {}    # a fan-out may replace it (fanout(..., role=, skills=))
        code_now = {"role": meta.get("role", code_binding["role"]) or None,
                    "skills": list(meta.get("skills", code_binding["skills"]) or []),
                    **{k: meta.get(k, code_binding.get(k)) for k in catalog.MODE_KEYS
                       if meta.get(k, code_binding.get(k)) is not None}}
        eff, bound, problem = step_binding(project, state, name, agent, code_now)
        if problem:
            write_status(run, status="failed", step=name, gate=None, error=f"{name}: {problem}"[:800],
                         event={"step": name, "kind": "ai", "agent": agent, "event": "failed",
                                "role": eff.get("role"), "skills": eff.get("skills") or None, "error": problem[:300]})
            raise StepFailed(f"{name}: {problem}")
        brole = (bound or {}).get("role")
        modes = catalog.modes(project, eff, agent, brole)
        if brole:
            brole = {**brole, "mode": modes["role_mode"]}
            bound = {**bound, "role": brole}
        native = brole if brole and brole.get("native") else {}
        base = (lambda: prompt(state)) if callable(prompt) else (lambda: prompt.format(**state.get("args", {})))
        make0 = (lambda: base() + mem.prompt_block(state, memory)) if memory else base
        bskills = (bound or {}).get("skills") or []         # resolved, each with `via`; a native fallback edits it

        def make():
            pre = catalog.skills_block(bskills)              # only via inject / name go into the prompt
            return f"{pre}\n---\n\n{make0()}" if pre else make0()
        use_contract = bool(bound) and modes["contract"]
        last = catalog.with_contract if use_contract else (lambda t: t)
        text = last(make())
        step_model = pick(state, "model", model) or native.get("model")
        step_effort = pick(state, "effort", effort) or native.get("effort")
        sopts = {**opts, "effort": step_effort, "role": brole,
                 "tools": opts["tools"] or (catalog.role_tools(native.get("tools"), opts["sandbox"])
                                            if modes["role_mode"] == "agent" else None),
                 "step_tools": opts["tools"], "role_mode": modes["role_mode"] if modes["explicit"] else None,
                 "contract": catalog.contract() if use_contract and modes["contract_system"] else None,
                 "run_dir": str(current().runs_dir / run), "step": name,
                 "skill_mode": modes["skill_mode"], "skills": bskills}
        if modes.get("note"):
            log_line(run, name, f"role_mode: {modes['note']}", page=False)
        write_status(run, status="running", step=name, gate=None,
                     event={"step": name, "kind": "ai", "agent": agent, "event": "start",
                            "model": step_model or project.agent(agent).get("default_model"),
                            "effort": step_effort or project.agent(agent).get("default_effort"),
                            **({"role": eff["role"], "skills": eff["skills"], "binding": catalog.record(bound),
                                "role_mode": modes["role_mode"], "contract": use_contract}
                               if bound else {}),
                            **({"skill_mode": modes["skill_mode"]} if bskills else {}),
                            **({"retry_mode": modes["retry_mode"]} if modes["retry_mode"] != "fresh" else {})})
        t0 = time.time()
        _SAY.target = (run, name)
        AGENT_CTX.cancelled = lambda: cancel_path(run).exists()
        spend = _Spend(project, [step_model, project.agent(agent).get("default_model")])
        rcfg = project.retry
        max_transient = rcfg["attempts"] if transient is None else max(0, int(transient))
        delays = rcfg["delays"] or [15]
        retried = 0
        session_cost: dict = {}          # session -> its last reported total cost (cost_scope "session")
        session_use: dict = {}           # session -> its last reported total usage (usage_scope "session")

        def call(prompt_text, extra=None):
            nonlocal retried
            while True:
                try:
                    out = AGENTS[agent](project, prompt_text, use_schema, step_model, {**sopts, **(extra or {})},
                                        Path(cwd or project.root), timeout, say)
                except AgentError as e:
                    spend.add(e.usage, e.cost_usd)
                    if retried < max_transient and is_transient(str(e)):
                        retried += 1
                        wait = float(delays[min(retried - 1, len(delays) - 1)])
                        write_status(run, event={"step": name, "kind": "ai", "event": "retry", "attempt": retried,
                                                 "wait": wait, "error": str(e)[:300]})
                        say(f"transient error, retry {retried}/{max_transient} in {wait:.0f} s: {str(e)[:200]}")
                        _sleep_or_cancel(run, name, wait)
                        continue
                    raise
                sid = out.get("session")
                if out.get("cost_scope") == "session" and isinstance(out.get("cost_usd"), (int, float)):
                    # the CLI reports the session's total so far (Claude after --resume): count only this call
                    raw = float(out["cost_usd"])
                    out["cost_usd"] = max(0.0, raw - session_cost.get(sid, 0.0))
                    session_cost[sid] = raw
                if out.get("usage_scope") == "session" and out.get("usage"):
                    # the same for tokens (Codex `exec resume`: turn.completed.usage is the thread's total)
                    raw = dict(out["usage"])
                    prev = session_use.get(sid) or {}
                    out["usage"] = {k: max(0, int(v or 0) - int(prev.get(k) or 0)) for k, v in raw.items()}
                    session_use[sid] = raw
                spend.add(out.get("usage"), out.get("cost_usd"), out.get("model_used"))
                u = out.get("usage") or {}
                say(f"call {spend.calls}{' (resumed)' if (extra or {}).get('resume') else ''}: input "
                    f"{u.get('input_tokens', 0)}, output {u.get('output_tokens', 0)}, cache read "
                    f"{u.get('cache_read_tokens', 0)}, cache write {u.get('cache_write_tokens', 0)}"
                    + (f", ${out['cost_usd']:.4f}" if isinstance(out.get("cost_usd"), (int, float)) else ""))
                return out

        resumable = modes["retry_mode"] == "resume" and agent in catalog.RESUMABLE
        resumes, fallen = 0, False

        def native_ids():
            return [x["id"] for x in bskills if x.get("via") == "native"]

        try:
            attempt, extra, fresh = 0, None, None
            while True:
                if extra:
                    try:
                        out = call(text, extra)
                        resumes += 1
                    except AgentError as e:
                        # a resume that does not work (session gone, flag refused, no answer): one fresh call
                        say(f"resume failed, fresh retry: {str(e)[:200]}")
                        write_status(run, event={"step": name, "kind": "ai", "event": "resume failed",
                                                 "error": str(e)[:300]})
                        extra, text = None, fresh
                        out = call(text)
                else:
                    out = call(text)
                # native skills: the adapter lists the ones it proved loaded (a resumed call keeps the first load)
                missing = [] if extra else [i for i in native_ids() if i not in (out.get("skills_loaded") or [])]
                if missing:
                    # the CLI did not load a native skill: switch it to native_fallback and call once more (fresh)
                    fb = modes["native_fallback"]
                    if fb == "fail" or fallen:
                        raise StepFailed(f"native skill {', '.join(missing)} did not load"
                                         + (" (native_fallback = fail)" if fb == "fail" else " after the fallback"))
                    for x in bskills:
                        if x["id"] in missing:
                            x["via"] = catalog.skill_via(agent, "native", None, fb, x["path"])[0]
                            x["fallback_reason"] = f"{agent} did not load it natively"
                    fallen = True
                    via = "/".join(sorted({x["via"] for x in bskills if x["id"] in missing}))
                    say(f"native skill {', '.join(missing)} did not load; fresh call with {via}")
                    write_status(run, event={"step": name, "kind": "ai", "event": "native fallback",
                                             "skills": missing, "via": via, "binding": catalog.record(bound)})
                    text, extra = last(make()), None
                    continue
                say(f"done in {time.time() - t0:.0f} s, hooks {out.get('hooks')}"
                    + (f" ({out['hook_note']})" if out.get("hook_note") else "")
                    + (f", transcript {out['transcript']}" if out.get("transcript") else ""))
                jsonschema.validate(out["result"], use_schema)
                out["result"], notes = mem.split(out["result"]) if memory else (out["result"], [])
                ok, feedback = check(out["result"]) if check else (True, "")
                if ok:
                    break
                attempt += 1
                resume = resumable and bool(out.get("session"))
                write_status(run, event={"step": name, "kind": "ai", "event": "check failed", "attempt": attempt,
                                         "feedback": feedback[:300], "resumed": resume})
                if attempt > retries:
                    raise StepFailed(f"guardrail still failing after {retries} retries: {feedback[:600]}")
                fresh = last(make() + ("\n\nYour previous answer failed these deterministic checks. Fix every point "
                                       f"and answer again in full:\n{feedback}\n\nPrevious answer:\n"
                                       f"{json.dumps(out['result'], ensure_ascii=False)}"))
                if resume:
                    # the session already holds the prompt, the role, the skills and the previous answer
                    say(f"retry: resume {out['session']}")
                    text = last("Your previous answer failed these deterministic checks. Fix every point and answer "
                                f"again in full:\n{feedback}")
                    extra = {"resume": out["session"]}
                else:
                    text, extra = fresh, None
        except (AgentCancelled, RunCancelled) as e:
            # cut by a cancel: its spend still counts; the step runs again from its start on `langflow continue`
            secs = round(time.time() - t0, 1)
            with _LOCK:
                _step_end(run, {"step": name, "kind": "ai", "event": "cut", "seconds": secs, "usage": spend.event(),
                                "attempts": spend.calls}, secs)
                mark_cancelled(run, name, (cancel_requested(run) or {}).get("by"))
            if isinstance(e, RunCancelled):
                raise
            raise RunCancelled(f"run '{run}' cancelled at step '{name}'") from e
        except (StepFailed, AgentError, jsonschema.ValidationError) as e:
            secs = round(time.time() - t0, 1)
            _step_end(run, {"step": name, "kind": "ai", "event": "failed", "error": str(e)[:300], "seconds": secs,
                            "usage": spend.event(), "attempts": spend.calls}, secs,
                      status="failed", error=str(e)[:800])
            raise StepFailed(f"{name}: {e}") from e
        finally:
            _SAY.target = None
            AGENT_CTX.cancelled = None
        meta = {k: v for k, v in out.items() if k != "result"}
        update = {"results": {name: out["result"]}, "log": [{"step": name, "agent": agent, **meta}]}
        if notes:
            update["memory"] = remember(run, state, name, notes)
        secs = round(time.time() - t0, 1)
        _step_end(run, {"step": name, "kind": "ai", "event": "done", "seconds": secs, "session": out.get("session"),
                        "hooks": out.get("hooks"), "transcript": out.get("transcript"), "memory": len(notes) or None,
                        "role_channel": out.get("role_channel"),
                        **{k: out[k] for k in ("skill_channel", "skills_loaded") if out.get(k)},
                        **({"resumes": resumes} if resumes else {}),
                        **({"denials": len(out["denials"])} if out.get("denials") else {}),
                        "usage": spend.event(), "attempts": spend.calls},
                  secs)
        return update
    # "cost": read by `langflow check` for its token warnings (design.cost_warnings, DESIGN.md)
    node.langflow_step = {"agent": agent, **code_binding,
                          "cost": {"model": model, "effort": effort, "tools": None if tools is None else list(tools),
                                   "guardrail": check is not None, "retries": retries, "memory": bool(memory)}}
    return name, node, "ai"


def step_binding(project, state: State, name: str, agent: str, code: dict) -> tuple[dict, dict | None, str | None]:
    """(effective {role, skills, from}, resolved binding or None, problem or None) of one ai step: code value,
    .langflow/bindings.toml of the run's workflow, run args role.<step>= / skills.<step>=."""
    args = state.get("args", {}) or {}
    try:
        over = catalog.override_for(catalog.read_bindings(project), args.get("_workflow") or "", name)
        eff = catalog.effective(code, over, args, name)
    except ValueError as e:
        return {"role": code.get("role"), "skills": code.get("skills")}, None, str(e)
    if not eff["role"] and not eff["skills"]:
        return eff, None, None
    try:
        return eff, catalog.resolve(project, agent, eff["role"], eff["skills"],
                                    *catalog.skill_modes(project, eff)), None
    except catalog.BindingError as e:
        return eff, None, "binding: " + "; ".join(e.problems)


def binding_drift(st: dict) -> dict:
    """{step: ["skill x changed (path)", ...]} for every step whose last recorded binding (start event) differs
    from the files now. Used by `langflow continue` and the web run view."""
    last = {}
    for h in st.get("history", []):
        if h.get("event") == "start" and h.get("step"):
            last[h["step"]] = h.get("binding")
    out = {}
    for step, rec in last.items():
        try:
            ch = catalog.changes(current(), rec)
        except OSError as e:
            ch = [f"cannot check: {e}"]
        if ch:
            out[step] = ch
    return out


def remember(run: str, state: State, step: str, notes: list[dict]) -> dict:
    """Store memory entries: series ones in the SqliteStore, all of them in the run memory. Returns the run update."""
    args, run_update = state.get("args", {}), {}
    for n in notes:
        scope = n.get("scope", "run") if mem.series_ns(args) else "run"
        e = mem.entry(n["text"], step, run, scope)
        if scope == "series":
            mem.put_series(args, n["key"], e)
        run_update[n["key"]] = e
        log_line(run, step, f"remember [{scope}] {n['key']}: {n['text']}", page=False)
    with _LOCK:
        recent = (read_status(run).get("memory_recent") or []) + [
            {"key": k, **v} for k, v in run_update.items()]
        write_status(run, memory_recent=recent[-30:])
    return run_update


def script(name: str, argv: list[str] | Callable[[State], list[str]], cwd: Path | None = None, timeout: int = 1800):
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        cmd = [str(c) for c in (argv(state) if callable(argv) else argv)]
        if cmd and not any(sep in cmd[0] for sep in ("/", "\\")):
            # Resolve a bare program name on PATH. On Windows, CreateProcess looks in the parent program's folder
            # first, so a bare "python" would start langflow's own interpreter instead of the project's.
            import shutil
            cmd[0] = shutil.which(cmd[0]) or cmd[0]
        write_status(run, status="running", step=name, gate=None,
                     event={"step": name, "kind": "script", "event": "start", "argv": cmd})
        rc, tail = _run_script(run, name, cmd, cwd or current().root, timeout)
        for line in tail.splitlines()[-8:]:
            log_line(run, name, "| " + line, page=False)
        if rc != 0:
            why = f"time limit of {timeout} s reached, process tree killed" if rc is None else f"exit {rc}"
            write_status(run, status="failed", error=f"{name} {why}: {tail[-500:]}",
                         event={"step": name, "kind": "script", "event": "failed", "exit": rc,
                                **({"error": why} if rc is None else {})})
            raise StepFailed(f"{name}: {why}\n{tail}")
        write_status(run, event={"step": name, "kind": "script", "event": "done"})
        return {"results": {name: {"exit": 0, "output": tail}}}
    return name, node, "script"


def _run_script(run: str, name: str, cmd: list[str], cwd, timeout: int) -> tuple[int | None, str]:
    """Run a script step's command; check the cancel flag every second (kill the tree, raise RunCancelled).
    Returns (exit code, or None when the time limit killed it; last 1500 characters of stdout + stderr)."""
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                         text=True, encoding="utf-8", errors="replace", **popen_flags())
    t0 = time.time()

    def finish():
        kill_tree(p)
        try:
            o, e = p.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            o, e = "", ""
        return ((o or "") + (e or ""))[-1500:]

    while True:
        try:
            out, err = p.communicate(timeout=1)
            return p.returncode, ((out or "") + (err or ""))[-1500:]
        except subprocess.TimeoutExpired:
            pass
        if cancel_path(run).exists():
            tail = finish()
            for line in tail.splitlines()[-4:]:
                log_line(run, name, "| " + line, page=False)
            check_cancel(run, name)
        if time.time() - t0 > timeout:
            return None, finish()


def write(name: str, path: Callable[[State, str], Path], content: Callable[[State], str], keep_existing: bool = False):
    """path(state, run) -> file. Put the run name in it, so a re-run overwrites only its own file.
    keep_existing=True never touches an existing file (a working copy a person edits)."""
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        p = Path(path(state, run))
        if keep_existing and p.exists():
            write_status(run, event={"step": name, "kind": "write", "event": "kept", "path": str(p)})
            return {"results": {name: {"path": str(p), "kept": True}}}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content(state), encoding="utf-8")
        write_status(run, step=name, event={"step": name, "kind": "write", "event": "done", "path": str(p)})
        return {"results": {name: {"path": str(p)}}}
    return name, node, "write"


def gate_files(run: str, name: str, state: State, show) -> list[str]:
    """Absolute paths of the files a gate shows (missing files included; the UI says so). A problem with `show` is
    logged and never stops the gate."""
    if show is None:
        return []
    try:
        val = show(state) if callable(show) else show
        items = val if isinstance(val, (list, tuple)) else [val]
        out = []
        for x in items:
            if x is None or x == "":
                continue
            s = x.format(**state.get("args", {})) if isinstance(x, str) and not callable(show) else str(x)
            p = Path(s)
            p = str((p if p.is_absolute() else current().root / p).resolve())
            if p not in out:
                out.append(p)
        return out
    except Exception as e:  # noqa: BLE001
        log_line(run, name, f"gate show: {type(e).__name__}: {e}", page=False)
        return []


def gate(name: str, question: str | Callable[[State], str], show=None):
    """Waits for a person. Code before interrupt() runs again on resume, so it only writes status.
    show: the files the person reads before answering: a path (str, may use {arg}), a list of paths, or
    callable(state) -> path | list. Relative paths are under the project root. They go to the status as
    `gate_files` while the gate waits (web UI and panel show them inline).
    When the gate starts waiting, the [notify] command of config.toml runs (see notify.py)."""
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        q = question(state) if callable(question) else question.format(**state.get("args", {}))
        files = gate_files(run, name, state, show)
        with run_lock(run):
            st = read_status(run)
            claimed = (st.get("answering") or {}).get("gate") == name
            if st.get("status") == "cancelled" and not claimed:
                # a resume that did not go through claim_answer, after a cancel: the cancel stays
                raise RunCancelled(f"run '{run}' was cancelled at gate '{name}'; the answer was not applied")
            first = st.get("status") != "waiting"
            if first:
                log_line(run, name, f"WAITING for {current().approver}: {q} -> langflow approve {run}", page=False)
            write_status(run, status="waiting", step=name, gate=name, question=q, gate_files=files)
        if first:
            notify.gate_waiting(current(), run, name, q, workflow=state.get("args", {}).get("_workflow"))
        answer = interrupt({"gate": name, "question": q})
        with run_lock(run):
            passed = read_status(run).get("passed", [])
            if answer.get("decision") == "approve" and name not in passed:
                passed = passed + [name]
            write_status(run, status="running", gate=None, question=None, gate_files=None, passed=passed,
                         answering=None, event={"step": name, "kind": "gate", "event": answer.get("decision"),
                                                "note": answer.get("note"), "by": answer.get("by")})
        update = {"decisions": {name: answer}}
        if answer.get("note") or answer.get("decision") != "approve":
            # what the person said at a gate is the most useful memory for the next steps and the next runs
            verb = {"approve": "approved", "reject": "rejected"}.get(answer.get("decision"), answer.get("decision"))
            text = f"{answer.get('by')} {verb} at '{name}' ({q[:120]})" + (
                f": {answer['note']}" if answer.get("note") else "")
            update["memory"] = remember(run, state, name, [{"key": f"gate:{name}:{run}", "text": text,
                                                            "scope": "series"}])
        return update
    return name, node, "gate"


# ---------------------------------------------------------------- graph

# ---------------------------------------------------------------- composite steps (patterns)

def route(name: str, decide: Callable[[State], str], branches: dict[str, list]):
    """Routing: decide(state) returns a branch label (usually from an earlier ai step's answer); the steps of that
    branch run, then the workflow goes on after the route."""
    return name, decide, "route", branches


def parallel(name: str, branches: list):
    """Parallelization: the branches (a step, or a list of steps each) run at the same time; the workflow goes on
    when all are done. Their results are all in state["results"]."""
    return name, None, "parallel", branches


def fanout(name: str, items: Callable[[State], list], worker: Callable[[Any, int], tuple], limit: int = 20,
           role: str | None = None, skills: list[str] | None = None, agent: str | None = None):
    """Orchestrator-worker: items(state) gives the work list (usually a planner ai step's answer); one worker step
    per item runs in parallel (LangGraph Send); results are collected in state["fan"][name] in item order, for a
    synthesizer step after it. worker(item, index) returns an ai or script step.
    role / skills: the binding of every worker's ai step, declared here so `langflow check`, "used by" and the graph
    see it before a worker exists. A declared key replaces the worker ai step's own value at run time (role="" or
    skills=[] = none). agent: the workers' CLI for the check (default: the worker's own, else claude).
    Without a declaration, catalog.walk reads the binding from the worker function's `langflow_step` attribute, or
    from one probe call worker(None, 0) when that returns an ai step (a worker that needs a real item is skipped).
    bindings.toml and run args (role.<name>= / skills.<name>=) use the fan-out name."""
    declared = {k: v for k, v in (("role", role), ("skills", list(skills) if skills is not None else None),
                                  ("agent", agent)) if v is not None}
    return name, items, "fanout", (worker, limit, declared)


def loop(name: str, body: list, until: Callable[[State], bool], max_rounds: int = 3):
    """Evaluator-optimizer: run the body steps (e.g. generate, then evaluate) again until until(state) is true or
    max_rounds is reached; then the workflow goes on. Steps in the body see the previous round's results."""
    return name, until, "loop", (body, max_rounds)


def _note(run, name, kind, event, **extra):
    write_status(run, step=name, event={"step": name, "kind": kind, "event": event, **extra})


def _route_node(name, decide, labels):
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        label = decide(state)
        if label not in labels:
            write_status(run, status="failed", error=f"{name}: route '{label}' not in {labels}",
                         event={"step": name, "kind": "route", "event": "failed", "error": f"unknown route {label}"})
            raise StepFailed(f"{name}: route '{label}' is not one of {labels}")
        _note(run, name, "route", "done", route=label)
        return {"results": {name: {"route": label}}}
    return node


def _mark_node(name, kind):
    def node(state: State, config: RunnableConfig):
        _note(_run_id(config), name, kind, "done")
        return {}
    return node


def _pass_node(state: State, config: RunnableConfig):
    """The end of a parallel branch: writes nothing, logs nothing (the join waits for every branch's marker)."""
    return {}


def _fanout_node(name, items, limit):
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        work = list(items(state))
        if len(work) > limit:
            write_status(run, status="failed", error=f"{name}: {len(work)} items > limit {limit}",
                         event={"step": name, "kind": "fanout", "event": "failed", "items": len(work)})
            raise StepFailed(f"{name}: {len(work)} items, limit {limit}")
        _note(run, name, "fanout", "done", items=len(work))
        return {"results": {name: {"items": work}}}
    return node


def _worker_node(name, worker, declared: dict | None = None):
    def node(payload: dict, config: RunnableConfig):
        item, i = payload["item"], payload["index"]
        step = worker(item, i)          # name it f"{fanout name}[{i}]" so the log and page show which worker
        meta = getattr(step[1], "langflow_step", None) if len(step) > 2 and step[2] == "ai" else None
        if declared and isinstance(meta, dict):
            # fanout(..., role=, skills=) is what check and the graph showed: the worker runs with it
            new = {**meta, **{k: declared[k] for k in ("role", "skills") if k in declared}}
            if declared.get("agent") and declared["agent"] != meta.get("agent"):
                log_line(_run_id(config), step[0], f"fan-out {name} declares agent {declared['agent']}, the worker "
                         f"runs {meta.get('agent')}: the check resolved the binding for {declared['agent']}",
                         page=False)
            step[1].langflow_step = new
        out = step[1](payload, config)
        result = next(iter((out.get("results") or {}).values()), None)
        return {"fan": {name: [{"index": i, "item": item, "result": result}]}, "log": out.get("log", [])}
    return node


def _collect_node(name):
    def node(state: State, config: RunnableConfig):
        got = sorted((state.get("fan") or {}).get(name, []), key=lambda x: x["index"])
        _note(_run_id(config), f"{name}_join", "join", "done", collected=len(got))
        return {"results": {f"{name}_join": {"results": got}}}
    return node


def _loop_check_node(name, until, max_rounds):
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        rnd = (state.get("results", {}).get(name) or {}).get("round", 0) + 1
        ok = bool(until(state))
        stop = ok or rnd >= max_rounds
        _note(run, f"{name}_check", "loop", "done", round=rnd, passed=ok,
              decision="stop" if stop else "again")
        return {"results": {name: {"round": rnd, "passed": ok, "stop": stop}}}
    return node


def _guarded(name, fn, kind=None):
    """Every node checks the cancel request before it starts. Except a gate whose answer was claimed before the
    cancel (claim_answer): it records that answer first, and the next node stops the run."""
    def node(state: State, config: RunnableConfig):
        run = _run_id(config)
        if not (kind == "gate" and (read_status(run).get("answering") or {}).get("gate") == name):
            check_cancel(run, name)
        return fn(state, config)
    return node


class _Builder:
    def __init__(self):
        self.g = StateGraph(State)
        self.kinds: dict[str, str] = {}

    def node(self, name, fn, kind):
        if name in self.kinds:
            raise ValueError(f"step name '{name}' used twice")
        self.kinds[name] = kind
        self.g.add_node(name, _guarded(name, fn, kind))

    def chain(self, steps, after) -> str:
        """Add steps in order, the last one going to `after`; return the first node's name."""
        nxt = after
        for st in reversed(steps if isinstance(steps, list) else [steps]):
            nxt = self.add(st, nxt)
        return nxt

    def add(self, st, nxt) -> str:
        name, fn, kind = st[0], st[1], st[2]
        if kind in ("ai", "script", "write"):
            self.node(name, fn, kind)
            self.g.add_edge(name, nxt)
        elif kind == "gate":
            self.node(name, fn, kind)
            self.g.add_conditional_edges(
                name, lambda s, n=name: "approve" if s["decisions"][n].get("decision") == "approve" else "reject",
                {"approve": nxt, "reject": END})
        elif kind == "route":
            entries = {label: self.chain(br, nxt) for label, br in st[3].items()}
            self.node(name, _route_node(name, fn, list(entries)), "route")
            self.g.add_conditional_edges(name, lambda s, n=name: s["results"][n]["route"], entries)
        elif kind == "parallel":
            # Each branch ends in its own silent marker, and the join waits for all markers (a LangGraph barrier
            # edge). Plain edges from each branch to the join would trigger it once per branch when the branches
            # differ in length (or hold a route, a loop or another parallel): the join and every step after it would
            # then run twice. layout() hides the markers.
            join = f"{name}_join"
            self.node(join, _mark_node(join, "join"), "join")
            self.g.add_edge(join, nxt)
            self.node(name, _mark_node(name, "parallel"), "parallel")
            ends = []
            for i, br in enumerate(st[3]):
                end = f"{name}_branch{i}"
                self.node(end, _pass_node, "branch")
                ends.append(end)
                self.g.add_edge(name, self.chain(br, end))
            self.g.add_edge(ends, join)
        elif kind == "fanout":
            worker, limit = st[3][0], st[3][1]
            declared = st[3][2] if len(st[3]) > 2 else None
            wname, join = f"{name}_worker", f"{name}_join"
            self.node(name, _fanout_node(name, fn, limit), "fanout")
            self.node(wname, _worker_node(name, worker, declared), "worker")
            self.node(join, _collect_node(name), "join")
            self.g.add_edge(wname, join)
            self.g.add_edge(join, nxt)
            self.g.add_conditional_edges(
                name, lambda s, n=name, w=wname, j=join: (
                    [Send(w, {"args": s.get("args", {}), "results": s.get("results", {}),
                              "decisions": s.get("decisions", {}), "item": it, "index": i})
                     for i, it in enumerate(s["results"][n]["items"])] or "empty"),
                {"items": wname, "empty": join})
        elif kind == "loop":
            body, max_rounds = st[3]
            check = f"{name}_check"
            self.node(check, _loop_check_node(name, fn, max_rounds), "loop")
            entry = self.chain(body, check)
            self.g.add_conditional_edges(check, lambda s, n=name: "done" if s["results"][n]["stop"] else "again",
                                         {"again": entry, "done": nxt})
            return entry
        else:
            raise ValueError(f"unknown step kind {kind}")
        return name


def build(steps: list[tuple]) -> tuple[StateGraph, dict]:
    """Steps in order (simple steps and patterns: route, parallel, fanout, loop). After a gate, reject ends the run.
    Returns (graph, kinds) where kinds maps every node name to its kind, for the diagrams."""
    b = _Builder()
    first = b.chain(list(steps), END)
    b.g.add_edge(START, first)
    return b.g, b.kinds


def layout(app, kinds: dict, rows: list[dict] | None = None) -> dict:
    """Nodes and edges of a compiled workflow, for the Mermaid views. rows (catalog.step_rows): ai nodes (and a
    fan-out's `<name>_worker`) get `role` and `skills`, the effective binding."""
    gr = app.get_graph()
    edges = [{"source": e.source, "target": e.target, "label": e.data if isinstance(e.data, str) else None,
              "conditional": bool(e.conditional)} for e in gr.edges]
    # parallel branch markers are plumbing: draw "step -> marker -> join" as "step -> join"
    hidden = {n for n, k in kinds.items() if k == "branch"}
    if hidden:
        after = {e["source"]: e["target"] for e in edges if e["source"] in hidden}
        edges = [{**e, "target": after.get(e["target"], e["target"])} for e in edges if e["source"] not in hidden]
    order, seen, queue = [], set(), ["__start__"]       # breadth-first from start: the order steps run in
    while queue:
        n = queue.pop(0)
        if n in seen:
            continue
        seen.add(n)
        order.append(n)
        queue += [e["target"] for e in edges if e["source"] == n and not (e["label"] == "again")]
    order += [n for n in gr.nodes if n not in seen and n not in hidden]
    nodes = [{"id": n, "kind": kinds.get(n, "start" if n == "__start__" else "end")} for n in order]
    bind = {}
    for r in rows or []:
        bind[r["step"] if kinds.get(r["step"]) == "ai" else f"{r['step']}_worker"] = r["effective"]
    for n in nodes:
        b = bind.get(n["id"])
        if b is not None or n["kind"] == "ai":
            n["role"], n["skills"] = (b or {}).get("role"), list((b or {}).get("skills") or [])
    return {"nodes": [n for n in nodes if n["id"] != "__end__"] + [n for n in nodes if n["id"] == "__end__"],
            "edges": edges}



def locks_for(mod, args: dict) -> list[dict]:
    """A workflow's LOCKS with its args filled in. Each lock: until (gate), paths (globs on the full path with '/'
    and lower case), commands (substrings of a shell command), reason. `langflow-guard` denies a matching edit or
    command in agent sessions while the run is active and the gate is not approved."""
    out = []
    for lk in getattr(mod, "LOCKS", []):
        out.append({"until": lk["until"], "reason": lk["reason"].format(**args),
                    "paths": [p.format(**args).replace("\\", "/").lower() for p in lk.get("paths", [])],
                    "commands": [c.format(**args).lower() for c in lk.get("commands", [])]})
    return out


def summary(st: Any) -> dict:
    if st.next:
        waits = [i.value for t in st.tasks for i in t.interrupts]
        return {"state": "waiting" if waits else "stopped", "next": list(st.next), "interrupts": waits}
    rejected = [g for g, d in (st.values.get("decisions") or {}).items() if d.get("decision") != "approve"]
    return {"state": "rejected" if rejected else "done", "rejected": rejected}
