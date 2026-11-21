"""Token-cost design rules for workflows: the guide (DESIGN.md, `langflow guide`) and the warnings `langflow check`
prints for the patterns that cost the most (rules 3, 4 and 5 of the guide). Warnings never stop a run."""
from pathlib import Path

GUIDE = Path(__file__).resolve().parent / "DESIGN.md"
SEARCH_TOOLS = ("Grep", "Glob", "Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "Agent")
HIGH_EFFORT = ("high", "xhigh", "max")


def guide_text() -> str:
    return GUIDE.read_text(encoding="utf-8")


def _pick(args: dict, key: str, step: str, own):
    """A run override (key.<step>= or key.*=) wins over the workflow's value, as in engine.ai."""
    return (args or {}).get(f"{key}.{step}") or (args or {}).get(f"{key}.*") or own


def cost_warnings(project, row: dict, modes: dict, args: dict | None = None) -> list[str]:
    """Warnings for one step_rows() row (needs row["cost"], set by engine.ai) and its catalog.modes(). Each warning
    names the guide rule. [] when the row carries no cost metadata (a worker that could not be probed)."""
    cost = row.get("cost")
    if not isinstance(cost, dict):
        return []
    from .catalog import tool_name
    agent, step, worker = row.get("agent") or "claude", row["step"], bool(row.get("fanout"))
    cfg = project.agent(agent) if hasattr(project, "agent") else {}
    effort = _pick(args, "effort", step, cost.get("effort")) or cfg.get("default_effort")
    model = _pick(args, "model", step, cost.get("model")) or cfg.get("default_model")
    tools = cost.get("tools")
    out = []
    if cost.get("guardrail"):
        if modes.get("retry_mode") == "fresh":
            out.append("guardrail retries start a new session that reads everything again; "
                       "retry_mode resume continues the session with the feedback only (guide rule 5)")
        if (cost.get("retries") or 0) > 2:
            out.append(f"retries={cost['retries']}: each round is another agent call; 1 or 2 is enough when the "
                       "feedback names the problem (guide rule 5)")
    if worker:
        if tools is None:
            out.append("fan-out workers run with the CLI's default tools, so each worker can search and read the "
                       "same sources again; prepare the input in a script step and give tools=[] or a short list "
                       "(guide rules 1-3)")
        else:
            search = sorted({tool_name(t) for t in tools} & set(SEARCH_TOOLS))
            if search:
                out.append(f"fan-out workers may use {', '.join(search)}: every worker repeats the search; hand them "
                           "prepared excerpts instead (guide rule 3)")
        if effort in HIGH_EFFORT:
            out.append(f"fan-out workers at effort {effort}: thinking is output, the costliest token; medium fits "
                       f"template work, raise one run with effort.{step}=high if needed (guide rule 4)")
        if model and "opus" in str(model).lower():
            out.append(f"fan-out workers on {model}: a mid model fits the many template calls; keep the strong model "
                       "for planning and review (guide rule 4)")
    elif effort in ("xhigh", "max"):
        out.append(f"effort {effort}: keep xhigh / max for a step that really needs the deepest judgement "
                   "(guide rule 4)")
    return out
