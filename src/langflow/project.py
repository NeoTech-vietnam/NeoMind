"""The project a command runs in: the nearest folder above the working directory that holds `.langflow/config.toml`.

config.toml (all keys optional except the file itself):
  [project]
  name = "My project"
  approver = "Alex"                     # the person who answers gates (shown in messages)
  allow_agent_approval = false          # true only for demo/test projects: `langflow approve` then works without a
                                        # console (an agent may pass gates); the decision is logged as by "agent"
  state_dir = ".langflow/state"         # run state, logs, live pages; keep it out of git
  workflows = ".langflow/workflows"     # one .py module per workflow
  checks = ".langflow/checks"           # helper modules the workflows import (put on sys.path)

  [agents.claude]
  default_model = "sonnet"
  git_bash = "auto"                     # Windows: path of Git Bash, or "auto"

  [agents.codex]
  default_model = "gpt-6-luna"

  [agents.opencode]                     # OpenCode 2.2.7, an isolated `opencode serve` per step (agents/opencode.py)
  default_model = "openai/gpt-6-luna"   # provider/model, as in `opencode models`
  default_effort = "low"                # one of the model's variants; a model without variants takes none
  allow_commands = ["make build"]       # shell commands the agent may run (none by default): exact, or `<cmd> *`
                                        # (also matches the bare command). Refused: other wildcards, wrappers
                                        # (cmd, powershell, bash, python, uv ...), grant and rig commands
  # ai(..., sandbox="workspace-write") lets the agent edit files below the step's folder; the default is
  # read-only. OpenCode runs no project hooks: its guard is the session's permission rules, checked on re-read.

  [catalog]                             # skills and roles a step binds (catalog.py; ai(..., role=, skills=))
  skill_dirs = ["tools/skills"]         # more skill folders (<dir>/<id>/SKILL.md), after .langflow/skills,
                                        # .agents/skills and .claude/skills; must be inside the project
  skill_mode = "inject"                 # "inject": SKILL.md text before the prompt; "name": only "use the skill <id>";
                                        # "system": the CLI's system channel; "native": the CLI loads it (checked)
  native_fallback = "system"            # "system" | "inject" | "fail" for a skill that cannot be / was not native
  retry_mode = "resume"                 # guardrail retry: "resume" (default; same session) | "fresh" (new session)
  role_mode = "append"                  # default unset = automatic; "append" | "agent" | "prompt" (catalog.modes)
  contract = true                       # the step contract last in a bound step's prompt
  contract_system = false               # also in the system prompt under Claude --agent
                                        # Per-step overrides: .langflow/bindings.toml ([<workflow>.<step>] role,
                                        # skills, skills_add, role_mode, contract, skill_mode, native_fallback,
                                        # retry_mode); per run: role.<step>= skills.<step>= <mode key>.<step>=

  [hook_check]                          # how to confirm the project's hooks ran in an agent session
  kind = "none"                         # "none", or "jsonl_log" with the keys below
  path = "logs/hook-calls.log"          # one JSON object per hook call
  session_field = "session"
  client_field = "client"               # value "claude" or "codex"
  event_field = "event"
  required_event = "SessionStart"

  [run]
  max_concurrency = 4                   # at most N steps at the same time (fan-out workers, parallel branches);
                                        # unset or 0 = no limit; a run can set it: langflow start ... concurrency=N

  [retry]                               # transient agent errors (rate limit, 429, overloaded, 5xx, network)
  attempts = 3                          # retries per ai step (ai(..., transient=N) overrides; 0 = none)
  delays = [15, 60, 180]                # seconds to wait before retry 1, 2, 3 (the last one repeats)

  [pricing."claude-sonnet-5-5"]         # USD per million tokens, used when the agent reports no cost (Codex;
  input = 3.0                           # OpenCode with cost 0). Keys: the model name the agent reports, or the
  output = 15.0                         # name in the workflow / default_model (provider/model for OpenCode; the
  cache_read = 0.3                      # part after "/" also matches). cache_read / cache_write default to input.
  cache_write = 3.75

  [notify]                              # runs when a gate starts waiting; failures are logged, never fatal
  command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".langflow/notify.ps1"]
                                        # argv list, no shell; placeholders {run} {gate} {question} {workflow}
                                        # {page}; the same values are in LANGFLOW_* environment variables
"""
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = ".langflow"
CONFIG_FILE = "config.toml"


