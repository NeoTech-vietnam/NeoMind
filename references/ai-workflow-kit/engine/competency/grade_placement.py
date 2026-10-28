"""Placement test for the learning map: start a sheet, check the test, grade a sheet, record levels.

    python .aikit/competency/grade_placement.py --check                # test covers every map item once
    python .aikit/competency/grade_placement.py --new NAME             # copy the test to people/NAME/<sheet>
    python .aikit/competency/grade_placement.py --person NAME          # grade, print the proposal (Markdown)
    python .aikit/competency/grade_placement.py --person NAME --record --date 2026-10-24

Rules: part A answer right and not marked "?" -> level "aware"; that plus a part B question on the item graded
"right" -> "understand". Wrong, "E", "?" or blank -> no level; the item goes on the study list. Part B is graded by
the AI, which writes the grade marker (`competency.markers.placement.grade`) under the answer. --record only after
the person confirms the proposal; it never lowers an existing level. File names, markers and report text come from
`competency.markers.placement` and `strings/<ui_lang>.json`. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compkit  # noqa: E402
import ids  # noqa: E402

HEAD = re.compile(r"^### (B?\d+) · (.+)$")
ROW = re.compile(r"^\| (B?\d+) \| (\S+) \| ([^|]+) \|")
UNASSESSED = ids.LEVELS[0]
AWARE = ids.LEVELS[1]
UNDERSTAND = ids.LEVELS[2]


class Placement:
    """The placement test of one project: its files and markers."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.pm = ctx.markers["placement"]
        self.folder = ctx.comp / self.pm["folder"]
        self.test = self.folder / self.pm["test"]
        self.key = self.folder / self.pm["key"]
        self.ans = re.compile(r"^" + re.escape(self.pm["answer"]) + r"\s*(.*)$")
        grades = "|".join(re.escape(v) for v in self.pm["grade_values"].values())
        self.mark = re.compile(r"^" + re.escape(self.pm["grade"]) + rf"\s*({grades})", re.I)
        self.right = self.pm["grade_values"]["right"]

    def sheet_path(self, person: str) -> Path:
        return self.ctx.comp / "people" / person / self.pm["sheet"]

    def load_map(self) -> list:
        return compkit.read_json(self.ctx.comp / "map.json")["items"]

    def load_key(self) -> dict:
        key = {}
        for line in self.key.read_text(encoding="utf-8").splitlines():
            m = ROW.match(line)
            if m:
                key[m.group(1)] = {"answer": m.group(2), "items": [s.strip() for s in m.group(3).split(",")]}
        return key

    def load_sheet(self, path: Path) -> dict:
        out, cur = {}, None
        for line in path.read_text(encoding="utf-8").splitlines():
            m = HEAD.match(line)
            if m:
                cur = m.group(1)
                out[cur] = {"items": [s.strip() for s in m.group(2).split(",")], "answer": "", "mark": ""}
                continue
            if cur is None:
                continue
            m = self.ans.match(line)
            if m:
                out[cur]["answer"] = m.group(1).strip()
                continue
            m = self.mark.match(line)
            if m:
                out[cur]["mark"] = m.group(1).lower()
        return out

    def check(self) -> int:
        tname = self.test.name
        items = {i["id"] for i in self.load_map()}
        key, test = self.load_key(), self.load_sheet(self.test)
        probs = []
        a_items = [k["items"][0] for q, k in key.items() if not q.startswith("B")]
        for i in sorted(items):
            n = a_items.count(i)
            if n != 1:
                probs.append(f"{i}: {n} part A questions (want 1)")
        for q, k in key.items():
            for i in k["items"]:
                if i not in items:
                    probs.append(f"{q}: unknown item {i}")
            if q not in test:
                probs.append(f"{q}: in the key, not in {tname}")
            elif test[q]["items"] != k["items"]:
                probs.append(f"{q}: items differ, {tname} {test[q]['items']} vs key {k['items']}")
            if not q.startswith("B") and k["answer"] not in "ABCD":
                probs.append(f"{q}: answer {k['answer']!r} not A-D")
        for q in test:
            if q not in key:
                probs.append(f"{q}: in {tname}, not in the key")
        print(f"{len(key)} questions, {len(items)} map items, {len(probs)} problems")
        for p in probs:
            print("  " + p)
        return 1 if probs else 0

    def grade(self, person: str):
        sheet_path = self.sheet_path(person)
        if not sheet_path.is_file():
            sys.exit(f"no sheet {sheet_path}; start one with --new {person}")
        S = self.ctx.strings
        items = self.load_map()
        key, sheet = self.load_key(), self.load_sheet(sheet_path)
        res = {i["id"]: {"item": i, "q": None, "given": "", "ok": False, "b": [], "level": UNASSESSED}
               for i in items}
        for q, k in key.items():
            s = sheet.get(q, {"answer": "", "mark": ""})
            if q.startswith("B"):
                for i in k["items"]:
                    res[i]["b"].append((q, s["mark"] or S["p_ungraded"] if s["answer"] else S["p_blank_answer"]))
                continue
            r = res[k["items"][0]]
            given = s["answer"].upper().replace(" ", "")
            r.update(q=q, given=given, ok=(given == k["answer"]))
        for r in res.values():
            if r["ok"]:
                r["level"] = UNDERSTAND if any(m == self.right for _, m in r["b"]) else AWARE
        return res, sheet_path

    def report(self, person: str, res: dict, sheet_path: Path) -> None:
        S = self.ctx.strings
        rows = list(res.values())
        blank = sum(1 for r in rows if not r["given"])
        print(f"# {S['p_title'].format(person=person)}\n")
        extra = S["p_blank"].format(n=blank) if blank else ""
        print(S["p_summary"].format(sheet=sheet_path.relative_to(self.ctx.comp).as_posix(),
                                    ok=sum(r["ok"] for r in rows), n=len(rows), blank=extra) + "\n")
        print(table_head(S["p_area_cols"]))
        areas: dict = {}
        for r in rows:
            areas.setdefault(r["item"]["area"], []).append(r)
        for area, rs in areas.items():
            miss = ", ".join(r["item"]["id"] for r in rs if not r["ok"]) or "—"
            print(f"| {area} | {sum(r['ok'] for r in rs)}/{len(rs)} | {miss} |")
        print("\n" + table_head(S["p_item_cols"]))
        for r in rows:
            b = "; ".join(f"{q} {m}" for q, m in r["b"]) or "—"
            mark = S["p_right"] if r["ok"] else (r["given"] or S["p_blank_answer"])
            print(f"| {r['item']['id']} | {r['q']} | {mark} | {b} | {r['level']} |")
        study = sorted((r for r in rows if not r["ok"]), key=lambda r: (r["item"]["priority"], r["item"]["id"]))
        print(f"\n## {S['p_study_heading']}\n")
        for r in study:
            print(S["p_study_item"].format(id=r["item"]["id"], priority=r["item"]["priority"], title=r["item"]["title"]))

    def record(self, person: str, res: dict, day: dt.date) -> None:
        S = self.ctx.strings
        path = self.ctx.comp / "people" / f"{person}.json"
        data = compkit.read_json(path)
        recs = data.setdefault("records", {})
        n = 0
        for iid, r in res.items():
            if r["level"] == UNASSESSED:
                continue
            rec = recs.setdefault(iid, {})
            if ids.level_index(rec.get("level", UNASSESSED)) > ids.level_index(r["level"]):
                continue
            parts = ", ".join([S["p_question"].format(q=r["q"])] + [q for q, m in r["b"] if m == self.right])
            rec["level"] = r["level"]
            rec.setdefault("evidence", []).append(
                {"date": day.isoformat(), "exercise": S["p_exercise"].format(parts=parts),
                 "support": ids.SUPPORT[0], "level": r["level"]})
            rec.setdefault("review_after", (day + dt.timedelta(days=14)).isoformat())
            n += 1
        compkit.write_json(path, data)
        print(f"recorded {n} items in {path.relative_to(self.ctx.comp)}")


