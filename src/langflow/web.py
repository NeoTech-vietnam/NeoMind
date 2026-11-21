"""langflow web: a local web page and JSON API to watch and drive the runs of the current project.

  langflow web [--port N] [--open]        serve the built app (src/langflow/webui/) and the API on 127.0.0.1
  langflow web --api-only [--port 0] [--stdin-watch]
                                          API only, for the Nimbalyst extension: the first stdout line is
                                          LANGFLOW_WEB {"port": N, "token": "..."}; --stdin-watch stops the
                                          server when stdin closes (the parent process went away)

Every /api request needs the header X-Langflow-Token (a random token made at start; the page gets it from
<meta name="langflow-token"> in index.html). Gates answered here are logged as by "web:<user>" or "panel:<user>"
(header X-Langflow-Channel). State stays in <state_dir>/runs (no new store). One background job per run at a time;
Ctrl-C stops the server and cuts off a running step (`langflow continue <run>` re-runs it).
Also: stats per workflow (usage, cost, gate reject rates), cancel, run outputs and a file preview limited to the
project root and state_dir, run and series memory edit/delete, "propose to KB" through the project's own command
([memory.propose] in config.toml; nothing is applied by langflow), and schedules (langflow.schedule).
Skills and roles (catalog.py): GET /api/catalog, /api/catalog/skill/{id}, /api/catalog/role/{id}; per workflow step
GET /api/workflows/{wf}/bindings, PUT / DELETE /api/workflows/{wf}/bindings/{step} (.langflow/bindings.toml; keys
role, skills, skills_add, role_mode, contract, skill_mode, native_fallback, retry_mode).
API contract: this docstring and README.md (Web UI); the UI's types are in ui/src/types.ts.
"""
import getpass
import hmac
import inspect
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__, argspec, catalog, cli, engine, memory, project as projmod, view

WEBUI = Path(__file__).resolve().parent / "webui"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
MAX_BODY = 1 << 20
MAX_LOG_LINES = 2000
MAX_EVENTS = 300
MAX_TEXT = 2000
MAX_FILE = 512 * 1024                   # file preview: text cap
MAX_MEMORY_TEXT = 20000
MAX_PROPOSE_ENTRIES = 50
MAX_PROPOSE_OUTPUT = 20000
PROPOSE_TIMEOUT = 120
TIME_FMT = "%Y-%m-%d %H:%M:%S"
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")
FINISHED = ("done", "rejected", "cancelled")
HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DAYS_RE = re.compile(r"^(DAILY|MON-FRI|(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*)$")
CMD_SPECIAL = set('&|<>^%"\r\n\0')       # schedule args end up in a `cmd /c` line: refused, not escaped
PROPOSE_ROW = "| {key} | {text} | {source} |"
PLACEHOLDER = "<!-- LANGFLOW_CONFIG -->"
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
FALLBACK_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>langflow</title></head>
<body style="font-family:sans-serif;margin:2em"><h1>langflow web</h1>
<p>The web app is not built (no <code>src/langflow/webui/index.html</code>). Build it with <code>npm run build</code>
in <code>ui/</code>. The JSON API is served under <code>/api</code> (header <code>X-Langflow-Token</code>).</p>
</body></html>"""


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _name(value: str, what: str) -> str:
    if not NAME_RE.match(value or "") or ".." in value:
        raise ApiError(400, f"invalid {what} name '{value}'")
    return value


# ---------------------------------------------------------------- reading state

def read_status(run: str) -> dict:
    """The run's status file, read under the engine lock (on Windows a reader holding the file open makes the
    engine's os.replace fail). Retried briefly when another process replaces it at the same moment."""
    for attempt in range(5):
        try:
            with engine._LOCK:
                return engine.read_status(run)
        except (OSError, ValueError):
            if attempt == 4:
                raise
            time.sleep(0.05)
    return {}


def run_names() -> list[str]:
    d = projmod.current().runs_dir
    return [f.stem for f in d.glob("*.json")] if d.is_dir() else []


def checkpoint_values(run: str) -> dict:
    """Channel values of the run's latest checkpoint, read straight from checkpoints.sqlite (no workflow import)."""
    from langgraph.checkpoint.sqlite import SqliteSaver
    db = projmod.current().state_dir / "checkpoints.sqlite"
    if not db.exists():
        return {}
    conn = sqlite3.connect(db, check_same_thread=False)
    try:
        tup = SqliteSaver(conn).get_tuple({"configurable": {"thread_id": run, "checkpoint_ns": ""}})
        return dict(tup.checkpoint.get("channel_values") or {}) if tup else {}
    finally:
        conn.close()


def transcripts_of(st: dict) -> dict:
    """step -> {path, agent} from the history; fan-out workers keep their own names ('research[0]')."""
    out, agents = {}, {}
    for h in st.get("history", []):
        step = h.get("step")
        if not step:
            continue
        if h.get("agent"):
            agents[step] = h["agent"]
        if h.get("transcript"):
            out[step] = {"path": h["transcript"], "agent": agents.get(step) or agent_of_path(h["transcript"])}
    return out


def agent_of_path(path: str) -> str:
    p = path.replace("\\", "/").lower()
    if "/.claude/" in p:
        return "claude"
    if "/.codex/" in p:
        return "codex"
    if "/opencode/" in p:
        return "opencode"
    return "unknown"


