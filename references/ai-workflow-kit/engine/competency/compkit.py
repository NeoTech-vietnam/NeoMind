"""Shared helpers of the competency tools: project context, strings, markers, JSON files.

Python 3.10+, standard library only.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent
STRINGS_DIR = HERE / "strings"
ROOT_ENV = "AIKIT_PROJECT_ROOT"
DEFAULT_KB_COMMAND = "python .aikit/kb/kb.py get {id}"

_REF_EXTENSIONS = ["c", "h", "py", "cmake", "conf", "yaml", "yml", "dts", "dtsi", "overlay", "txt", "ld", "S", "json",
                   "toml", "sh"]

DEFAULT_MARKERS: dict = {
    "lesson": {
        "exercise_heading": "### Exercise {n} — ",
        "tiers": ["Understand", "Apply", "Apply advanced"],
        "hints": ["Hint: direction", "Hint: specific", "Solution"],
        "sections": 7,
        "ref_extensions": _REF_EXTENSIONS,
    },
    "placement": {
        "folder": "placement",
        "test": "test.md",
        "key": "key.md",
        "sheet": "placement.md",
        "answer": "**Answer:**",
        "grade": "**Grade:**",
        "grade_values": {"right": "right", "partial": "partial", "wrong": "wrong"},
    },
}


def _load_config_module():
    """engine/config.py under a private module name, so it works from the repo and from an installed .aikit/."""
    name = "aikit_config"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, ENGINE / "config.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


config = _load_config_module()
ConfigError = config.ConfigError


class Context:
    """Everything a competency tool needs from the project config."""

    def __init__(self, root: Path, cfg: dict):
        self.root = root
        self.cfg = cfg
        self.comp: Path = cfg["paths"]["competency"]
        self.cache: Path = cfg["paths"]["cache"]
        self.person: str = cfg["people"]["default"]
        self.lang: str = cfg["project"]["ui_lang"]
        self.strings: dict = load_strings(self.lang)
        self.markers: dict = config.deep_merge(DEFAULT_MARKERS, cfg.get("competency", {}).get("markers", {}))

    @property
    def kb_command(self):
        """Command template with {id}, or None when the project turned the button off (null)."""
        comp = self.cfg.get("competency", {})
        return comp["kb_get_command"] if "kb_get_command" in comp else DEFAULT_KB_COMMAND

    def repos(self) -> list[dict]:
        """Each repo as {"name", "root": Path, "index": bool}."""
        out = []
        for repo in self.cfg.get("repos", []):
            out.append({
                "name": repo["name"],
                "root": Path(os.path.normpath(self.root / repo["path"])),
                "index": repo.get("index", True) is not False,
            })
        return out


def find_root() -> Path:
    env = os.environ.get(ROOT_ENV)
    if env:
        return Path(env)
    try:
        return config.find_project_root(Path(__file__))
    except ConfigError:
        return config.find_project_root(Path.cwd())


def load_context(root=None) -> Context:
    root = Path(root) if root is not None else find_root()
    cfg = config.load(root)
    return Context(cfg["project_root"], cfg)


def load_strings(lang: str) -> dict:
    out = read_json(STRINGS_DIR / "en.json")
    path = STRINGS_DIR / f"{lang}.json"
    if lang != "en" and path.is_file():
        out = config.deep_merge(out, read_json(path))
    return out


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data, indent: int = 2) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")


def die(message: str, code: int = 2) -> int:
    print(f"error: {message}", file=sys.stderr)
    return code
