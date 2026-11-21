"""Skills and roles (agent definitions) a workflow step can be bound to, and the per-project overrides.

Skills: `<dir>/<id>/SKILL.md` (frontmatter `name`, `description`; the rest is the skill text) in, by priority:
  .langflow/skills   .agents/skills   .claude/skills   then [catalog] skill_dirs = [...] of config.toml
The first copy of an id wins; later copies are listed under `shadowed`. Other files in the skill folder are listed as
`files` (companions; never read). Every path must resolve inside the project (a symlink or junction that leads out
is skipped), and no file is followed outside it.

Roles: one id, up to three sources:
  .claude/agents/<id>.md     frontmatter name, description, tools, model; body = instructions   (source "claude")
  .codex/agents/<id>.toml    name, description, model, model_reasoning_effort, developer_instructions  ("codex")
  .langflow/agents/<id>.md   same format as Claude                                               ("langflow")
A step's CLI picks the source it reads (ROLE_ORDER): Claude prefers its own file (run natively with --agent), Codex
its own toml, OpenCode the langflow file. Model, effort and tools of a role apply only from the CLI's own source.

Bindings: a step's role and skills come from the workflow code (ai(..., role=, skills=)), may be overridden per
project in `.langflow/bindings.toml`, and per run with `role.<step>=` / `skills.<step>=` (run arg > bindings.toml >
code):
  [client_report.draft]
  role = "report-writer"            # "" = no role
  skills = ["asd-ste100"]           # replaces the code list ([] = none)
  skills_add = ["humanizer"]        # appended instead (after `skills` when both are set)
  role_mode = "append"              # see "Role mode" below
  contract = true                   # see "Step contract" below
Run args: `role.draft=report-writer`, `role.draft=` (none), `skills.draft=a,b` (replace), `skills.draft=+c` (add),
`skills.draft=` (none), `role_mode.draft=agent`, `contract.draft=false`, `skill_mode.draft=native`,
`native_fallback.draft=fail`, `retry_mode.draft=resume`; `<step>` may be `*` (every ai step) or a fan-out name (its
workers). The mode keys (MODE_KEYS) go the same way into bindings.toml, ai(...) and [catalog] in config.toml:
run arg > bindings.toml > ai() > config > built-in default (modes(), DEFAULTS).

Skill mode (skill_mode, per step, default "inject"; resolve() gives each skill its `via`, skill_via()):
  inject   the full SKILL.md text and its companion list before the step prompt (skills_block()).
  name     "use the skill <id>" before the prompt.
  system   the CLI's system / developer channel (Claude system file, Codex developer_instructions: system_text());
           CLIs without one (SYSTEM_SKILL_CLIS) get inject.
  native   the CLI loads its own copy (cli_skill; path / sha256 / text are that copy's) and the adapter proves it after
           the call (`skills_loaded`). A skill the CLI cannot load natively (NATIVE_SKILL_CLIS, no own copy) gets
           native_fallback ("system" — inject without a system channel —, "inject", or "fail": a BindingError);
           the engine does the same for a skill that did not load, with one fresh call.
Retry mode (retry_mode, default "resume" since 2026-11-18, was "fresh"): "resume" continues the CLI session on a
guardrail retry (RESUMABLE CLIs; another CLI gets "fresh"); "fresh" starts a new session with the whole prompt.

Pin: `record()` keeps {id, source, path, sha256} of what a step used (start event, info[step]); `changes()` compares
such a record with the files now (shown on `langflow continue`, never fatal). Each skill also records `via` (how it
reached the model: the skill_mode) and `cli` (cli_skill: the copy the step's CLI itself loads, which may differ from
the catalog's first copy or be a personal copy in the user's home); `langflow check` warns about such differences.

Role mode (role_mode, per step; run arg `role_mode.<step>=` > bindings.toml > ai(role_mode=) > [catalog] role_mode >
automatic): "append" adds the role to the CLI's system / developer prompt (Claude --append-system-prompt-file, Codex
-c developer_instructions), "agent" runs the role as the CLI's agent (Claude --agent; it replaces the default system
prompt), "prompt" puts it before the step prompt. Automatic: Claude "append" (on the command line, or the system
file when the step has "system" skills), Codex and OpenCode "prompt". See modes().

Step contract (contract, per step, default true): with a role or skills bound, CONTRACT goes last in the prompt (after
memory and after guardrail feedback), so the step's JSON answer wins over a role or skill that asks for a file.
"""
import hashlib
import json
import os
import re
import threading
import tomllib
from pathlib import Path
from typing import Any, Iterable

SKILL_SOURCES = (("langflow", ".langflow/skills"), ("agents", ".agents/skills"), ("claude", ".claude/skills"))
ROLE_SOURCES = (("claude", ".claude/agents", ".md"), ("codex", ".codex/agents", ".toml"),
                ("langflow", ".langflow/agents", ".md"))
ROLE_ORDER = {"claude": ("claude", "langflow", "codex"), "codex": ("codex", "langflow", "claude"),
              "opencode": ("langflow", "claude", "codex")}
DEFAULT_ORDER = ("langflow", "claude", "codex")
SKILL_MODES = ("inject", "system", "native", "name")
ROLE_MODES = ("append", "agent", "prompt")
FALLBACKS = ("system", "inject", "fail")
RETRY_MODES = ("fresh", "resume")
BINDINGS_FILE = ".langflow/bindings.toml"
# per-step mode keys (ai(...), bindings.toml, run args <key>.<step>=, [catalog] in config.toml)
MODE_KEYS = ("role_mode", "contract", "skill_mode", "native_fallback", "retry_mode")
MODE_VALUES = {"role_mode": ROLE_MODES, "skill_mode": SKILL_MODES, "native_fallback": FALLBACKS,
               "retry_mode": RETRY_MODES}
BINDING_KEYS = ("role", "skills", "skills_add", *MODE_KEYS)
# CLIs with a system / developer channel for skill text (skill_mode "system"), and CLIs that can load a skill by
# itself and prove it after the call (skill_mode "native"; the adapter returns `skills_loaded`). Others fall back.
SYSTEM_SKILL_CLIS = ("claude", "codex")
NATIVE_SKILL_CLIS = ("claude", "codex", "opencode")
# CLIs whose session a guardrail retry can continue (retry_mode "resume"; the adapter takes opts["resume"])
RESUMABLE = ("claude", "codex", "opencode")
MAX_COMPANIONS = 200
# the CLI's own skill folders (cli_skill): project folder, then the personal folders that shadow it
CLI_SKILL_DIRS = {"claude": ".claude/skills", "codex": ".agents/skills"}
CLI_HOME_SKILL_DIRS = {"claude": (".claude/skills",), "codex": (".agents/skills", ".codex/skills")}