def table_head(cols: list) -> str:
    return "| " + " | ".join(cols) + " |\n" + "| " + " | ".join("---" for _ in cols) + " |"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--person", default=None, help="default: people.default of kit.json")
    ap.add_argument("--new", metavar="PERSON", help="start a sheet for PERSON from the test file")
    ap.add_argument("--check", action="store_true", help="check the test and key against the map")
    ap.add_argument("--record", action="store_true", help="write the proposed levels into people/<person>.json")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    a = ap.parse_args(argv)
    try:
        ctx = compkit.load_context()
    except compkit.ConfigError as exc:
        return compkit.die(str(exc))
    pl = Placement(ctx)
    person = a.person or ctx.person
    needed = [pl.test] if a.new else [pl.test, pl.key] if a.check else [pl.key]
    missing = [p for p in needed if not p.is_file()]
    if missing:
        return compkit.die("no placement test: " + ", ".join(str(p) for p in missing))
    try:
        if a.check:
            return pl.check()
        if a.new:
            dst = pl.sheet_path(a.new)
            if dst.exists():
                sys.exit(f"{dst} exists; not overwritten")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pl.test, dst)
            print(f"wrote {dst}")
            return 0
        res, sheet_path = pl.grade(person)
        if a.record:
            pl.record(person, res, dt.date.fromisoformat(a.date))
        else:
            pl.report(person, res, sheet_path)
        return 0
    finally:
        ids.flush_warning()


if __name__ == "__main__":
    sys.exit(main())