def transcript_allowed(path: Path) -> bool:
    """Only files in the agents' own transcript folders or the project's OpenCode copies."""
    roots = [Path.home() / ".claude" / "projects", Path.home() / ".codex" / "sessions",
             projmod.current().state_dir / "opencode"]
    try:
        rp = path.resolve()
    except OSError:
        return False
    for r in roots:
        try:
            rp.relative_to(r.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


# ---------------------------------------------------------------- usage, stats

def _ts(s) -> float | None:
    try:
        return time.mktime(time.strptime(str(s), TIME_FMT))
    except (TypeError, ValueError, OverflowError):
        return None


def tokens_of(usage: dict | None) -> int:
    """Tokens of one usage record: input + output + cache read + cache write (reasoning is part of output)."""
    if not isinstance(usage, dict):
        return 0
    return sum(int(usage.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_tokens",
                                                "cache_write_tokens"))


def _add_cost(a, b):
    return b if a is None else a if b is None else a + b


def _node_of(step: str) -> str:
    """Fan-out workers log as '<fanout>[i]'; they are one node '<fanout>_worker' (as in view.step_states)."""
    m = re.match(r"^(.*)\[(\d+)\]$", step)
    return m.group(1) + "_worker" if m else step


def run_totals(st: dict) -> dict:
    """The status file's `totals` (written by the engine); for older runs, summed from the history usage."""
    if isinstance(st.get("totals"), dict):
        return st["totals"]
    out = {**{k: 0 for k in USAGE_KEYS if k != "reasoning_tokens"}, "cost_usd": None, "ai_seconds": 0.0, "steps": 0}
    for h in st.get("history", []):
        if h.get("kind") != "ai" or h.get("event") not in ("done", "failed"):
            continue
        u = h.get("usage") or {}
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
            out[k] += int(u.get(k) or 0)
        out["cost_usd"] = _add_cost(out["cost_usd"], u.get("cost_usd"))
        out["ai_seconds"] += float(h.get("seconds") or 0)
        out["steps"] += 1
    out["ai_seconds"] = round(out["ai_seconds"], 1)
    return out


def _median(values: list):
    return round(statistics.median(values), 1) if values else None


def workflow_stats(workflow: str, sts: list[dict]) -> dict:
    """Aggregates over the runs of one workflow (see the API table in the README)."""
    by_status: dict[str, int] = {}
    durations, series, gates, steps = [], {}, {}, {}
    cost, tokens, guard, retries = None, 0, 0, 0
    for st in sts:
        status = st.get("status") or "?"
        by_status[status] = by_status.get(status, 0) + 1
        hist = st.get("history", [])
        if status == "done" and _ts(st.get("started")) and hist:
            end = _ts(hist[-1].get("time")) or _ts(st.get("updated"))
            if end:
                durations.append(end - _ts(st.get("started")))
        tot = run_totals(st)
        cost = _add_cost(cost, tot.get("cost_usd"))
        tokens += tokens_of(tot)
        if st.get("series"):
            s = series.setdefault(st["series"], {"series": st["series"], "runs": 0, "latest_run": None, "_t": ""})
            s["runs"] += 1
            if (st.get("started") or "") >= s["_t"]:
                s["_t"], s["latest_run"] = st.get("started") or "", st.get("run")
        started: dict[str, float] = {}
        seen_in_run = set()
        for h in hist:
            step, ev, kind = h.get("step"), h.get("event"), h.get("kind")
            if not step:
                continue
            if kind == "gate" and ev in ("approve", "reject"):
                g = gates.setdefault(step, {"gate": step, "approve": 0, "reject": 0})
                g[ev] += 1
                continue
            if kind not in ("ai", "script", "write"):
                continue
            node = _node_of(step)
            s = steps.setdefault(node, {"step": node, "kind": "worker" if node != step else kind, "runs": 0,
                                        "_sec": [], "_tok": [], "total_cost_usd": None, "guardrail_rounds": 0,
                                        "transient_retries": 0})
            if node not in seen_in_run:
                seen_in_run.add(node)
                s["runs"] += 1
            if ev == "start":
                started[step] = _ts(h.get("time"))
            elif ev == "check failed":
                s["guardrail_rounds"] += 1
                guard += 1
            elif ev == "retry":
                s["transient_retries"] += 1
                retries += 1
            elif ev in ("done", "failed", "kept"):
                if ev == "done":
                    sec = h.get("seconds")
                    if sec is None and started.get(step) and _ts(h.get("time")):
                        sec = _ts(h.get("time")) - started[step]
                    if sec is not None:
                        s["_sec"].append(float(sec))
                if isinstance(h.get("usage"), dict):
                    if ev == "done":
                        s["_tok"].append(tokens_of(h["usage"]))
                    s["total_cost_usd"] = _add_cost(s["total_cost_usd"], h["usage"].get("cost_usd"))
    for g in gates.values():
        n = g["approve"] + g["reject"]
        g["reject_rate"] = round(g["reject"] / n, 3) if n else None
    step_rows = []
    for s in steps.values():
        sec, tok = s.pop("_sec"), s.pop("_tok")
        s["median_seconds"], s["median_tokens"] = _median(sec), (int(statistics.median(tok)) if tok else None)
        step_rows.append(s)
    for s in series.values():
        s.pop("_t")
    return {"workflow": workflow, "runs": len(sts), "by_status": by_status, "median_seconds": _median(durations),
            "total_cost_usd": round(cost, 4) if cost is not None else None, "total_tokens": tokens,
            "guardrail_rounds": guard, "transient_retries": retries, "gates": list(gates.values()),
            "series": sorted(series.values(), key=lambda s: (-s["runs"], s["series"])), "steps": step_rows}


# ---------------------------------------------------------------- files

TEXT_EXT = {".txt", ".log", ".csv", ".tsv", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".xml", ".html", ".htm",
            ".jsonl", ".py", ".c", ".h", ".cpp", ".ts", ".tsx", ".js", ".css", ".sh", ".ps1", ".bat", ".mmd",
            ".rst", ".diff", ".patch", ""}
DENIED_NAMES = re.compile(r"^(\.env.*|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*)$", re.IGNORECASE)


def file_kind(path: Path, head: bytes | None = None) -> str:
    """markdown / json by extension; otherwise text or binary, from the first bytes when given."""
    ext = path.suffix.lower()
    if ext in (".md", ".markdown"):
        return "markdown"
    if ext == ".json":
        return "json"
    if head is None:
        return "text" if ext in TEXT_EXT else "binary"
    if b"\0" in head:
        return "binary"
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as e:
        if e.start < len(head) - 4:              # not just a character cut at the end of the sample
            return "binary"
    return "text"


def _abs(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else projmod.current().root / path


def file_allowed(path: Path) -> bool:
    """Only files below the project root or the state dir, never .git internals or key/secret files."""
    p = projmod.current()
    if any(part.lower() == ".git" for part in path.parts) or DENIED_NAMES.match(path.name):
        return False
    for root in (p.root, p.state_dir):
        try:
            path.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


def file_info(step: str | None, raw: str) -> dict:
    path = _abs(raw)
    try:
        st = path.stat() if path.is_file() else None
    except OSError:
        st = None
    head = None
    if st and file_allowed(path.resolve()):
        try:
            with open(path, "rb") as f:
                head = f.read(4096)
        except OSError:
            pass
    return {"step": step, "path": str(path), "rel": projmod.current().rel(path), "exists": st is not None,
            "size": st.st_size if st else None,
            "mtime": time.strftime(TIME_FMT, time.localtime(st.st_mtime)) if st else None,
            "kind": file_kind(path, head)}


def read_file(raw: str) -> dict:
    if not raw:
        raise ApiError(400, "query parameter 'path' is required")
    if raw.startswith(("\\\\", "//")):
        raise ApiError(403, "network paths are not served")
    try:
        path = _abs(raw).resolve()
    except (OSError, RuntimeError, ValueError):
        raise ApiError(400, f"invalid path: {raw}")
    if not file_allowed(path):
        raise ApiError(403, "only files below the project root or the state dir are served")
    if not path.exists():
        raise ApiError(404, f"no file {raw}")
    if not path.is_file():
        raise ApiError(400, f"not a file: {raw}")
    size = path.stat().st_size
    with open(path, "rb") as f:
        data = f.read(MAX_FILE + 1)
    truncated = len(data) > MAX_FILE
    data = data[:MAX_FILE]
    kind = file_kind(path, data[:8192])
    text = "" if kind == "binary" else data.decode("utf-8", "replace")
    if kind == "json" and not truncated:
        try:
            json.loads(text)
        except ValueError:
            kind = "text"
    return {"path": str(path), "rel": projmod.current().rel(path), "size": size,
            "mtime": time.strftime(TIME_FMT, time.localtime(path.stat().st_mtime)), "text": text,
            "truncated": truncated, "kind": kind}


def run_outputs(st: dict) -> list[dict]:
    """Files the run wrote or showed: history events with `path` (write steps), `gate_files` of the gate it waits
    at, and gate_files kept in history events. One row per path, the latest step wins."""
    found: dict[str, str | None] = {}
    for h in st.get("history", []):
        if isinstance(h.get("path"), str) and h["path"]:
            found[h["path"]] = h.get("step")
        for f in h.get("gate_files") or []:
            if isinstance(f, str) and f:
                found[f] = h.get("step")
    for f in st.get("gate_files") or []:
        if isinstance(f, str) and f:
            found[f] = st.get("gate") or st.get("step")
    return [file_info(step, path) for path, step in found.items()]


# ---------------------------------------------------------------- propose to KB

def propose_config() -> dict:
    c = projmod.current().cfg.get("memory", {}).get("propose", {}) or {}
    cmd = c.get("command")
    ok = isinstance(cmd, list) and bool(cmd) and all(isinstance(x, str) and x for x in cmd)
    fields = [f for f in c.get("fields", []) if isinstance(f, str) and re.match(r"^\w+$", f)]
    return {"enabled": ok, "fields": fields, "description": str(c.get("description", "")),
            "command": cmd if ok else None, "row": c.get("row") if isinstance(c.get("row"), str) else PROPOSE_ROW}


def _cell(text) -> str:
    return " ".join(str(text if text is not None else "").replace("|", "\\|").split("\n")).strip()


def propose_rows(entries: list[dict], row: str) -> str:
    """The entries as markdown rows (one per entry) from the row template ({key} {text} {scope} {run} {step}
    {source})."""
    out = []
    for e in entries:
        src = " · ".join(x for x in (f"langflow run {e['run']}" if e.get("run") else "",
                                     f"step {e['step']}" if e.get("step") else "", e.get("scope") or "") if x)
        values = {"key": _cell(e.get("key")), "text": _cell(e.get("text")), "scope": _cell(e.get("scope")),
                  "run": _cell(e.get("run")), "step": _cell(e.get("step")), "source": _cell(src)}
        out.append(re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), m.group(0)), row))
    return "\n".join(out) + "\n"