CONTRACT = ("Step contract (langflow): this is one step of an automated workflow. Finish by returning the JSON the "
            "schema asks for; that JSON is your whole answer. Do not create, edit or export files, and do not ask "
            "questions, unless this step's prompt says so. When the role or a skill asks for another kind of output "
            "(a file, a .docx, a chat reply), put that content into the JSON fields instead.")

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_FM_RE = re.compile(r"^﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.S)
_LOCK = threading.Lock()


class BindingError(Exception):
    """A step names a role or skill that does not exist (or cannot be read). `problems` lists each one."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


# ---------------------------------------------------------------- small helpers

def valid_id(x) -> bool:
    return isinstance(x, str) and bool(ID_RE.match(x))


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p) -> str:
    return sha256_bytes(Path(p).read_bytes())


def _root_cfg(project) -> tuple[Path, dict]:
    """(root, config dict) of a Project, or of a bare path (no config)."""
    if hasattr(project, "root"):
        return Path(project.root), dict(getattr(project, "cfg", {}) or {})
    return Path(project), {}


def _real(p) -> Path:
    return Path(os.path.realpath(p))


def inside(root, p) -> Path | None:
    """The real path of p when it resolves inside root (symlinks and junctions followed), else None."""
    try:
        rp, rr = _real(p), _real(root)
        rp.relative_to(rr)
        return rp
    except (OSError, ValueError):
        return None


def rel(root, p) -> str:
    """p relative to root, with '/' (p as given, not resolved: the path the project uses)."""
    try:
        return Path(os.path.abspath(p)).relative_to(Path(os.path.abspath(root))).as_posix()
    except ValueError:
        return Path(p).as_posix()


def _text(b: bytes) -> str:
    """UTF-8 (with or without BOM); raises UnicodeDecodeError."""
    return b.decode("utf-8-sig")


def _mini_yaml(src: str) -> dict:
    """The frontmatter YAML subset agent and skill files use, when PyYAML is not installed: `key: value` (plain,
    'single' or "double" quoted), `key: [a, b]`, `key:` followed by `- item` lines, and `key: |` / `key: >` blocks."""
    out: dict[str, Any] = {}
    lines = src.splitlines()
    i = 0

    def scalar(v: str):
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] == '"':
            try:
                return json.loads(v)
            except ValueError:
                return v[1:-1]
        if len(v) >= 2 and v[0] == v[-1] == "'":
            return v[1:-1].replace("''", "'")
        if v.startswith("[") and v.endswith("]"):
            return [scalar(x) for x in v[1:-1].split(",") if x.strip()]
        if " #" in v:
            v = v.split(" #", 1)[0].rstrip()
        return {"true": True, "false": False, "null": None, "~": None, "": None}.get(v.lower(), v)

    while i < len(lines):
        line = lines[i]
        m = re.match(r"^([A-Za-z0-9_][\w.-]*)\s*:(.*)$", line)
        i += 1
        if not m:
            continue
        key, rest = m.group(1), m.group(2).strip()
        if rest[:1] in ("|", ">"):
            block = []
            while i < len(lines) and (not lines[i].strip() or lines[i][:1] in (" ", "\t")):
                block.append(lines[i].strip())
                i += 1
            while block and not block[-1]:
                block.pop()
            out[key] = "\n".join(block) if rest[0] == "|" else " ".join(b for b in block if b)
        elif rest == "":
            items = []
            while i < len(lines) and re.match(r"^\s+-\s", lines[i] + " "):
                items.append(scalar(lines[i].strip()[1:]))
                i += 1
            out[key] = items if items else None
        else:
            out[key] = scalar(rest)
    return out


def frontmatter(text: str) -> tuple[dict, str]:
    """(metadata, body) of a Markdown file with a `---` YAML block at the top; ({}, text) without one or when the
    block is not a mapping. Metadata is descriptive only."""
    m = _FM_RE.match(text)
    if not m:
        return {}, text.lstrip("﻿")
    try:
        import yaml
        meta = yaml.safe_load(m.group(1))
    except ImportError:
        meta = _mini_yaml(m.group(1))
    except Exception:  # noqa: BLE001 - malformed YAML: keep the body, drop the metadata
        meta = None
    return (meta if isinstance(meta, dict) else {}), text[m.end():]


def _str(v) -> str:
    return v.strip() if isinstance(v, str) else ""


def _tools(v) -> list[str] | None:
    if isinstance(v, str):
        v = [t for t in (x.strip() for x in v.split(",")) if t]
    if isinstance(v, list):
        return [str(t).strip() for t in v if str(t).strip()] or None
    return None


def _model(v) -> str | None:
    v = _str(v)
    return None if not v or v.lower() == "inherit" else v


# ---------------------------------------------------------------- skills

def skill_dirs(project) -> tuple[list[tuple[str, str]], list[str]]:
    """([(source, folder relative to the root)], warnings) in priority order: the three standard folders, then
    [catalog] skill_dirs (source "config"; a folder outside the project is refused with a warning)."""
    root, cfg = _root_cfg(project)
    out, warn = list(SKILL_SOURCES), []
    extra = (cfg.get("catalog") or {}).get("skill_dirs") or []
    if not isinstance(extra, list):
        return out, ["[catalog] skill_dirs must be a list of folders"]
    for d in extra:
        if not isinstance(d, str) or not d.strip():
            warn.append(f"[catalog] skill_dirs: ignored {d!r}")
            continue
        p = Path(d) if Path(d).is_absolute() else root / d
        if inside(root, p) is None:
            warn.append(f"[catalog] skill_dirs: {d} is outside the project; ignored")
            continue
        r = rel(root, p)
        if r not in [f for _, f in out]:
            out.append(("config", r))
    return out, warn


def companions(root, folder) -> list[str]:
    """Files next to a SKILL.md (sub-folders included), relative to the root with '/'; links that lead out of the
    project are skipped, linked folders are not entered. At most MAX_COMPANIONS."""
    root, folder = Path(root), Path(folder)
    out: list[str] = []
    for d, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = sorted(x for x in dirs if not (Path(d) / x).is_symlink() and not x.startswith(".git"))
        for f in sorted(files):
            p = Path(d) / f
            if p == folder / "SKILL.md" or inside(root, p) is None:
                continue
            out.append(rel(root, p))
            if len(out) >= MAX_COMPANIONS:
                return out
    return out


def scan_skills(project) -> tuple[list[dict], list[str]]:
    """(entries, warnings). One entry per skill id:
    {id, name, description, source, path, sha256, size, files, shadowed: [{source, path, sha256}]}."""
    root, _ = _root_cfg(project)
    dirs, warn = skill_dirs(project)
    found: dict[str, dict] = {}
    for source, folder in dirs:
        base = root / folder
        if not base.is_dir():
            continue
        if inside(root, base) is None:
            warn.append(f"{folder} leads outside the project; skipped")
            continue
        for d in sorted(base.iterdir(), key=lambda x: x.name.lower()):
            f = d / "SKILL.md"
            if not d.is_dir() or not f.is_file():
                continue
            sid, path = d.name, rel(root, f)
            if not valid_id(sid):
                warn.append(f"{path}: skill id {sid!r} not allowed (letters, digits, . _ -)")
                continue
            if inside(root, f) is None:
                warn.append(f"{path} leads outside the project; skipped")
                continue
            try:
                b = f.read_bytes()
                meta, _ = frontmatter(_text(b))
            except (OSError, UnicodeDecodeError) as e:
                warn.append(f"{path}: cannot read ({type(e).__name__})")
                continue
            sha = sha256_bytes(b)
            if sid in found:
                found[sid]["shadowed"].append({"source": source, "path": path, "sha256": sha})
                continue
            found[sid] = {"id": sid, "name": _str(meta.get("name")) or sid,
                          "description": _str(meta.get("description")), "source": source, "path": path,
                          "sha256": sha, "size": len(b), "files": companions(root, d), "shadowed": []}
    return sorted(found.values(), key=lambda e: e["id"].lower()), warn


def skills(project) -> list[dict]:
    return scan_skills(project)[0]


def skill(project, sid: str, text: bool = True) -> dict | None:
    """One skill entry (+ `text`, the SKILL.md content), or None."""
    if not valid_id(sid):
        return None
    e = next((s for s in skills(project) if s["id"] == sid), None)
    if e and text:
        root, _ = _root_cfg(project)
        e = {**e, "text": _text((root / e["path"]).read_bytes())}
    return e


def _home() -> Path:
    """The user's home folder (a function, so tests can replace it)."""
    return Path(os.path.expanduser("~"))


def _home_file(rel_dir: str, sid: str) -> tuple[str, str] | None:
    """("~/<rel_dir>/<id>/SKILL.md", sha256) of a personal skill copy, or None. Read for its hash only."""
    f = _home() / rel_dir / sid / "SKILL.md"
    try:
        return (f"~/{rel_dir}/{sid}/SKILL.md", sha256_file(f)) if f.is_file() else None
    except OSError:
        return None


def cli_skill(project, agent: str, sid: str, entry: dict | None = None) -> dict | None:
    """The copy of skill `sid` that the CLI `agent` loads by itself: {path, sha256, source, shadow: [{path, sha256}]},
    or None when that CLI has no copy of it.
      claude:   .claude/skills/<id>/SKILL.md; a personal ~/.claude/skills/<id> wins over it (Claude: personal over
                project), then path is "~/…" and source "personal". Claude does not read .agents/skills.
      codex:    .agents/skills/<id>/SKILL.md; ~/.agents/skills and ~/.codex/skills copies are listed as `shadow` (a
                linked mention picks the project file); with no project copy, the first personal one.
      other:    the catalog entry (OpenCode reads every folder; langflow passes that exact file).
    A project path must resolve inside the project. entry: the catalog entry when the caller has it."""
    if not valid_id(sid):
        return None
    root, _ = _root_cfg(project)
    if agent not in CLI_SKILL_DIRS:
        e = entry or next((s for s in skills(project) if s["id"] == sid), None)
        return {"path": e["path"], "sha256": e["sha256"], "source": "catalog", "shadow": []} if e else None
    own = None
    f = root / CLI_SKILL_DIRS[agent] / sid / "SKILL.md"
    if f.is_file() and inside(root, f) is not None:
        try:
            own = {"path": rel(root, f), "sha256": sha256_file(f), "source": "project"}
        except OSError:
            own = None
    homes = [h for h in (_home_file(d, sid) for d in CLI_HOME_SKILL_DIRS[agent]) if h]
    homes = [{"path": p, "sha256": s} for p, s in homes]
    if agent == "claude" and homes:                 # personal over project: Claude loads the personal copy
        first = homes[0]
        return {"path": first["path"], "sha256": first["sha256"], "source": "personal",
                "shadow": ([{"path": own["path"], "sha256": own["sha256"]}] if own else [])}
    if own:
        return {**own, "shadow": homes}
    if homes:
        return {"path": homes[0]["path"], "sha256": homes[0]["sha256"], "source": "personal", "shadow": homes[1:]}
    return None


def skill_notes(agent: str, s: dict, mode: str = "inject") -> list[str]:
    """Warnings about one resolved skill (resolve()) for `langflow check`: the CLI loads another copy than the
    catalog's, a personal copy shadows the project's, or (mode "name") the CLI has no copy at all."""
    cli, out = s.get("cli"), []
    sid, sha8 = s["id"], s["sha256"][:8]
    if s.get("fallback_reason"):
        out.append(f"{sid}: skill_mode {mode} not possible ({s['fallback_reason']}); {s.get('via')} used")
    if cli is None:
        if mode == "name" and agent in CLI_SKILL_DIRS:
            out.append(f"{sid}: {agent} does not read {s['path']} and has no copy of its own "
                       f"({CLI_SKILL_DIRS[agent]}/{sid}); skill_mode \"name\" cannot work for it")
        return out
    if cli["source"] == "personal":
        out.append(f"{sid}: {agent} loads the personal copy {cli['path']} #{cli['sha256'][:8]}"
                   + (f", not the project's {cli['shadow'][0]['path']}" if cli.get("shadow") else ""))
    elif cli["sha256"] != s["sha256"]:
        out.append(f"{sid}: {agent} loads {cli['path']} #{cli['sha256'][:8]}, the catalog's first copy (the text "
                   f"langflow sends) is {s['path']} #{sha8}")
    for sh in cli.get("shadow") or []:
        if cli["source"] != "personal" and sh["sha256"] != cli["sha256"]:
            out.append(f"{sid}: {agent} also sees {sh['path']} #{sh['sha256'][:8]} (another text)")
    return out


# ---------------------------------------------------------------- roles

def _role_source(root, source: str, f: Path) -> tuple[dict | None, str | None]:
    """({name, description, path, sha256, size, model, effort, tools, instructions}, warning)."""
    path = rel(root, f)
    if inside(root, f) is None:
        return None, f"{path} leads outside the project; skipped"
    try:
        b = f.read_bytes()
        t = _text(b)
    except (OSError, UnicodeDecodeError) as e:
        return None, f"{path}: cannot read ({type(e).__name__})"
    if source == "codex":
        try:
            meta = tomllib.loads(t)
        except tomllib.TOMLDecodeError as e:
            return None, f"{path}: bad TOML ({e})"
        body, effort = _str(meta.get("developer_instructions")), _str(meta.get("model_reasoning_effort")) or None
        tools = None
    else:
        meta, body = frontmatter(t)
        body, effort, tools = body.strip(), _str(meta.get("effort")) or None, _tools(meta.get("tools"))
    return {"name": _str(meta.get("name")) or f.stem, "description": _str(meta.get("description")), "path": path,
            "sha256": sha256_bytes(b), "size": len(b), "model": _model(meta.get("model")), "effort": effort,
            "tools": tools, "instructions": body}, None


def scan_roles(project) -> tuple[list[dict], list[str]]:
    """(entries, warnings). One entry per role id: {id, name, description, sources: {claude|codex|langflow: {name,
    description, path, sha256, size, model, effort, tools}}} (instructions are left out; see role())."""
    root, _ = _root_cfg(project)
    found: dict[str, dict] = {}
    warn: list[str] = []
    for source, folder, ext in ROLE_SOURCES:
        base = root / folder
        if not base.is_dir():
            continue
        for f in sorted(base.glob(f"*{ext}"), key=lambda x: x.name.lower()):
            if not f.is_file():
                continue
            rid = f.stem
            if not valid_id(rid):
                warn.append(f"{rel(root, f)}: role id {rid!r} not allowed")
                continue
            src, w = _role_source(root, source, f)
            if w:
                warn.append(w)
            if not src:
                continue
            src.pop("instructions")
            e = found.setdefault(rid, {"id": rid, "name": src["name"], "description": src["description"],
                                       "sources": {}})
            e["sources"][source] = src
            if not e["description"]:
                e["description"] = src["description"]
    return sorted(found.values(), key=lambda e: e["id"].lower()), warn


def roles(project) -> list[dict]:
    return scan_roles(project)[0]


def role(project, rid: str, text: bool = True) -> dict | None:
    """One role entry; with text=True each source also carries `text` (the whole file) and `instructions`."""
    if not valid_id(rid):
        return None
    e = next((r for r in roles(project) if r["id"] == rid), None)
    if e and text:
        root, _ = _root_cfg(project)
        srcs = {}
        for name, s in e["sources"].items():
            full, _ = _role_source(root, name, root / s["path"])
            srcs[name] = {**s, "text": _text((root / s["path"]).read_bytes()),
                          "instructions": (full or {}).get("instructions", "")}
        e = {**e, "sources": srcs}
    return e


def pick_source(entry: dict, agent: str) -> str | None:
    """The source a CLI reads for this role (ROLE_ORDER), or None when the role has no usable source."""
    for s in ROLE_ORDER.get(agent, DEFAULT_ORDER):
        if s in entry.get("sources", {}):
            return s
    return None


# ---------------------------------------------------------------- resolve, record, compare

def skill_via(agent: str, mode: str, cli: dict | None, fallback: str = "system", path: str = "") -> tuple[str, str | None]:
    """(via, reason) for one skill: how it reaches the model under skill_mode `mode` on CLI `agent`, and why it is not
    the mode itself (None when it is). "system" needs a system channel (SYSTEM_SKILL_CLIS, else "inject"); "native"
    needs a CLI that loads skills (NATIVE_SKILL_CLIS) and its own copy of the skill (cli_skill), else the fallback
    (native_fallback: "system" — or "inject" without a system channel —, "inject", or "fail")."""
    if mode == "system":
        return ("system", None) if agent in SYSTEM_SKILL_CLIS else ("inject", f"{agent} has no system channel for "
                                                                               "skills")
    if mode != "native":
        return mode, None
    if agent not in NATIVE_SKILL_CLIS:
        reason = f"{agent} cannot load skills by itself"
    elif cli is None:
        reason = (f"{agent} does not read {path or 'the catalog copy'}"
                  + (f" and has no {CLI_SKILL_DIRS[agent]}/<id> copy" if agent in CLI_SKILL_DIRS else ""))
    else:
        return "native", None
    if fallback == "fail":
        return "fail", reason
    if fallback == "system" and agent not in SYSTEM_SKILL_CLIS:
        return "inject", reason
    return (fallback if fallback in ("system", "inject") else "system"), reason


def _cli_copy(root: Path, cli: dict) -> tuple[bytes, list[str]] | None:
    """(bytes, companions) of the copy a CLI loads (cli_skill): a project path, or a personal "~/…" copy (read here
    because the CLI itself loads that text; never sent anywhere else). None when it cannot be read."""
    try:
        if cli["path"].startswith("~/"):
            f = _home() / cli["path"][2:]
            return f.read_bytes(), []
        f = root / cli["path"]
        if inside(root, f) is None:
            return None
        return f.read_bytes(), companions(root, f.parent)
    except OSError:
        return None


def resolve(project, agent: str, role_id: str | None, skill_ids: Iterable[str] | None,
            skill_mode: str = "inject", native_fallback: str = "system") -> dict:
    """The binding of one step, read now: {"role": {id, name, source, path, sha256, native, model, effort, tools,
    instructions} | None, "skills": [{id, name, path, sha256, text, files, via, cli, fallback_reason?}]}. `native` =
    the role file is the CLI's own (Claude can then run it with --agent; model/effort/tools come only from a native
    source). Per skill: `via` = how it reaches the model (skill_via: the skill_mode, or its fallback with
    `fallback_reason`), `cli` = cli_skill() for this agent (the copy the CLI itself loads, or None). Under via
    "native", path / sha256 / text are those of the CLI's copy (the file it loads). Raises BindingError with every
    problem (also a native skill that cannot be native under native_fallback "fail")."""
    root, _ = _root_cfg(project)
    problems, out_role, out_skills = [], None, []
    if role_id:
        if not valid_id(role_id):
            problems.append(f"role {role_id!r}: not a valid id")
        else:
            e = next((r for r in roles(project) if r["id"] == role_id), None)
            src = pick_source(e, agent) if e else None
            if not src:
                problems.append(f"role {role_id}: no .claude/agents/{role_id}.md, .codex/agents/{role_id}.toml or "
                                f".langflow/agents/{role_id}.md")
            else:
                full, w = _role_source(root, src, root / e["sources"][src]["path"])
                if not full:
                    problems.append(f"role {role_id}: {w}")
                else:
                    native = src == agent
                    out_role = {"id": role_id, "name": full["name"], "source": src, "path": full["path"],
                                "sha256": full["sha256"], "native": native,
                                "model": full["model"] if native else None,
                                "effort": full["effort"] if native else None,
                                "tools": full["tools"] if native else None, "instructions": full["instructions"]}
    ids = list(skill_ids or [])
    if ids:
        catalog = {s["id"]: s for s in skills(project)}
        seen = set()
        for sid in ids:
            if sid in seen:
                continue
            seen.add(sid)
            s = catalog.get(sid) if valid_id(sid) else None
            if not s:
                problems.append(f"skill {sid}: not found in {', '.join(f for _, f in skill_dirs(project)[0])}")
                continue
            try:
                b = (root / s["path"]).read_bytes()
                it = {"id": sid, "name": s["name"], "path": s["path"], "sha256": sha256_bytes(b), "text": _text(b),
                      "files": s["files"], "via": skill_mode, "cli": cli_skill(project, agent, sid, s)}
            except (OSError, UnicodeDecodeError) as e:
                problems.append(f"skill {sid}: cannot read {s['path']} ({type(e).__name__})")
                continue
            via, reason = skill_via(agent, skill_mode, it["cli"], native_fallback, s["path"])
            if via == "fail":
                problems.append(f"skill {sid}: not native ({reason}) and native_fallback is \"fail\"")
                continue
            if via == "native" and it["cli"]["path"] != s["path"]:
                got = _cli_copy(root, it["cli"])
                try:
                    if got is None:
                        raise OSError("unreadable")
                    it.update(path=it["cli"]["path"], sha256=sha256_bytes(got[0]), text=_text(got[0]), files=got[1])
                except (OSError, UnicodeDecodeError) as e:
                    problems.append(f"skill {sid}: cannot read {it['cli']['path']} ({type(e).__name__})")
                    continue
            it["via"] = via
            if reason:
                it["fallback_reason"] = reason
            out_skills.append(it)
    if problems:
        raise BindingError(problems)
    return {"role": out_role, "skills": out_skills}


def record(resolved: dict | None) -> dict | None:
    """What a run keeps of a binding (start event, info[step]): ids, sources, paths and hashes, no text.
    None when the step has neither role nor skills."""
    if not resolved or (not resolved.get("role") and not resolved.get("skills")):
        return None
    r = resolved.get("role")
    role = None
    if r:
        role = {k: r[k] for k in ("id", "source", "path", "sha256", "native")}
        if r.get("mode"):
            role["mode"] = r["mode"]
    sk = []
    for s in resolved.get("skills") or []:
        it = {k: s[k] for k in ("id", "path", "sha256")}
        if s.get("via"):
            it["via"] = s["via"]
        if s.get("fallback_reason"):
            it["fallback_reason"] = s["fallback_reason"]
        cli = s.get("cli")
        if cli and (cli["path"] != s["path"] or cli["sha256"] != s["sha256"]):
            it["cli"] = {k: cli[k] for k in ("path", "sha256", "source")}
        sk.append(it)
    return {"role": role, "skills": sk}


def _now_sha(root: Path, path: str) -> str | None:
    """sha256 of a recorded file now: a project path (must stay inside the project) or a personal "~/…" copy (read
    for its hash only); None when missing."""
    try:
        if path.startswith("~/"):
            p = _home() / path[2:]
            return sha256_file(p) if p.is_file() else None
        p = root / path
        return sha256_file(p) if inside(root, p) is not None and p.is_file() else None
    except OSError:
        return None


def changes(project, rec: dict | None) -> list[str]:
    """How the files of a recorded binding differ now: ["skill asd-ste100 changed (.claude/skills/…/SKILL.md)",
    "role report-writer missing (…)"]; [] when all match. A skill's `cli` copy (the one its CLI loads, when it is
    not the recorded file) is compared too: "skill x changed (~/.claude/skills/x/SKILL.md, the copy claude
    loads)"."""
    if not rec:
        return []
    root, _ = _root_cfg(project)
    out = []
    items = ([("role", rec["role"])] if rec.get("role") else []) + [("skill", s) for s in rec.get("skills") or []]
    for kind, it in items:
        now = _now_sha(root, it["path"])
        if now is None:
            out.append(f"{kind} {it['id']} missing ({it['path']})")
        elif now != it["sha256"]:
            out.append(f"{kind} {it['id']} changed ({it['path']})")
        cli = it.get("cli") if kind == "skill" else None
        if cli and cli.get("path") != it["path"]:
            now = _now_sha(root, cli["path"])
            if now is None:
                out.append(f"skill {it['id']} missing ({cli['path']}, the copy the CLI loads)")
            elif now != cli["sha256"]:
                out.append(f"skill {it['id']} changed ({cli['path']}, the copy the CLI loads)")
    return out


# ---------------------------------------------------------------- prompt

def skill_mode(project) -> str:
    _, cfg = _root_cfg(project)
    m = (cfg.get("catalog") or {}).get("skill_mode", "inject")
    return m if m in SKILL_MODES else "inject"


def role_text(r: dict | None) -> str:
    """The role block for a CLI that does not load the role itself ("" without instructions)."""
    if not r or not (r.get("instructions") or "").strip():
        return ""
    return (f"Role for this step: {r['id']} ({r['path']}). Follow these instructions:\n\n"
            f"{r['instructions'].strip()}\n")


def skills_text(items: list[dict] | None, mode: str = "inject") -> str:
    """The skills block (NeoMind's layout): `Skills for this step (follow them):`, then per skill
    `### <name> (<path>)`, its SKILL.md text and `Companion files (read only if needed): …`. mode "name" lists the
    skill ids only."""
    if not items:
        return ""
    if mode == "name":
        return "Skills for this step (follow them):\n" + "".join(
            f"- Use the skill {s['id']} ({s['path']}).\n" for s in items)
    parts = ["Skills for this step (follow them):"]
    for s in items:
        block = f"### {s.get('name') or s['id']} ({s['path']})\n\n{(s.get('text') or '').strip()}"
        if s.get("files"):
            block += "\n\nCompanion files (read only if needed): " + ", ".join(s["files"])
        parts.append(block)
    return "\n\n".join(parts) + "\n"


def prompt_skills(items: list[dict] | None) -> list[dict]:
    """The skills that go into the prompt text: via "inject" or "name" (a skill without `via` counts as inject)."""
    return [s for s in items or [] if s.get("via", "inject") in ("inject", "name")]


def skills_block(items: list[dict] | None) -> str:
    """The prompt's skills block for prompt_skills(items): injected skills in full, then "name" skills by id."""
    inj = [s for s in prompt_skills(items) if s.get("via", "inject") == "inject"]
    nam = [s for s in prompt_skills(items) if s.get("via") == "name"]
    return "\n".join(b for b in (skills_text(inj), skills_text(nam, "name")) if b)


def system_text(role: dict | None, items: list[dict] | None) -> str:
    """Text for a CLI's system / developer channel: the role block (role_text; None = no role), then the skills block
    of the given skills in full (skills_text layout). "" when there is nothing."""
    blocks = [role_text(role), skills_text(items or [])]
    return "\n".join(b for b in blocks if b)


def preamble(resolved: dict | None, mode: str = "inject", with_role: bool = True) -> str:
    """Role block (when with_role) and skills block, in that order; "" when there is nothing."""
    if not resolved:
        return ""
    blocks = [role_text(resolved.get("role")) if with_role else "", skills_text(resolved.get("skills"), mode)]
    return "\n".join(b for b in blocks if b)


def prepend_role(prompt: str, r: dict | None) -> str:
    """The role block before a prompt that may already start with the skills block (adapters without a system
    prompt: Codex, OpenCode, Claude with a non-native role that is too long for the command line)."""
    rt = role_text(r)
    if not rt:
        return prompt
    return rt + ("\n" if prompt.startswith("Skills for this step") else "\n---\n\n") + prompt


def compose(prompt: str, resolved: dict | None, mode: str = "inject", with_role: bool = True) -> str:
    """The step prompt with the preamble before it (unchanged when the step has no binding)."""
    pre = preamble(resolved, mode, with_role)
    return f"{pre}\n---\n\n{prompt}" if pre else prompt


def contract() -> str:
    """The step-contract block (CONTRACT), for the end of a bound step's prompt."""
    return CONTRACT


def with_contract(text: str) -> str:
    """text with the step contract as its last block."""
    return f"{text.rstrip()}\n\n---\n\n{CONTRACT}"


_TRUE = {"true", "1", "yes", "on"}
_FALSE = {"false", "0", "no", "off"}


def _bool(v, where: str, key: str) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in _TRUE | _FALSE:
        return v.strip().lower() in _TRUE
    raise ValueError(f"{where}: {key} must be true or false")


def config_modes(project) -> dict:
    """[catalog] role_mode / contract / contract_system / skill_mode / native_fallback / retry_mode of config.toml,
    validated (bad values are ignored: the built-in default applies, and `langflow check` shows the setting)."""
    _, cfg = _root_cfg(project)
    c = cfg.get("catalog") or {}
    out = {}
    for k, allowed in MODE_VALUES.items():
        if c.get(k) in allowed:
            out[k] = c[k]
    for k in ("contract", "contract_system"):
        if isinstance(c.get(k), bool):
            out[k] = c[k]
    return out


DEFAULTS = {"skill_mode": "inject", "native_fallback": "system", "retry_mode": "resume", "contract": True}


def _pick(eff: dict, cfgm: dict, key: str) -> tuple[Any, str]:
    """(value, from) of a mode key: effective() (run arg > bindings.toml > ai()), then config, then DEFAULTS."""
    if eff.get(key) is not None:
        return eff[key], (eff.get("from") or {}).get(key) or "code"
    if key in cfgm:
        return cfgm[key], "config"
    return DEFAULTS[key], "default"


def skill_modes(project, eff: dict) -> tuple[str, str]:
    """(skill_mode, native_fallback) of a step: effective() > [catalog] > default ("inject", "system")."""
    cfgm = config_modes(project)
    return _pick(eff, cfgm, "skill_mode")[0], _pick(eff, cfgm, "native_fallback")[0]


def modes(project, eff: dict, agent: str, role: dict | None = None) -> dict:
    """How a step's binding reaches its CLI: {"role_mode": "append"|"agent"|"prompt"|None (no role), "explicit":
    bool, "contract": bool, "contract_system": bool, "skill_mode", "native_fallback", "retry_mode", "from":
    {"role_mode", "contract", "skill_mode", "native_fallback", "retry_mode"}, "note"?}.
    eff: effective() (run arg > bindings.toml > ai()); then [catalog] in config.toml; then the built-in default:
    skill_mode "inject", native_fallback "system", retry_mode "resume", contract true, and for role_mode the automatic
    default: Claude "append" (the role text in the system prompt; also for a native role, since --agent replaces the
    default system prompt), Codex and OpenCode "prompt". `explicit` is False for that automatic role_mode: adapters
    then keep their old code path.
    A mode a CLI cannot give is changed, with a note: "agent" on Claude needs .claude/agents/<id>.md (else
    "append"); Codex has no main-thread agent ("agent" -> "append"); OpenCode: "agent" = the instance agent lf-role,
    "append" = [agents.opencode] role_channel ("prompt" default, or "instructions"); another CLI: "prompt"; retry_mode "resume" needs a CLI in RESUMABLE (else "fresh")."""
    cfgm = config_modes(project)
    src = dict(eff.get("from") or {})
    rm, rm_from = eff.get("role_mode"), src.get("role_mode")
    if rm is None and cfgm.get("role_mode"):
        rm, rm_from = cfgm["role_mode"], "config"
    notes = []
    explicit = rm is not None
    if not role:
        rm, explicit = None, False
    elif rm is None:
        # Claude: "append" even for a native role. `--agent` replaces the default system prompt, and the agent file's
        # `tools:` line drops the StructuredOutput tool that --json-schema needs (tested 2026-11-18): "agent" only
        # when asked for.
        rm, rm_from = "append" if agent == "claude" else "prompt", "default"
    elif rm == "agent" and agent == "claude" and not role.get("native"):
        rm = "append"
        notes.append(f"role_mode agent needs .claude/agents/{role['id']}.md; append used")
    elif rm == "agent" and agent == "codex":
        rm = "append"
        notes.append("codex has no main-thread agent; append (developer_instructions) used")
    elif rm in ("append", "agent") and agent not in ("claude", "codex", "opencode"):
        rm = "prompt"
        notes.append(f"{agent} has no system channel for a role yet; prompt used")
    con, con_from = _pick(eff, cfgm, "contract")
    sm, sm_from = _pick(eff, cfgm, "skill_mode")
    fb, fb_from = _pick(eff, cfgm, "native_fallback")
    rt, rt_from = _pick(eff, cfgm, "retry_mode")
    if rt == "resume" and agent not in RESUMABLE:
        rt = "fresh"
        if rt_from != "default":        # the built-in default needs no note: it is resume only where a CLI can
            notes.append(f"{agent} cannot resume a session (retry_mode resume); fresh retries used")
    out = {"role_mode": rm, "explicit": explicit, "contract": bool(con),
           "contract_system": cfgm.get("contract_system", False), "skill_mode": sm, "native_fallback": fb,
           "retry_mode": rt,
           "from": {"role_mode": rm_from if role else None, "contract": con_from, "skill_mode": sm_from,
                    "native_fallback": fb_from, "retry_mode": rt_from}}
    if notes:
        out["note"] = "; ".join(notes)
    return out


WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")


def tool_name(rule: str) -> str:
    """The tool of a permission rule: "Bash(git diff *)" -> "Bash"."""
    return str(rule).split("(", 1)[0].strip()


def role_tools(tools: list[str] | None, sandbox: str | None) -> list[str] | None:
    """A native role's tools as a step's allowed tools, limited by the step's sandbox: no Write / Edit / Bash /
    PowerShell (any rule) under "read-only". None when nothing is left. The engine uses it only under role_mode
    "agent" and when the step has no tools of its own: role tools never widen a step's tools."""
    if not tools:
        return None
    if (sandbox or "read-only") == "read-only":
        tools = [t for t in tools if tool_name(t) not in WRITE_TOOLS + ("Bash", "PowerShell")]
    return list(tools) or None


# ---------------------------------------------------------------- bindings.toml

def bindings_path(project) -> Path:
    root, _ = _root_cfg(project)
    return root / BINDINGS_FILE


def read_bindings(project) -> dict:
    """{workflow: {step: {role?, skills?, skills_add?}}}; {} without the file. Raises ValueError on bad TOML or
    bad values."""
    p = bindings_path(project)
    return _parse(p.read_text(encoding="utf-8-sig")) if p.is_file() else {}


def _parse(text: str) -> dict:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"{BINDINGS_FILE}: {e}") from e
    out: dict[str, dict] = {}
    for wf, steps in data.items():
        if not isinstance(steps, dict):
            raise ValueError(f"{BINDINGS_FILE}: '{wf}' must be a table of steps ([{wf}.<step>])")
        for step, vals in steps.items():
            if not isinstance(vals, dict):
                raise ValueError(f"{BINDINGS_FILE}: [{wf}.{step}] must be a table")
            out.setdefault(wf, {})[step] = check_values(vals, f"[{wf}.{step}]")
    return out


