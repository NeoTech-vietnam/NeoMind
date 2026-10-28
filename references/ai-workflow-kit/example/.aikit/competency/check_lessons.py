"""Check the lesson files in <competency>/lessons/ against the map and the code.

    python .aikit/competency/check_lessons.py          # all lessons
    python .aikit/competency/check_lessons.py ID ...   # some

Checks: the file belongs to a map item and its title line starts with the ID; every numbered section is present; at
least three exercises with the tiers from `competency.markers.lesson.tiers`, each with the hint and solution lines
from `markers.lesson.hints`; every `path:line` reference names a real file (path from a repo root of `repos` in
kit.json, or a bare file name unique among the repos not marked `"index": false`) with at least that many lines.
Run again after the code moves to see which lessons need a look. Standard library only.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compkit  # noqa: E402
import ids  # noqa: E402

SKIP_DIRS = {".git", "build", "node_modules", "__pycache__", ".venv"}
EXTRA_NAMES = ["Makefile", r"Kconfig[\w.]*"]


def ref_regex(extensions: list) -> re.Pattern:
    exts = "|".join(re.escape(e) for e in extensions)
    names = "|".join(EXTRA_NAMES + [rf"\.(?:{exts})"])
    return re.compile(rf"`([\w./\\-]*(?:{names})):(\d+)")


def heading_regex(heading: str) -> re.Pattern:
    prefix, _, suffix = heading.partition("{n}")
    return re.compile(rf"^{re.escape(prefix)}\d+{re.escape(suffix)}", re.M)


def basename_index(repos: list) -> dict:
    idx: dict = {}
    for repo in repos:
        if not repo["index"]:
            continue
        for dirpath, dirs, files in os.walk(repo["root"]):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                idx.setdefault(f, []).append(Path(dirpath) / f)
    return idx


def resolve(path: str, idx: dict, roots: list):
    p = path.replace("\\", "/")
    for root in roots:
        cand = root / p
        if cand.is_file():
            return cand, None
    if "/" not in p:
        hits = idx.get(p, [])
        if len(hits) == 1:
            return hits[0], None
        return None, ("not found" if not hits else f"ambiguous ({len(hits)} files)")
    # a path relative to some sub-directory: accept a unique suffix match
    hits = [h for h in idx.get(Path(p).name, []) if h.as_posix().endswith("/" + p)]
    if len(hits) == 1:
        return hits[0], None
    return None, "not found" if not hits else f"ambiguous ({len(hits)} files)"


def line_count(path: Path, cache: dict) -> int:
    if path not in cache:
        with open(path, "rb") as fh:
            cache[path] = sum(1 for _ in fh)
    return cache[path]


def check(path: Path, item_ids: set, idx: dict, roots: list, cache: dict, lesson: dict) -> list:
    errs = []
    lid = path.stem
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if lid not in item_ids:
        errs.append("not an item in map.json")
    if not lines or not lines[0].startswith(f"# {lid} "):
        errs.append("title line must start with '# <ID> '")
    for n in range(1, int(lesson["sections"]) + 1):
        if not re.search(rf"^## {n}\. ", text, re.M):
            errs.append(f"section {n} missing")
    parts = heading_regex(lesson["exercise_heading"]).split(text)[1:]
    tiers = [p.split(":", 1)[0].strip() for p in parts]
    for t in lesson["tiers"]:
        if t not in tiers:
            errs.append(f"no exercise with tier '{t}'")
    for k, p in enumerate(parts, 1):
        body = re.split(r"^## ", p, flags=re.M)[0]
        for need in lesson["hints"]:
            if f"<summary>{need}" not in body:
                errs.append(f"exercise {k}: no '{need}'")
    for m in ref_regex(lesson["ref_extensions"]).finditer(text):
        f, ln = m.group(1), int(m.group(2))
        hit, why = resolve(f, idx, roots)
        if hit is None:
            errs.append(f"ref `{f}:{ln}`: {why}")
        elif ln > line_count(hit, cache):
            errs.append(f"ref `{f}:{ln}`: file has {line_count(hit, cache)} lines")
    return errs


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    try:
        ctx = compkit.load_context()
    except compkit.ConfigError as exc:
        return compkit.die(str(exc))
    try:
        m = compkit.read_json(ctx.comp / "map.json")
        item_ids = {it["id"] for it in m["items"]}
        want = set(argv)
        files = sorted(p for p in (ctx.comp / "lessons").glob("*.md") if not p.name.startswith("_")
                       and (not want or p.stem in want))
        repos = ctx.repos()
        roots = [r["root"] for r in repos]
        idx, cache, bad = basename_index(repos), {}, 0
        lesson = ctx.markers["lesson"]
        for f in files:
            errs = check(f, item_ids, idx, roots, cache, lesson)
            bad += bool(errs)
            print(f"{'FAIL' if errs else 'ok  '} {f.stem}")
            for e in errs:
                print(f"     {e}")
        if not want:
            missing = sorted(item_ids - {f.stem for f in files})
            print(f"{len(files)} lessons, {bad} with problems; {len(missing)} items without a lesson"
                  + (f": {', '.join(missing)}" if missing else ""))
        return 1 if bad else 0
    finally:
        ids.flush_warning()


if __name__ == "__main__":
    sys.exit(main())
