"""Tests of engine/competency: the four CLIs, the id migration, the strings and the markers.

Each CLI test copies the small project in tests/fixtures/competency/project/ to a temp folder, points
AIKIT_PROJECT_ROOT at it and runs the script as a subprocess, as a user would.
"""

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent.parent
COMP_DIR = KIT_ROOT / "engine" / "competency"
FIXTURE = KIT_ROOT / "tests" / "fixtures" / "competency" / "project"
sys.path.insert(0, str(COMP_DIR))

import compkit  # noqa: E402
import gate  # noqa: E402
import ids  # noqa: E402

# Legacy ids are taken from the alias table, so this file holds no legacy literals.
LEGACY_OF = {cat: {new: old for old, new in table.items() if old != new} for cat, table in ids.LEGACY.items()}


def run_cli(script: str, root: Path, *args: str, env: dict | None = None) -> tuple[int, str, str]:
    full_env = dict(os.environ, AIKIT_PROJECT_ROOT=str(root), PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    full_env.update(env or {})
    proc = subprocess.run([sys.executable, str(COMP_DIR / script), *args], capture_output=True, text=True,
                          encoding="utf-8", env=full_env, cwd=str(root), timeout=120)
    return proc.returncode, proc.stdout, proc.stderr


def page_data(page: Path) -> dict:
    text = page.read_text(encoding="utf-8")
    start = text.index("const D=") + len("const D=")
    return json.JSONDecoder().raw_decode(text[start:])[0]


def page_strings(page: Path) -> dict:
    text = page.read_text(encoding="utf-8")
    start = text.index("S=", text.index("const D=")) + 2
    return json.JSONDecoder().raw_decode(text[start:])[0]


class ProjectCase(unittest.TestCase):
    def setUp(self):
        ids.reset()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "proj"
        shutil.copytree(FIXTURE, self.root)
        self.comp = self.root / "knowledge" / "competency"

    def read_json(self, path: Path):
        return json.loads(path.read_text(encoding="utf-8"))

    def write_json(self, path: Path, data) -> None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def set_kit(self, **changes) -> None:
        path = self.root / "kit.json"
        cfg = self.read_json(path)
        for key, value in changes.items():
            cfg = compkit.config.deep_merge(cfg, {key: value})
        self.write_json(path, cfg)

    def edit(self, rel: str, old: str, new: str) -> None:
        path = self.comp / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new), encoding="utf-8")

    def make_legacy(self) -> None:
        """Rewrite the fixture person record and map with legacy ids."""
        person = self.comp / "people" / "alex.json"
        text = person.read_text(encoding="utf-8")
        text = text.replace('"aware"', f'"{LEGACY_OF["level"]["aware"]}"')
        text = text.replace('"hint-direction"', f'"{LEGACY_OF["support"]["hint-direction"]}"')
        person.write_text(text, encoding="utf-8")
        mp = self.comp / "map.json"
        text = mp.read_text(encoding="utf-8")
        text = text.replace('"foundation"', f'"{LEGACY_OF["kind"]["foundation"]}"')
        text = text.replace('"open-question"', f'"{LEGACY_OF["kind"]["open-question"]}"')
        mp.write_text(text, encoding="utf-8")


# --- ids ---------------------------------------------------------------------------------------------


class IdsTest(unittest.TestCase):
    def setUp(self):
        ids.reset()

    def test_alias_table_covers_every_english_id(self):
        for cat, english in (("level", ids.LEVELS), ("support", ids.SUPPORT), ("kind", ids.KINDS)):
            self.assertEqual(sorted(set(ids.LEGACY[cat].values())), sorted(english))
            self.assertEqual(len(ids.LEGACY[cat]), 5)

    def test_normalize_counts_only_real_legacy_ids(self):
        self.assertEqual(ids.normalize("level", "understand"), "understand")
        self.assertEqual(ids.normalize("kind", "module"), "module")  # same in both tables: not legacy
        self.assertIsNone(ids.legacy_warning())
        old = LEGACY_OF["level"]["understand"]
        self.assertEqual(ids.normalize("level", old), "understand")
        self.assertEqual(ids.normalize("level", "zzz"), "zzz")
        self.assertEqual(ids.legacy_warning(), f"warning: 1 legacy ids read (e.g. '{old}' -> 'understand'); run migrate_ids.py")

    def test_level_index_accepts_both_spellings(self):
        for n, new in enumerate(ids.LEVELS):
            self.assertEqual(ids.level_index(new), n)
            if new in LEGACY_OF["level"]:
                self.assertEqual(ids.level_index(LEGACY_OF["level"][new]), n)
        self.assertEqual(ids.level_index(None), 0)