def check_values(vals: dict, where: str = "binding") -> dict:
    """Validate an override {role?, skills?, skills_add?, role_mode?, contract?, skill_mode?, native_fallback?,
    retry_mode?}; returns a clean copy. Raises ValueError."""
    if not isinstance(vals, dict):
        raise ValueError(f"{where}: must be a table/object")
    out = {}
    for k, v in vals.items():
        if k not in BINDING_KEYS:
            raise ValueError(f"{where}: unknown key '{k}' (allowed: {', '.join(BINDING_KEYS)})")
        if k == "role":
            if not isinstance(v, str) or (v and not valid_id(v)):
                raise ValueError(f"{where}: role must be a role id or \"\" (none)")
            out[k] = v
        elif k in MODE_VALUES:
            if v not in MODE_VALUES[k]:
                raise ValueError(f"{where}: {k} must be one of {', '.join(MODE_VALUES[k])}")
            out[k] = v
        elif k == "contract":
            out[k] = _bool(v, where, k)
        else:
            if not isinstance(v, list) or not all(valid_id(x) for x in v):
                raise ValueError(f"{where}: {k} must be a list of skill ids")
            out[k] = list(dict.fromkeys(v))
    return out


def override_for(bindings: dict, workflow: str, step: str) -> dict | None:
    """The bindings.toml override of a step (the fan-out name covers its workers `name[i]`), or None."""
    steps = bindings.get(workflow) or {}
    return steps.get(step) if step in steps else steps.get(step.split("[")[0])