def fill_command(cmd: list[str], values: dict) -> list[str]:
    def sub(m):
        if m.group(1) not in values:
            raise ApiError(400, f"[memory.propose] command uses an unknown placeholder {{{m.group(1)}}}")
        return values[m.group(1)]
    out = [re.sub(r"\{(\w+)\}", sub, part) for part in cmd]
    if not any(sep in out[0] for sep in ("/", "\\")):
        # as in engine.script: on Windows a bare "python" would otherwise start langflow's own interpreter
        out[0] = shutil.which(out[0]) or out[0]
    return out


# ---------------------------------------------------------------- schedules

def schedule_module():
    """langflow.schedule (written by the engine side); replaced in the tests."""
    try:
        from . import schedule
    except ImportError as e:
        raise ApiError(501, f"schedules are not available in this langflow build ({e})")
    return schedule


def _schedule_call(fn_name: str, *args):
    mod = schedule_module()
    fn = getattr(mod, fn_name, None)
    if fn is None:
        raise ApiError(501, f"langflow.schedule has no {fn_name}()")
    try:
        return fn(projmod.current(), *args)
    except ApiError:
        raise
    except getattr(mod, "ScheduleError", ApiError) as e:
        raise ApiError(400, str(e))
    except SystemExit as e:
        raise ApiError(400, str(e))
    except NotImplementedError as e:
        raise ApiError(501, str(e) or "not supported on this system")
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, KeyError, LookupError) as e:
        raise ApiError(400, f"{type(e).__name__}: {e}")


def _jsonable(x):
    try:
        json.dumps(x)
        return x
    except (TypeError, ValueError):
        return str(x)


# ---------------------------------------------------------------- transcript summaries

def _clip(text) -> str:
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    text = text.strip()
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + f" …(+{len(text) - MAX_TEXT} chars)"


def _ev(role: str, kind: str, text) -> dict:
    return {"role": role, "kind": kind, "text": _clip(text)}