# --- check_lessons -----------------------------------------------------------------------------------


class CheckLessonsTest(ProjectCase):
    def test_fixture_lessons_pass(self):
        code, out, err = run_cli("check_lessons.py", self.root)
        self.assertEqual(code, 0, out + err)
        self.assertIn("ok   L-T-01", out)
        self.assertIn("2 lessons, 0 with problems; 1 items without a lesson: L-T-03", out)

    def test_control_lesson_without_third_tier_fails(self):
        lesson = self.comp / "lessons" / "L-T-01.md"
        text = lesson.read_text(encoding="utf-8")
        head, rest = text.split("### Exercise 3 — ", 1)
        tail = rest[rest.index("## 7."):]
        lesson.write_text(head + tail, encoding="utf-8")
        code, out, err = run_cli("check_lessons.py", self.root)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL L-T-01", out)
        self.assertIn("no exercise with tier 'Apply advanced'", out)
        self.assertIn("ok   L-T-02", out)

    def test_missing_hint_and_section_are_reported(self):
        self.edit("lessons/L-T-02.md", "<details><summary>Solution</summary>`/* end */`.</details>\n", "")
        self.edit("lessons/L-T-02.md", "## 4. Easy to get wrong", "## 4 Easy to get wrong")
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-02")
        self.assertEqual(code, 1)
        self.assertIn("exercise 1: no 'Solution'", out)
        self.assertIn("section 4 missing", out)

    def test_references_are_checked(self):
        self.edit("lessons/L-T-01.md", "`src/main.c:3`.</details>", "`src/main.c:50`, `src/none.c:1`.</details>")
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-01")
        self.assertEqual(code, 1)
        self.assertIn("ref `src/main.c:50`: file has 5 lines", out)
        self.assertIn("ref `src/none.c:1`: not found", out)

    def test_title_and_unknown_item(self):
        self.edit("lessons/L-T-02.md", "# L-T-02 — Second item", "# Second item")
        shutil.copy(self.comp / "lessons" / "L-T-01.md", self.comp / "lessons" / "L-X-99.md")
        code, out, _ = run_cli("check_lessons.py", self.root)
        self.assertEqual(code, 1)
        self.assertIn("title line must start with '# <ID> '", out)
        self.assertIn("not an item in map.json", out)

    def test_markers_come_from_kit_json(self):
        text = (self.comp / "lessons" / "L-T-01.md").read_text(encoding="utf-8")
        for n, old, new in ((1, "Understand", "Một"), (2, "Apply", "Hai"), (3, "Apply advanced", "Ba")):
            text = text.replace(f"Exercise {n} — {old}:", f"Bài {n} — {new}:")
        (self.comp / "lessons" / "L-T-01.md").write_text(text, encoding="utf-8")
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-01")
        self.assertEqual(code, 1, "control: default markers do not match the changed lesson")
        self.set_kit(competency={"markers": {"lesson": {"exercise_heading": "### Bài {n} — ", "tiers": ["Một", "Hai", "Ba"]}}})
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-01")
        self.assertEqual(code, 0, out)

    def test_bare_names_use_the_index_flag_of_repos(self):
        self.edit("lessons/L-T-01.md", "`src/main.c:3`.</details>", "`main.c:3`.</details>")
        (self.root / "other").mkdir()
        (self.root / "other" / "main.c").write_text("x\ny\nz\n", encoding="utf-8")
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-01")
        self.assertEqual(code, 1)
        self.assertIn("ref `main.c:3`: ambiguous (2 files)", out)
        self.set_kit(repos=[{"name": "src", "path": "src"}, {"name": "other", "path": "other", "index": False}])
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-01")
        self.assertEqual(code, 0, out)

    def test_lesson_template_passes_with_default_markers(self):
        template = KIT_ROOT / "template" / "knowledge" / "competency" / "lessons" / "_TEMPLATE.md"
        text = template.read_text(encoding="utf-8").replace("<ID>", "L-T-09")
        (self.comp / "lessons" / "L-T-09.md").write_text(text, encoding="utf-8")
        mp = self.read_json(self.comp / "map.json")
        mp["items"].append(dict(mp["items"][0], id="L-T-09", title="Template"))
        self.write_json(self.comp / "map.json", mp)
        code, out, _ = run_cli("check_lessons.py", self.root, "L-T-09")
        self.assertEqual(code, 0, out)
        self.assertIn("ok   L-T-09", out)


