"""Claude Code adapter: `claude -p --output-format stream-json --json-schema ...`, prompt on stdin.

Runs with the user's normal Claude Code login and loads the project's CLAUDE.md, skills and hooks (not --bare).
Options: tools (allowed tools, permission rule syntax), permission_mode, role (the step's resolved role, see
catalog.resolve), role_mode (catalog.modes; None = automatic, the behaviour before role_mode):
  agent    a role whose file is .claude/agents/<id>.md runs as the session's agent: `--agents <run>/<step>.agents.json
           --agent lf-<id>`, a copy of the role whose tools keep StructuredOutput (its prompt replaces the default
           system prompt). The step's tools limit it (agent_limits: --tools, and --disallowedTools
           Write,Edit,NotebookEdit when the step is read-only); the step contract, when the engine passes `contract`,
           also goes in with --append-system-prompt.
  append   the role text in <runs_dir>/<run>/<step>.system.md, passed with --append-system-prompt-file (no length
           limit; the default system prompt stays).
  prompt   the role text before the prompt.
  None     --append-system-prompt <text> on the command line, or before the prompt when longer than APPEND_MAX
           characters (the Windows command-line limit); the system file when the step also has "system" skills.
skills (catalog.resolve, each with `via`; the engine already put "inject" / "name" skills into the prompt):
  system   their text goes into the same <step>.system.md, after the role (--append-system-prompt-file).
  native   Claude loads them from its own folder (.claude/skills, or the personal copy). [agents.claude]
           native_skills = "tool" (default): a first prompt line asks for the Skill tool, `Skill(<id>)` is
           auto-approved and kept in a limited tool list; "preload": the generated agent (`--agents` file) lists them
           under `skills:` (with an empty prompt when the role is not the agent). Claude Code 2.1.312 does not preload
           skills for the main-thread agent in -p (tested 2026-11-18, C4), so "preload" only works if a later version
           does. After the call the transcript must hold each skill's text (or a Skill tool call for it): the
           result's `skills_loaded` lists the ones found (the engine falls back for the others).
resume (a session id): `--resume <id>` with the same flags (the system-prompt snapshot keeps the first system
prompt; the same flags keep the tool list, so the cache prefix stays the same); the prompt is only the feedback.
The result's `role_channel` / `skill_channel` say what ran. On Windows, Claude Code needs Git Bash; without it, it
falls back to PowerShell, so the adapter always passes CLAUDE_CODE_GIT_BASH_PATH.
"""
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from .. import hookcheck
from ..catalog import frontmatter, prepend_role, role_text, system_text, tool_name
from ..project import Project
from .base import AgentError, brief, clean_env, stream, usage


APPEND_MAX = 16000


def git_bash(setting: str | None) -> str | None:
    if setting and setting != "auto":
        return setting if Path(setting).is_file() else None
    cand = [os.environ.get("CLAUDE_CODE_GIT_BASH_PATH")]
    git = shutil.which("git")
    if git:
        root = Path(git).resolve().parents[1]           # …/Git/cmd/git.exe or …/Git/mingw64/bin/git.exe
        cand += [root / "bin" / "bash.exe", root.parent / "bin" / "bash.exe"]
    cand += [Path.home() / "AppData/Local/Programs/Git/bin/bash.exe", Path("C:/Program Files/Git/bin/bash.exe")]
    return next((str(c) for c in cand if c and Path(c).is_file()), None)


