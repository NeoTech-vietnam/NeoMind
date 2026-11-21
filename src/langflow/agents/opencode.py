"""OpenCode adapter: an isolated `opencode serve` (V2 API, OpenCode 2.2.7) per step, driven over loopback HTTP.

Port of NeoMind's OpenCode V2 runner (test_workflow/src/runners/opencode-v2-*.ts):
1. Start `opencode serve --hostname 127.0.0.1 --port 0` with an isolated environment: no inherited OPENCODE_*,
   PWD or OLDPWD; XDG_CONFIG_HOME and XDG_CACHE_HOME in a temp instance folder whose opencode.json denies plugins,
   MCP, grant and rig commands and pins the shell (Windows PowerShell); project config off; Claude Code folders off
   and OPENCODE_TEST_HOME = an empty folder of the instance, so OpenCode finds no personal skills in ~/.claude or
   ~/.agents (2.2.7 always scans both; OPENCODE_DISABLE_EXTERNAL_SKILLS does not exist in 2.2.7); Basic auth with a
   random password. The user's XDG_DATA_HOME (login, saved sessions) stays.
   Native role / skills (catalog role_mode "agent", skill_mode "native") extend the instance config: `agents.lf-role`
   (the role text as the agent's system prompt, which replaces OpenCode's base prompt) and `skills: [<copies>]`, a
   copy of exactly the bound skill folders (SKILL.md checked against the sha256 langflow recorded) in a folder of
   its own under <state dir>/opencode/skills (deleted after the call). OpenCode tells the model that folder as the
   skill's base directory for companion files; under the project the session's read rule covers it (in the temp
   instance folder, the fallback when the state dir is not under the step's folder, reads are denied).
2. Verify the server before use: version, config sources (only the instance config, unchanged, extension included),
   no MCP, built-in plugins only, no saved approvals, the requested model and effort exist; the skill registry holds
   only the built-in `skill://` skills plus the bound ones, each from its copy with the copied body; the role agent
   (when used) has the role text. The registries load lazily: the check waits for them.
3. Create a session in the step's folder (agent `build`, or `lf-role` for role_mode "agent") with ordered permission
   rules (deny all, allow read/glob/grep, edit only for sandbox="workspace-write", `skill` only for the bound native
   skills, deny read/edit above the folder, allow the configured shell commands, deny grant and rig commands, deny
   external_directory) and re-read it: the server's copy must match exactly. These rules are the guard: OpenCode runs
   no project hooks. Shell rule semantics were probed on Windows
   (OpenCode 2.2.7): action `shell`, a pattern matches the whole
   command case-insensitively, `<cmd> *` also matches the bare command, every subcommand of a compound must be
   allowed, the last matching rule wins.
4. Send the prompt with the JSON schema (native skills as `skills: [{id}]` attachments), wait, read the timeline and
   take the last assistant message after the prompt; the engine validates the schema. A thread follows the event
   stream for the live log and stops the turn after 60 model steps. `skills_loaded` lists the native skills whose
   copied body is in the timeline (the prompt attachment, or a `skill` message); the engine falls back for the
   others.
5. Always stop the server (whole process tree) and delete the instance folder.
Resume (opts["resume"] = a session id from an earlier call of the same step, retry_mode "resume"): a new isolated
server with the same config re-opens that session from the user's OpenCode data, checks it as in 3 (same folder,
model, agent, rules, metadata) and sends only the new text; skills are not attached again (the session holds them).

Config ([agents.opencode] in .langflow/config.toml):
  default_model = "openai/gpt-6-luna"   # provider/model
  default_effort = "medium"             # a variant of the model; models without variants run without one
  allow_commands = ["make build", "make flash *"]   # shell commands the agent may run: exact, or `<cmd> *`
  role_channel = "prompt"               # role_mode "append": "prompt" (before the prompt) or "instructions" (an
                                        # experimental session instruction entry)
ai() options used: sandbox ("read-only" default, "workspace-write" adds edit), role (the step's resolved role, with
`mode` = the catalog role_mode: "agent" = the lf-role agent, "append" = role_channel, else before the prompt), skills
(resolved, with `via`; "native" ones are attached), resume. tools / permission_mode are Claude's and are ignored.
"""
import base64
import fnmatch
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

from ..catalog import frontmatter, inside, prepend_role, role_text, sha256_bytes
from ..project import Project
from .base import AgentCancelled, AgentError, Watch, add_usage, brief, usage

VERSION = "2.2.7"
MAX_STEPS = 60
SENSITIVE = {"policies", "experimental", "permissions", "permission", "plugins", "plugin", "mcp", "agents", "agent",
             "skills", "instructions", "references", "reference"}
# Never allowed, whatever the config says: grants and rig/device commands. `make flash` checks its grant itself.
FORBIDDEN = ("make flash-grant", "make rig-grant", "nrfutil", "tetra_cli")
# The same as shell patterns: session deny rules after the allows (the last match wins) and hard config policies.
DENY_SHELL = ("make flash-grant*", "make rig-grant*", "*nrfutil*", "*tetra_cli*")
# Commands that run another command line: allowing them would allow anything (the scanner does not look inside).
WRAPPERS = {"cmd", "powershell", "pwsh", "bash", "sh", "zsh", "wsl", "python", "python3", "py", "uv", "uvx", "node",
            "npx", "env", "start", "iex", "invoke-expression", "call", "&", "."}
