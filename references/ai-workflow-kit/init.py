#!/usr/bin/env python3
"""Install, upgrade and check the AI workflow kit in a project.

    python init.py init    --target DIR --name NAME --owner OWNER [--lang en|vi] [--harness claude,codex,antigravity]
    python init.py upgrade --target DIR [--force]
    python init.py check   --target DIR
    python init.py harness --target DIR

Python 3.10+, standard library only. See README.md for exit codes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(KIT_ROOT))

from engine import config  # noqa: E402

ENGINE_SRC = KIT_ROOT / "engine"
TEMPLATE_SRC = KIT_ROOT / "template"
MANIFEST_NAME = "manifest.json"
DEFAULT_ENGINE_DIR = ".aikit"
TEXT_SUFFIXES = {".md", ".json", ".toml", ".txt", ".yml", ".yaml"}
HARNESSES = ("claude", "codex", "antigravity")
DEFAULT_HARNESSES = "claude,codex"
VENDORED_FILE = ".claude/skills/VENDORED.json"
VENDORED_DIR = ".claude/skills"

EXIT_OK = 0
EXIT_CHECK_FAILED = 1
EXIT_REFUSED = 2
EXIT_LOCAL_EDITS = 3


class ManifestError(Exception):
    pass


def kit_version() -> str:
    return (KIT_ROOT / "VERSION").read_text(encoding="utf-8").strip()


# --- file helpers ---------------------------------------------------------------------------------


def _skip(path: Path) -> bool:
    return "__pycache__" in path.parts or path.suffix == ".pyc"


def list_files(root: Path) -> list[str]:
    """Relative POSIX paths of all files under root, sorted. Bytecode caches are ignored."""
    if not root.is_dir():
        return []
    return sorted(
        p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and not _skip(p.relative_to(root))
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- engine and manifest --------------------------------------------------------------------------


def install_engine(dest: Path) -> dict:
    """Copy the engine to dest and write dest/manifest.json. Returns the manifest."""
    if dest.exists():
        raise FileExistsError(str(dest))
    shutil.copytree(ENGINE_SRC, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    manifest = {
        "kit_version": kit_version(),
        "files": {rel: sha256(dest / rel) for rel in list_files(dest) if rel != MANIFEST_NAME},
    }
    (dest / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def read_manifest(engine_dir: Path) -> dict:
    path = engine_dir / MANIFEST_NAME
    if not path.is_file():
        raise ManifestError(f"{path} not found")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"{path} cannot be read: {exc}") from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict):
        raise ManifestError(f"{path} has no 'files' table")
    return manifest


def diff_engine(engine_dir: Path, manifest: dict) -> tuple[list[str], list[str], list[str]]:
    """Return (changed, missing, extra) engine files compared with the manifest."""
    recorded: dict = manifest["files"]
    present = set(list_files(engine_dir)) - {MANIFEST_NAME}
    changed = sorted(rel for rel, digest in recorded.items() if rel in present and sha256(engine_dir / rel) != digest)
    missing = sorted(set(recorded) - present)
    extra = sorted(present - set(recorded))
    return changed, missing, extra


def _engine_dir(cfg: dict) -> Path:
    return cfg["paths"]["engine"]


# --- template rendering ---------------------------------------------------------------------------

PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def render(text: str, values: dict[str, str], as_json: bool) -> str:
    def sub(match: re.Match) -> str:
        key = match.group(1)
        if key not in values:
            return match.group(0)
        value = values[key]
        return json.dumps(value, ensure_ascii=False)[1:-1] if as_json else value

    return PLACEHOLDER.sub(sub, text)


def vendored_skills(template: Path = TEMPLATE_SRC) -> set[str]:
    """Names of the skills copied from other authors, as listed in the template's VENDORED.json."""
    path = template / VENDORED_FILE
    if not path.is_file():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(entry["name"]) for entry in data.get("skills", [])}