# --- grade_placement ---------------------------------------------------------------------------------


class PlacementTest(ProjectCase):
    def test_check_passes_and_control_fails(self):
        code, out, err = run_cli("grade_placement.py", self.root, "--check")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(out.strip(), "4 questions, 3 map items, 0 problems")
        key = self.comp / "placement" / "key.md"
        key.write_text(key.read_text(encoding="utf-8").replace("| 3 | B | L-T-03 | any |\n", ""), encoding="utf-8")
        code, out, _ = run_cli("grade_placement.py", self.root, "--check")
        self.assertEqual(code, 1)
        self.assertIn("L-T-03: 0 part A questions (want 1)", out)
        self.assertIn("3: in test.md, not in the key", out)

    def test_grade_report(self):
        code, out, err = run_cli("grade_placement.py", self.root, "--person", "alex")
        self.assertEqual(code, 0, out + err)
        self.assertIn("# Placement test · alex", out)
        self.assertIn("Part A right 1/3, 1 not answered.", out)
        self.assertIn("| L-T-01 | 1 | right | B1 right | understand |", out)
        self.assertIn("| L-T-02 | 2 | B | — | unassessed |", out)
        self.assertIn("| Core | 0/2 | L-T-02, L-T-03 |", out)
        self.assertIn("## Study first (by priority)", out)
        self.assertIn("- L-T-02 (priority 2): Second item", out)

    def test_record_raises_but_never_lowers(self):
        code, out, _ = run_cli("grade_placement.py", self.root, "--person", "alex", "--record", "--date", "2026-02-01")
        self.assertEqual(code, 0)
        self.assertIn("recorded 1 items in people", out)
        rec = self.read_json(self.comp / "people" / "alex.json")["records"]["L-T-01"]
        self.assertEqual(rec["level"], "understand")
        self.assertEqual(rec["review_after"], "2026-01-16")  # an existing date is kept
        self.assertEqual(rec["evidence"][-1], {"date": "2026-02-01", "exercise": "Placement test question 1, B1",
                                               "support": "independent", "level": "understand"})
        data = self.read_json(self.comp / "people" / "alex.json")
        data["records"]["L-T-01"]["level"] = "apply"
        self.write_json(self.comp / "people" / "alex.json", data)
        run_cli("grade_placement.py", self.root, "--person", "alex", "--record")
        self.assertEqual(self.read_json(self.comp / "people" / "alex.json")["records"]["L-T-01"]["level"], "apply")

    def test_new_sheet_is_not_overwritten(self):
        code, out, _ = run_cli("grade_placement.py", self.root, "--new", "bo")
        self.assertEqual(code, 0)
        self.assertTrue((self.comp / "people" / "bo" / "placement.md").is_file())
        code, _, err = run_cli("grade_placement.py", self.root, "--new", "bo")
        self.assertNotEqual(code, 0)
        self.assertIn("not overwritten", err)

    def test_markers_and_strings_follow_the_config(self):
        for name in ("test.md", "key.md"):
            (self.comp / "placement" / name).rename(self.comp / "placement" / f"x-{name}")
        sheet = self.comp / "people" / "alex" / "placement.md"
        sheet.write_text(sheet.read_text(encoding="utf-8").replace("**Answer:**", "**Đáp:**")
                         .replace("**Grade:** right", "**Chấm:** đúng"), encoding="utf-8")
        self.set_kit(project={"ui_lang": "vi"}, competency={"markers": {"placement": {
            "test": "x-test.md", "key": "x-key.md", "answer": "**Đáp:**", "grade": "**Chấm:**",
            "grade_values": {"right": "đúng", "partial": "một phần", "wrong": "sai"}}}})
        code, out, err = run_cli("grade_placement.py", self.root, "--person", "alex")
        self.assertEqual(code, 0, out + err)
        self.assertIn("# Bài đầu vào · alex", out)
        self.assertIn("Phần A đúng 1/3, 1 câu chưa làm.", out)
        self.assertIn("| L-T-01 | 1 | đúng | B1 đúng | understand |", out)
        self.assertIn("## Học trước (theo ưu tiên)", out)
        self.assertIn("- L-T-02 (ưu tiên 2): Second item", out)
        code, out, _ = run_cli("grade_placement.py", self.root, "--check")
        self.assertEqual(code, 0, out)
        self.assertIn("4 questions, 3 map items, 0 problems", out)