# Pinned shell (Windows PowerShell 5.1): otherwise OpenCode follows an inherited SHELL (Git Bash, ...).
WIN_SHELL = str(Path(os.environ.get("SystemRoot", r"C:\WINDOWS")) / "System32/WindowsPowerShell/v1.0/powershell.exe")
ROLE_AGENT = "lf-role"                              # the instance-config agent that carries a role (role_mode "agent")
BUILTIN_SKILL = "skill://"                          # path prefix of OpenCode's built-in skills (opencode, report, ...)
ROLE_KEY = "langflow.role"                          # instruction entry key (role_channel "instructions")
ROLE_CHANNELS = ("prompt", "instructions")          # [agents.opencode] role_channel (role_mode "append")
REGISTRY_WAIT = 15.0                                # seconds: the agent and skill registries load after startup


def instance_config(role_agent: dict | None = None, skills_dir: str | None = None) -> dict:
    """The only config the server loads: no plugins, no MCP, hard denies for grant and rig commands (a config
    policy needs action tool.use and resource shell:<pattern>; action shell is ignored there), pinned shell.
    role_agent: {"system", "description"} of the lf-role agent (mode primary); skills_dir: the instance folder that
    holds the copies of the bound native skills."""
    cfg = {"policies": [{"action": "plugin.use", "resource": "*", "effect": "deny"},
                        {"action": "mcp.use", "resource": "*", "effect": "deny"},
                        *({"action": "tool.use", "resource": f"shell:{p}", "effect": "deny"} for p in DENY_SHELL)]}
    if sys.platform == "win32":
        cfg["shell"] = WIN_SHELL
    if role_agent:
        cfg["agents"] = {ROLE_AGENT: {"system": role_agent["system"], "mode": "primary",
                                      "description": role_agent.get("description") or "langflow role"}}
    if skills_dir:
        cfg["skills"] = [str(skills_dir)]
    return cfg


def skill_sources(root: Path, items: list[dict]) -> list[dict]:
    """The files to copy for each bound native skill: [{id, sha256, files: [(source Path, relative name)]}]. The
    SKILL.md is the catalog path (OpenCode loads langflow's own copy, catalog.cli_skill); companions are the catalog's
    list (relative to the project root, inside the skill folder). Every file must resolve inside the project."""
    out = []
    for s in items:
        f = Path(root) / s["path"]
        if inside(root, f) is None or not f.is_file():
            raise AgentError(f"skill {s['id']}: {s['path']} is not a file inside the project")
        folder = f.parent
        files = [(f, "SKILL.md")]
        for c in s.get("files") or []:
            p = Path(root) / c
            try:
                relname = p.relative_to(folder).as_posix()
            except ValueError:
                continue                              # not under the skill folder: not part of the skill
            if inside(root, p) is None or inside(folder, p) is None or not p.is_file():
                raise AgentError(f"skill {s['id']}: companion {c} is not a file inside the skill folder")
            files.append((p, relname))
        out.append({"id": s["id"], "sha256": s.get("sha256"), "files": files})
    return out