def run(project: Project, prompt: str, schema: dict, model: str | None, opts: dict, cwd: Path, timeout: int, say):
    cfg = project.agent("claude")
    exe = shutil.which("claude")
    if not exe:
        raise AgentError("claude CLI not found on PATH")
    env = clean_env()
    if sys.platform == "win32":
        bash = git_bash(cfg.get("git_bash", "auto"))
        if not bash:
            raise AgentError("Git Bash not found (set [agents.claude] git_bash): without it the hooks do not run")
        env["CLAUDE_CODE_GIT_BASH_PATH"] = bash
    skills = opts.get("skills") or []
    sys_sk = [s for s in skills if s.get("via") == "system"]
    nat_sk = [s for s in skills if s.get("via") == "native"]
    how = cfg.get("native_skills", "tool")
    how = how if how in ("preload", "tool") else "tool"
    resume = opts.get("resume")
    allowed = list(opts.get("tools") or []) + [f"Skill({s['id']})" for s in nat_sk]
    args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--json-schema", json.dumps(schema),
            "--model", model or cfg.get("default_model", "sonnet")]
    if resume:
        args += ["--resume", resume]
    if allowed:
        args += ["--allowedTools", ",".join(dict.fromkeys(allowed))]
    if opts.get("permission_mode"):
        args += ["--permission-mode", opts["permission_mode"]]
    effort = opts.get("effort") or cfg.get("default_effort")
    if effort:
        args += ["--effort", {"minimal": "low"}.get(effort, effort)]       # Claude: low medium high xhigh max
    role, mode, channel, sk_channel = opts.get("role"), opts.get("role_mode"), None, None
    preload = [s["id"] for s in nat_sk] if how == "preload" else []
    extra_tools = ["Skill"] if nat_sk and how == "tool" else []     # the Skill tool must stay in a limited list
    sys_text = ""                                   # text for the system file (role and/or "system" skills)
    if role and role.get("native") and mode == "agent":
        channel = "agent"
        name, f = agent_file(opts, role, preload, extra_tools)
        args += ["--agents", str(f), "--agent", name]
        say(f"role {role['id']}: agent (--agent {name}, a copy of {role['path']} whose tools keep StructuredOutput: {f})")
        lim = agent_limits(cfg, opts, extra_tools)
        if lim:
            args += lim
            say("agent tools limited: " + " ".join(lim))
        if opts.get("contract"):
            args += ["--append-system-prompt", opts["contract"]]      # the step contract after the agent's prompt
            say("step contract also in the system prompt (--append-system-prompt)")
        sys_text = system_text(None, sys_sk)
    else:
        if preload:
            name, f = agent_file(opts, None, preload)
            args += ["--agents", str(f), "--agent", name]
        rt = role_text(role) if role else ""
        if rt and (mode == "append" or (mode is None and sys_sk)):
            channel = "append-file"
            sys_text = system_text(role, sys_sk)
        elif rt and (mode == "prompt" or len(rt) > APPEND_MAX):
            channel = "prompt"
            prompt = prepend_role(prompt, role)
            say(f"role {role['id']}: instructions before the prompt ({role['path']}"
                + (")" if mode == "prompt" else ", too long for the command line)"))
            sys_text = system_text(None, sys_sk)
        elif rt:                    # automatic (role_mode not set): the role text on the command line, as before
            channel = "append"
            args += ["--append-system-prompt", rt]
            say(f"role {role['id']}: system prompt from {role['path']}")
        else:
            sys_text = system_text(None, sys_sk)
    if sys_text:
        f = system_file(opts, sys_text)
        args += ["--append-system-prompt-file", str(f)]
        if channel == "append-file":
            say(f"role {role['id']}: append (system file {f})")
        if sys_sk:
            sk_channel = "system-file"
            say(f"skills system: {', '.join(s['id'] for s in sys_sk)} (system file {f})")
    if nat_sk:
        ids = ", ".join(s["id"] for s in nat_sk)
        if how == "preload":
            sk_channel = "native-preload" if not sk_channel else sk_channel + "+native-preload"
            who = f"lf-{_slug(role['id'])}" if channel == "agent" else _step_agent(opts)
            say(f"skills native: {ids} (preload via agent {who})")
        else:
            sk_channel = "native-tool" if not sk_channel else sk_channel + "+native-tool"
            if not resume:
                prompt = skill_tool_line(nat_sk) + "\n\n" + prompt
            say(f"skills native: {ids} (Skill tool)")
    if resume:
        say(f"retry: resume {resume} (same flags, prompt = feedback)")
    since = hookcheck.mark(project)
    out, session, used_model = None, None, None
    skill_calls: set[str] = set()

    def handle(e):
        nonlocal out, session, used_model
        t = e.get("type")
        if t == "system" and e.get("subtype") == "init":
            session, used_model = e.get("session_id"), e.get("model")
            say(f"session {session} model {used_model}")
        elif t == "assistant":
            for c in (e.get("message") or {}).get("content", []):
                if c.get("type") == "tool_use":
                    if c["name"] == "Skill" and isinstance(c.get("input"), dict):
                        skill_calls.add(str(c["input"].get("skill") or c["input"].get("command") or ""))
                    say("answer ready" if c["name"] == "StructuredOutput" else f"{c['name']} {brief(c.get('input'))}")
                elif c.get("type") == "text" and c.get("text", "").strip():
                    say("says: " + c["text"].strip()[:160])
        elif t == "result":
            out = e

    rc, err = stream(args, prompt, cwd, env, timeout, handle)
    if out is None:
        raise AgentError(f"claude exit {rc}, no result: {err[-500:]}")
    session = out.get("session_id") or session
    use, cost = norm_usage(out.get("usage")), out.get("total_cost_usd")
    if out.get("is_error") or "structured_output" not in out:
        raise AgentError(f"claude returned no structured output: {str(out.get('result'))[:500]}", use, cost)
    ok, n, msg = hookcheck.verify(project, since, session, "claude")
    if not ok:
        raise AgentError(msg)
    transcript = Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd)) / f"{session}.jsonl"
    res = {"result": out["structured_output"], "session": session, "hooks": n, "hook_note": msg,
           "transcript": str(transcript) if transcript.exists() else None, "usage": use,
           "usage_raw": out.get("usage", {}), "cost_usd": cost, "model_used": used_model,
           "denials": out.get("permission_denials", []), "role_channel": channel,
           # total_cost_usd is the session's total: after --resume it includes the earlier calls (tested 2026-11-18)
           "cost_scope": "session"}
    if sk_channel:
        res["skill_channel"] = sk_channel
    if nat_sk:
        res["skills_loaded"] = loaded_skills(nat_sk, transcript, skill_calls)
        missing = [s["id"] for s in nat_sk if s["id"] not in res["skills_loaded"]]
        if missing and not resume:
            say(f"native skill {', '.join(missing)} not found in the transcript")
    return res


