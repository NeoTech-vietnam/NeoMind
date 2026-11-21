"""Views of a workflow for a person: a Mermaid diagram of the steps and a live page per run.

The run page (<state_dir>/runs/<run>.md) is rewritten on every status change, so it can stay open in a Markdown
viewer that renders Mermaid while the run goes on: diagram coloured by progress, one row per step, the gate question
with the command to answer it, and the last lines of the live log (runs/<run>.log).
The diagram comes from the compiled LangGraph graph (engine.layout): nodes with their kind, edges with labels.
"""
import json
import re
from pathlib import Path

SHAPE = {"ai": ('(["', '"])'), "script": ('[["', '"]]'), "write": ('[("', '")]'), "gate": ('{"', '"}'),
         "route": ('{{"', '"}}'), "loop": ('{{"', '"}}'), "fanout": ('[/"', '"\\]'), "worker": ('(["', '"])'),
         "parallel": ('[/"', '"\\]'), "join": ('[\\"', '"/]'), "start": ('(("', '"))'), "end": ('(("', '"))')}
KIND_LABEL = {"ai": "AI", "script": "script", "write": "write file", "gate": "gate (person)", "route": "route",
              "loop": "loop check", "fanout": "fan-out", "worker": "AI worker × N", "parallel": "parallel",
              "join": "join", "start": "", "end": ""}
KIND_CLASS = {"ai": "fill:#dbe9ff,stroke:#3b6fb6", "worker": "fill:#dbe9ff,stroke:#3b6fb6,stroke-dasharray:4",
              "script": "fill:#eeeeee,stroke:#777", "write": "fill:#e3f4e1,stroke:#4f8f4a",
              "gate": "fill:#ffe1bf,stroke:#c77700", "route": "fill:#f3e5f5,stroke:#7b1fa2",
              "loop": "fill:#f3e5f5,stroke:#7b1fa2", "fanout": "fill:#fffde7,stroke:#9e9d24",
              "parallel": "fill:#fffde7,stroke:#9e9d24", "join": "fill:#fffde7,stroke:#9e9d24"}
STATE_CLASS = {"done": "fill:#c8e6c9,stroke:#2e7d32", "running": "fill:#fff59d,stroke:#f9a825,stroke-width:3px",
               "waiting": "fill:#ffcc80,stroke:#ef6c00,stroke-width:3px", "failed": "fill:#ef9a9a,stroke:#c62828",
               "rejected": "fill:#e0e0e0,stroke:#616161", "cancelled": "fill:#e0e0e0,stroke:#616161,stroke-dasharray:4",
               "todo": "fill:#ffffff,stroke:#9e9e9e"}
STATE_ICON = {"done": "✅", "running": "⏳", "waiting": "⏸", "failed": "❌", "rejected": "⛔", "cancelled": "⏹",
              "todo": "·"}
USAGE_SUM = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")


def add_usage(a: dict | None, b: dict | None) -> dict:
    """Sum two `usage` dicts (tokens; cost_usd stays None only when both are unknown)."""
    a, b = a or {}, b or {}
    out = {k: int(a.get(k) or 0) + int(b.get(k) or 0) for k in USAGE_SUM}
    costs = [x.get("cost_usd") for x in (a, b) if x.get("cost_usd") is not None]
    out["cost_usd"] = round(sum(costs), 6) if costs else None
    srcs = [x.get("cost_source") for x in (a, b) if x.get("cost_source")]
    out["cost_source"] = ("agent" if "agent" in srcs else "pricing") if srcs else None
    return out