@dataclass
class Project:
    root: Path
    cfg: dict = field(default_factory=dict)

    def _p(self, key, default):
        return self.root / self.cfg.get("project", {}).get(key, default)

    @property
    def name(self) -> str:
        return self.cfg.get("project", {}).get("name", self.root.name)

    @property
    def approver(self) -> str:
        return self.cfg.get("project", {}).get("approver", "the approver")

    @property
    def allow_agent_approval(self) -> bool:
        return self.cfg.get("project", {}).get("allow_agent_approval", False) is True

    @property
    def state_dir(self) -> Path:
        return self._p("state_dir", f"{CONFIG_DIR}/state")

    @property
    def runs_dir(self) -> Path:
        return self.state_dir / "runs"

    @property
    def workflows_dir(self) -> Path:
        return self._p("workflows", f"{CONFIG_DIR}/workflows")

    @property
    def checks_dir(self) -> Path:
        return self._p("checks", f"{CONFIG_DIR}/checks")

    def agent(self, name: str) -> dict:
        return self.cfg.get("agents", {}).get(name, {})

    @property
    def hook_check(self) -> dict:
        return self.cfg.get("hook_check", {"kind": "none"})

    @property
    def retry(self) -> dict:
        """{"attempts": int, "delays": [seconds, ...]} for transient agent errors."""
        r = self.cfg.get("retry", {})
        try:
            attempts = max(0, int(r.get("attempts", 3)))
        except (TypeError, ValueError):
            attempts = 3
        delays = [float(d) for d in r.get("delays", [15, 60, 180]) if isinstance(d, (int, float)) and d >= 0]
        return {"attempts": attempts, "delays": delays or [15.0]}

    @property
    def max_concurrency(self) -> int | None:
        """[run] max_concurrency: at most this many steps (fan-out workers, parallel branches) run at the same time;
        unset or 0 = no limit."""
        try:
            n = int(self.cfg.get("run", {}).get("max_concurrency", 0))
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None

    @property
    def pricing(self) -> dict:
        return {str(k): v for k, v in self.cfg.get("pricing", {}).items() if isinstance(v, dict)}

    def price_of(self, *models) -> dict | None:
        """The [pricing."<model>"] table of the first model that has one (case-insensitive; "provider/model" also
        matches "model")."""
        table = {k.lower(): v for k, v in self.pricing.items()}
        for m in models:
            if not m:
                continue
            m = str(m).lower()
            for key in (m, m.split("/", 1)[-1]):
                if key in table:
                    return table[key]
        return None

    @property
    def catalog(self) -> dict:
        """[catalog] skill_dirs / skill_mode (read by catalog.py)."""
        c = self.cfg.get("catalog", {})
        return c if isinstance(c, dict) else {}

    @property
    def notify(self) -> dict:
        return self.cfg.get("notify", {})

    def rel(self, p) -> str:
        try:
            return str(Path(p).resolve().relative_to(self.root.resolve())).replace("\\", "/")
        except ValueError:
            return str(p)


def find_root(start: Path | str | None = None) -> Path | None:
    p = Path(start or os.getcwd()).resolve()
    for d in (p, *p.parents):
        if (d / CONFIG_DIR / CONFIG_FILE).is_file():
            return d
    return None


def load(start=None) -> Project:
    root = find_root(start)
    if root is None:
        raise SystemExit(f"langflow: no {CONFIG_DIR}/{CONFIG_FILE} here or above; run `langflow init` in the project root")
    with open(root / CONFIG_DIR / CONFIG_FILE, "rb") as f:
        return Project(root, tomllib.load(f))


_current: Project | None = None


def set_current(p: Project):
    global _current
    _current = p


def current() -> Project:
    """The project of this command (workflows use current().root for their file paths)."""
    global _current
    if _current is None:
        _current = load()
    return _current