def run_value(args: dict | None, key: str, step: str) -> str | None:
    """The run arg `<key>.<step>` (then `<key>.<fan-out name>`, then `<key>.*`), or None. "" is a value (none)."""
    args = args or {}
    for k in (f"{key}.{step}", f"{key}.{step.split('[')[0]}", f"{key}.*"):
        if k in args and args[k] is not None:
            return str(args[k]).strip()
    return None


def _ids(text: str) -> list[str]:
    return [x for x in (y.strip() for y in text.split(",")) if x]


def effective(code: dict | None, override: dict | None = None, args: dict | None = None,
              step: str | None = None) -> dict:
    """The binding a step runs with: {"role": id | None, "skills": [ids], <mode key>: value (MODE_KEYS: role_mode,
    contract, skill_mode, native_fallback, retry_mode), "from": {"role": "code"|"bindings"|"run", "skills": ...,
    <mode key>: "code"|"bindings"|"run"}}. Precedence: run arg > bindings.toml > code. A mode key (and its `from`) is
    present only when set by one of these (modes() adds config and the default). A bad run-arg value raises
    ValueError."""
    code = code or {}
    role_id, skills_l = code.get("role") or None, list(code.get("skills") or [])
    src = {"role": "code", "skills": "code"}
    extra: dict[str, Any] = {}
    for k in MODE_KEYS:
        if code.get(k) is not None:
            extra[k], src[k] = code[k], "code"
    if override:
        if "role" in override:
            role_id, src["role"] = override["role"] or None, "bindings"
        if "skills" in override:
            skills_l, src["skills"] = list(override["skills"]), "bindings"
        if override.get("skills_add"):
            skills_l += [s for s in override["skills_add"] if s not in skills_l]
            src["skills"] = "bindings"
        for k in MODE_KEYS:
            if override.get(k) is not None:
                extra[k], src[k] = override[k], "bindings"
    if step is not None:
        for k in MODE_KEYS:
            v = run_value(args, k, step)
            if v:                                      # "" = not set by the run
                extra[k] = check_values({k: v}, f"run arg {k}.{step}")[k]
                src[k] = "run"
        rv = run_value(args, "role", step)
        if rv is not None:
            role_id, src["role"] = rv or None, "run"
        sv = run_value(args, "skills", step)
        if sv is not None:
            if sv.startswith("+"):
                skills_l += [s for s in _ids(sv[1:]) if s not in skills_l]
            else:
                skills_l = _ids(sv)
            src["skills"] = "run"
    return {"role": role_id, "skills": list(dict.fromkeys(skills_l)), **extra, "from": src}