def tokens(u: dict | None) -> int:
    """All tokens of a usage dict or totals (input + output + cache read + cache write)."""
    u = u or {}
    return sum(int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"))


def fmt_tokens(n: int) -> str:
    return f"{n / 1e6:.2f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e3 else str(n)


def fmt_cost(c) -> str:
    return "" if c is None else f"${c:.4f}" if c < 0.1 else f"${c:.2f}"


def _id(n: str) -> str:
    return {"__start__": "START", "__end__": "END"}.get(n, re.sub(r"[^A-Za-z0-9_]", "_", n))


def mermaid(graph: dict, states: dict | None = None) -> str:
    """graph: {"nodes": [{id, kind}], "edges": [{source, target, label, conditional}]}.
    states: node -> state (run page); None colours by kind (plain workflow diagram)."""
    lines = ["flowchart TD"]
    for n in graph["nodes"]:
        a, b = SHAPE.get(n["kind"], ('["', '"]'))
        if n["kind"] in ("start", "end"):
            lines.append(f'  {_id(n["id"])}{a}{n["kind"]}{b}')
        else:
            extra = "".join([f" · role {n['role']}" if n.get("role") else "",
                             f" · {len(n['skills'])} skill{'s' if len(n['skills']) != 1 else ''}"
                             if n.get("skills") else ""])
            lines.append(f'  {_id(n["id"])}{a}{n["id"]}<br/><small>{KIND_LABEL.get(n["kind"], n["kind"])}{extra}'
                         f'</small>{b}')
    for e in graph["edges"]:
        arrow = "-.->" if e.get("conditional") else "-->"
        label = f"|{e['label']}|" if e.get("label") else ""
        lines.append(f"  {_id(e['source'])} {arrow}{label} {_id(e['target'])}")
    nodes = [n for n in graph["nodes"] if n["kind"] not in ("start", "end")]
    if states is None:
        for k, style in KIND_CLASS.items():
            lines.append(f"  classDef {k} {style}")
        lines += [f"  class {_id(n['id'])} {n['kind']}" for n in nodes if n["kind"] in KIND_CLASS]
    else:
        for k, style in STATE_CLASS.items():
            lines.append(f"  classDef {k} {style}")
        lines += [f"  class {_id(n['id'])} {states.get(n['id'], 'todo')}" for n in nodes]
    return "\n".join(lines)


def step_states(st: dict) -> tuple[dict, dict]:
    """From the status history: node -> state, and node -> detail. Fan-out workers log as '<fanout>[i]' and are
    counted on the node '<fanout>_worker'.
    Detail keys from ai steps: usage (summed over the step's runs: a step cut and run again counts both), attempts
    (agent calls of the last run of the step), retries (transient retries) and guardrail_rounds (check failed),
    both counted over the whole history; role, skills and binding (ids, paths, sha256 the last start used) and
    binding_changes (what `langflow continue` found changed since; cleared when the step starts again)."""
    states, info = {}, {}
    workers: dict[str, dict[str, str]] = {}

    def spend(d, h):
        if h.get("usage"):
            d["usage"] = add_usage(d.get("usage"), h["usage"])
        if h.get("attempts") is not None:
            d["attempts"] = h["attempts"]
        if ev == "retry":
            d["retries"] = d.get("retries", 0) + 1
        elif ev == "check failed":
            d["guardrail_rounds"] = d.get("guardrail_rounds", 0) + 1

    for h in st.get("history", []):
        name, ev = h.get("step"), h.get("event")
        if not name:
            continue
        m = re.match(r"^(.*)\[(\d+)\]$", name)
        if m:
            wnode = m.group(1) + "_worker"
            w = workers.setdefault(wnode, {})
            if ev != "binding changed":
                w[m.group(2)] = {"start": "running", "done": "done", "failed": "failed", "cut": "cancelled"}.get(
                    ev, w.get(m.group(2), "running"))
            wd = info.setdefault(wnode, {})
            spend(wd, h)
            if ev == "start":
                # every worker runs with the fan-out's binding: the node shows the latest start's
                wd.setdefault("start", h["time"])
                for k in ("agent", "model", "effort"):
                    if h.get(k) is not None:
                        wd[k] = h[k]
                for k in ("role", "skills", "binding", "role_mode", "contract", "skill_mode", "retry_mode"):
                    if h.get(k) not in (None, "", []):
                        wd[k] = h[k]
                    else:
                        wd.pop(k, None)
                wd.pop("binding_changes", None)
            elif ev == "binding changed":
                wd["binding_changes"] = list(dict.fromkeys((wd.get("binding_changes") or [])
                                                           + list(h.get("changes") or [])))
            continue
        d = info.setdefault(name, {})
        if ev == "start":
            states[name], d["start"] = "running", h["time"]
            for k in ("role", "skills", "binding", "binding_changes", "role_mode", "contract", "role_channel",
                      "skill_mode", "retry_mode", "skill_channel", "skills_loaded", "resumes", "native_fallback"):
                d.pop(k, None)
        elif ev == "binding changed":
            d["binding_changes"] = h.get("changes") or []
        elif ev == "native fallback":
            # a native skill did not load: the step ran again with the fallback; the binding shows the new `via`
            if h.get("binding"):
                d["binding"] = h["binding"]
            d["native_fallback"] = list(dict.fromkeys((d.get("native_fallback") or []) + list(h.get("skills") or [])))
        elif ev in ("done", "kept", "approve"):
            states[name], d["end"] = "done", h["time"]
            d.setdefault("start", h["time"])
        elif ev == "failed":
            states[name], d["end"], d["error"] = "failed", h["time"], h.get("error")
        elif ev == "reject":
            states[name], d["end"] = "rejected", h["time"]
        elif ev in ("cut", "cancelled"):
            if states.get(name) in ("running", "waiting", None) or ev == "cut":
                states[name], d["end"] = "cancelled", h["time"]
            if ev == "cancelled":
                d["cancelled_by"] = h.get("by")
        elif ev == "continue" and states.get(name) in ("cancelled", "failed"):
            states[name] = "running"
        spend(d, h)
        for k in ("role", "skills", "binding", "role_mode", "contract", "skill_mode", "retry_mode") if ev == "start" else ():
            if h.get(k) not in (None, "", []):
                d[k] = h[k]
        for k in ("agent", "model", "effort", "seconds", "session", "hooks", "path", "transcript", "note", "by", "attempt", "feedback", "route",
                  "role_channel", "skill_channel", "skills_loaded", "resumes",
                  "round", "passed", "items", "collected", "decision"):
            if h.get(k) is not None:
                d[k] = h[k]
    for wnode, ws in workers.items():
        vals = list(ws.values())
        states[wnode] = ("failed" if "failed" in vals else "cancelled" if "cancelled" in vals and st.get("status") ==
                         "cancelled" else "running" if "running" in vals or "cancelled" in vals else "done")
        info.setdefault(wnode, {})["workers"] = f"{vals.count('done')}/{len(vals)} done"
    if st.get("status") == "waiting" and st.get("gate"):
        states[st["gate"]] = "waiting"
    if st.get("status") == "failed" and st.get("step") and st["step"] in info:
        states[st["step"]] = "failed"
    if st.get("status") == "cancelled":
        for n, s_ in states.items():
            if s_ in ("running", "waiting"):
                states[n] = "cancelled"
    return states, info


def binding_label(d: dict, node: dict | None = None) -> str:
    """"role x · skills a, b" for a step: what its last run used (info), else what the graph says it will use."""
    src = d if d.get("binding") or d.get("role") or d.get("skills") else (node or {})
    mode = d.get("role_mode") or (((d.get("binding") or {}).get("role") or {}).get("mode"))
    via = {s.get("id"): s.get("via") for s in ((d.get("binding") or {}).get("skills") or [])} if src is d else {}
    names = [x + (f" [{via[x]}]" if via.get(x) not in (None, "inject") else "") for x in src.get("skills") or []]
    parts = ([f"role {src['role']}" + (f" [{mode}]" if mode and src is d else "")] if src.get("role") else []) + (
        [f"skills {', '.join(names)}"] if names else [])
    if d.get("binding_changes"):
        parts.append("changed since run: " + "; ".join(d["binding_changes"])[:120])
    return " · ".join(parts)


def _detail(d: dict, node: dict | None = None) -> str:
    out = [binding_label(d, node)] if binding_label(d, node) else []
    for k, fmt in (("model", "{}"), ("effort", "effort {}"), ("seconds", "{} s"), ("hooks", "hooks {}"), ("route", "route → {}"), ("round", "round {}"),
                   ("passed", "passed: {}"), ("decision", "{}"), ("items", "{} items"), ("collected", "{} collected"),
                   ("workers", "workers {}"), ("note", "note: {}"), ("feedback", "check: {}")):
        if d.get(k) is not None:
            out.append(fmt.format(str(d[k])[:120]))
    u = d.get("usage")
    if u and (tokens(u) or u.get("cost_usd") is not None):
        out.append(f"{fmt_tokens(tokens(u))} tok" + (f" {fmt_cost(u['cost_usd'])}" if u.get("cost_usd") is not None
                                                     else ""))
    if (d.get("attempts") or 0) > 1:
        out.append(f"{d['attempts']} calls")
    if d.get("retries"):
        out.append(f"{d['retries']} retries")
    if d.get("path"):
        out.append(f"`{Path(d['path']).name}`")
    if d.get("transcript"):
        out.append(f"transcript `{d['transcript']}`")
    if d.get("error"):
        out.append(f"error: {str(d['error'])[:120]}")
    return "; ".join(out)


def totals_line(t: dict) -> str:
    """One line for the status totals: tokens, cost, AI time, ai steps."""
    parts = [f"{fmt_tokens(tokens(t))} tokens (in {fmt_tokens(int(t.get('input_tokens') or 0))}, "
             f"out {fmt_tokens(int(t.get('output_tokens') or 0))}, "
             f"cache {fmt_tokens(int(t.get('cache_read_tokens') or 0) + int(t.get('cache_write_tokens') or 0))})"]
    if t.get("cost_usd") is not None:
        parts.append(fmt_cost(t["cost_usd"]))
    parts.append(f"AI {float(t.get('ai_seconds') or 0) / 60:.1f} min over {t.get('steps', 0)} ai step runs")
    return " · ".join(parts)


def page(st: dict, log_tail: list[str]) -> str:
    graph = st.get("graph") or {"nodes": [], "edges": []}
    states, info = step_states(st)
    status = st.get("status", "?")
    out = [f"# langflow run `{st.get('run')}` — {st.get('workflow')}", "",
           f"**Status:** {STATE_ICON.get(status, '')} {status} · step `{st.get('step')}` · updated {st.get('updated')} · "
           f"started {st.get('started')}", "",
           f"Args: `{json.dumps(st.get('args', {}), ensure_ascii=False)}`", ""]
    if st.get("totals"):
        out += [f"**Spend:** {totals_line(st['totals'])}", ""]
    if status == "waiting":
        out += ["> [!IMPORTANT]", f"> Waiting at gate **{st.get('gate')}**: {st.get('question')}",
                f"> Answer in your own terminal: `langflow approve {st.get('run')}` "
                "(add `--note \"...\"`, or `--reject`)."]
        out += [f"> Read: `{f}`" for f in st.get("gate_files") or []] + [""]
    if status == "cancelled":
        by = next((h.get("by") for h in reversed(st.get("history", [])) if h.get("event") == "cancelled"), None)
        out += ["> [!NOTE]", f"> Cancelled at `{st.get('step')}`" + (f" by {by}" if by else "") + ". "
                f"`langflow continue {st.get('run')}` re-runs that step.", ""]
    if status == "failed":
        out += ["> [!CAUTION]", f"> Failed at `{st.get('step')}`: {str(st.get('error'))[:400]}",
                f"> After fixing the cause: `langflow continue {st.get('run')}`", ""]
    out += ["```mermaid", mermaid(graph, states), "```", "",
            "| # | Step | Kind | State | Start | End | Detail |", "|---|---|---|---|---|---|---|"]
    nodes = [n for n in graph["nodes"] if n["kind"] not in ("start", "end")]
    for i, n in enumerate(nodes, 1):
        d, state = info.get(n["id"], {}), states.get(n["id"], "todo")
        out.append(f"| {i} | `{n['id']}` | {KIND_LABEL.get(n['kind'], n['kind'])} | {STATE_ICON[state]} {state} | "
                   f"{(d.get('start') or '')[11:]} | {(d.get('end') or '')[11:]} | {_detail(d, n)} |")
    mem = st.get("memory_recent") or []
    if mem or st.get("series"):
        out += ["", f"## Memory (series `{st.get('series') or '—'}`; latest written in this run)", "",
                "| Scope | Key | Step | Text |", "|---|---|---|---|"]
        out += [f"| {m.get('scope')} | `{m.get('key')}` | {m.get('step')} | {str(m.get('text'))[:160]} |" for m in mem]
    out += ["", f"## Live log (last {len(log_tail)} lines of `{st.get('run')}.log`)", "", "```text", *log_tail, "```", ""]
    return "\n".join(out)