class Server:
    """One `opencode serve` process on loopback. Use as a context manager: the exit always stops it.
    role_agent / skills: the native extension of the instance config (instance_config, skill_sources).
    skills_parent: where the skill copies go (a folder of its own, deleted on close). OpenCode tells the model the
    skill's "Base directory" for its companion files; under the project (the state dir) the session's read rule
    covers it, in the temp instance folder (the default) the rules deny reading it."""

    def __init__(self, exe: str, cwd: Path, data_home: str | None = None, startup: int = 30,
                 role_agent: dict | None = None, skills: list[dict] | None = None, skills_parent: Path | None = None):
        self.exe, self.cwd, self.startup = exe, cwd, startup
        self.data_home = data_home
        self.proc: subprocess.Popen | None = None
        self.port = 0
        self.dir = Path(tempfile.mkdtemp(prefix="langflow_opencode_"))
        self.config_dir = self.dir / "config" / "opencode"
        self.config_file = self.config_dir / "opencode.json"
        self.skills_dir = (Path(skills_parent) / self.dir.name) if skills_parent else self.dir / "skills"
        self.home_dir = self.dir / "home"
        self.role_agent = role_agent
        self.skills = list(skills or [])
        self.skill_bodies: dict[str, str] = {}        # id -> SKILL.md body (after the frontmatter) of the copy
        self.cfg = instance_config(role_agent, str(self.skills_dir) if self.skills else None)
        self._stop_events = threading.Event()

    # ------------------------------------------------------------ start / stop

    def __enter__(self):
        try:
            self._start()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *exc):
        self.close()

    def kill(self):
        """Stop the server process tree now (cancel); close() still cleans up afterwards."""
        p = self.proc
        if p and p.poll() is None:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            else:
                p.kill()

    def _env(self) -> dict:
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("OPENCODE_")
               and k.upper() not in ("PWD", "OLDPWD")}
        self.password = secrets.token_hex(32)
        # OPENCODE_TEST_HOME: the "home" OpenCode scans for ~/.claude and ~/.agents skills (2.2.7: always, no flag);
        # data, cache and config paths do not use it (data = XDG / the real home: login and sessions stay).
        env.update(XDG_CONFIG_HOME=str(self.dir / "config"), XDG_CACHE_HOME=str(self.dir / "cache"),
                   OPENCODE_DISABLE_PROJECT_CONFIG="1", OPENCODE_DISABLE_EXTERNAL_SKILLS="1",
                   OPENCODE_DISABLE_CLAUDE_CODE="1", OPENCODE_TEST_HOME=str(self.home_dir),
                   OPENCODE_SERVER_USERNAME="opencode", OPENCODE_SERVER_PASSWORD=self.password)
        if self.data_home:
            env["XDG_DATA_HOME"] = self.data_home
        return env

    def _copy_skills(self):
        """Copy the bound native skills into <skills_dir>/<id>/; the SKILL.md bytes must still have the sha256
        langflow recorded for the step (else the file changed after the binding was resolved)."""
        for s in self.skills:
            dst = self.skills_dir / s["id"]
            for src, relname in s["files"]:
                b = src.read_bytes()
                if relname == "SKILL.md":
                    if s.get("sha256") and sha256_bytes(b) != s["sha256"]:
                        raise AgentError(f"skill {s['id']}: {src.name} changed after the step's binding was read")
                    self.skill_bodies[s["id"]] = frontmatter(b.decode("utf-8-sig"))[1]
                out = dst / relname
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(b)

    def _start(self):
        self.config_dir.mkdir(parents=True)
        (self.dir / "cache").mkdir()
        self.home_dir.mkdir()
        if self.skills:
            self.skills_dir.mkdir(parents=True)
            self._copy_skills()
        self.config_file.write_text(json.dumps(self.cfg), encoding="utf-8")
        env = self._env()
        self.auth = "Basic " + base64.b64encode(f"opencode:{self.password}".encode()).decode()
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        self.proc = subprocess.Popen([self.exe, "serve", "--hostname", "127.0.0.1", "--port", "0"], cwd=self.cwd,
                                     env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, creationflags=flags)
        found: list[int] = []
        out: list[str] = []

        def read_stdout():
            for raw in self.proc.stdout:
                line = raw.decode("utf-8", "replace")
                if not found:
                    out.append(line)
                    m = re.search(r"server listening on http://127\.0\.0\.1:(\d+)", line, re.I)
                    if m:
                        found.append(int(m.group(1)))
            # keep draining to EOF so the server never blocks on a full pipe

        threading.Thread(target=read_stdout, daemon=True).start()
        # stderr may hold credentials or private config: drain it, never show it
        threading.Thread(target=lambda: [None for _ in self.proc.stderr], daemon=True).start()
        end = time.time() + self.startup
        while not found:
            if self.proc.poll() is not None:
                raise AgentError(f"opencode serve exited during startup (exit {self.proc.returncode})")
            if time.time() > end:
                raise AgentError("opencode serve startup timed out")
            time.sleep(0.1)
        self.port = found[0]

    def close(self):
        self._stop_events.set()
        p = self.proc
        if p and p.poll() is None:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            else:
                p.kill()
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
        for _ in range(20):                           # Windows: files stay locked for a moment after the kill
            shutil.rmtree(self.dir, ignore_errors=True)
            if self.skills and self.skills_dir.exists():
                shutil.rmtree(self.skills_dir, ignore_errors=True)
            if not self.dir.exists() and not (self.skills and self.skills_dir.exists()):
                break
            time.sleep(0.25)

    def alive(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    # ------------------------------------------------------------ HTTP

    def request(self, method: str, path: str, body=None, timeout: float = 30):
        """JSON request on the loopback origin only: the Basic credentials never go anywhere else."""
        if not path.startswith("/") or path.startswith("//"):
            raise AgentError(f"invalid OpenCode API path {path!r}")
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            headers = {"Authorization": self.auth}
            data = None
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = "application/json"
            c.request(method, path, body=data, headers=headers)
            r = c.getresponse()
            raw = r.read()
            if not 200 <= r.status < 300:
                raise AgentError(f"OpenCode {method} {path.split('?')[0]}: HTTP {r.status} {raw[:300]!r}")
            if r.status == 204 or not raw.strip():
                return None
            return json.loads(raw)
        finally:
            c.close()

    def events(self, on_event, path: str = "/api/event"):
        """Follow the server-sent event stream in a daemon thread. Observation only: errors end it silently."""
        def follow():
            try:
                c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=None)
                c.request("GET", path, headers={"Authorization": self.auth, "Accept": "text/event-stream"})
                r = c.getresponse()
                if r.status != 200:
                    return
                while not self._stop_events.is_set():
                    line = r.readline()
                    if not line:
                        return
                    line = line.decode("utf-8", "replace").rstrip("\r\n")
                    if not line.startswith("data:"):
                        continue
                    try:
                        on_event(json.loads(line[5:].strip()))
                    except Exception:  # noqa: BLE001 - not JSON, or a logging problem
                        pass
            except Exception:  # noqa: BLE001
                return
        threading.Thread(target=follow, daemon=True).start()


# ---------------------------------------------------------------- checks of the server's answers