_HEADER_RE = re.compile(r"^\s*\[(?!\[)")


def _header_path(line: str) -> tuple | None:
    """Key path of a `[a.b]` table header line, or None for other lines."""
    if not _HEADER_RE.match(line.rstrip("\r\n")):
        return None
    try:
        d = tomllib.loads(line.strip() + "\n")
    except tomllib.TOMLDecodeError:
        return None
    path = []
    while isinstance(d, dict) and len(d) == 1:
        k = next(iter(d))
        path.append(k)
        d = d[k]
    return tuple(path)


def _key(k: str) -> str:
    return k if re.match(r"^[A-Za-z0-9_-]+$", k) else json.dumps(k, ensure_ascii=False)


def _val(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, list):
        return "[" + ", ".join(_val(x) for x in v) + "]"
    return json.dumps(str(v), ensure_ascii=False)


def _block(workflow: str, step: str, vals: dict) -> list[str]:
    return [f"[{_key(workflow)}.{_key(step)}]\n"] + [f"{k} = {_val(vals[k])}\n" for k in BINDING_KEYS if k in vals]


def _clean(data: dict) -> str:
    out = ["# Step bindings (langflow): role and skills per workflow step; see `langflow roles` / `langflow skills`.\n"]
    for wf in data:
        for step, vals in data[wf].items():
            out += ["\n", *_block(wf, step, vals)]
    return "".join(out)


