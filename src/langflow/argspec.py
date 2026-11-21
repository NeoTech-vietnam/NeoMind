"""What a workflow's run arguments mean, for the forms in the web UI (start a run, add a schedule).

Two sources, the second wins per field:
  1. The usage block of the workflow's docstring: the lines from the first `langflow start <workflow>` to the next blank
     line. `key=<what to give>` is a help text, `key=a|b|c` a choice, `key=value` an example (required arg) or the
     default (an optional arg, written in brackets: `[max_items=20]`). Text after the value inside a bracket is help.
  2. An optional `ARGS` dict in the workflow:
       ARGS = {"area": {"help": "folder under the documents root", "kind": "dir", "base": "reports/documents"},
               "cover": {"choices": ["L2", "L3", "L4"], "default": "L3"},
               "prev": {"kind": "path", "example": "Report v2.docx"}}
     Fields: help, kind ("text" | "path" | "paths" | "dir" | "choice" | "number" | "bool"), default, choices (a list,
     or a function of the project returning one), example, base (folder the paths are relative to, from the project
     root; the form's path suggestions start there).
Every REQUIRED key is listed even without a description. Spec: {key, required, help, kind, default, choices, example,
base, source}. A default of an optional arg is what the workflow uses when the arg is left out (or only an example:
the docstring cannot tell), so forms show it as a hint and send nothing for an empty optional field.
(No regex here uses a word-boundary escape: lookarounds instead, so no editing tool can turn it into a backspace.)
"""
import re
from pathlib import Path

KINDS = ("text", "path", "paths", "dir", "choice", "number", "bool")
_BRACKET = re.compile(r"\[([^\]]*)\]")
_PAIR = re.compile(r'(?<![\w.])([A-Za-z_][\w.]*)=(<[^>]*>\S*|"[^"]*"|\S+)')


def _usage_block(doc: str, workflow: str) -> str:
    start = re.compile(r"langflow start " + re.escape(workflow) + r"(?![\w])")
    out, on = [], False
    for ln in (doc or "").splitlines():
        if not on and start.search(ln):
            on = True
        if on:
            if not ln.strip():
                break
            out.append(ln)
    return "\n".join(out)


def _kind_from_help(text: str) -> str:
    t = text.lower()
    words = set(re.findall(r"[a-z]+", t))
    if re.search(r"path\s*,\s*path|;\s*\.\.\.|,\.\.\.", t) or words & {"paths", "files"}:
        return "paths"
    if words & {"folder", "dir", "directory"}:
        return "dir"
    if re.search(r"file\s*name|(?<![a-z])name(?![a-z])", t):
        return "text"                    # "base file name": a name, not a path
    if words & {"file", "path", "doc"} or re.search(r"\.(md|docx|csv|json|txt|xlsx|pdf)(?![a-z])", t):
        return "path"
    if words & {"number", "count"}:
        return "number"
    return "text"


def _spec(raw: str, tail: str, optional: bool) -> dict:
    spec: dict = {"optional": optional}
    if raw.startswith("<") and ">" in raw:
        inner, after = raw[1:raw.index(">")], raw[raw.index(">") + 1:]
        spec["help"] = " ".join(x for x in (inner, after, tail) if x).strip()
        spec["kind"] = _kind_from_help(spec["help"])
        return spec
    value = raw.strip('"')
    if "|" in value:
        spec["choices"], spec["kind"] = [c for c in value.split("|") if c], "choice"
    elif value and value != "...":
        spec["default" if optional else "example"] = value
        if re.fullmatch(r"\d+", value):
            spec["kind"] = "number"
        elif value in ("true", "false"):
            spec["kind"], spec["choices"] = "bool", ["true", "false"]
    if tail:
        spec["help"] = tail
    return spec


def from_doc(doc: str, workflow: str) -> dict:
    """{key: spec fields} read from the docstring's usage block: `[key=value more text]` is optional (the text is
    help), `key=value` outside brackets is required."""
    block, out = _usage_block(doc, workflow), {}
    for b in _BRACKET.finditer(block):
        m = _PAIR.search(b.group(1))
        if m and m.group(1) not in out and "." not in m.group(1):
            out[m.group(1)] = _spec(m.group(2), b.group(1)[m.end():].strip(), True)
    for m in _PAIR.finditer(_BRACKET.sub(" ", block)):
        if m.group(1) not in out and "." not in m.group(1):
            out[m.group(1)] = _spec(m.group(2), "", False)
    return out