def is_vendored(rel: str, names: set[str]) -> bool:
    """True for VENDORED.json and every file inside a vendored skill folder. These are copied byte for byte."""
    if rel == VENDORED_FILE:
        return True
    parts = rel.split("/")
    prefix = VENDORED_DIR.split("/")
    return parts[: len(prefix)] == prefix and len(parts) > len(prefix) + 1 and parts[len(prefix)] in names


def parse_harnesses(text: str) -> dict[str, bool]:
    chosen = [part.strip().lower() for part in text.split(",") if part.strip()]
    unknown = [name for name in chosen if name not in HARNESSES]
    if unknown:
        raise ValueError(f"unknown harness {unknown}, use any of {list(HARNESSES)}")
    return {name: name in chosen for name in HARNESSES}


# --- harness configs (hooks for Claude, Codex, Antigravity) ---------------------------------------

# (event, matcher, hook scripts). A matcher of None means the event has no matcher.
CLAUDE_HOOKS = (
    ("SessionStart", None, ("kb_guard", "kb_context")),
    ("PreToolUse", "Bash", ("action_guard",)),
    ("PreToolUse", "Edit|Write|MultiEdit", ("action_guard", "kb_guard", "kb_context")),
    ("PostToolUse", "Edit|Write|MultiEdit", ("kb_guard",)),
    ("PostToolUse", "Bash", ("kb_context",)),
    ("Stop", None, ("kb_context",)),
)
CODEX_HOOKS = (
    ("SessionStart", None, ("kb_guard", "kb_context")),
    ("PreToolUse", "Bash", ("action_guard",)),
    ("PreToolUse", "apply_patch|Edit|Write", ("action_guard", "kb_guard", "kb_context")),
    ("PostToolUse", "apply_patch|Edit|Write", ("kb_guard",)),
    ("PostToolUse", "Bash", ("kb_context",)),
    ("Stop", None, ("kb_context",)),
)
ANTIGRAVITY_BLOCK = "aikit-guards"
ANTIGRAVITY_MATCHERS = ("run_command", "replace_file_content", "write_to_file")
HOOK_SCRIPTS = ("hook_paths", "kb_guard", "kb_context", "action_guard", "grant", "antigravity")


def _json_text(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _is_kit_hook(entry: object, marker: str) -> bool:
    return isinstance(entry, dict) and marker in str(entry.get("command", "")).replace("\\", "/")


def merge_hook_groups(existing: dict, wanted: tuple, command_of, marker: str) -> dict:
    """Return `existing` (a settings or hooks.json dict) with the kit's hook entries replaced.

    Entries whose command contains `marker` are removed (a group left empty is dropped), then the kit groups are
    appended to each event. Everything else is kept in place, so a second run gives the same result.
    """
    out = json.loads(json.dumps(existing))
    hooks = out.get("hooks")
    if not isinstance(hooks, dict):
        hooks = out["hooks"] = {}
    emptied = set()
    for event, groups in list(hooks.items()):
        if not isinstance(groups, list):
            continue
        kept = []
        for group in groups:
            if isinstance(group, dict) and isinstance(group.get("hooks"), list):
                rest = [h for h in group["hooks"] if not _is_kit_hook(h, marker)]
                if not rest:
                    continue
                group = {**group, "hooks": rest}
            kept.append(group)
        hooks[event] = kept
        if groups and not kept:
            emptied.add(event)
    for event, matcher, scripts in wanted:
        group: dict = {} if matcher is None else {"matcher": matcher}
        group["hooks"] = [{"type": "command", "command": command_of(s)} for s in scripts]
        hooks.setdefault(event, []).append(group)
    for event in [e for e in emptied if hooks.get(e) == []]:
        del hooks[event]
    return out


def claude_settings(existing: dict, engine: str) -> dict:
    marker = f"/{engine}/hooks/"
    out = merge_hook_groups(
        existing, CLAUDE_HOOKS, lambda s: f'python "$CLAUDE_PROJECT_DIR/{engine}/hooks/{s}.py"', marker
    )
    protected = [".claude/grants/**", f"{engine}/hooks/grant.py", f"{engine}/hooks/action_guard.py"]
    perms = out.get("permissions")
    if not isinstance(perms, dict):
        perms = out["permissions"] = {}
    deny = perms.get("deny")
    if not isinstance(deny, list):
        deny = perms["deny"] = []
    for path in protected:
        for tool in ("Edit", "Write"):
            rule = f"{tool}({path})"
            if rule not in deny:
                deny.append(rule)
    return out


def codex_hooks(existing: dict, engine: str, root: Path) -> dict:
    base = f"{root.as_posix()}/{engine}/hooks"
    return merge_hook_groups(existing, CODEX_HOOKS, lambda s: f"python {base}/{s}.py --codex", f"/{engine}/hooks/")


def antigravity_hooks(existing: dict, engine: str, root: Path) -> dict:
    command = f"python {root.as_posix()}/{engine}/hooks/antigravity.py"
    out = json.loads(json.dumps(existing))
    out[ANTIGRAVITY_BLOCK] = {
        "enabled": True,
        "PreToolUse": [
            {"matcher": m, "hooks": [{"type": "command", "command": command, "timeout": 15}]}
            for m in ANTIGRAVITY_MATCHERS
        ],
    }
    return out


def _read_json_object(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path} is not valid JSON ({exc}); fix or move it, then run harness again") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top level must be a JSON object")
    return data