def verify_server(s: Server):
    info = s.request("GET", "/api/info") or {}
    if info.get("version") != VERSION or not isinstance(info.get("pid"), int) or info["pid"] <= 0:
        raise AgentError(f"OpenCode server version {info.get('version')!r}; this adapter supports {VERSION} only")
    sources = s.request("GET", "/api/config")
    if not isinstance(sources, list):
        raise AgentError("OpenCode /api/config: unexpected answer")
    own_file, own_dir = os.path.normcase(str(s.config_file)), os.path.normcase(str(s.config_dir))
    has_own = False
    for e in sources:
        path = os.path.normcase(str(e.get("path") or ""))
        if e.get("type") == "document":
            if path == own_file:
                has_own = True
            elif SENSITIVE & set(e.get("info") or {}):
                raise AgentError(f"OpenCode loaded security-sensitive config from outside the instance: {e.get('path')}")
        elif e.get("type") == "directory":
            if path != own_dir:
                raise AgentError(f"OpenCode loaded an outside config directory: {e.get('path')}")
        else:
            raise AgentError(f"OpenCode config source of unknown type {e.get('type')!r}")
    if not has_own:
        raise AgentError("OpenCode did not load the isolation policy (plugins and MCP denied)")
    own = next(e for e in sources if e.get("type") == "document" and os.path.normcase(str(e.get("path"))) == own_file)
    if own.get("info") != getattr(s, "cfg", None):
        raise AgentError("OpenCode instance config differs from the one written (policies, shell, agents, skills)")
    saved = s.request("GET", "/api/permission/saved")
    if (saved.get("data") if isinstance(saved, dict) else saved):
        # saved "always" approvals in the user's OpenCode data are applied before policies and session rules
        raise AgentError("OpenCode has saved permission approvals in the user's data; remove them first")
    if (s.request("GET", "/api/mcp") or {}).get("data"):
        raise AgentError("OpenCode exposes MCP servers")
    plugins = (s.request("GET", "/api/plugin") or {}).get("data") or []
    if any((p.get("source") or {}).get("type") != "builtin" for p in plugins):
        raise AgentError("OpenCode exposes external plugins")
    verify_skills(s)
    verify_agent(s)


def _location(s: Server) -> str:
    return "?" + urllib.parse.urlencode({"location[directory]": str(Path(s.cwd).resolve())})


def _registry(s: Server, kind: str, ready, wait: float | None = None) -> list[dict]:
    """GET /api/<kind> for the step's folder. The registries load after startup (the first answers are empty or
    partial): poll until ready(data) or the wait ends, then return the last answer."""
    end = time.time() + (REGISTRY_WAIT if wait is None else wait)
    while True:
        data = (s.request("GET", f"/api/{kind}{_location(s)}") or {}).get("data") or []
        if ready(data) or time.time() > end:
            return data
        time.sleep(0.25)


def _norm(text: str) -> str:
    return (text or "").replace("\r\n", "\n").strip()


def verify_skills(s: Server, wait: float | None = None):
    """The skill registry holds only OpenCode's built-in skills (path skill://…) and the bound native skills, each
    loaded from its copy in <instance>/skills with the copied text (Skill.Info content = the body after the
    frontmatter). Anything else (a personal or project skill) fails the step."""
    bound = {x["id"] for x in getattr(s, "skills", [])}
    data = _registry(s, "skill", lambda d: any(str(x.get("path", "")).startswith(BUILTIN_SKILL) for x in d)
                     and bound <= {x.get("id") for x in d}, wait)
    if not any(str(x.get("path", "")).startswith(BUILTIN_SKILL) for x in data):
        raise AgentError("OpenCode skill registry did not load")
    seen = set()
    for x in data:
        sid, path = x.get("id"), str(x.get("path") or "")
        if path.startswith(BUILTIN_SKILL):
            continue
        if sid not in bound:
            raise AgentError(f"OpenCode loaded a skill langflow did not bind: {sid} ({path})")
        if not same_path(path, s.skills_dir / sid / "SKILL.md"):
            raise AgentError(f"OpenCode loaded skill {sid} from {path}, not from langflow's copy")
        if _norm(x.get("content")) != _norm(s.skill_bodies.get(sid)):
            raise AgentError(f"OpenCode skill {sid}: the loaded text differs from langflow's copy")
        seen.add(sid)
    if bound - seen:
        raise AgentError(f"OpenCode did not register the bound skill(s) {', '.join(sorted(bound - seen))}")


def verify_agent(s: Server, wait: float | None = None):
    """With a role agent: lf-role is registered as a primary agent with exactly the role text as its system prompt.
    Its own permissions are OpenCode's defaults; the session rules decide (verify_session)."""
    ra = getattr(s, "role_agent", None)
    if not ra:
        return
    data = _registry(s, "agent", lambda d: any(x.get("id") == ROLE_AGENT for x in d), wait)
    a = next((x for x in data if x.get("id") == ROLE_AGENT), None)
    if a is None:
        raise AgentError(f"OpenCode did not register the role agent {ROLE_AGENT}")
    if a.get("system") != ra["system"] or a.get("mode") != "primary" or a.get("model"):
        raise AgentError(f"OpenCode role agent {ROLE_AGENT} differs from the one written (system, mode, model)")