def _texts(content) -> str:
    """Text of a content value: a string, or a list of blocks with "text"."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict) and c.get("text"))
    return "" if content is None else json.dumps(content, ensure_ascii=False)


def _tool(name, inp) -> str:
    from .agents.base import brief
    return f"{name} {brief(inp)}".strip()


def _jsonl(path: Path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def claude_events(path: Path) -> list[dict]:
    out = []
    for e in _jsonl(path):
        t, msg = e.get("type"), e.get("message") or {}
        if t not in ("user", "assistant") or e.get("isMeta"):
            continue
        content = msg.get("content")
        if t == "user":
            if isinstance(content, str):
                out.append(_ev("user", "text", content))
                continue
            for c in content or []:
                if c.get("type") == "tool_result":
                    out.append(_ev("tool", "tool_result", _texts(c.get("content"))))
                elif c.get("type") == "text" and c.get("text", "").strip():
                    out.append(_ev("user", "text", c["text"]))
            continue
        for c in content or []:
            ct = c.get("type")
            if ct == "text" and c.get("text", "").strip():
                out.append(_ev("assistant", "text", c["text"]))
            elif ct == "tool_use":
                if c.get("name") == "StructuredOutput":
                    out.append(_ev("assistant", "answer", c.get("input")))
                else:
                    out.append(_ev("assistant", "tool_use", _tool(c.get("name"), c.get("input"))))
            elif ct == "thinking" and (c.get("thinking") or "").strip():
                out.append(_ev("assistant", "thinking", c["thinking"]))
    return out


CODEX_CONTEXT = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<permissions")


def codex_events(path: Path) -> list[dict]:
    out = []
    for e in _jsonl(path):
        if e.get("type") != "response_item":
            continue
        p = e.get("payload") or {}
        pt = p.get("type")
        if pt == "message":
            role = p.get("role")
            if role not in ("user", "assistant"):
                continue
            text = _texts(p.get("content"))
            if role == "user" and text.lstrip().startswith(CODEX_CONTEXT):
                continue
            if text.strip():
                out.append(_ev(role, "text", text))
        elif pt in ("function_call", "custom_tool_call"):
            args = p.get("arguments") if pt == "function_call" else p.get("input")
            try:
                args = json.loads(args) if isinstance(args, str) else args
            except ValueError:
                pass
            out.append(_ev("assistant", "tool_use", _tool(p.get("name"), args)))
        elif pt in ("function_call_output", "custom_tool_call_output"):
            o = p.get("output")
            out.append(_ev("tool", "tool_result", o.get("content", o) if isinstance(o, dict) else o))
        elif pt == "local_shell_call":
            out.append(_ev("assistant", "tool_use", _tool("shell", (p.get("action") or {}).get("command"))))
        elif pt == "reasoning":
            text = "\n".join(s.get("text", "") for s in p.get("summary") or [] if isinstance(s, dict))
            if text.strip():
                out.append(_ev("assistant", "thinking", text))
    return out


def opencode_events(path: Path) -> list[dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for m in d.get("messages") or []:
        mt = m.get("type")
        if mt == "user":
            text = m.get("text") or _texts(m.get("content"))
            if text and text.strip():
                out.append(_ev("user", "text", text))
        elif mt == "assistant":
            for c in m.get("content") or []:
                ct = c.get("type")
                if ct == "text" and (c.get("text") or "").strip():
                    out.append(_ev("assistant", "text", c["text"]))
                elif ct in ("reasoning", "thinking") and (c.get("text") or "").strip():
                    out.append(_ev("assistant", "thinking", c["text"]))
                elif ct == "tool":
                    s = c.get("state") or {}
                    out.append(_ev("assistant", "tool_use", _tool(c.get("name"), s.get("input"))))
                    result = _texts(s.get("content")) or s.get("output") or s.get("error") or s.get("status")
                    if result:
                        out.append(_ev("tool", "tool_result", result))
            if m.get("error"):
                out.append(_ev("assistant", "error", m["error"]))
    return out


READERS = {"claude": claude_events, "codex": codex_events, "opencode": opencode_events}


def transcript_summary(st: dict, step: str) -> dict:
    found = transcripts_of(st).get(step)
    if not found:
        raise ApiError(404, f"step '{step}' has no transcript in run '{st.get('run')}'")
    path = Path(found["path"])
    if not transcript_allowed(path):
        raise ApiError(400, f"transcript path is outside the agents' transcript folders: {path}")
    if not path.is_file():
        raise ApiError(404, f"transcript file is gone: {path}")
    agent = found["agent"]
    reader = READERS.get(agent) or READERS.get(agent_of_path(str(path)))
    if not reader:
        raise ApiError(400, f"no transcript reader for agent '{agent}'")
    events = reader(path)
    if len(events) > MAX_EVENTS:
        cut = len(events) - (MAX_EVENTS - 1)
        events = events[:100] + [_ev("system", "cut", f"{cut} events left out")] + events[100 + cut:]
    return {"step": step, "agent": agent, "path": str(path), "events": events}


# ---------------------------------------------------------------- jobs

class Jobs:
    """At most one background job (start, answer, continue) per run; `busy` = a job holds the run's lock."""

    def __init__(self):
        self._guard = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self.last: dict[str, dict] = {}         # run -> last job {action, started, finished, state, message}

    def lock(self, run: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(run, threading.Lock())

    def busy(self, run: str) -> bool:
        with self._guard:
            lk = self._locks.get(run)
        return bool(lk and lk.locked())

    def acquire(self, run: str) -> threading.Lock:
        lk = self.lock(run)
        if not lk.acquire(blocking=False):
            raise ApiError(409, f"run '{run}' is busy (a job is running)")
        return lk

    def spawn(self, run: str, lk: threading.Lock, action: str, fn):
        """Run fn() -> (state, message) in a daemon thread; lk is already held and released at the end."""
        job = {"action": action, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "finished": None, "state": None,
               "message": ""}
        self.last[run] = job

        def work():
            try:
                state, msg = fn()
            except SystemExit as e:
                state, msg = "error", str(e)
            except BaseException as e:  # noqa: BLE001 - the server must survive a job crash
                cancelled = getattr(engine, "RunCancelled", None)
                if cancelled and isinstance(e, cancelled):      # not a crash: the status is already `cancelled`
                    state, msg = "cancelled", str(e)
                else:
                    state, msg = "failed", f"{type(e).__name__}: {e}"
                    sys.stderr.write(f"[langflow web] job {action} {run} crashed:\n{traceback.format_exc()}")
                    try:
                        st = read_status(run)
                        if st.get("status") == "running":
                            engine.write_status(run, status="failed", error=msg[:800],
                                                event={"step": st.get("step"), "kind": "run", "event": "failed",
                                                       "error": msg[:300]})
                    except Exception:  # noqa: BLE001
                        pass
            finally:
                lk.release()
            job.update(finished=time.strftime("%Y-%m-%d %H:%M:%S"), state=state, message=msg)

        threading.Thread(target=work, name=f"langflow-{action}-{run}", daemon=True).start()


# ---------------------------------------------------------------- API

class Api:
    def __init__(self):
        self.jobs = Jobs()
        self.start_lock = threading.Lock()
        self.propose_lock = threading.Lock()
        self.user = getpass.getuser()

    # -- GET
    def project(self) -> dict:
        p = projmod.current()
        return {"name": p.name, "root": str(p.root), "approver": p.approver,
                "allow_agent_approval": p.allow_agent_approval, "version": __version__, "user": self.user}

    def last_args(self) -> dict:
        """workflow -> the args of its newest run (keys starting with _ left out), to prefill the forms."""
        out = {}
        for r in engine.list_runs():                       # newest first
            wf = r.get("workflow")
            if wf and wf not in out:
                args = read_status(r["run"]).get("args") or {}
                out[wf] = {"run": r["run"], "updated": r.get("updated"),
                           "args": {k: v for k, v in args.items() if not str(k).startswith("_")}}
        return out

    def paths(self, query: dict) -> dict:
        """GET /api/paths?prefix=&base=&kind=path|dir: suggestions for path fields (argspec.suggest_paths)."""
        q = {k: v[-1] for k, v in query.items()}
        try:
            return argspec.suggest_paths(projmod.current(), q.get("prefix", ""), q.get("base") or None,
                                         q.get("kind", "path"))
        except ValueError as e:
            raise ApiError(403, str(e))

    def workflows(self) -> list[dict]:
        p = projmod.current()
        last = self.last_args()
        out = []
        for f in sorted(p.workflows_dir.glob("*.py")) if p.workflows_dir.is_dir() else []:
            if f.stem.startswith("_"):
                continue
            try:
                mod = cli.load_workflow(f.stem)
                out.append({"name": f.stem, "description": getattr(mod, "META", {}).get("description", ""),
                            "required": list(getattr(mod, "REQUIRED", [])), "doc": (mod.__doc__ or "").strip(),
                            "args": argspec.specs(p, mod, f.stem), "last_args": last.get(f.stem)})
            except BaseException as e:  # noqa: BLE001 - one broken workflow must not hide the others
                out.append({"name": f.stem, "description": "", "required": [], "doc": "",
                            "error": f"{type(e).__name__}: {e}"})
        return out

    def graph(self, name: str, query: dict) -> dict:
        _name(name, "workflow")
        if not (projmod.current().workflows_dir / f"{name}.py").is_file():
            raise ApiError(404, f"no workflow '{name}'")
        args = {k: v[-1] for k, v in query.items()}
        try:
            return cli.layout_of(name, {"_run": "RUN", **args})
        except SystemExit as e:
            raise ApiError(400, str(e))
        except Exception as e:  # noqa: BLE001 - steps(args) may need args the caller did not give
            raise ApiError(400, f"cannot build workflow '{name}': {type(e).__name__}: {e}")

    def runs(self) -> list[dict]:
        out = []
        for run in run_names():
            try:
                st = read_status(run)
            except (OSError, ValueError):
                continue
            if not st:
                continue
            out.append({"run": st.get("run", run), "workflow": st.get("workflow"), "status": st.get("status"),
                        "step": st.get("step"), "gate": st.get("gate"), "question": st.get("question"),
                        "error": st.get("error"), "updated": st.get("updated"), "started": st.get("started"),
                        "series": st.get("series"), "busy": self.jobs.busy(run), "totals": run_totals(st)})
        out.sort(key=lambda r: (r.get("started") or r.get("updated") or "", r["run"]), reverse=True)
        return out

    def stats(self, query: dict) -> dict:
        only = (query.get("workflow") or [""])[-1]
        if only:
            _name(only, "workflow")
        by_wf: dict[str, list] = {}
        for run in run_names():
            try:
                st = read_status(run)
            except (OSError, ValueError):
                continue
            wf = st.get("workflow")
            if st and wf and (not only or wf == only):
                by_wf.setdefault(wf, []).append(st)
        return {"workflows": [workflow_stats(wf, sts) for wf, sts in sorted(by_wf.items())]}

    def outputs(self, run: str) -> list[dict]:
        return run_outputs(self.status(run))

    def file(self, query: dict) -> dict:
        return read_file((query.get("path") or [""])[-1])

    def propose_info(self) -> dict:
        c = propose_config()
        return {"enabled": c["enabled"], "fields": c["fields"], "description": c["description"]}

    def status(self, run: str) -> dict:
        st = read_status(_name(run, "run"))
        if not st:
            raise ApiError(404, f"no run '{run}'")
        return st

    def run(self, run: str) -> dict:
        st = self.status(run)
        states, info = view.step_states(st)
        try:
            drift = engine.binding_drift(st)          # live: the role / skill files now vs what the step used
        except Exception:  # noqa: BLE001 - a view only
            drift = {}
        by_node: dict[str, list] = {}
        for step, ch in drift.items():                # fan-out workers '<fanout>[i]' -> node '<fanout>_worker'
            by_node[_node_of(step)] = list(dict.fromkeys(by_node.get(_node_of(step), []) + list(ch)))
        drift = by_node
        for step, d in info.items():
            if d.get("binding"):
                if drift.get(step):
                    d["binding_changes"] = drift[step]
                else:
                    d.pop("binding_changes", None)
        last_usage = {h["step"]: h["usage"] for h in st.get("history", [])
                      if h.get("step") and h.get("event") in ("done", "failed") and isinstance(h.get("usage"), dict)}
        for step, usage in last_usage.items():     # when view.step_states does not copy it itself
            if step in info and "usage" not in info[step]:
                info[step]["usage"] = usage
        return {**st, "states": states, "info": info, "busy": self.jobs.busy(run), "totals": run_totals(st),
                "gate_files": st.get("gate_files") or [], "transcripts": transcripts_of(st),
                "job": self.jobs.last.get(run)}

    def log(self, run: str, query: dict) -> dict:
        self.status(run)
        try:
            offset = max(0, int((query.get("offset") or ["0"])[-1]))
        except ValueError:
            raise ApiError(400, "offset must be an integer")
        p = engine.log_path(run)
        if not p.exists():
            return {"offset": 0, "lines": []}
        size = p.stat().st_size
        if offset > size:                          # the log was replaced: start again
            offset = 0
        with open(p, "rb") as f:
            f.seek(offset)
            data = f.read()
        end = data.rfind(b"\n")
        if end < 0:                                 # only a partial line so far: wait for its end
            return {"offset": offset, "lines": []}
        lines = data[:end + 1].decode("utf-8", "replace").splitlines()
        return {"offset": offset + end + 1, "lines": lines[-MAX_LOG_LINES:]}

    def memory(self, run: str) -> dict:
        st = self.status(run)
        values = checkpoint_values(run)
        args = values.get("args") or {**st.get("args", {}), "_run": run, "_workflow": st.get("workflow"),
                                      **({"_series": st["series"]} if st.get("series") else {})}
        return {"run": values.get("memory") or {}, "series": memory.series_entries(args)}

    def transcript(self, run: str, query: dict) -> dict:
        step = (query.get("step") or [""])[-1]
        if not step:
            raise ApiError(400, "query parameter 'step' is required")
        return transcript_summary(self.status(run), step)

    # -- skills, roles, bindings
    def catalog(self) -> dict:
        rows, warn = cli.all_step_rows()
        c = catalog.catalog(projmod.current(), rows)
        cm = catalog.config_modes(projmod.current())
        return {**c, "warnings": warn + c["warnings"], "skill_mode": catalog.skill_mode(projmod.current()),
                "role_mode": cm.get("role_mode"), "contract": cm.get("contract", True),
                "native_fallback": cm.get("native_fallback", "system"), "retry_mode": cm.get("retry_mode", catalog.DEFAULTS["retry_mode"])}

    @staticmethod
    def _used_by(kind: str, cid: str) -> list[dict]:
        rows, _ = cli.all_step_rows()
        return catalog.usage(rows)[kind].get(cid, [])

    def catalog_skill(self, sid: str) -> dict:
        e = catalog.skill(projmod.current(), sid)
        if not e:
            raise ApiError(404, f"no skill '{sid}'")
        return {**e, "used_by": self._used_by("skills", sid)}

    def catalog_role(self, rid: str) -> dict:
        e = catalog.role(projmod.current(), rid)
        if not e:
            raise ApiError(404, f"no role '{rid}'")
        return {**e, "used_by": self._used_by("roles", rid)}

    def _rows(self, wf: str, query: dict | None = None) -> list[dict]:
        _name(wf, "workflow")
        if not (projmod.current().workflows_dir / f"{wf}.py").is_file():
            raise ApiError(404, f"no workflow '{wf}'")
        args = {**{k: v[-1] for k, v in (query or {}).items()}, "_run": "RUN", "_workflow": wf}
        try:
            return cli.step_rows(wf, cli.load_workflow(wf).steps(args), args)
        except ValueError as e:
            raise ApiError(400, str(e))
        except SystemExit as e:
            raise ApiError(400, str(e))
        except Exception as e:  # noqa: BLE001 - steps(args) may need args the caller did not give
            raise ApiError(400, f"cannot build workflow '{wf}': {type(e).__name__}: {e}")

    def bindings(self, wf: str, query: dict | None = None) -> dict:
        """Per ai step: code, override, effective ({role, skills, role_mode?, contract?, skill_mode?,
        native_fallback?, retry_mode?, from, skills_detail: [{id, via, path, sha256, cli, fallback_reason?}] (cli =
        the copy the step's CLI loads; via = how the skill reaches the model)}), modes (catalog.modes: the resolved
        role_mode, contract, skill_mode, native_fallback, retry_mode and where each came from), warnings (other skill
        copies, fallbacks, mode changes), problems."""
        p, out = projmod.current(), []
        for r in self._rows(wf, query):
            d = catalog.step_detail(p, r)
            out.append({"step": r["step"], "agent": r["agent"], "code": r["code"], "override": r["override"],
                        "effective": {**r["effective"], "skills_detail": d["skills"]}, "modes": d["modes"],
                        "warnings": d["warnings"], "problems": d["problems"]})
        return {"workflow": wf, "file": catalog.BINDINGS_FILE, "steps": out,
                "defaults": {"role_mode": None, **catalog.DEFAULTS, **catalog.config_modes(p)}}

    def set_binding(self, wf: str, step: str, body: dict | None) -> dict:
        """PUT body {role?: id | "" (none) | null (keep the code value), skills?: [ids] | null, skills_add?: [ids],
        role_mode?: "append"|"agent"|"prompt" | null, contract?: bool | null, skill_mode?:
        "inject"|"system"|"native"|"name" | null, native_fallback?: "system"|"inject"|"fail" | null, retry_mode?:
        "fresh"|"resume" | null}; only the keys given and not null are written; nothing left = DELETE."""
        row = next((r for r in self._rows(wf) if r["step"] == step), None)
        if row is None:
            raise ApiError(404, f"workflow '{wf}' has no ai step '{step}'")
        vals = None
        if body is not None:
            unknown = set(body) - set(catalog.BINDING_KEYS)
            if unknown:
                raise ApiError(400, f"unknown keys {sorted(unknown)} (allowed: {', '.join(catalog.BINDING_KEYS)})")
            vals = {k: v for k, v in body.items() if v is not None}
            try:
                vals = catalog.check_values(vals, f"[{wf}.{step}]") if vals else None
            except ValueError as e:
                raise ApiError(400, str(e))
            if vals:
                eff = catalog.effective(row["code"], vals)
                try:
                    catalog.resolve(projmod.current(), row["agent"] or "claude", eff["role"], eff["skills"],
                                    *catalog.skill_modes(projmod.current(), eff))
                except catalog.BindingError as e:
                    raise ApiError(400, "; ".join(e.problems))
        try:
            catalog.set_binding(projmod.current(), wf, step, vals)
        except ValueError as e:
            raise ApiError(400, str(e))
        return self.bindings(wf)

    # -- POST
    def start(self, body: dict) -> dict:
        workflow, run, args = body.get("workflow"), body.get("run"), body.get("args") or {}
        if not isinstance(workflow, str) or not isinstance(run, str) or not isinstance(args, dict):
            raise ApiError(400, "body must be {workflow: str, run: str, args: {..}}")
        _name(workflow, "workflow")
        run = cli.expand_run_name(run)
        _name(run, "run")
        if any(not isinstance(k, str) or not k for k in args):
            raise ApiError(400, "args keys must be non-empty strings")
        args = {k: v if isinstance(v, str) else json.dumps(v) for k, v in args.items()}
        if not (projmod.current().workflows_dir / f"{workflow}.py").is_file():
            raise ApiError(404, f"no workflow '{workflow}'")
        with self.start_lock:
            if engine.status_path(run).exists():
                raise ApiError(409, f"run '{run}' already exists; runs are never reused, pick a new name")
            lk = self.jobs.acquire(run)
            try:
                run, app, payload = cli.prepare_start(workflow, run, args)
            except SystemExit as e:
                lk.release()
                raise ApiError(400, str(e))
            except BaseException as e:
                lk.release()
                raise ApiError(400, f"cannot start '{workflow}': {type(e).__name__}: {e}")
        self.jobs.spawn(run, lk, "start", lambda: cli.advance(app, run, payload))
        return {"started": run}

    def answer(self, run: str, body: dict, channel: str) -> dict:
        decision, note, confirm = body.get("decision"), body.get("note"), body.get("confirm")
        if decision not in ("approve", "reject"):
            raise ApiError(400, "decision must be 'approve' or 'reject'")
        if note is not None and not isinstance(note, str):
            raise ApiError(400, "note must be a string")
        if confirm != run:
            raise ApiError(400, "confirm must equal the run name")
        self.status(run)
        by = f"{channel}:{self.user}"
        lk = self.jobs.acquire(run)
        try:
            # under the run lock: a cancel that came first refuses the answer (409 with the reason); an answer
            # claimed first is applied, and a later cancel stops the run before the next step
            st = engine.claim_answer(run, by)
        except engine.GateClosed as e:
            lk.release()
            raise ApiError(409, str(e))
        except BaseException:
            lk.release()
            raise
        note = (note or "").strip() or None
        self.jobs.spawn(run, lk, "answer", lambda: cli.answer_gate(run, decision, note, by, claimed=True))
        return {"accepted": True, "gate": st.get("gate"), "decision": decision, "by": by}

    def continue_(self, run: str) -> dict:
        self.status(run)
        lk = self.jobs.acquire(run)
        try:
            st = read_status(run)
            if st.get("status") == "waiting":
                raise ApiError(409, f"run '{run}' waits at gate '{st.get('gate')}'; answer it instead")
            if st.get("status") in ("done", "rejected"):
                raise ApiError(409, f"run '{run}' is {st.get('status')}; nothing to continue")
        except BaseException:
            lk.release()
            raise
        self.jobs.spawn(run, lk, "continue", lambda: cli.continue_run(run))
        return {"continued": run}

    def cancel(self, run: str, channel: str) -> dict:
        """Ask the engine to stop the run (engine.request_cancel). Not under the job lock: the job that runs the step
        is what gets stopped."""
        st = self.status(run)
        if st.get("status") in FINISHED:
            raise ApiError(409, f"run '{run}' is {st.get('status')}; nothing to cancel")
        fn = getattr(engine, "request_cancel", None)
        if fn is None:
            raise ApiError(501, "this langflow build has no engine.request_cancel")
        by = f"{channel}:{self.user}"
        try:
            takes_by = "by" in inspect.signature(fn).parameters
        except (TypeError, ValueError):
            takes_by = False
        try:
            result = fn(run, by=by) if takes_by else fn(run)
        except ValueError as e:                     # finished meanwhile (the engine checks again)
            raise ApiError(409, str(e))
        return {"accepted": True, "run": run, "by": by, "result": result if isinstance(result, str) else None,
                "status": read_status(run).get("status")}

    # -- delete and prune
    def delete_run(self, run: str, query: dict, channel: str) -> dict:
        """engine.delete_run under the run's job lock (409 while a web job works on it)."""
        force = (query.get("force") or ["0"])[-1] in ("1", "true", "yes")
        lk = self.jobs.acquire(run)
        try:
            res = engine.delete_run(run, force=force, by=f"{channel}:{self.user}")
        except LookupError as e:
            raise ApiError(404, str(e))
        except (engine.RunBusy, TimeoutError) as e:
            raise ApiError(409, str(e))
        except ValueError as e:
            raise ApiError(400, str(e))
        finally:
            lk.release()
        self.jobs.last.pop(run, None)
        return res

    def prune(self, body: dict, channel: str) -> dict:
        days, keep = body.get("days"), body.get("keep", 0)
        statuses, wf = body.get("statuses"), body.get("workflow")
        if days is not None and (not isinstance(days, int) or days < 0):
            raise ApiError(400, "days must be a non-negative integer")
        if not isinstance(keep, int) or keep < 0:
            raise ApiError(400, "keep must be a non-negative integer")
        if statuses is not None and (not isinstance(statuses, list) or not all(isinstance(s, str) for s in statuses)):
            raise ApiError(400, "statuses must be a list of strings")
        if wf is not None:
            _name(wf, "workflow")
        cand = engine.prune_candidates(days or None, statuses or engine.PRUNE_STATUSES, keep, wf)
        if body.get("dry_run"):
            return {"candidates": cand, "deleted": [], "skipped": []}
        deleted, skipped = [], []
        for r in cand:
            if self.jobs.busy(r["run"]):
                skipped.append({"run": r["run"], "reason": "a web job is running it"})
                continue
            try:
                deleted.append(self.delete_run(r["run"], {"force": ["1" if r["status"] == "waiting" else "0"]},
                                               channel))
            except ApiError as e:
                skipped.append({"run": r["run"], "reason": e.message})
        return {"candidates": cand, "deleted": deleted, "skipped": skipped}

    # -- memory
    def edit_run_memory(self, run: str, key: str, text: str | None, channel: str) -> dict:
        """Change the run memory in the latest checkpoint (LangGraph update_state, applied as the node that wrote
        last, so the next step stays the same); text None deletes the key. Refused while a job runs or the run is
        running in another process (two writers would fork the checkpoint chain)."""
        from langgraph.errors import InvalidUpdateError
        from langgraph.types import Overwrite
        if not key or len(key) > 200:
            raise ApiError(400, "memory key must be 1-200 characters")
        self.status(run)
        lk = self.jobs.acquire(run)
        app = None
        try:
            st = read_status(run)
            alive = getattr(engine, "_pid_alive", None)
            if st.get("status") == "running" and not (alive and st.get("pid") and not alive(st["pid"])):
                # a `running` run whose process is gone (cut off) may be edited; a live or unknown one may not
                raise ApiError(409, f"run '{run}' is running; edit its memory when it waits at a gate or has stopped")
            try:
                app = cli.app_for(st["workflow"], st.get("args", {}))
            except SystemExit as e:
                raise ApiError(400, str(e))
            except Exception as e:  # noqa: BLE001 - a broken workflow module
                raise ApiError(400, f"cannot load workflow '{st.get('workflow')}': {type(e).__name__}: {e}")
            cfg = {"configurable": {"thread_id": run}}
            snap = app.get_state(cfg)
            if not snap.values:
                raise ApiError(404, f"run '{run}' has no checkpoint")
            mem_now = dict(snap.values.get("memory") or {})
            by = f"{channel}:{self.user}"
            if text is None:
                if key not in mem_now:
                    raise ApiError(404, f"no key '{key}' in the memory of run '{run}'")
                del mem_now[key]
            else:
                old = mem_now.get(key) or {"step": "manual", "run": run, "scope": "run"}
                mem_now[key] = {**old, "text": text, "time": time.strftime(TIME_FMT), "edited_by": by}
            try:
                app.update_state(cfg, {"memory": Overwrite(mem_now)})
            except InvalidUpdateError as e:
                raise ApiError(409, f"cannot change the memory at this point of run '{run}': {e}")
            recent = [m for m in st.get("memory_recent") or [] if text is not None or m.get("key") != key]
            for m in recent:
                if m.get("key") == key:
                    m.update(text=text, edited_by=by)
            engine.write_status(run, memory_recent=recent,
                                event={"step": None, "kind": "memory", "event": "deleted" if text is None else "edited",
                                       "key": key, "by": by})
            return {"ok": True, "run": run, "key": key, "entry": mem_now.get(key)}
        finally:
            if app is not None:
                try:
                    app.checkpointer.conn.close()
                except Exception:  # noqa: BLE001
                    pass
            lk.release()

    @staticmethod
    def _series_body(body: dict, need_text: bool) -> tuple[str, str, str, str | None]:
        workflow, series, key, text = (body.get(k) for k in ("workflow", "series", "key", "text"))
        if not isinstance(workflow, str) or not isinstance(series, str) or not isinstance(key, str):
            raise ApiError(400, "body must be {workflow: str, series: str, key: str" + (", text: str}" if need_text
                                                                                         else "}"))
        _name(workflow, "workflow")
        if not series or len(series) > 300 or not key or len(key) > 200:
            raise ApiError(400, "series must be 1-300 and key 1-200 characters")
        if need_text:
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_MEMORY_TEXT:
                raise ApiError(400, f"text must be a non-empty string of at most {MAX_MEMORY_TEXT} characters")
        if not memory.has_series(workflow, series):
            raise ApiError(404, f"no series '{series}' of workflow '{workflow}'")
        return workflow, series, key, text

    def put_series(self, body: dict, channel: str) -> dict:
        workflow, series, key, text = self._series_body(body, True)
        return {"ok": True, "entry": memory.put_entry(workflow, series, key, text, f"{channel}:{self.user}")}

    def delete_series(self, body: dict) -> dict:
        workflow, series, key, _ = self._series_body(body, False)
        if not memory.delete_entry(workflow, series, key):
            raise ApiError(404, f"no key '{key}' in series '{series}'")
        return {"ok": True, "deleted": key}

    def propose(self, body: dict, channel: str) -> dict:
        """Run the project's [memory.propose] command on the chosen entries. langflow applies nothing itself; the
        command (e.g. the KB's `store propose`) only files a proposal for a person to review."""
        c = propose_config()
        if not c["enabled"]:
            raise ApiError(400, "proposing is not enabled: add [memory.propose] command = [...] to config.toml")
        entries, fields = body.get("entries"), body.get("fields") or {}
        if not isinstance(entries, list) or not entries or len(entries) > MAX_PROPOSE_ENTRIES:
            raise ApiError(400, f"entries must be a list of 1-{MAX_PROPOSE_ENTRIES} entries")
        for e in entries:
            if not isinstance(e, dict) or not isinstance(e.get("text"), str) or not e["text"].strip() \
                    or len(e["text"]) > MAX_MEMORY_TEXT:
                raise ApiError(400, "each entry needs a non-empty text")
            if any(e.get(k) is not None and not isinstance(e.get(k), str) for k in ("key", "scope", "run", "step")):
                raise ApiError(400, "entry key, scope, run and step must be strings")
        if not isinstance(fields, dict):
            raise ApiError(400, "fields must be an object")
        unknown = set(fields) - set(c["fields"])
        if unknown:
            raise ApiError(400, f"unknown fields: {', '.join(sorted(unknown))} (configured: {', '.join(c['fields'])})")
        values = {}
        for f in c["fields"]:
            v = fields.get(f)
            if not isinstance(v, str) or not v.strip():
                raise ApiError(400, f"field '{f}' is required")
            v = v.strip()
            if len(v) > 1000 or any(ch in v for ch in "\r\n\0") or v.startswith("-"):
                raise ApiError(400, f"field '{f}': one line, at most 1000 characters, not starting with '-'")
            values[f] = v
        if not self.propose_lock.acquire(blocking=False):
            raise ApiError(409, "another proposal is running")
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", prefix="langflow_propose_",
                                             delete=False) as f:
                f.write(propose_rows(entries, c["row"]))
                tmp = f.name
            argv = fill_command(c["command"], {**values, "text_file": tmp})
            try:
                r = subprocess.run(argv, cwd=projmod.current().root, capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=PROPOSE_TIMEOUT,
                                   stdin=subprocess.DEVNULL, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
                code, output = r.returncode, (r.stdout + r.stderr)
            except subprocess.TimeoutExpired:
                code, output = None, f"timed out after {PROPOSE_TIMEOUT} s"
            except OSError as e:
                code, output = None, f"cannot run {argv[0]}: {e}"
            if len(output) > MAX_PROPOSE_OUTPUT:
                output = "…" + output[-MAX_PROPOSE_OUTPUT:]
            self._propose_log({"time": time.strftime(TIME_FMT), "by": f"{channel}:{self.user}", "argv": argv,
                               "exit": code, "keys": [e.get("key") for e in entries]})
            return {"ok": code == 0, "exit": code, "output": output, "command": argv}
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            self.propose_lock.release()

    @staticmethod
    def _propose_log(rec: dict):
        try:
            p = projmod.current().state_dir / "propose.log"
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass

    # -- schedules
    def schedules(self):
        return _jsonable(_schedule_call("list_tasks"))

    def add_schedule(self, body: dict) -> dict:
        name, at, days, args = body.get("name"), body.get("time"), body.get("days") or "DAILY", body.get("args")
        if not isinstance(name, str):
            raise ApiError(400, "body must be {name, time: 'HH:MM', days, args: [..]}")
        _name(name, "schedule")
        if not isinstance(at, str) or not HHMM_RE.match(at):
            raise ApiError(400, "time must be HH:MM (24 h)")
        if not isinstance(days, str) or not DAYS_RE.match(days.upper()):
            raise ApiError(400, "days must be DAILY, MON-FRI or a list like MON,WED,FRI")
        if not isinstance(args, list) or not args or len(args) > 30 or not all(isinstance(a, str) for a in args):
            raise ApiError(400, "args must be a non-empty list of strings (langflow arguments, e.g. start <wf> <run>)")
        if args[0] not in ("start", "continue"):
            raise ApiError(400, "a schedule may only run `langflow start ...` or `langflow continue ...`")
        bad = [a for a in args if not a.strip() or len(a) > 200 or CMD_SPECIAL & set(a)]
        if bad:
            raise ApiError(400, f"argument {bad[0]!r}: empty, too long, or holds one of & | < > ^ % \" (not allowed "
                                "in a task command line)")
        return {"added": name, "result": _jsonable(_schedule_call("add_task", name, at, days.upper(), args))}

    def remove_schedule(self, name: str) -> dict:
        _name(name, "schedule")
        return {"removed": name, "result": _jsonable(_schedule_call("remove_task", name))}

    # -- routing
    def route(self, method: str, parts: list[str], query: dict, body, channel: str):
        if method == "GET":
            if parts == ["project"]:
                return self.project()
            if parts == ["workflows"]:
                return self.workflows()
            if len(parts) == 3 and parts[0] == "workflows" and parts[2] == "graph":
                return self.graph(parts[1], query)
            if len(parts) == 3 and parts[0] == "workflows" and parts[2] == "bindings":
                return self.bindings(parts[1], query)
            if parts == ["catalog"]:
                return self.catalog()
            if len(parts) == 3 and parts[0] == "catalog" and parts[1] in ("skill", "role"):
                return self.catalog_skill(parts[2]) if parts[1] == "skill" else self.catalog_role(parts[2])
            if parts == ["runs"]:
                return self.runs()
            if parts == ["stats"]:
                return self.stats(query)
            if parts == ["file"]:
                return self.file(query)
            if parts == ["paths"]:
                return self.paths(query)
            if parts == ["memory", "propose"]:
                return self.propose_info()
            if parts == ["schedules"]:
                return self.schedules()
            if len(parts) == 2 and parts[0] == "runs":
                return self.run(parts[1])
            if len(parts) == 3 and parts[0] == "runs":
                fn = {"log": self.log, "transcript": self.transcript}.get(parts[2])
                if fn:
                    return fn(parts[1], query)
                if parts[2] == "memory":
                    return self.memory(parts[1])
                if parts[2] == "outputs":
                    return self.outputs(parts[1])
            raise ApiError(404, f"no route {method} /api/{'/'.join(parts)}")
        if not isinstance(body, dict):
            raise ApiError(400, "body must be a JSON object")
        if method == "POST":
            if parts == ["runs"]:
                return self.start(body)
            if parts == ["runs", "prune"]:
                return self.prune(body, channel)
            if parts == ["memory", "propose"]:
                return self.propose(body, channel)
            if parts == ["schedules"]:
                return self.add_schedule(body)
            if len(parts) == 3 and parts[0] == "runs" and parts[2] in ("answer", "continue", "cancel"):
                run = _name(parts[1], "run")
                if parts[2] == "cancel":
                    return self.cancel(run, channel)
                return self.answer(run, body, channel) if parts[2] == "answer" else self.continue_(run)
        elif method in ("PUT", "DELETE"):
            if len(parts) == 4 and parts[0] == "runs" and parts[2] == "memory":
                text = None
                if method == "PUT":
                    text = body.get("text")
                    if not isinstance(text, str) or not text.strip() or len(text) > MAX_MEMORY_TEXT:
                        raise ApiError(400, f"text must be a non-empty string of at most {MAX_MEMORY_TEXT} characters")
                return self.edit_run_memory(_name(parts[1], "run"), parts[3], text, channel)
            if parts == ["memory", "series"]:
                return self.put_series(body, channel) if method == "PUT" else self.delete_series(body)
            if len(parts) == 4 and parts[0] == "workflows" and parts[2] == "bindings":
                return self.set_binding(_name(parts[1], "workflow"), parts[3], body if method == "PUT" else None)
            if method == "DELETE" and len(parts) == 2 and parts[0] == "schedules":
                return self.remove_schedule(parts[1])
            if method == "DELETE" and len(parts) == 2 and parts[0] == "runs":
                return self.delete_run(_name(parts[1], "run"), query, channel)
        raise ApiError(404, f"no route {method} /api/{'/'.join(parts)}")


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "langflow-web"
    protocol_version = "HTTP/1.1"

    # set on the class by serve()
    api: Api = None
    token: str = ""
    api_only: bool = False
    quiet: bool = False

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write(f"[langflow web] {self.address_string()} {fmt % args}\n")

    def _send(self, status: int, data: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status: int, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1")

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PATCH(self):
        self.close_connection = True              # the body is not read
        self._json(405, {"error": "method not allowed"})

    def _dispatch(self, method: str):
        try:
            if not self._host_ok():
                return self._json(403, {"error": "invalid host"})
            url = urlsplit(self.path)
            if url.path == "/api" or url.path.startswith("/api/"):
                return self._api(method, url)
            if method != "GET" or self.api_only:
                return self._json(404, {"error": "not found"})
            return self._static(url.path)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[langflow web] {method} {self.path}:\n{traceback.format_exc()}")
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except OSError:
                pass

    def _api(self, method: str, url):
        sent = self.headers.get("X-Langflow-Token") or ""
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if 0 < length <= MAX_BODY else b""
        if length > MAX_BODY:
            self.close_connection = True          # the unread body would corrupt the next request
        if not hmac.compare_digest(sent.encode(), self.token.encode()):
            return self._json(401, {"error": "missing or wrong X-Langflow-Token"})
        if length > MAX_BODY:
            return self._json(413, {"error": "body larger than 1 MiB"})
        channel = (self.headers.get("X-Langflow-Channel") or "web").strip().lower()
        if channel not in ("web", "panel"):
            return self._json(400, {"error": "X-Langflow-Channel must be web or panel"})
        body = None
        if method in ("POST", "PUT", "DELETE"):
            try:
                body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
            except ValueError:
                return self._json(400, {"error": "body is not JSON"})
        parts = [unquote(p) for p in url.path.split("/")[2:] if p]
        try:
            return self._json(200, self.api.route(method, parts, parse_qs(url.query), body, channel))
        except ApiError as e:
            return self._json(e.status, {"error": e.message})
        except SystemExit as e:
            return self._json(400, {"error": str(e)})

    def _with_token(self, html: str) -> bytes:
        meta = f'<meta name="langflow-token" content="{self.token}">'
        html = html.replace(PLACEHOLDER, meta) if PLACEHOLDER in html else html.replace("</head>", meta + "</head>", 1)
        return html.encode("utf-8")

    def _static(self, path: str):
        index = WEBUI / "index.html"
        if not index.is_file():
            return self._send(200, self._with_token(FALLBACK_PAGE), "text/html; charset=utf-8")
        rel = unquote(path).lstrip("/") or "index.html"
        target = (WEBUI / rel).resolve()
        try:
            target.relative_to(WEBUI.resolve())
        except ValueError:
            return self._json(403, {"error": "invalid asset path"})
        if not target.is_file():
            if "." in Path(rel).name:
                return self._json(404, {"error": "not found"})
            target = index                        # client-side route: serve the app
        data = target.read_bytes()
        if target in (index, index.resolve()):
            data = self._with_token(data.decode("utf-8"))
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        ctype = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
                 ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json"}.get(target.suffix, ctype)
        if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, data, ctype, {"Content-Security-Policy": CSP})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def serve(port: int = 8765, api_only: bool = False, quiet: bool = False) -> tuple[Server, str]:
    """Make the server (not started). Returns (server, token)."""
    token = secrets.token_urlsafe(32)
    handler = type("LangflowHandler", (Handler,), {"api": Api(), "token": token, "api_only": api_only,
                                                   "quiet": quiet})
    return Server(("127.0.0.1", port), handler), token


USAGE = "usage: langflow web [--port N] [--open] [--api-only] [--stdin-watch] [--quiet]"


def main(argv: list[str]):
    port, api_only, open_page, stdin_watch, quiet = None, False, False, False, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--port" and i + 1 < len(argv):
            try:
                port = int(argv[i + 1])
            except ValueError:
                raise SystemExit(USAGE)
            i += 1
        elif a == "--api-only":
            api_only = True
        elif a == "--open":
            open_page = True
        elif a == "--stdin-watch":
            stdin_watch = True
        elif a == "--quiet":
            quiet = True
        else:
            raise SystemExit(USAGE)
        i += 1
    if port is None:
        port = 0 if api_only else 8765
    try:
        server, token = serve(port, api_only, quiet)
    except OSError as e:
        raise SystemExit(f"langflow web: cannot listen on 127.0.0.1:{port}: {e}")
    real_port = server.server_address[1]
    url = f"http://127.0.0.1:{real_port}/"
    if api_only:
        print("LANGFLOW_WEB " + json.dumps({"port": real_port, "token": token}), flush=True)
    else:
        p = projmod.current()
        print(f"langflow web: {p.name} ({p.root})\n  {url}   (Ctrl-C stops the server; a running step is cut off, "
              "`langflow continue <run>` re-runs it)", flush=True)
        if not (WEBUI / "index.html").is_file():
            print("  the web app is not built (src/langflow/webui/); only the API is useful", flush=True)
        if open_page:
            webbrowser.open(url)
    if stdin_watch:
        def watch():
            try:
                while sys.stdin.read(1024):
                    pass
            except (OSError, ValueError):
                pass
            server.shutdown()
        threading.Thread(target=watch, name="langflow-stdin-watch", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