def cmd_harness(args: argparse.Namespace) -> int:
    return run_harness(Path(args.target).absolute())


def run_harness(target: Path) -> int:
    try:
        cfg = config.load(target)
    except config.ConfigError as exc:
        print(f"error: {exc}")
        return EXIT_REFUSED
    engine = cfg["paths_raw"]["engine"].replace("\\", "/").strip("/")
    missing = [s for s in HOOK_SCRIPTS if not (cfg["paths"]["engine"] / "hooks" / f"{s}.py").is_file()]
    if missing:
        print(f"error: {engine}/hooks is missing {', '.join(m + '.py' for m in missing)}; run 'init' or 'upgrade' first")
        return EXIT_REFUSED
    flags = cfg["harnesses"]
    root = Path(cfg["project_root"])
    jobs = []  # (relative path, builder)
    if flags.get("claude"):
        jobs.append((".claude/settings.json", lambda ex: claude_settings(ex, engine)))
    if flags.get("codex"):
        jobs.append((".codex/hooks.json", lambda ex: codex_hooks(ex, engine, root)))
    if flags.get("antigravity"):
        jobs.append((".agents/hooks.json", lambda ex: antigravity_hooks(ex, engine, root)))

    plan = []
    try:
        for rel, build in jobs:
            path = root / rel
            existing = _read_json_object(path)
            wanted = build(existing)
            plan.append((rel, path, path.is_file(), existing != wanted, wanted))
    except ValueError as exc:
        print(f"error: {exc}")
        return EXIT_REFUSED

    codex_changed = False
    for rel, path, existed, differs, wanted in plan:
        if not differs:
            print(f"unchanged: {rel}")
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_json_text(wanted).encode("utf-8"))
        print(f"{'changed' if existed else 'created'}: {rel}")
        codex_changed = codex_changed or rel == ".codex/hooks.json"
    if not jobs:
        print("harness: no harness is enabled in kit.json harnesses")
    if " " in root.as_posix() and flags.get("codex"):
        print("warning: the project path contains a space; Codex runs hook commands without quotes, so they will fail")
    if codex_changed:
        print("Codex: re-trust the hooks now. Open Codex, type /hooks and approve the changed hooks "
              "(Codex trusts each hook by a hash of its command).")
    return EXIT_OK


# --- commands -------------------------------------------------------------------------------------