def _slug(x: str) -> str:
    return re.sub(r"[^A-Za-z0-9-]", "-", str(x)).strip("-") or "step"


def _step_agent(opts: dict) -> str:
    return "lf-" + _slug(opts.get("step") or "step")


def skill_tool_line(items: list[dict]) -> str:
    """The first prompt line for native skills under native_skills = "tool"."""
    return ("Before you start, load each of these skills with the Skill tool, then follow them: "
            + ", ".join(s["id"] for s in items) + ".")


def probe_text(text: str) -> str:
    """A line that proves a skill's text reached the conversation: the first non-empty line of the SKILL.md body
    (after the frontmatter), at most 120 characters."""
    _, body = frontmatter(text or "")
    line = next((x.strip() for x in body.splitlines() if x.strip()), "")
    return line[:120]


def _strings(x):
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from _strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from _strings(v)


def loaded_skills(items: list[dict], transcript: Path | None, skill_calls=()) -> list[str]:
    """The ids of `items` whose text shows in the transcript JSONL (probe_text in any string), or that had a Skill
    tool call (input.skill == id, seen in the stream or in the transcript)."""
    want = {s["id"]: probe_text(s.get("text") or "") for s in items}
    got = {i for i in want if i in set(skill_calls)}
    try:
        lines = Path(transcript).read_text(encoding="utf-8", errors="replace").splitlines() if transcript else []
    except OSError:
        lines = []
    for line in lines:
        if len(got) == len(want):
            break
        try:
            e = json.loads(line)
        except ValueError:
            continue
        for c in ((e.get("message") or {}).get("content") or []) if isinstance(e.get("message"), dict) else []:
            if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill":
                sid = str((c.get("input") or {}).get("skill") or "")
                if sid in want:
                    got.add(sid)
        texts = list(_strings(e))
        for sid, probe in want.items():
            if sid not in got and probe and any(probe in t for t in texts):
                got.add(sid)
    return [s["id"] for s in items if s["id"] in got]


