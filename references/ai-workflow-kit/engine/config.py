"""Load and validate the project config (kit.json).

Python 3.10+, standard library only.
"""

from __future__ import annotations

import copy
import json
import os
import re
import unicodedata
from pathlib import Path, PurePosixPath, PureWindowsPath

CONFIG_NAME = "kit.json"

DEFAULTS: dict = {
    "kit_version": "0.1.0",
    "project": {"name": "project", "owner": "owner", "reviewer": "owner", "ui_lang": "en"},
    "people": {"default": "owner"},
    "paths": {
        "engine": ".aikit",
        "kb": "knowledge/kb",
        "competency": "knowledge/competency",
        "memory": ".claude/memory",
        "cache": "knowledge/.cache",
    },
    "repos": [{"name": "main", "path": "."}],
    "kb": {"scopes": ["project"], "default_groups": {}, "status_column": "Status"},
    "competency": {"markers": {}},
    "grants": [],
    "guard_rules": [],
    "agents": {
        "tiers": {
            "H": {"claude": "opus", "codex": "gpt-6.1-sol", "codex_effort": "high"},
            "M": {"claude": "sonnet", "codex": "gpt-6.1-sol", "codex_effort": "medium"},
            "L": {"claude": "haiku", "codex": "gpt-6-luna", "codex_effort": "low"},
        },
        "assign": {},
    },
    "harnesses": {"claude": True, "codex": True, "antigravity": False},
    "plugins": [],
}

# Keys that load() adds to the returned dict. They are not part of kit.json.
DERIVED_KEYS = frozenset({"paths_raw", "project_root"})

UI_LANGS = frozenset({"en", "vi"})
GUARD_ACTIONS = ("allow", "ask", "deny-without-grant")
SCOPE_RE = re.compile(r"[a-z0-9-]+")


class ConfigError(Exception):
    """The config cannot be loaded."""