# --- build_catchup -----------------------------------------------------------------------------------


class CatchupTest(ProjectCase):
    def build(self, *extra: str):
        out = self.root / "page.html"
        code, stdout, err = run_cli("build_catchup.py", self.root, "--out", str(out), *extra)
        self.assertEqual(code, 0, stdout + err)
        return out, err

    def test_default_output_is_in_the_competency_folder(self):
        code, out, err = run_cli("build_catchup.py", self.root)
        self.assertEqual(code, 0, err)
        self.assertEqual(Path(out.strip()), self.comp / "catchup.html")
        self.assertTrue((self.comp / "catchup.html").is_file())

    def test_page_data(self):
        page, err = self.build()
        self.assertEqual(err, "")
        d = page_data(page)
        self.assertEqual(d["person"], "Alex")
        self.assertEqual(d["levels"], ["Unassessed", "Aware", "Understand", "Apply", "Apply advanced"])
        by_id = {i["id"]: i for i in d["items"]}
        self.assertEqual(by_id["L-T-01"]["level"], 1)
        self.assertTrue(by_id["L-T-01"]["due"])
        self.assertEqual(by_id["L-T-02"]["level"], 0)
        self.assertEqual(by_id["L-T-01"]["sources"][0], {"label": "Lesson", "path": "lessons/L-T-01.md"})
        self.assertEqual(by_id["L-T-01"]["exercises"][0], "Exercise 1 — Understand: find the function")
        self.assertEqual(d["today"], ["L-T-01"])
        self.assertIn("<title>Learning map · Alex</title>", page.read_text(encoding="utf-8"))

    def test_journey_follows_stages_and_open_questions_branch(self):
        page, _ = self.build()
        j = page_data(page)["journey"]
        self.assertEqual([s["name"] for s in j], ["Basics", "Core"])
        self.assertEqual(j[1]["items"], [{"id": "L-T-02", "branch": False}, {"id": "L-T-03", "branch": True}])

    def test_without_stages_the_order_of_areas_is_used(self):
        mp = self.read_json(self.comp / "map.json")
        del mp["stages"]
        self.write_json(self.comp / "map.json", mp)
        page, _ = self.build()
        # stages default to areas: "Core" comes first but is empty, because both Core items need the Basics item
        j = page_data(page)["journey"]
        self.assertEqual([s["name"] for s in j], ["Basics"])
        self.assertEqual([e["id"] for e in j[0]["items"]], ["L-T-01", "L-T-02", "L-T-03"])

    def test_pinned_first_moves_items_to_the_first_stage(self):
        mp = self.read_json(self.comp / "map.json")
        mp["pinned_first"] = ["L-T-02"]
        self.write_json(self.comp / "map.json", mp)
        page, _ = self.build()
        j = page_data(page)["journey"]
        self.assertEqual([e["id"] for e in j[0]["items"]], ["L-T-01", "L-T-02"])
        self.assertEqual(j[1]["items"], [{"id": "L-T-03", "branch": True}])

    def test_today_option(self):
        code, out, err = run_cli("build_catchup.py", self.root, "--today")
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "L-T-01  First item")

    def test_kb_button_command(self):
        page, _ = self.build()
        self.assertEqual(page_strings(page)["kb_cmd"], "python .aikit/kb/kb.py get {id}")
        self.set_kit(competency={"kb_get_command": "kb get {id}"})
        page, _ = self.build()
        self.assertEqual(page_strings(page)["kb_cmd"], "kb get {id}")
        self.set_kit(competency={"kb_get_command": None})
        page, _ = self.build()
        self.assertIsNone(page_strings(page)["kb_cmd"])

    def test_vi_strings_render_the_vietnamese_page_title(self):
        self.set_kit(project={"ui_lang": "vi"})
        page, _ = self.build()
        text = page.read_text(encoding="utf-8")
        self.assertIn("<title>Bản đồ học · Alex</title>", text)
        self.assertIn('<html lang="vi">', text)
        self.assertEqual(page_data(page)["levels"][0], "Chưa đánh giá")
        self.assertIn(">Hành trình<", text)

    def test_every_page_text_exists_in_both_languages(self):
        en = compkit.read_json(compkit.STRINGS_DIR / "en.json")
        vi = compkit.read_json(compkit.STRINGS_DIR / "vi.json")
        self.assertEqual(sorted(en), sorted(vi))
        page = (COMP_DIR / "build_catchup.py").read_text(encoding="utf-8")
        for key in set(re.findall(r"__S_([a-z_]+?)__", page)) | set(re.findall(r"\bS\.([a-z_]+)", page)) | \
                set(re.findall(r'S\["([a-z_]+)"\]', page)):
            if key in ("kb_cmd", "level_ids"):
                continue
            self.assertIn(key, en, key)

    def test_legacy_ids_are_read_with_one_warning(self):
        self.make_legacy()
        page, err = self.build()
        warnings = [ln for ln in err.splitlines() if ln.startswith("warning:")]
        self.assertEqual(len(warnings), 1, err)
        self.assertRegex(warnings[0], r"^warning: \d+ legacy ids read \(e\.g\. '.+' -> '.+'\); run migrate_ids\.py$")
        d = page_data(page)
        by_id = {i["id"]: i for i in d["items"]}
        self.assertEqual(by_id["L-T-01"]["record"]["level"], "aware")
        self.assertEqual(by_id["L-T-01"]["record"]["evidence"][0]["support"], "hint-direction")
        self.assertEqual(by_id["L-T-01"]["kind"], "foundation")
        self.assertIn("open-question", d["kinds"])
        # control: the same data in English ids reads without any warning
        self.setUp()
        self.assertEqual(self.build()[1], "")