def agent_limits(cfg: dict, opts: dict, extra: list[str] | tuple = ()) -> list[str]:
    """Extra flags for a step run as the role's agent (--agent): the agent's own `tools` would otherwise be the
    step's tools, and --allowedTools only auto-approves (it removes nothing). `--tools` = the tool names of the step's
    allowed tools (the step's own, else the role's tools the engine kept, see catalog.role_tools); under sandbox
    "read-only" also `--disallowedTools Write,Edit,NotebookEdit` (minus a tool the step itself allows).
    [agents.claude] restrict_tools = false turns both off."""
    if not cfg.get("restrict_tools", True):
        return []
    out = []
    names = list(dict.fromkeys(tool_name(t) for t in opts.get("tools") or [] if tool_name(t)))
    if names:
        names += [x for x in extra if x not in names]
    if names:
        # --json-schema answers through the StructuredOutput tool; a --tools list without it leaves the agent
        # unable to answer (tested 2026-11-18: "no structured output", the JSON came back as plain text).
        out += ["--tools", ",".join([*names, "StructuredOutput"] if "StructuredOutput" not in names else names)]
    if (opts.get("sandbox") or "read-only") == "read-only":
        own = {tool_name(t) for t in opts.get("step_tools") or []}
        deny = [t for t in ("Write", "Edit", "NotebookEdit") if t not in own]
        if deny:
            out += ["--disallowedTools", ",".join(deny)]
    return out


def agent_file(opts: dict, role: dict | None, skills: list[str] | None = None,
               extra: list[str] | tuple = ()) -> tuple[str, Path]:
    """Write <runs_dir>/<run>/<step>.agents.json with one agent and return (name, path) for `--agents <file> --agent
    <name>`.
    role (role_mode "agent"): `lf-<id>`, a copy of the role (its prompt and model) whose tools are the step's tool
    names (else the role's) plus StructuredOutput. Running the project file itself with --agent fails under
    --json-schema when its `tools:` line lacks StructuredOutput (no structured output; tested 2026-11-18).
    role None: `lf-<step>` with an empty prompt (the session's system prompt stays as it is) and no tools list.
    skills: native skill ids the agent preloads (`skills:`). extra: tool names added to a role's tools list (the Skill
    tool for native skills under native_skills = "tool")."""
    if role:
        name = "lf-" + _slug(role["id"])
        tools = [tool_name(t) for t in (opts.get("tools") or role.get("tools") or []) if tool_name(t)]
        spec = {"description": f"langflow step role {role['id']} (copy of {role['path']})",
                "prompt": (role.get("instructions") or "").strip()}
        if tools:
            spec["tools"] = list(dict.fromkeys([*tools, *extra, "StructuredOutput"]))
        if role.get("model"):
            spec["model"] = role["model"]
    else:
        name = _step_agent(opts)
        spec = {"description": f"langflow step {opts.get('step') or 'step'} (skills preload)", "prompt": ""}
    if skills:
        spec["skills"] = list(dict.fromkeys(skills))
    p = run_file(opts, ".agents.json")
    p.write_text(json.dumps({name: spec}, ensure_ascii=False, indent=1), encoding="utf-8")
    return name, p


def run_file(opts: dict, suffix: str) -> Path:
    """<runs_dir>/<run>/<step><suffix> (kept: it shows what the CLI got); %TEMP% when the engine gave no run folder
    (tests)."""
    d = opts.get("run_dir")
    if d:
        p = Path(d) / (re.sub(r"[^\w.\[\]-]", "_", str(opts.get("step") or "step")) + suffix)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    fd, name = tempfile.mkstemp(prefix="langflow_", suffix=suffix)
    os.close(fd)
    return Path(name)


def system_file(opts: dict, text: str) -> Path:
    """Write a step's system-prompt text to <runs_dir>/<run>/<step>.system.md (UTF-8, no BOM) and return its path."""
    p = run_file(opts, ".system.md")
    p.write_bytes(text.encode("utf-8"))
    return p


def norm_usage(u: dict | None) -> dict:
    """Claude `result.usage`: input_tokens is already the uncached input."""
    u = u or {}
    return usage(u.get("input_tokens"), u.get("output_tokens"), u.get("cache_read_input_tokens"),
                 u.get("cache_creation_input_tokens"))