def _edit(text: str, workflow: str, step: str, vals: dict | None) -> str:
    """Replace (vals) or remove (None) the [workflow.step] table in text, keeping every other line."""
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    heads = [i for i, ln in enumerate(lines) if _header_path(ln) is not None]
    start = next((i for i in heads if _header_path(lines[i]) == (workflow, step)), None)
    if start is None:
        if vals is None:
            return "".join(lines)
        while lines and not lines[-1].strip():
            lines.pop()
        return "".join(lines + (["\n"] if lines else []) + _block(workflow, step, vals))
    end = next((i for i in heads if i > start), len(lines))
    while end - 1 > start and (not lines[end - 1].strip() or lines[end - 1].lstrip().startswith("#")):
        end -= 1                                      # comments just above the next table belong to it
    if vals is not None:
        return "".join(lines[:start] + _block(workflow, step, vals) + lines[end:])
    while end < len(lines) and not lines[end].strip():
        end += 1                                      # the blank lines after the removed table
    while start > 0 and not lines[start - 1].strip() and end >= len(lines):
        start -= 1                                    # removed the last table: no trailing blank lines
    return "".join(lines[:start] + lines[end:])


def set_binding(project, workflow: str, step: str, vals: dict | None) -> dict:
    """Write (vals) or remove (None or {}) the override of one step in .langflow/bindings.toml. Other tables and
    their comments are kept; when the line edit cannot be verified, the file is rewritten cleanly from the data.
    Returns the new bindings."""
    if not valid_id(workflow) or not isinstance(step, str) or not step.strip():
        raise ValueError("workflow and step names are required")
    vals = check_values(vals, f"[{workflow}.{step}]") if vals else None
    p = bindings_path(project)
    with _LOCK:
        old = read_bindings(project)
        want = {wf: dict(steps) for wf, steps in old.items()}
        if vals is None:
            want.get(workflow, {}).pop(step, None)
            if workflow in want and not want[workflow]:
                del want[workflow]
        else:
            want.setdefault(workflow, {})[step] = vals
        text = p.read_text(encoding="utf-8-sig") if p.is_file() else ""
        try:
            new = _edit(text, workflow, step, vals)
            ok = _parse(new) == want
        except ValueError:
            ok = False
        if not ok:
            new = _clean(want)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(new, encoding="utf-8")
        os.replace(tmp, p)
        return want