def _inside(root: Path, rel: str) -> Path | None:
    """<root>/<rel> without resolving links (a junction inside the project counts as inside), or None for a path that
    leaves the project or is absolute."""
    rel = (rel or "").replace("\\", "/").strip("/")
    if not rel:
        return root
    if re.match(r"^[A-Za-z]:|^/", rel) or ".." in rel.split("/"):
        return None
    return root / rel


def _base_from_help(project, help_text: str | None) -> str | None:
    """'folder under reports/documents' -> that folder, when it exists in the project."""
    m = re.search(r"(?<![a-z])under\s+([\w./\-]+)", help_text or "")
    d = _inside(project.root, m.group(1)) if m else None
    return m.group(1).replace("\\", "/").rstrip("/") if d is not None and d.is_dir() else None


def specs(project, mod, workflow: str) -> list[dict]:
    required = list(getattr(mod, "REQUIRED", []) or [])
    doc = from_doc(mod.__doc__ or "", workflow)
    declared = getattr(mod, "ARGS", None) or {}
    keys = list(dict.fromkeys([*required, *doc, *declared]))
    out = []
    for key in keys:
        d = doc.get(key, {})
        a = declared.get(key) if isinstance(declared.get(key), dict) else {}
        spec = {"key": key, "required": key in required, "help": None, "kind": "text", "default": None,
                "choices": None, "example": None, "base": None,
                "source": "ARGS" if key in declared else "doc" if key in doc else "required"}
        for src in (d, a):
            for f in ("help", "kind", "default", "choices", "example", "base"):
                if src.get(f) is not None:
                    spec[f] = src[f]
        if callable(spec["choices"]):
            try:
                spec["choices"] = list(spec["choices"](project))
            except Exception:  # noqa: BLE001 - a broken choices function must not hide the form
                spec["choices"] = None
        if spec["choices"] is not None:
            spec["choices"] = [str(c) for c in spec["choices"]]
            if spec["kind"] == "text":
                spec["kind"] = "choice"
        if spec["kind"] not in KINDS:
            spec["kind"] = "text"
        if spec["default"] is not None:
            spec["default"] = str(spec["default"])
        if spec["kind"] == "text" and spec["default"] and "/" in spec["default"]:
            p = _inside(project.root, spec["default"])
            spec["kind"] = "dir" if p is not None and p.is_dir() else "path" if p is not None and p.is_file() \
                else "text"
        if spec["base"] is None and spec["kind"] in ("path", "paths", "dir"):
            spec["base"] = _base_from_help(project, spec["help"])
        out.append(spec)
    return out


HIDDEN = re.compile(r"(^|/)(\.git|\.env[^/]*|node_modules|__pycache__|\.venv)(/|$)|\.(pem|key|pfx|p12)$", re.I)


def suggest_paths(project, prefix: str = "", base: str | None = None, kind: str = "path", limit: int = 200) -> dict:
    """Entries under <root>/<base>/<folder part of prefix> whose name starts with the rest of prefix, for path
    fields (for a list field, the part after the last , or ;). Only inside the project (links inside it are
    followed); .git, .env*, keys and build folders are left out. Returns {base, dir, entries: [{rel (from base),
    dir}]}. ValueError for a base or prefix outside the project."""
    b = _inside(project.root, base or "")
    if b is None:
        raise ValueError("base is outside the project")
    prefix = re.split(r"[,;]", (prefix or "").replace("\\", "/"))[-1].lstrip()
    folder, _, start = prefix.rpartition("/")
    d = _inside(b, folder) if folder else b
    if d is None:
        raise ValueError("path is outside the project")
    if not d.is_dir():
        return {"base": base or "", "dir": folder, "entries": []}
    try:
        items = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except OSError:
        items = []
    entries = []
    for e in items:
        rel = f"{folder}/{e.name}" if folder else e.name
        full = f"{base.strip('/')}/{rel}" if base else rel
        if HIDDEN.search(full) or not e.name.lower().startswith(start.lower()):
            continue
        is_dir = e.is_dir()
        if kind == "dir" and not is_dir:
            continue
        entries.append({"rel": rel + ("/" if is_dir else ""), "dir": is_dir})
        if len(entries) >= limit:
            break
    return {"base": base or "", "dir": folder, "entries": entries}
