"""Rewrite legacy ids in the competency files to the English ids.

    python .aikit/competency/migrate_ids.py --check [--root DIR]     # list every change; exit 1 if there is any
    python .aikit/competency/migrate_ids.py --write [--root DIR]     # apply the changes and report counts

DIR is the competency folder (default: `paths.competency` of kit.json). Files and fields:

- map.json: `kinds` (keys), item `kind`, and `levels` (list of level ids) when present;
- people/*.json: record `level`, `self`, and each evidence entry's `level` and `support`;
- people/*/gates.jsonl: `support`.

Key order, all other content, UTF-8 (no escaping), the indentation, line endings and the final newline of each file
are kept. A file whose layout cannot be reproduced exactly is reported and left alone (exit 2).
Exit codes: 0 nothing to change, or changes written; 1 `--check` found changes; 2 error.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compkit  # noqa: E402
import ids  # noqa: E402

INDENT_RE = re.compile(r"^([ \t]+)\S", re.M)


class LayoutError(Exception):
    pass


class Changes:
    def __init__(self):
        self.items: list[tuple[str, str]] = []  # (where, "old -> new")

    def convert(self, where: str, category: str, value):
        """English id for value; records the change when it differs."""
        new = ids.LEGACY[category].get(value) if isinstance(value, str) else None
        if new is None or new == value:
            return value
        self.items.append((where, f"'{value}' -> '{new}'"))
        return new

    def __len__(self):
        return len(self.items)


# --- file layout -----------------------------------------------------------------------------------------


class Layout:
    """How a JSON file is written: BOM, line ending, indent, final newline."""

    def __init__(self, text: str):
        self.bom = text.startswith("﻿")
        body = text[1:] if self.bom else text
        self.crlf = "\r\n" in body
        body = body.replace("\r\n", "\n")
        self.final_newline = body.endswith("\n")
        found = INDENT_RE.search(body)
        self.indent = found.group(1) if found else None
        self.body = body

    def dump(self, data) -> str:
        text = json.dumps(data, ensure_ascii=False, indent=self.indent)
        if self.final_newline:
            text += "\n"
        if self.crlf:
            text = text.replace("\n", "\r\n")
        return ("﻿" if self.bom else "") + text


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def write_text(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def load_json_file(path: Path):
    """(data, layout, original text); raises LayoutError when json.dumps cannot reproduce the file."""
    text = read_text(path)
    try:
        data = json.loads(text.lstrip("﻿"))
    except json.JSONDecodeError as exc:
        raise LayoutError(f"{path}: not valid JSON ({exc})") from exc
    layout = Layout(text)
    if layout.dump(data) != text:
        raise LayoutError(f"{path}: layout cannot be reproduced exactly; migrate it by hand")
    return data, layout, text


# --- what to migrate -------------------------------------------------------------------------------------


def migrate_map(data: dict, ch: Changes, name: str) -> dict:
    if isinstance(data.get("kinds"), dict):
        data["kinds"] = {ch.convert(f"{name}: kinds", "kind", k): v for k, v in data["kinds"].items()}
    if isinstance(data.get("levels"), list):
        data["levels"] = [ch.convert(f"{name}: levels", "level", v) for v in data["levels"]]
    for it in data.get("items", []):
        if isinstance(it, dict) and "kind" in it:
            it["kind"] = ch.convert(f"{name}: item {it.get('id', '?')} kind", "kind", it["kind"])
    return data


def migrate_person(data: dict, ch: Changes, name: str) -> dict:
    for iid, rec in (data.get("records") or {}).items():
        if not isinstance(rec, dict):
            continue
        for key in ("level", "self"):
            if key in rec:
                rec[key] = ch.convert(f"{name}: {iid} {key}", "level", rec[key])
        for n, ev in enumerate(rec.get("evidence") or [], 1):
            if isinstance(ev, dict):
                if "level" in ev:
                    ev["level"] = ch.convert(f"{name}: {iid} evidence {n} level", "level", ev["level"])
                if "support" in ev:
                    ev["support"] = ch.convert(f"{name}: {iid} evidence {n} support", "support", ev["support"])
    return data


def plan(root: Path):
    """(list of (path, new_text), Changes, errors) for every file under root that needs a change."""
    ch, errors, writes = Changes(), [], []

    def one(path: Path, migrate, label: str):
        before = len(ch)
        try:
            data, layout, text = load_json_file(path)
        except LayoutError as exc:
            errors.append(str(exc))
            return
        data = migrate(data, ch, label)
        if len(ch) != before:
            writes.append((path, layout.dump(data)))

    map_path = root / "map.json"
    if map_path.is_file():
        one(map_path, migrate_map, "map.json")
    for path in sorted((root / "people").glob("*.json")):
        one(path, migrate_person, f"people/{path.name}")
    for path in sorted((root / "people").glob("*/gates.jsonl")):
        rel = path.relative_to(root).as_posix()
        before = len(ch)
        lines, out = read_text(path).splitlines(keepends=True), []
        failed = False
        for n, raw in enumerate(lines, 1):
            body = raw.rstrip("\r\n")
            if not body.strip():
                out.append(raw)
                continue
            try:
                rec = json.loads(body)
            except json.JSONDecodeError as exc:
                errors.append(f"{rel}: line {n} is not valid JSON ({exc})")
                failed = True
                break
            if json.dumps(rec, ensure_ascii=False) != body:
                errors.append(f"{rel}: line {n} layout cannot be reproduced exactly; migrate it by hand")
                failed = True
                break
            if isinstance(rec, dict) and "support" in rec:
                rec["support"] = ch.convert(f"{rel}: line {n} support", "support", rec["support"])
            out.append(json.dumps(rec, ensure_ascii=False) + raw[len(body):])
        if not failed and len(ch) != before:
            writes.append((path, "".join(out)))
    return writes, ch, errors


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="list every change; exit 1 if there is any")
    mode.add_argument("--write", action="store_true", help="apply the changes")
    ap.add_argument("--root", default=None, help="competency folder (default: paths.competency of kit.json)")
    a = ap.parse_args(argv)
    if a.root:
        root = Path(a.root)
    else:
        try:
            root = compkit.load_context().comp
        except compkit.ConfigError as exc:
            return compkit.die(f"{exc}; pass --root")
    if not root.is_dir():
        return compkit.die(f"{root} is not a folder")

    writes, ch, errors = plan(root)
    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    for where, what in ch.items:
        print(f"{where}: {what}")
    if errors:
        return 2
    if a.check:
        print(f"check: {len(ch)} legacy ids in {len(writes)} files" if len(ch) else "check: no legacy ids")
        return 1 if len(ch) else 0
    for path, text in writes:
        write_text(path, text)
    print(f"wrote {len(writes)} files, {len(ch)} ids changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