def pick_model(s: Server, provider: str, model: str, effort: str | None) -> str | None:
    """The variant to send (None = none). Fails when the model or the effort does not exist."""
    data = (s.request("GET", "/api/model") or {}).get("data") or []
    m = next((x for x in data if x.get("providerID") == provider and x.get("id") == model and x.get("enabled")
              and x.get("type") in (None, "chat")), None)
    if m is None:
        raise AgentError(f"OpenCode model {provider}/{model} not found or not enabled")
    variants = [v.get("id") for v in m.get("variants") or []]
    if not variants:                                  # a model without variants counts as "medium"
        if effort not in (None, "medium"):
            raise AgentError(f"OpenCode model {provider}/{model} has no effort variants (asked {effort})")
        return None
    if effort is None:
        return None
    if effort not in variants:
        raise AgentError(f"OpenCode model {provider}/{model}: effort {effort} not one of {variants}")
    return effort


def check_patterns(patterns: list[str]):
    """allow_commands: an exact command, or `<command> *` (that one also matches the bare command). No other
    wildcard (`make flash*` also matches `make flash-grant`), no wrapper or interpreter, nothing that covers a grant
    or a rig command."""
    samples = [f"{c} x=1" for c in FORBIDDEN] + list(FORBIDDEN) + [
        "python tools/tetra_cli.py status", "py tools\\tetra_cli.py status", "uv run tools/tetra_cli.py status"]
    for p in patterns:
        low = " ".join(str(p).lower().split())
        body = low[:-2] if low.endswith(" *") else low
        first = Path(body.split(" ")[0]).name.removesuffix(".exe") if body else ""
        why = ("empty" if not body else
               "only a final ' *' may be a wildcard" if any(ch in body for ch in "*?[") else
               f"'{first}' runs other command lines" if first in WRAPPERS else
               "it would allow a grant or rig command"
               if any(f in low for f in FORBIDDEN) or any(fnmatch.fnmatchcase(c, low) for c in samples) else None)
        if why:
            raise AgentError(f"[agents.opencode] allow_commands: {p!r} refused: {why}")


def rules(write: bool, commands: list[str], allow_skills: list[str] | tuple = ()) -> list[dict]:
    """Ordered: a later match overrides an earlier one. Deny everything, then allow what the step needs.
    external_directory only covers paths outside the git worktree, not outside the step's folder; read and edit
    resources are paths relative to the step's folder ('../x' above it), so '../*' denies them above the folder.
    grep and glob resources are the search patterns, not paths: they can still search above the folder.
    allow_skills: the bound native skill ids (action `skill`, resource = the id); every other skill stays denied."""
    out = [{"action": "*", "resource": "*", "effect": "deny"}]
    out += [{"action": a, "resource": "*", "effect": "allow"}
            for a in ("read", "glob", "grep", *(["edit"] if write else []))]
    out += [{"action": "skill", "resource": sid, "effect": "allow"} for sid in allow_skills]
    out += [{"action": a, "resource": "../*", "effect": "deny"} for a in ("read", "edit")]
    out += [{"action": "shell", "resource": " ".join(c.split()), "effect": "allow"} for c in commands]
    if commands:
        out += [{"action": "shell", "resource": p, "effect": "deny"} for p in DENY_SHELL]
    out.append({"action": "external_directory", "resource": "*", "effect": "deny"})
    return out


def same_path(a: str, b) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(str(b)))


def verify_session(resp, spec: dict, sid: str | None = None) -> str:
    """The server's copy, not the request, must prove the binding."""
    d = (resp or {}).get("data") or {}
    model = d.get("model") or {}
    bad = [k for k, ok in (
        ("id", re.fullmatch(r"ses_[A-Za-z0-9]+", str(d.get("id"))) and (sid is None or d.get("id") == sid)),
        ("parent", not d.get("parentID")),
        ("directory", same_path((d.get("location") or {}).get("directory", ""), spec["cwd"])),
        ("agent", d.get("agent") == spec.get("agent", "build")),
        ("model", model.get("providerID") == spec["provider"] and model.get("id") == spec["model"]
         and model.get("variant") == spec["variant"]),
        ("metadata", d.get("metadata") == spec["metadata"]),
        ("permissions", d.get("permissions") == spec["permissions"])) if not ok]
    if bad:
        raise AgentError(f"OpenCode session does not match the request: {', '.join(bad)}")
    return d["id"]


def read_timeline(s: Server, sid: str) -> list[dict]:
    out, seen, query = [], set(), "?order=asc"
    for _ in range(100):
        page = s.request("GET", f"/api/session/{sid}/message{query}") or {}
        data = page.get("data") or []
        out += data
        nxt = (page.get("cursor") or {}).get("next")
        if not nxt or not data:
            return out
        if nxt in seen:
            raise AgentError("OpenCode repeated a message cursor")
        seen.add(nxt)
        query = f"?cursor={urllib.parse.quote(nxt)}"
    raise AgentError("OpenCode message timeline exceeds 100 pages")