def deep_merge(base: dict, over: dict) -> dict:
    """Return base with over merged in. Dicts merge key by key; everything else is replaced."""
    out = copy.deepcopy(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def owner_slug(owner: str) -> str:
    """Lower-case ASCII slug: accents stripped, runs of other characters become one '-'."""
    text = owner.replace("đ", "d").replace("Đ", "D")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def find_project_root(start) -> Path:
    """Walk up from start to the first folder that holds kit.json."""
    here = Path(start).absolute()
    if here.is_file():
        here = here.parent
    for folder in (here, *here.parents):
        if (folder / CONFIG_NAME).is_file():
            return folder
    raise ConfigError(f"no {CONFIG_NAME} found in {here} or any parent folder")


def load(project_root) -> dict:
    """Read kit.json, merge it over the defaults and resolve paths.* under project_root."""
    root = Path(os.path.normpath(Path(project_root).absolute()))
    config_file = root / CONFIG_NAME
    if not config_file.is_file():
        raise ConfigError(f"{config_file} not found")
    try:
        raw = json.loads(config_file.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError) as exc:
        raise ConfigError(f"cannot read {config_file}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{config_file} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{config_file}: top level must be a JSON object")

    cfg = deep_merge(DEFAULTS, raw)

    paths = cfg.get("paths")
    if not isinstance(paths, dict):
        raise ConfigError("'paths' must be an object")
    resolved: dict[str, Path] = {}
    for name, value in paths.items():
        if not isinstance(value, str) or not value.strip():
            raise ConfigError(f"paths.{name} must be a non-empty string")
        if _is_absolute(value):
            raise ConfigError(f"paths.{name} must be relative to the project root, got '{value}'")
        target = Path(os.path.normpath(root / value))
        try:
            target.relative_to(root)
        except ValueError:
            raise ConfigError(f"paths.{name} points outside the project root: '{value}'") from None
        resolved[name] = target

    cfg["paths_raw"] = dict(paths)
    cfg["paths"] = resolved
    cfg["project_root"] = root
    return cfg


def _is_absolute(value: str) -> bool:
    return PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute() or bool(
        PureWindowsPath(value).drive
    )


def validate(cfg: dict) -> list[str]:
    """Return every problem found. Items starting with 'warning:' do not fail `check`."""
    problems: list[str] = []
    err = problems.append

    for key in sorted(set(cfg) - set(DEFAULTS) - DERIVED_KEYS):
        err(f"warning: unknown top-level key '{key}'")

    def section(name: str, kind: type):
        value = cfg.get(name)
        if not isinstance(value, kind):
            err(f"'{name}' must be {_kind_name(kind)}")
            return None
        return value

    def text(where: str, value) -> bool:
        if isinstance(value, str) and value.strip():
            return True
        err(f"{where} must be a non-empty string")
        return False

    text("kit_version", cfg.get("kit_version"))

    project = section("project", dict)
    if project is not None:
        for key in ("name", "owner", "reviewer", "ui_lang"):
            text(f"project.{key}", project.get(key))
        lang = project.get("ui_lang")
        if isinstance(lang, str) and lang not in UI_LANGS:
            err(f"project.ui_lang '{lang}' is invalid, use one of {sorted(UI_LANGS)}")

    people = section("people", dict)
    if people is not None:
        text("people.default", people.get("default"))

    raw_paths = cfg.get("paths_raw", cfg.get("paths"))
    if not isinstance(raw_paths, dict):
        err("'paths' must be an object")
    else:
        for key in DEFAULTS["paths"]:
            if key not in raw_paths:
                err(f"paths.{key} is missing")
        for key, value in raw_paths.items():
            if not isinstance(value, str) or not value.strip():
                err(f"paths.{key} must be a non-empty string")

    repos = section("repos", list)
    if repos is not None:
        for i, repo in enumerate(repos):
            if not isinstance(repo, dict):
                err(f"repos[{i}] must be an object")
                continue
            text(f"repos[{i}].name", repo.get("name"))
            text(f"repos[{i}].path", repo.get("path"))

    kb = section("kb", dict)
    if kb is not None:
        scopes = kb.get("scopes")
        if not isinstance(scopes, list) or not scopes:
            err("kb.scopes must be a non-empty list")
        else:
            for scope in scopes:
                if not isinstance(scope, str) or not SCOPE_RE.fullmatch(scope):
                    err(f"kb.scopes entry {scope!r} must match [a-z0-9-]+")
        if not isinstance(kb.get("default_groups"), dict):
            err("kb.default_groups must be an object")
        text("kb.status_column", kb.get("status_column"))

    competency = section("competency", dict)
    if competency is not None and not isinstance(competency.get("markers"), dict):
        err("competency.markers must be an object")

    grant_names: set[str] = set()
    grants = section("grants", list)
    if grants is not None:
        for i, grant in enumerate(grants):
            if not isinstance(grant, dict):
                err(f"grants[{i}] must be an object")
                continue
            name = grant.get("name")
            if text(f"grants[{i}].name", name):
                if name in grant_names:
                    err(f"grants[{i}].name '{name}' is declared twice")
                grant_names.add(name)
            minutes = grant.get("max_minutes")
            if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes <= 0:
                err(f"grants[{i}].max_minutes must be a positive integer")

    rules = section("guard_rules", list)
    if rules is not None:
        for i, rule in enumerate(rules):
            where = f"guard_rules[{i}]"
            if not isinstance(rule, dict):
                err(f"{where} must be an object")
                continue
            pattern = rule.get("match")
            if not isinstance(pattern, str) or not pattern:
                err(f"{where}.match must be a non-empty regex string")
            else:
                try:
                    re.compile(pattern)
                except re.error as exc:
                    err(f"{where}.match is not a valid regex ({exc}): {pattern!r}")
            action = rule.get("action")
            if action not in GUARD_ACTIONS:
                err(f"{where}.action {action!r} is invalid, use one of {list(GUARD_ACTIONS)}")
            if action == "deny-without-grant":
                grant = rule.get("grant")
                if not isinstance(grant, str) or not grant:
                    err(f"{where}.grant is required for deny-without-grant")
                elif grant not in grant_names:
                    err(f"{where}.grant '{grant}' is not a declared grant")
            if "reason" in rule and not isinstance(rule["reason"], str):
                err(f"{where}.reason must be a string")

    agents = section("agents", dict)
    if agents is not None:
        tiers = agents.get("tiers")
        tier_names: set[str] = set()
        if not isinstance(tiers, dict) or not tiers:
            err("agents.tiers must be a non-empty object")
        else:
            for tier, spec in tiers.items():
                if not isinstance(spec, dict):
                    err(f"agents.tiers.{tier} must be an object")
                    continue
                tier_names.add(tier)
                for key in ("claude", "codex", "codex_effort"):
                    text(f"agents.tiers.{tier}.{key}", spec.get(key))
        assign = agents.get("assign")
        if not isinstance(assign, dict):
            err("agents.assign must be an object")
        else:
            for agent, tier in assign.items():
                if tier not in tier_names:
                    err(f"agents.assign.{agent} uses unknown tier {tier!r}, declared: {sorted(tier_names)}")

    harnesses = section("harnesses", dict)
    if harnesses is not None:
        for name, flag in harnesses.items():
            if not isinstance(flag, bool):
                err(f"harnesses.{name} must be true or false")

    plugins = section("plugins", list)
    if plugins is not None:
        for i, plugin in enumerate(plugins):
            if not isinstance(plugin, str) or not plugin.strip():
                err(f"plugins[{i}] must be a non-empty relative path string")
            elif _is_absolute(plugin):
                err(f"plugins[{i}] must be a relative path, got '{plugin}'")

    return problems


def errors_only(problems: list[str]) -> list[str]:
    return [p for p in problems if not p.startswith("warning:")]


def _kind_name(kind: type) -> str:
    return {dict: "an object", list: "a list"}.get(kind, kind.__name__)
