"""Workflow memory, in two scopes (think MCU: registers/RAM of one task, RAM shared between tasks; the project's own
knowledge base stays the Flash, written only after a person reviews it).

  run     State channel "memory": shared by every step of one run, checkpointed with each step, so a re-run or a fork
          from a step sees the memory as it was at that point.
  series  LangGraph SqliteStore (<state_dir>/memory.sqlite), namespace ("series", <workflow>, <series key>): shared by
          every run of the same series, e.g. report v1, v2, v3. A workflow names its series with MEMORY_SERIES
          (formatted with the run args, e.g. "{area}/{name}"); without it there is no series memory.

Agents are separate processes: they read memory from a block the runner adds to their prompt, and write it through a
"memory" field the runner adds to their answer schema ([{key, text, scope}]). Gate answers with a note or a reject
are remembered automatically. Writing to a key again replaces it (last writer wins, also between parallel branches).
"""
import copy
import json
import sqlite3
import threading
import time

from .project import current

ENTRY = {"type": "object", "additionalProperties": False, "required": ["key", "text", "scope"],
         "properties": {"key": {"type": "string"}, "text": {"type": "string"},
                        "scope": {"enum": ["run", "series"]}}}
_LOCK = threading.RLock()
_STORE = None
MAX_PROMPT_CHARS = 8000


def store():
    """The project's SqliteStore (created on first use)."""
    global _STORE
    with _LOCK:
        if _STORE is None:
            from langgraph.store.sqlite import SqliteStore
            path = current().state_dir / "memory.sqlite"
            path.parent.mkdir(parents=True, exist_ok=True)
            _STORE = SqliteStore(sqlite3.connect(path, check_same_thread=False, isolation_level=None))
            _STORE.setup()
        return _STORE


def series_ns(args: dict) -> tuple | None:
    if args.get("_series"):
        return ("series", args.get("_workflow", "?"), args["_series"])
    return None


def put_series(args: dict, key: str, value: dict):
    ns = series_ns(args)
    if ns:
        with _LOCK:
            store().put(ns, key, value)


def series_entries(args: dict, limit: int = 200) -> list[dict]:
    ns = series_ns(args)
    if not ns:
        return []
    with _LOCK:
        items = store().search(ns, limit=limit)
    out = [{"key": it.key, **it.value, "updated": str(it.updated_at)[:19]} for it in items]
    return sorted(out, key=lambda e: e.get("time", ""))


def has_series(workflow: str, series: str) -> bool:
    with _LOCK:
        return bool(store().search(("series", workflow, series), limit=1))


def put_entry(workflow: str, series: str, key: str, text: str, by: str | None = None) -> dict:
    """Write one series entry by hand (web UI): replace the text of an existing key and keep its step and run, or
    add a new key. Returns the stored entry."""
    ns = ("series", workflow, series)
    with _LOCK:
        old = store().get(ns, key)
        value = dict(old.value) if old else {"step": "manual", "run": None, "scope": "series"}
        value.update(text=text, time=time.strftime("%Y-%m-%d %H:%M:%S"), **({"edited_by": by} if by else {}))
        store().put(ns, key, value)
    return {"key": key, **value}


def delete_entry(workflow: str, series: str, key: str) -> bool:
    """Delete one series entry. False when the key is not there."""
    ns = ("series", workflow, series)
    with _LOCK:
        if store().get(ns, key) is None:
            return False
        store().delete(ns, key)
    return True


def clear_series(workflow: str, series: str) -> int:
    ns = ("series", workflow, series)
    with _LOCK:
        items = store().search(ns, limit=10000)
        for it in items:
            store().delete(ns, it.key)
    return len(items)


def list_series() -> list[tuple]:
    with _LOCK:
        return [ns for ns in store().list_namespaces(prefix=("series",))]


def augment(schema: dict) -> dict:
    """The step's answer schema plus a required "memory" array (required, so strict structured outputs accept it)."""
    s = copy.deepcopy(schema)
    s.setdefault("properties", {})["memory"] = {"type": "array", "maxItems": 10, "items": ENTRY}
    s["required"] = list(dict.fromkeys(list(s.get("required", [])) + ["memory"]))
    return s


def split(result: dict) -> tuple[dict, list[dict]]:
    clean = {k: v for k, v in result.items() if k != "memory"}
    return clean, list(result.get("memory") or [])


def entry(text: str, step: str, run: str, scope: str) -> dict:
    return {"text": text, "step": step, "run": run, "scope": scope, "time": time.strftime("%Y-%m-%d %H:%M:%S")}


def prompt_block(state: dict, scopes: list[str]) -> str:
    """Memory shown to an agent: series memory (earlier runs) first, then this run's."""
    args = state.get("args", {})
    lines = []
    if "series" in scopes:
        for e in series_entries(args):
            lines.append(f"- [series · run {e.get('run')} · {e.get('step')}] {e['key']}: {e['text']}")
    if "run" in scopes:
        for k, e in (state.get("memory") or {}).items():
            lines.append(f"- [this run · {e.get('step')}] {k}: {e['text']}")
    body = "\n".join(lines) or "(empty)"
    if len(body) > MAX_PROMPT_CHARS:
        body = "…(older entries cut)\n" + body[-MAX_PROMPT_CHARS:]
    where = ("this run" if scopes == ["run"] else
             f"this run and earlier runs of the same series ({args.get('_series')})" if args.get("_series")
             else "this run")
    return (f"\n\n## Workflow memory ({where})\n{body}\n\n"
            "In your answer, `memory` holds what a later step"
            + (" or a later run of this series" if "series" in scopes and args.get("_series") else "")
            + " should know: decisions, verified facts with their source, things the reviewer rejected, open "
              "questions. Use a short stable `key` (writing the same key again replaces it); scope `series` for "
              "what outlives this run, `run` for this run only. Use an empty list when there is nothing new. "
              "Never put secrets in memory.")


def as_json(state: dict) -> str:
    return json.dumps({"run": state.get("memory") or {}, "series": series_entries(state.get("args", {}))},
                      ensure_ascii=False, indent=2)