def parse_json(text: str):
    try:
        return json.loads(text)
    except ValueError:
        pass
    fences = re.findall(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", text, re.S | re.I)
    if len(fences) != 1 or text.count("```") != 2:
        raise AgentError(f"OpenCode answer is not one JSON document: {text[:300]}")
    try:
        return json.loads(fences[0])
    except ValueError:
        raise AgentError(f"OpenCode answer is not JSON: {text[:300]}")


def answer(timeline: list[dict], user_id: str, spec: dict) -> str:
    """Text of the last assistant message after our prompt, only if it ended cleanly with the bound model."""
    idx = next((i for i, m in enumerate(timeline) if m.get("id") == user_id and m.get("type") == "user"), None)
    if idx is None:
        raise AgentError("OpenCode: the prompt is not in the session timeline")
    later = timeline[idx + 1:]
    if any(m.get("type") == "user" for m in later):
        raise AgentError("OpenCode: the session received another prompt")
    replies = [m for m in later if m.get("type") == "assistant"]
    if not replies:
        raise AgentError("OpenCode returned no assistant message")
    r = replies[-1]
    model = r.get("model") or {}
    if r.get("error") or r.get("finish") != "stop" or r.get("agent") != spec.get("agent", "build") \
            or model.get("id") != spec["model"] \
            or model.get("providerID") != spec["provider"] or model.get("variant") != spec["variant"]:
        raise AgentError(f"OpenCode answer not verified: finish={r.get('finish')} error={r.get('error')}")
    texts = [c["text"] for c in r.get("content") or [] if c.get("type") == "text" and (c.get("text") or "").strip()]
    if not texts:
        raise AgentError("OpenCode returned no text")
    return "\n".join(texts)


def _step_names() -> tuple[str | None, str | None]:
    """Run and step of the ai step calling us (for the session metadata)."""
    try:
        from .. import engine                         # late: engine imports this package
        return getattr(engine._SAY, "target", None) or (None, None)
    except Exception:  # noqa: BLE001
        return None, None


def _any_thread(say, run_name, step):
    """The engine's say() logs for the step bound to the calling thread; the event thread has none, so bind it."""
    if not run_name:
        return say

    def tsay(text):
        from .. import engine
        if getattr(engine._SAY, "target", None) is None:
            engine._SAY.target = (run_name, step)
        say(text)
    return tsay


def save_transcript(project: Project, sid: str, info: dict, timeline: list[dict]) -> str | None:
    """The session stays in the user's OpenCode data; a copy of its timeline goes to the state dir for review."""
    try:
        d = project.state_dir / "opencode"
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{sid}.json"
        p.write_text(json.dumps({"session": info, "messages": timeline}, ensure_ascii=False, indent=1),
                     encoding="utf-8")
        return str(p)
    except OSError:
        return None


# ---------------------------------------------------------------- adapter

def delivery(opts: dict, cfg: dict) -> dict:
    """How the step's role and skills reach OpenCode: {"channel": "agent" | "instructions" | "prompt" | None,
    "role_agent": {system, description} | None, "native": [the resolved skills with via "native"], "note"?}.
    channel follows the role's catalog mode: "agent" -> the lf-role agent (its system prompt replaces OpenCode's base
    prompt); "append" -> [agents.opencode] role_channel ("prompt" default: before the prompt; "instructions": an
    experimental session instruction entry); "prompt" / anything else -> before the prompt."""
    role = opts.get("role")
    rc = cfg.get("role_channel", "prompt")
    if rc not in ROLE_CHANNELS:
        raise AgentError(f"[agents.opencode] role_channel must be one of {', '.join(ROLE_CHANNELS)} (got {rc!r})")
    out = {"channel": None, "role_agent": None,
           "native": [x for x in opts.get("skills") or [] if x.get("via") == "native"]}
    text = role_text(role)
    if not text:
        return out
    mode = role.get("mode") or opts.get("role_mode")
    if mode == "agent":
        out["channel"] = "agent"
        out["role_agent"] = {"system": text.strip(), "description": f"langflow role {role['id']}"}
    elif mode == "append" and rc == "instructions":
        out["channel"] = "instructions"
    else:
        out["channel"] = "prompt"
        if mode == "append":
            out["note"] = "role_mode append: role_channel prompt, so the role goes before the prompt"
    return out


def put_role_entry(s: Server, sid: str, role: dict):
    """role_channel "instructions": the role as a durable session instruction entry (key langflow.role), read back."""
    value = {"role": role["id"], "source": role.get("path"), "instructions": role_text(role).strip()}
    s.request("PUT", f"/api/experimental/session/{sid}/instructions/entries/{ROLE_KEY}", {"value": value})
    got = s.request("GET", f"/api/experimental/session/{sid}/instructions/entries") or {}
    items = got.get("data") if isinstance(got, dict) else got
    if not any(isinstance(e, dict) and e.get("key") == ROLE_KEY and e.get("value") == value for e in items or []):
        raise AgentError("OpenCode did not keep the role instruction entry")


def skills_parent(project, cwd) -> Path | None:
    """<state dir>/opencode/skills when the state dir lies inside the step's folder (the session's read rule then
    covers the copies and their companion files), else None (the copies go to the temp instance folder)."""
    try:
        state = Path(project.state_dir)
    except (AttributeError, TypeError):
        return None
    return state / "opencode" / "skills" if inside(Path(cwd), state) is not None else None


def run(project: Project, prompt: str, schema: dict, model: str | None, opts: dict, cwd: Path, timeout: int, say):
    cfg = project.agent("opencode")
    exe = shutil.which("opencode")
    if not exe:
        raise AgentError("opencode CLI not found on PATH")
    full = model or cfg.get("default_model")
    if not full or "/" not in full:
        raise AgentError(f"OpenCode model must be provider/model (got {full!r}); set [agents.opencode] default_model")
    provider, model_id = full.split("/", 1)
    effort = opts.get("effort") or cfg.get("default_effort")
    commands = list(cfg.get("allow_commands", []))
    check_patterns(commands)
    write = opts.get("sandbox") == "workspace-write"
    run_name, step = _step_names()
    deadline = time.time() + timeout
    say = _any_thread(say, run_name, step)
    how = delivery(opts, cfg)
    if how.get("note"):
        say(how["note"])
    native = skill_sources(Path(project.root), how["native"]) if how["native"] else []
    parent = skills_parent(project, cwd) if native else None
    if native and parent is None and any(len(x["files"]) > 1 for x in native):
        say("skills native: the copies cannot sit under the step's folder, so companion files are not readable")

    with Server(exe, Path(cwd), role_agent=how["role_agent"], skills=native, skills_parent=parent) as s:
        watch = Watch(s.kill, None)                   # cancel only; the time limit is the deadline below
        try:
            return _session(project, s, prompt, schema, cwd, timeout, say, cfg, provider, model_id, effort, commands,
                            write, run_name, step, deadline, opts, how)
        except AgentCancelled:
            raise
        except BaseException as e:
            if watch.cancelled:
                raise AgentCancelled("run cancelled while OpenCode ran (server process tree killed)") from e
            raise
        finally:
            watch.done()


def _session(project, s, prompt, schema, cwd, timeout, say, cfg, provider, model_id, effort, commands, write,
             run_name, step, deadline, opts=None, how=None):
    opts = opts or {}
    how = how or {"channel": None, "role_agent": None, "native": []}
    role, channel, resume = opts.get("role"), how["channel"], opts.get("resume")
    ids = [x["id"] for x in how["native"]]
    verify_server(s)
    variant = pick_model(s, provider, model_id, effort)
    spec = {"cwd": str(Path(cwd).resolve()), "provider": provider, "model": model_id, "variant": variant,
            "agent": ROLE_AGENT if channel == "agent" else "build",
            "metadata": {"langflow": {"project": project.name, "run": run_name, "step": step}},
            "permissions": rules(write, commands, ids)}
    if resume:
        # the session lives in the user's OpenCode data: this new server must see it exactly as it was made
        sid = verify_session(s.request("GET", f"/api/session/{urllib.parse.quote(str(resume), safe='')}"), spec,
                             str(resume))
    else:
        body = {"location": {"directory": spec["cwd"]}, "metadata": spec["metadata"], "agent": spec["agent"],
                "model": {"providerID": provider, "id": model_id, **({"variant": variant} if variant else {})},
                "permissions": spec["permissions"]}
        sid = verify_session(s.request("POST", "/api/session", body), spec)
        verify_session(s.request("GET", f"/api/session/{sid}"), spec, sid)
    say(("resume session " if resume else "session ") + f"{sid} model {provider}/{model_id}"
        + (f" effort {variant}" if variant else "") + f", {'edit' if write else 'read-only'}"
        + (f", commands {commands}" if commands else ""))
    if role and resume and channel == "instructions":
        got = s.request("GET", f"/api/experimental/session/{sid}/instructions/entries") or {}
        if not any(isinstance(e, dict) and e.get("key") == ROLE_KEY for e in got.get("data") or []):
            raise AgentError("OpenCode resumed session lost the role instruction entry")
    if role and not resume:
        if channel == "instructions":
            try:
                put_role_entry(s, sid, role)
                say(f"role {role['id']}: instruction entry {ROLE_KEY} (from {role['path']})")
            except AgentError as e:
                say(f"role {role['id']}: instruction entry refused ({str(e)[:160]}); instructions before the prompt")
                channel = "prompt"
        if channel == "agent":
            say(f"role {role['id']}: agent {ROLE_AGENT} (system prompt from {role['path']})")
        elif channel == "prompt":
            prompt = prepend_role(prompt, role)
            say(f"role {role['id']}: instructions from {role['path']} before the prompt")
    if ids:
        say(f"skills native: {', '.join(ids)} ({'already in the session' if resume else 'attached'}, copies in "
            f"{s.skills_dir})")

    live = {"steps": 0, "names": {}, "failed": [], "over": False, "error": None}

    def on_event(e):
        d = e.get("data") or {}
        if d.get("sessionID") != sid:
            return
        t = e.get("type")
        if t == "session.step.started":
            live["steps"] += 1
            if live["steps"] > MAX_STEPS and not live["over"]:
                live["over"] = True
                say(f"stopping: more than {MAX_STEPS} model steps without an answer")
                try:
                    s.request("POST", f"/api/session/{sid}/interrupt")
                except Exception:  # noqa: BLE001
                    pass
        elif t == "session.tool.input.started":
            live["names"][d.get("id")] = d.get("name")
        elif t == "session.tool.called":
            say(f"{live['names'].get(d.get('id'), 'tool')} {brief(d.get('input'))}")
        elif t == "session.tool.failed":
            err = (d.get("error") or {}).get("message", "")
            name = live["names"].get(d.get("id"), "tool")
            live["failed"].append({"tool": name, "error": err[:300]})
            say(f"  {name} failed: {err[:200]}")
        elif t == "session.skill.activated":
            say(f"skill {d.get('skill') or d.get('id') or ''} loaded")
        elif t == "permission.asked":
            say(f"permission asked: {d.get('action')} {d.get('resources')} (nobody answers; the rules decide)")
        elif t == "session.text.ended" and (d.get("text") or "").strip():
            say("says: " + d["text"].strip()[:160])
        elif t == "session.execution.failed":
            live["error"] = (d.get("error") or {}).get("message")
            say(f"ERROR {str(live['error'])[:200]}")

    s.events(on_event)
    text = (f"{prompt}\n\nReturn only one JSON document matching this JSON Schema. Do not use Markdown fences.\n"
            f"{json.dumps(schema)}")
    body = {"text": text, **({"skills": [{"id": i} for i in ids]} if ids and not resume else {})}
    receipt = (s.request("POST", f"/api/session/{sid}/prompt", body) or {}).get("data") or {}
    if receipt.get("sessionID") != sid or receipt.get("type") != "user" or not receipt.get("id"):
        raise AgentError("OpenCode prompt receipt does not match the session")
    try:
        s.request("POST", f"/api/experimental/session/{sid}/wait", {}, timeout=max(5, deadline - time.time()))
    except (TimeoutError, OSError) as e:
        try:
            s.request("POST", f"/api/session/{sid}/interrupt")
        except Exception:  # noqa: BLE001
            pass
        raise AgentError(f"OpenCode step time limit of {timeout} s reached ({type(e).__name__})")
    final = s.request("GET", f"/api/session/{sid}")
    verify_session(final, spec, sid)
    info = final["data"]
    timeline = read_timeline(s, sid)
    transcript = save_transcript(project, sid, info, timeline)
    # a resumed session's totals include the earlier calls: count only the messages after this prompt
    use, cost = session_usage(info, timeline, receipt["id"], totals=not resume)
    if live["over"]:
        raise AgentError(f"OpenCode stopped after {MAX_STEPS} model steps without an answer", use, cost)
    if info.get("outcome") != "succeeded":
        raise AgentError(f"OpenCode outcome {info.get('outcome')}: {live['error'] or ''}"[:500], use, cost)
    result = parse_json(answer(timeline, receipt["id"], spec))
    loaded = skills_loaded(timeline, ids, getattr(s, "skill_bodies", None))
    if ids and not resume and set(loaded) != set(ids):
        say(f"native skill(s) not loaded: {', '.join(i for i in ids if i not in loaded)}")
    return {"result": result, "session": sid, "hooks": None,
            "hook_note": "guard: OpenCode session permissions (deny by default), verified",
            "transcript": transcript, "usage": use, "usage_raw": info.get("tokens", {}), "cost_usd": cost,
            "model_used": f"{provider}/{model_id}", "denials": live["failed"],
            "role_channel": channel if role else None, "skills_loaded": loaded, "resumed": bool(resume)}


def skills_loaded(timeline: list[dict], ids: list[str], bodies: dict[str, str] | None = None) -> list[str]:
    """The native skill ids whose text reached the session: a prompt attachment (a user message's `skills[]` entry,
    rendered as <skill_content name="id">…, tested 2026-11-18) or a `skill` message (Session.Message.Skill, from the
    skill tool or the activate endpoint). With bodies (id -> the copy's body), the text must contain that body."""
    have: dict[str, list[str]] = {}
    for m in timeline:
        if m.get("type") == "user":
            for a in m.get("skills") or []:
                if isinstance(a, dict):
                    have.setdefault(a.get("id"), []).append(a.get("text") or "")
        elif m.get("type") == "skill":
            have.setdefault(m.get("skill"), []).append(m.get("text") or "")
    out = []
    for i in ids:
        want = _norm((bodies or {}).get(i, ""))
        if any(want in _norm(t) for t in have.get(i, [])):
            out.append(i)
    return out


def norm_usage(t: dict | None) -> dict:
    """OpenCode tokens {input, output, reasoning, cache: {read, write}} (also accepts *_tokens names)."""
    t = t if isinstance(t, dict) else {}
    cache = t.get("cache") if isinstance(t.get("cache"), dict) else {}
    return usage(t.get("input", t.get("input_tokens")), t.get("output", t.get("output_tokens")),
                 cache.get("read", t.get("cache_read", t.get("cache_read_tokens"))),
                 cache.get("write", t.get("cache_write", t.get("cache_write_tokens"))),
                 t.get("reasoning", t.get("reasoning_tokens")))


def session_usage(info: dict, timeline: list[dict], user_id: str, totals: bool = True) -> tuple[dict, float | None]:
    """Tokens and cost of the step: the session totals when the server gives them (and totals is True; a resumed
    session's totals include earlier calls), else the sum of the assistant messages after our prompt. A cost of 0
    counts as unknown (the engine then uses [pricing])."""
    use = norm_usage(info.get("tokens") if totals else None)
    cost = info.get("cost") if totals and isinstance(info.get("cost"), (int, float)) else None
    if not any(use.values()) or not cost:
        idx = next((i for i, m in enumerate(timeline) if m.get("id") == user_id), -1)
        msgs = [m for m in timeline[idx + 1:] if m.get("type") == "assistant"]
        if not any(use.values()):
            for m in msgs:
                use = add_usage(use, norm_usage(m.get("tokens")))
        if not cost:
            cost = sum(m["cost"] for m in msgs if isinstance(m.get("cost"), (int, float))) or None
    return use, (float(cost) if cost else None)