def cmd_init(args: argparse.Namespace) -> int:
    name, owner = args.name.strip(), args.owner.strip()
    owner_id = config.owner_slug(owner)
    if not name or not owner or not owner_id:
        print("error: --name and --owner must not be empty and --owner needs at least one letter or digit")
        return EXIT_REFUSED
    try:
        harnesses = parse_harnesses(args.harness)
    except ValueError as exc:
        print(f"error: {exc}")
        return EXIT_REFUSED

    target = Path(args.target).absolute()
    if target.exists() and not target.is_dir():
        print(f"error: {target} is not a folder")
        return EXIT_REFUSED

    # Where the engine goes: the existing kit.json decides, else the default.
    engine_rel = DEFAULT_ENGINE_DIR
    if (target / config.CONFIG_NAME).is_file():
        try:
            engine_rel = config.load(target)["paths_raw"]["engine"]
        except config.ConfigError as exc:
            print(f"error: existing kit.json is unusable: {exc}")
            return EXIT_REFUSED
    engine_dir = target / engine_rel
    engine_installed = (engine_dir / MANIFEST_NAME).is_file()
    if engine_dir.exists() and not engine_installed:
        print(f"error: {engine_dir} exists but has no {MANIFEST_NAME}; move it away or fix it by hand")
        return EXIT_REFUSED

    values = {
        "project_name": name,
        "owner": owner,
        "owner_id": owner_id,
        "lang": args.lang,
        "project_root": target.resolve().as_posix(),
    }
    created: list[str] = []
    skipped: list[str] = []
    target.mkdir(parents=True, exist_ok=True)
    vendored = vendored_skills()

    for rel in list_files(TEMPLATE_SRC):
        dest = target / rel
        if dest.exists():
            skipped.append(rel)
            continue
        src = TEMPLATE_SRC / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Vendored skills keep their exact bytes: no placeholder rendering (some hold GitHub Actions `${{ ... }}`).
        if src.suffix.lower() in TEXT_SUFFIXES and not is_vendored(rel, vendored):
            text = render(src.read_text(encoding="utf-8"), values, as_json=src.suffix.lower() == ".json")
            if rel == config.CONFIG_NAME:
                data = json.loads(text)
                data["harnesses"] = harnesses
                text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
            dest.write_bytes(text.encode("utf-8"))
        else:
            dest.write_bytes(src.read_bytes())
        created.append(rel)

    try:
        cfg = config.load(target)
    except config.ConfigError as exc:
        print(f"error: kit.json is unusable: {exc}")
        return EXIT_REFUSED

    if engine_installed:
        engine_note = f"engine: already installed (version {read_manifest(engine_dir).get('kit_version')}); use 'upgrade' to replace it"
    else:
        install_engine(_engine_dir(cfg))
        engine_note = f"engine: installed version {kit_version()} in {engine_rel}"
        created.append(f"{engine_rel}/")

    for folder in cfg["paths"].values():
        folder.mkdir(parents=True, exist_ok=True)

    # An empty learning-map record for the default person. Its file name holds the person id, so it is made here
    # and not copied from template/.
    person_file = cfg["paths"]["competency"] / "people" / f"{cfg['people']['default']}.json"
    if not person_file.exists():
        person_file.parent.mkdir(parents=True, exist_ok=True)
        record = {"schema": 1, "person": cfg["project"]["owner"], "records": {}}
        person_file.write_bytes((json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
        created.append(person_file.relative_to(cfg["project_root"]).as_posix())

    for rel in created:
        print(f"created: {rel}")
    for rel in skipped:
        print(f"skipped: {rel}")
    print(engine_note)
    print(f"summary: {len(created)} created, {len(skipped)} skipped")
    return run_harness(target)


def cmd_upgrade(args: argparse.Namespace) -> int:
    target = Path(args.target).absolute()
    if not (target / config.CONFIG_NAME).is_file():
        print(f"error: {target / config.CONFIG_NAME} not found; run 'init' first")
        return EXIT_REFUSED
    try:
        cfg = config.load(target)
    except config.ConfigError as exc:
        print(f"error: {exc}")
        return EXIT_REFUSED
    engine_dir = _engine_dir(cfg)
    try:
        manifest = read_manifest(engine_dir)
    except ManifestError as exc:
        print(f"error: {exc}; run 'init' first")
        return EXIT_REFUSED

    changed, missing, extra = diff_engine(engine_dir, manifest)
    if (changed or missing or extra) and not args.force:
        print("error: the engine differs from its manifest (local edits); upgrade would overwrite them. Use --force to continue.")
        for label, items in (("changed", changed), ("missing", missing), ("extra", extra)):
            for rel in items:
                print(f"  {label}: {rel}")
        return EXIT_LOCAL_EDITS

    old_version = manifest.get("kit_version", "unknown")
    staging = engine_dir.parent / (engine_dir.name + ".new")
    if staging.exists():
        shutil.rmtree(staging)
    install_engine(staging)
    shutil.rmtree(engine_dir)
    staging.rename(engine_dir)
    print(f"engine: {old_version} -> {kit_version()}")
    return EXIT_OK


def cmd_check(args: argparse.Namespace) -> int:
    target = Path(args.target).absolute()
    errors: list[str] = []
    warnings: list[str] = []

    try:
        cfg = config.load(target)
    except config.ConfigError as exc:
        print(f"error: {exc}")
        return EXIT_CHECK_FAILED

    for problem in config.validate(cfg):
        if problem.startswith("warning:"):
            warnings.append(problem)
        else:
            errors.append(f"error: {problem}")

    engine_dir = _engine_dir(cfg)
    try:
        manifest = read_manifest(engine_dir)
    except ManifestError as exc:
        errors.append(f"error: {exc}")
    else:
        changed, missing, extra = diff_engine(engine_dir, manifest)
        errors += [f"error: engine file changed: {rel}" for rel in changed]
        errors += [f"error: engine file missing: {rel}" for rel in missing]
        errors += [f"error: engine file not in manifest: {rel}" for rel in extra]

    for name, folder in cfg["paths"].items():
        if not folder.is_dir():
            errors.append(f"error: paths.{name} folder does not exist: {cfg['paths_raw'][name]}")

    for line in errors + warnings:
        print(line)
    if errors:
        print(f"check: FAILED, {len(errors)} error(s), {len(warnings)} warning(s)")
        return EXIT_CHECK_FAILED
    print(f"check: ok, {len(warnings)} warning(s)")
    return EXIT_OK


# --- command line ---------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="init.py",
        description="Install, upgrade and check the AI workflow kit in a project.",
        epilog="Exit codes: 0 ok; 1 check found errors; 2 refused (bad input, missing kit.json or manifest); "
        "3 upgrade refused because engine files were edited locally.",
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="{init,upgrade,check,harness}")

    p_init = sub.add_parser("init", help="install the engine and copy the template files that are missing")
    p_init.add_argument("--target", required=True, help="project folder (created if missing)")
    p_init.add_argument("--name", required=True, help="project name")
    p_init.add_argument("--owner", required=True, help="owner name")
    p_init.add_argument("--lang", choices=("en", "vi"), default="en", help="interface language (default: en)")
    p_init.add_argument(
        "--harness", default=DEFAULT_HARNESSES, help=f"comma list of {', '.join(HARNESSES)} (default: {DEFAULT_HARNESSES})"
    )
    p_init.set_defaults(func=cmd_init)

    p_up = sub.add_parser("upgrade", help="replace the engine in .aikit/ with this kit's engine")
    p_up.add_argument("--target", required=True, help="project folder")
    p_up.add_argument("--force", action="store_true", help="overwrite engine files that were edited locally")
    p_up.set_defaults(func=cmd_upgrade)

    p_check = sub.add_parser("check", help="validate kit.json, the engine manifest and the paths")
    p_check.add_argument("--target", required=True, help="project folder")
    p_check.set_defaults(func=cmd_check)

    p_harness = sub.add_parser(
        "harness", help="write the hook config for each enabled harness (.claude/settings.json, .codex/hooks.json, ...)"
    )
    p_harness.add_argument("--target", required=True, help="project folder")
    p_harness.set_defaults(func=cmd_harness)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    sys.exit(main())
