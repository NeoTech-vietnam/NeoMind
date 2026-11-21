"""Codex adapter: `codex exec --json --output-schema <file> -s <sandbox> -`, prompt on stdin.

Runs with the saved Codex login and the project's AGENTS.md and hooks (.codex/hooks.json, once trusted).
Options: sandbox ("read-only" default, "workspace-write"), role (the step's resolved role, see catalog.resolve),
role_mode (catalog.modes; None = automatic, the behaviour before role_mode):
  prompt / None      the role's instructions (developer_instructions of .codex/agents/<id>.toml, else the Markdown
                     body) go before the prompt.
  append / agent     the role text goes in as `-c developer_instructions=<TOML string>` (Codex sends it as a
                     developer message; Codex has no main-thread agent, so "agent" is the same). This needs the
                     direct launcher (launcher(): node + codex.js, or the bundled codex.exe), never the codex.cmd
                     shim: cmd.exe would mangle & | < > ^ % and quotes in the argument. Without a launcher, or when
                     the command line would pass ARGV_MAX characters, the role goes before the prompt (logged).
skills (catalog.resolve, each with `via`; "inject" / "name" ones are already in the prompt):
  system             after the role in the same developer_instructions (same launcher and length rules; else
                     before the prompt).
  native             first prompt line `Load these skills before you start: [$id](<abs path>/SKILL.md)` (the linked
                     form binds the exact file, even when ~/.codex/skills has a skill of the same name). Codex then
                     injects the SKILL.md as a `<skill>` user message; `skills_loaded` = the ids whose text shows in
                     the rollout.
resume (a thread id): `codex exec resume <thread> … -c sandbox_mode="<sandbox>" … -` (resume has no -s / -C: the
folder is the process cwd); developer_instructions are sent again; the prompt is only the feedback. Codex reports
turn.completed.usage for the whole thread, so the result says `usage_scope: "session"` and the engine keeps only the
new call's part.
The prompt always goes through stdin. The result's `role_channel` / `skill_channel` say which channel ran.
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .. import hookcheck
from ..catalog import prepend_role, role_text, skills_text, system_text
from ..project import Project
from .base import AgentError, clean_env, stream, usage as mk_usage
from .claude import loaded_skills

ARGV_MAX = 30000          # the Windows command line is at most 32,767 characters
PACKAGE = Path("node_modules") / "@openai" / "codex"
VENDOR_EXE = Path("node_modules") / "@openai" / "codex-win32-x64" / "vendor" / "x86_64-pc-windows-msvc" / "bin" / \
    "codex.exe"


def launcher(exe: str | None) -> tuple[list[str], dict] | None:
    """(argv prefix, extra env) that starts Codex without a shell, or None when that is not possible.
    exe = the `codex` found on PATH. An npm shim (codex.cmd / codex.ps1) is bypassed: [node, <npm>/node_modules/
    @openai/codex/bin/codex.js] (node = <npm>/node.exe when present, else node on PATH); without node, the bundled
    codex.exe with the two variables codex.js sets. Any other exe (native, POSIX script) is used as it is."""
    if not exe:
        return None
    p = Path(exe)
    if p.suffix.lower() not in (".cmd", ".ps1", ".bat"):
        return [exe], {}
    pkg = p.parent / PACKAGE
    js = pkg / "bin" / "codex.js"
    if js.is_file():
        node = p.parent / "node.exe"
        node = str(node) if node.is_file() else shutil.which("node")
        if node:
            return [node, str(js)], {}
        vendor = pkg / VENDOR_EXE
        if vendor.is_file():
            return [str(vendor)], {"CODEX_MANAGED_PACKAGE_ROOT": str(pkg.resolve()), "CODEX_MANAGED_BY_NPM": "1"}
    return None


def toml_str(s: str) -> str:
    """s as a TOML basic string ("…"): backslash, quote and control characters escaped (\\n \\t \\r, else
    \\uXXXX); other characters (Vietnamese text, & | < > ^ %) kept. Raises ValueError on a lone surrogate (not valid
    TOML)."""
    out = ['"']
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF:
            raise ValueError("text holds a lone surrogate; it cannot go into TOML")
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif o < 0x20 or o == 0x7F:
            out.append(f"\\u{o:04X}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def cmdline_len(args: list[str]) -> int:
    """Length of the command line CreateProcess gets for args."""
    return len(subprocess.list2cmdline([str(a) for a in args]))


def skill_path(project: Project, s: dict) -> str:
    """Absolute path (with '/') of the SKILL.md Codex should load for a resolved native skill (its `path` is the copy
    Codex reads: project-relative, or "~/…" for a personal copy)."""
    p = s["path"]
    full = Path(os.path.expanduser(p)) if p.startswith("~/") else Path(project.root) / p
    return full.resolve().as_posix()


def mention_line(project: Project, items: list[dict]) -> str:
    """The first prompt line for native skills: linked mentions `[$id](<abs path>/SKILL.md)`; the link binds the
    exact file even when another skill has the same name (F5)."""
    return "Load these skills before you start: " + ", ".join(f"[${s['id']}]({skill_path(project, s)})" for s in items)


def run(project: Project, prompt: str, schema: dict, model: str | None, opts: dict, cwd: Path, timeout: int, say):
    cfg = project.agent("codex")
    exe = shutil.which("codex")
    if not exe:
        raise AgentError("codex CLI not found on PATH")
    model = model or cfg.get("default_model")
    role, mode, channel, sk_channel = opts.get("role"), opts.get("role_mode"), None, None
    skills = opts.get("skills") or []
    sys_sk = [s for s in skills if s.get("via") == "system"]
    nat_sk = [s for s in skills if s.get("via") == "native"]
    resume = opts.get("resume")
    dev_role = role if role and mode in ("append", "agent") and role_text(role) else None
    dev_text = system_text(dev_role, sys_sk)
    head, env_extra, dev = [exe], {}, None
    if dev_text:
        found = launcher(exe)
        why = None
        if not found:
            why = "codex launcher not found (no codex.js / codex.exe next to the shim)"
        else:
            try:
                dev = ["-c", "developer_instructions=" + toml_str(dev_text)]
            except ValueError as e:
                why = str(e)
        if why:
            dev = None
            say(f"developer_instructions: {why}; instructions before the prompt instead")
        else:
            head, env_extra = found
    fd, sf = tempfile.mkstemp(suffix=".json", prefix="langflow_schema_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(schema, f)
    effort = opts.get("effort") or cfg.get("default_effort")
    effort = {"max": "xhigh"}.get(effort, effort)                       # Codex: minimal low medium high xhigh
    sandbox = opts.get("sandbox", "read-only")
    pre = [*(["-m", model] if model else []), *(["-c", f'model_reasoning_effort="{effort}"'] if effort else [])]
    if resume:
        # `exec resume` has no -C and no -s: the folder is the process cwd, the sandbox a config value
        tail = [*pre, "-c", f'sandbox_mode="{sandbox}"', "--json", "--output-schema", sf, "-"]
        verb = ["exec", "resume", resume]
    else:
        tail = [*pre, "-C", str(cwd), "--json", "--output-schema", sf, "-s", sandbox, "-"]
        verb = ["exec"]
    args = [*head, *verb, *(dev or []), *tail]
    if dev and cmdline_len(args) > ARGV_MAX:
        say(f"developer_instructions would make the command line {cmdline_len(args)} characters (> {ARGV_MAX}); "
            "instructions before the prompt instead")
        dev, args = None, [exe, *verb, *tail]
        env_extra = {}
    if dev and dev_role:
        channel = "developer_instructions"
        say(f"role {role['id']}: append (developer_instructions from {role['path']}, launcher {Path(head[-1]).name})")
    if dev and sys_sk:
        sk_channel = "developer_instructions"
        say(f"skills system: {', '.join(s['id'] for s in sys_sk)} (developer_instructions)")
    if not resume:
        # no developer channel: the skills, then the role, before the prompt (as inject / prompt would)
        if sys_sk and not dev:
            sk_channel = "prompt"
            prompt = f"{skills_text(sys_sk)}\n---\n\n{prompt}"
            say(f"skills system: {', '.join(s['id'] for s in sys_sk)} before the prompt instead")
        if role and role_text(role) and not (dev and dev_role):
            channel = "prompt"
            prompt = prepend_role(prompt, role)
            say(f"role {role['id']}: instructions from {role['path']} before the prompt")
    if nat_sk:
        sk_channel = "native-mention" if not sk_channel else sk_channel + "+native-mention"
        if not resume:
            prompt = mention_line(project, nat_sk) + "\n\n" + prompt
        say(f"skills native: {', '.join(s['id'] for s in nat_sk)} (linked $mention)")
    if resume:
        say(f"retry: resume {resume} (prompt = feedback)")
    since = hookcheck.mark(project)
    thread, text, usage, errors = None, None, {}, []

    def handle(e):
        nonlocal thread, text, usage
        t, item = e.get("type"), e.get("item") or {}
        if t == "thread.started":
            thread = e.get("thread_id")
            say(f"thread {thread} model {model}")
        elif t == "item.started" and item.get("type") == "command_execution":
            say("$ " + str(item.get("command"))[:200])
        elif t == "item.completed" and item.get("type") == "command_execution":
            say(f"  exit {item.get('exit_code')}")
        elif t == "item.completed" and item.get("type") == "agent_message":
            text = item.get("text")
            say("answer ready")
        elif t == "turn.completed":
            usage = e.get("usage", {})
        elif t in ("turn.failed", "error"):
            errors.append(json.dumps(e)[:300])
            say("ERROR " + json.dumps(e)[:200])

    try:
        rc, err = stream(args, prompt, cwd, {**clean_env(), **env_extra}, timeout, handle)
    finally:
        os.unlink(sf)
    thread = thread or resume
    if errors or text is None:
        raise AgentError(f"codex exit {rc}: {errors or err[-500:]}", norm_usage(usage))
    try:
        result = json.loads(text)
    except ValueError:
        raise AgentError(f"codex answer is not JSON: {text[:300]}")
    ok, n, msg = hookcheck.verify(project, since, thread, "codex")
    if not ok:
        raise AgentError(msg)
    found = sorted((Path.home() / ".codex" / "sessions").rglob(f"*{thread}*.jsonl")) if thread else []
    res = {"result": result, "session": thread, "hooks": n, "hook_note": msg, "usage": norm_usage(usage),
           "usage_raw": usage, "cost_usd": None, "model_used": model,
           "transcript": str(found[-1]) if found else None, "role_channel": channel,
           # turn.completed.usage is the thread's total: after `exec resume` it includes the earlier turns (tested
           # 2026-11-18); the engine keeps only this call's part
           "usage_scope": "session"}
    if sk_channel:
        res["skill_channel"] = sk_channel
    if nat_sk:
        res["skills_loaded"] = loaded_skills(nat_sk, found[-1] if found else None)
        missing = [s["id"] for s in nat_sk if s["id"] not in res["skills_loaded"]]
        if missing and not resume:
            say(f"native skill {', '.join(missing)} not found in the rollout")
    return res


def norm_usage(u: dict | None) -> dict:
    """Codex `turn.completed.usage`: input_tokens include the cached ones; output_tokens include reasoning."""
    u = u or {}
    cached = int(u.get("cached_input_tokens") or 0)
    return mk_usage(int(u.get("input_tokens") or 0) - cached, u.get("output_tokens"), cached, 0,
                    u.get("reasoning_output_tokens"))