# ---------------------------------------------------------------- workflow steps, usage, preflight

def step_meta(st) -> dict | None:
    """The binding metadata an ai step carries: {"agent", "role", "skills"} (the engine sets it on the node function
    as `langflow_step`), or None."""
    fn = st[1] if isinstance(st, tuple) and len(st) > 1 else None
    meta = getattr(fn, "langflow_step", None)
    return meta if isinstance(meta, dict) else None


def fanout_meta(spec) -> dict | None:
    """The binding metadata of a fan-out's workers, from its spec (worker, limit[, declared]) — {"agent", "role",
    "skills", "via"} or None when no worker is known to be an ai step. Sources, first wins per key:
    fanout(..., role=, skills=, agent=) ("declared"); the worker function's `langflow_step` attribute ("worker");
    one probe call worker(None, 0) that returns an ai step ("probe"; a worker that needs a real item raises and is
    skipped)."""
    worker = spec[0]
    declared = (spec[2] if len(spec) > 2 else None) or {}
    base = getattr(worker, "langflow_step", None)
    via = "worker" if isinstance(base, dict) else None
    if not isinstance(base, dict):
        base = None
        try:
            st = worker(None, 0)
            if isinstance(st, tuple) and len(st) > 2 and st[2] == "ai":
                base, via = step_meta(st), "probe"
        except Exception:  # noqa: BLE001 - the worker may need a real item; then only a declaration helps
            base = None
    if not declared and base is None:
        return None
    base = dict(base or {})
    meta = {"agent": declared.get("agent") or base.get("agent") or "claude",
            "role": declared["role"] if "role" in declared else base.get("role"),
            "skills": list(declared["skills"] if "skills" in declared else base.get("skills") or []),
            **{k: base[k] for k in MODE_KEYS if base.get(k) is not None},
            **({"cost": base["cost"]} if isinstance(base.get("cost"), dict) else {}),
            "via": "declared" if declared else via}
    return meta