# --- migrate_ids -------------------------------------------------------------------------------------


class MigrateTest(ProjectCase):
    def legacy_files(self) -> dict:
        """Write a legacy competency folder: 1-space indent and CRLF in the map, 4-space indent in the person
        record, a jsonl with non-ASCII text. Returns the original bytes by relative path."""
        lv, su, kd = LEGACY_OF["level"], LEGACY_OF["support"], LEGACY_OF["kind"]
        comp = self.comp
        mp = {"schema": 1, "levels": list(ids.LEGACY["level"]), "kinds": {kd["foundation"]: "Nền", "module": "Mô-đun"},
              "areas": ["A"], "items": [{"id": "X-1", "kind": kd["foundation"], "title": "Đầu tiên"},
                                        {"id": "X-2", "kind": "module", "title": "Thứ hai"}]}
        (comp / "map.json").write_bytes(json.dumps(mp, ensure_ascii=False, indent=1).replace("\n", "\r\n").encode("utf-8") + b"\r\n")
        person = {"schema": 1, "person": "Ánh", "records": {"X-1": {
            "level": lv["understand"], "self": lv["aware"], "gaps": "Giải thích chưa đủ",
            "evidence": [{"date": "2026-01-01", "exercise": "Bài 1", "support": su["taught-first"], "level": lv["aware"]}]}}}
        (comp / "people" / "alex.json").write_bytes(json.dumps(person, ensure_ascii=False, indent=4).encode("utf-8") + b"\n")
        rec = {"date": "2026-01-01", "kind": "doc", "support": su["hint-specific"], "notes": "Đã xong"}
        (comp / "people" / "alex" / "gates.jsonl").write_bytes((json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8"))
        return {rel: (comp / rel).read_bytes() for rel in ("map.json", "people/alex.json", "people/alex/gates.jsonl")}

    def test_check_write_check(self):
        before = self.legacy_files()
        code, out, err = run_cli("migrate_ids.py", self.root, "--root", str(self.comp), "--check")
        self.assertEqual(code, 1, out + err)
        lv, su, kd = LEGACY_OF["level"], LEGACY_OF["support"], LEGACY_OF["kind"]
        self.assertIn(f"map.json: kinds: '{kd['foundation']}' -> 'foundation'", out)
        self.assertIn(f"map.json: item X-1 kind: '{kd['foundation']}' -> 'foundation'", out)
        self.assertIn(f"people/alex.json: X-1 self: '{lv['aware']}' -> 'aware'", out)
        self.assertIn(f"people/alex.json: X-1 evidence 1 support: '{su['taught-first']}' -> 'taught-first'", out)
        self.assertIn(f"people/alex/gates.jsonl: line 1 support: '{su['hint-specific']}' -> 'hint-specific'", out)
        self.assertTrue(out.strip().endswith("legacy ids in 3 files"), out)
        self.assertEqual({rel: (self.comp / rel).read_bytes() for rel in before}, before, "--check writes nothing")

        code, out, err = run_cli("migrate_ids.py", self.root, "--root", str(self.comp), "--write")
        self.assertEqual(code, 0, out + err)
        self.assertRegex(out, r"wrote 3 files, \d+ ids changed")

        code, out, err = run_cli("migrate_ids.py", self.root, "--root", str(self.comp), "--check")
        self.assertEqual(code, 0, out + err)
        self.assertIn("no legacy ids", out)

    def test_write_keeps_layout_order_and_content(self):
        before = self.legacy_files()
        run_cli("migrate_ids.py", self.root, "--root", str(self.comp), "--write")
        after = {rel: (self.comp / rel).read_bytes() for rel in before}
        mp = after["map.json"]
        self.assertIn(b"\r\n", mp)
        self.assertNotIn(b"\n\n", mp.replace(b"\r\n", b"\x00"))
        self.assertTrue(mp.endswith(b"\r\n"))
        self.assertIn('\r\n "kinds": {\r\n  "foundation": "Nền"'.encode("utf-8"), mp)
        person = after["people/alex.json"]
        self.assertIn("\n    \"schema\": 1".encode(), person)
        self.assertIn("Giải thích chưa đủ".encode("utf-8"), person)
        self.assertNotIn(b"\\u", person)
        data = json.loads(person.decode("utf-8"))
        self.assertEqual(list(data["records"]["X-1"]), ["level", "self", "gaps", "evidence"])
        self.assertEqual(data["records"]["X-1"]["level"], "understand")
        self.assertEqual(data["records"]["X-1"]["evidence"][0]["support"], "taught-first")
        self.assertEqual(list(json.loads(mp.decode("utf-8"))["kinds"]), ["foundation", "module"])
        gates = json.loads(after["people/alex/gates.jsonl"].decode("utf-8"))
        self.assertEqual(gates, {"date": "2026-01-01", "kind": "doc", "support": "hint-specific", "notes": "Đã xong"})
        # everything except the ids is unchanged: undo the id changes in the new text and compare with the old bytes
        undo = dict(LEGACY_OF["level"], **LEGACY_OF["support"], **{k: v for k, v in LEGACY_OF["kind"].items()})
        for rel in before:
            text = after[rel].decode("utf-8")
            text = re.sub(r'"(%s)"' % "|".join(sorted(undo, key=len, reverse=True)), lambda m: f'"{undo[m.group(1)]}"', text)
            self.assertEqual(text.encode("utf-8"), before[rel], rel)

    def test_clean_folder_is_not_touched(self):
        before = {p: p.read_bytes() for p in self.comp.rglob("*") if p.is_file()}
        code, out, _ = run_cli("migrate_ids.py", self.root, "--check")
        self.assertEqual(code, 0, out)
        code, out, _ = run_cli("migrate_ids.py", self.root, "--write")
        self.assertEqual(code, 0)
        self.assertIn("wrote 0 files, 0 ids changed", out)
        self.assertEqual({p: p.read_bytes() for p in self.comp.rglob("*") if p.is_file()}, before)

    def test_a_layout_that_cannot_be_kept_is_refused(self):
        compact = json.dumps({"records": {"X": {"level": LEGACY_OF["level"]["aware"]}}}, separators=(",", ":"))
        path = self.comp / "people" / "alex.json"
        path.write_text(compact, encoding="utf-8")
        code, out, err = run_cli("migrate_ids.py", self.root, "--check")
        self.assertEqual(code, 2)
        self.assertIn("layout cannot be reproduced exactly", err)
        self.assertEqual(path.read_text(encoding="utf-8"), compact)


# --- gate --------------------------------------------------------------------------------------------

NOW = dt.datetime(2026, 10, 27, 9, 0)


def sh(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@unittest.skipUnless(shutil.which("git"), "git is needed")
class GateTest(unittest.TestCase):
    def setUp(self):
        ids.reset()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "kit.json").write_text(json.dumps({"project": {"ui_lang": "en"}, "people": {"default": "alex"}}),
                                            encoding="utf-8")
        self.comp = self.root / "knowledge" / "competency"
        self.comp.mkdir(parents=True)
        self.repo = self.root / "fw"
        (self.repo / "core").mkdir(parents=True)
        (self.repo / "other").mkdir()
        sh(self.root, "init", "-q", str(self.repo))
        sh(self.repo, "config", "user.email", "t@t")
        sh(self.repo, "config", "user.name", "t")
        self.write("core/a.c", "a1")
        self.write("other/x.c", "x1")
        self.commit("base")
        base = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        (self.comp / "gate_config.json").write_text(json.dumps({
            "max_core_files_per_step": 1,
            "projects": {"p": {"repo": "fw", "baseline": base, "core": ["core/"]},
                         "h": {"repo": None, "baseline": None, "core": [], "open": "later"}}}), encoding="utf-8")
        self.ctx = compkit.load_context(self.root)

    def write(self, rel, text):
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    def commit(self, msg):
        sh(self.repo, "add", "-A")
        sh(self.repo, "commit", "-q", "-m", msg)

    def gate(self, kind="code", **extra):
        data = {"kind": kind, "questions": [{"q": "q1", "key": "B", "given": "B"}, {"q": "q2", "key": "A", "given": "E"}]}
        data.update(extra)
        return gate.record(self.ctx, "p", "alex", data, NOW)

    def scope(self):
        return gate.scope(self.ctx, "p", "alex")

    def test_scope_lists_core_commits_and_uncommitted_only(self):
        self.write("core/a.c", "a2")
        self.write("other/x.c", "x2")
        self.commit("change core and other")
        self.write("core/b.c", "new, untracked")
        s = self.scope()
        self.assertEqual([c["subject"] for c in s["commits"]], ["change core and other"])
        self.assertEqual(s["uncommitted"], ["core/b.c"])
        self.assertEqual(s["files"], ["core/a.c", "core/b.c"])
        self.assertFalse(s["gated"])

    def test_scratch_index_lives_under_the_cache_folder(self):
        self.write("core/b.c", "new")
        self.scope()
        self.assertTrue((self.ctx.cache / "gate").is_dir())
        self.assertEqual(list((self.ctx.cache / "gate").iterdir()), [], "scratch files are removed again")

    def test_no_baseline_and_no_gate_scopes_all_core_history(self):
        # A new project: no baseline yet and no gate recorded; every core file is in scope (control: it used to crash).
        cfg = json.loads((self.comp / "gate_config.json").read_text(encoding="utf-8"))
        cfg["projects"]["p"]["baseline"] = None
        (self.comp / "gate_config.json").write_text(json.dumps(cfg), encoding="utf-8")
        s = self.scope()
        self.assertIsNone(s["from"])
        self.assertEqual(s["files"], ["core/a.c"])
        self.assertEqual([c["subject"] for c in s["commits"]], ["base"])
        self.assertFalse(s["gated"])

    def test_nothing_after_the_baseline(self):
        self.write("other/x.c", "x2")
        self.commit("other only")
        self.assertTrue(self.scope()["gated"])

    def test_gated_work_stays_gated_after_commit(self):
        self.write("core/a.c", "a2")
        rec = self.gate()
        self.assertEqual(rec["score"], "1/2")
        self.assertEqual([q["ok"] for q in rec["questions"]], [True, False])
        self.assertEqual(rec["support"], "independent")
        self.assertTrue(self.scope()["gated"])
        self.commit("commit the gated change")
        self.assertTrue(self.scope()["gated"])
        self.write("core/c.c", "next step")
        s = self.scope()
        self.assertFalse(s["gated"])
        self.assertEqual(s["files"], ["core/c.c"])  # the gated a.c is not asked again

    def test_doc_gate_does_not_move_the_code_scope(self):
        self.write("core/a.c", "a2")
        self.gate(kind="doc", doc="report.md")
        self.assertFalse(self.scope()["gated"])
        lines = (self.comp / "people" / "alex" / "gates.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(lines[0])["doc"], "report.md")

    def test_project_without_repo_needs_a_doc_gate(self):
        with self.assertRaises(gate.GateError):
            gate.scope(self.ctx, "h", "alex")
        rec = gate.record(self.ctx, "h", "alex", {"kind": "doc", "doc": "r.md",
                                                   "questions": [{"q": "q", "key": "C", "given": "C"}]}, NOW)
        self.assertEqual(rec["score"], "1/1")

    def test_bad_input_is_refused(self):
        bad = [{"kind": "x", "questions": [{"q": "q", "key": "A"}]},
               {"kind": "doc", "questions": [{"q": "q", "key": "A"}]},
               {"kind": "code", "questions": []},
               {"kind": "code", "questions": [{"q": "q", "key": "E"}]},
               {"kind": "code", "questions": [{"q": "q", "key": "A", "given": "F"}]},
               {"kind": "code", "support": "guess", "questions": [{"q": "q", "key": "A"}]}]
        for data in bad:
            with self.assertRaises(gate.GateError, msg=data):
                gate.check_input(data)

    def test_cli_scope_record_and_legacy_support(self):
        self.write("core/a.c", "a2")
        code, out, err = run_cli("gate.py", self.root, "scope", "--project", "p", "--json")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["files"], ["core/a.c"])
        legacy = LEGACY_OF["support"]["hint-direction"]
        result = self.root / "result.json"
        result.write_text(json.dumps({"kind": "code", "support": legacy, "session": "s1",
                                      "questions": [{"q": "q", "key": "A", "given": "A"}]}), encoding="utf-8")
        code, out, err = run_cli("gate.py", self.root, "record", "--project", "p", "--input", str(result))
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "recorded code gate 1/1 in knowledge/competency/people/alex/gates.jsonl")
        self.assertEqual(len([ln for ln in err.splitlines() if ln.startswith("warning:")]), 1, err)
        line = (self.comp / "people" / "alex" / "gates.jsonl").read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(json.loads(line)["support"], "hint-direction")
        code, out, err = run_cli("gate.py", self.root, "scope", "--project", "p")
        self.assertIn("nothing to gate", out)

    def test_cli_errors_exit_2(self):
        code, _, err = run_cli("gate.py", self.root, "scope", "--project", "nope")
        self.assertEqual(code, 2)
        self.assertIn("unknown project", err)

    def test_project_root_env_overrides_the_search(self):
        elsewhere = self.root / "deep" / "er"
        elsewhere.mkdir(parents=True)
        env = dict(os.environ, AIKIT_PROJECT_ROOT=str(self.root), PYTHONUTF8="1")
        proc = subprocess.run([sys.executable, str(COMP_DIR / "gate.py"), "scope", "--project", "h"],
                              capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(elsewhere))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("has no repo or core paths yet", proc.stderr)  # it found gate_config.json of self.root


if __name__ == "__main__":
    unittest.main()