def walk(steps) -> list[tuple[str, dict]]:
    """Every ai step of a workflow's step list, patterns included: [(step name, meta)]. A fan-out's workers count
    under the fan-out name (fanout_meta: declared with fanout(..., role=, skills=), the worker's `langflow_step`, or a
    probe call)."""
    out: list[tuple[str, dict]] = []

    def go(x):
        if isinstance(x, list):
            for y in x:
                go(y)
            return
        if not isinstance(x, tuple) or len(x) < 3:
            return
        name, kind = x[0], x[2]
        if kind == "ai":
            m = step_meta(x)
            if m is not None:
                out.append((name, m))
        elif kind == "route":
            for br in x[3].values():
                go(br)
        elif kind == "parallel":
            for br in x[3]:
                go(br)
        elif kind == "loop":
            go(x[3][0])
        elif kind == "fanout":
            m = fanout_meta(x[3])
            if m is not None:
                out.append((name, m))
    go(steps)
    return out


def step_rows(workflow: str, steps, bindings: dict | None = None, args: dict | None = None) -> list[dict]:
    """One row per ai step: {workflow, step, agent, code: {role, skills}, override, effective: {role, skills,
    from}, cost?: {model, effort, tools, guardrail, retries, memory} (as written in the workflow, for
    design.cost_warnings)}."""
    rows = []
    for name, m in walk(steps):
        code = {"role": m.get("role") or None, "skills": list(m.get("skills") or []),
                **{k: m[k] for k in MODE_KEYS if m.get(k) is not None}}
        ov = override_for(bindings or {}, workflow, name)
        rows.append({"workflow": workflow, "step": name, "agent": m.get("agent"), "code": code, "override": ov,
                     "effective": effective(code, ov, args, name),
                     **({"fanout": m["via"]} if m.get("via") else {}),
                     **({"cost": m["cost"]} if isinstance(m.get("cost"), dict) else {})})
    return rows


def usage(rows: Iterable[dict]) -> dict:
    """{"skills": {id: [{workflow, step}]}, "roles": {id: [{workflow, step}]}} from step_rows() rows."""
    out: dict[str, dict] = {"skills": {}, "roles": {}}
    for r in rows:
        eff, ref = r["effective"], {"workflow": r["workflow"], "step": r["step"]}
        if eff.get("role"):
            out["roles"].setdefault(eff["role"], []).append(ref)
        for s in eff.get("skills") or []:
            out["skills"].setdefault(s, []).append(ref)
    return out


def catalog(project, rows: Iterable[dict] = ()) -> dict:
    """{skills: [entry + used_by], roles: [entry + used_by], warnings} for `langflow skills|roles` and GET
    /api/catalog. Ids used by a step but missing from the project are listed with `missing: true`."""
    sk, w1 = scan_skills(project)
    ro, w2 = scan_roles(project)
    use = usage(rows)
    for kind, entries in (("skills", sk), ("roles", ro)):
        for e in entries:
            e["used_by"] = use[kind].get(e["id"], [])
        known = {e["id"] for e in entries}
        entries += [{"id": i, "missing": True, "used_by": refs} for i, refs in use[kind].items() if i not in known]
    return {"skills": sk, "roles": ro, "warnings": w1 + w2}


def preflight(project, rows: Iterable[dict]) -> list[str]:
    """Problems that stop a start: every role and skill an ai step will run with must exist for its CLI, and a
    skill_mode "native" skill that cannot be native must not have native_fallback "fail".
    ["<workflow>.<step>: role x: …", …]; [] when all is well. Fallbacks and shadows are warnings (step_detail)."""
    out = []
    for r in rows:
        eff = r["effective"]
        try:
            resolve(project, r.get("agent") or "claude", eff.get("role"), eff.get("skills"), *skill_modes(project, eff))
        except BindingError as e:
            out += [f"{r['workflow']}.{r['step']}: {p}" for p in e.problems]
    return out


def step_detail(project, row: dict) -> dict:
    """What a step_rows() row runs with, resolved now, for `langflow check` and the web bindings view:
    {"modes": modes(), "role": {id, source, path, sha256, native, mode} | None, "skills": [{id, via, path, sha256,
    cli, fallback_reason?}], "warnings": [...], "problems": [...]}. Never raises."""
    agent = row.get("agent") or "claude"
    eff = row["effective"]
    mode, fallback = skill_modes(project, eff)
    try:
        res = resolve(project, agent, eff.get("role"), eff.get("skills"), mode, fallback)
        problems = []
    except BindingError as e:
        res, problems = {"role": None, "skills": []}, e.problems
        try:                                     # a skill problem: still show the role
            res["role"] = resolve(project, agent, eff.get("role"), [])["role"]
        except BindingError:
            pass
    m = modes(project, eff, agent, res["role"])
    role = None
    if res["role"]:
        role = {**{k: res["role"][k] for k in ("id", "source", "path", "sha256", "native")}, "mode": m["role_mode"]}
    sk = [{"id": s["id"], "via": s["via"], "path": s["path"], "sha256": s["sha256"], "cli": s["cli"],
           **({"fallback_reason": s["fallback_reason"]} if s.get("fallback_reason") else {})} for s in res["skills"]]
    warn = [w for s in res["skills"] for w in skill_notes(agent, s, mode)]
    if m.get("note"):
        warn.append(m["note"])
    return {"modes": m, "role": role, "skills": sk, "warnings": warn, "problems": problems}
