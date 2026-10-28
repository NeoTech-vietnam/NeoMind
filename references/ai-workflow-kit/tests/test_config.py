import json
import sys
import tempfile
import unittest
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT_ROOT))

from engine import config  # noqa: E402


def write_config(folder: Path, data: dict) -> None:
    (folder / "kit.json").write_text(json.dumps(data), encoding="utf-8")


class OwnerSlugTest(unittest.TestCase):
    def test_vietnamese_name(self):
        self.assertEqual(config.owner_slug("Nguyễn Văn Ánh"), "nguyen-van-anh")

    def test_d_stroke_and_punctuation(self):
        self.assertEqual(config.owner_slug("Đỗ  Thị, Lan"), "do-thi-lan")

    def test_plain(self):
        self.assertEqual(config.owner_slug("Alex Doe"), "alex-doe")


class LoadTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_defaults_fill_missing_keys_and_paths_resolve(self):
        write_config(self.root, {"project": {"name": "P"}, "kb": {"scopes": ["a", "b"]}})
        cfg = config.load(self.root)
        self.assertEqual(cfg["project"]["name"], "P")
        self.assertEqual(cfg["project"]["ui_lang"], "en")  # from defaults, merged key by key
        self.assertEqual(cfg["kb"]["scopes"], ["a", "b"])  # lists are replaced, not merged
        self.assertEqual(cfg["kb"]["status_column"], "Status")
        self.assertEqual(cfg["paths_raw"]["kb"], "knowledge/kb")
        self.assertTrue(cfg["paths"]["kb"].is_absolute())
        self.assertEqual(cfg["paths"]["kb"], self.root.absolute() / "knowledge" / "kb")
        self.assertEqual(config.errors_only(config.validate(cfg)), [])

    def test_missing_file(self):
        with self.assertRaises(config.ConfigError):
            config.load(self.root)

    def test_invalid_json(self):
        (self.root / "kit.json").write_text("{not json", encoding="utf-8")
        with self.assertRaisesRegex(config.ConfigError, "not valid JSON"):
            config.load(self.root)

    def test_path_outside_root_or_absolute_is_rejected(self):
        for bad in ("../outside", "/abs/path", "C:/abs/path"):
            write_config(self.root, {"paths": {"kb": bad}})
            with self.assertRaises(config.ConfigError, msg=bad):
                config.load(self.root)

    def test_find_project_root_walks_up(self):
        write_config(self.root, {})
        deep = self.root / "a" / "b"
        deep.mkdir(parents=True)
        self.assertEqual(config.find_project_root(deep), self.root.absolute())

    def test_find_project_root_not_found(self):
        with self.assertRaises(config.ConfigError):
            config.find_project_root(self.root)


class ValidateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def problems(self, data: dict) -> list[str]:
        write_config(self.root, data)
        return config.validate(config.load(self.root))

    def test_all_problems_reported_not_just_first(self):
        found = self.problems(
            {
                "project": {"ui_lang": "fr"},
                "grants": [{"name": "rig", "max_minutes": 5}],
                "guard_rules": [
                    {"match": "(unclosed", "action": "ask", "reason": "x"},
                    {"match": "ok", "action": "deny-without-grant", "grant": "nope", "reason": "x"},
                ],
                "agents": {"assign": {"worker": "Z"}},
                "kb": {"scopes": ["Bad Scope"]},
                "plugins": ["/abs/plugin"],
            }
        )
        text = "\n".join(found)
        for needle in ("ui_lang", "not a valid regex", "not a declared grant", "unknown tier", "kb.scopes", "plugins[0]"):
            self.assertIn(needle, text)
        self.assertGreaterEqual(len(found), 6)

    def test_deny_without_grant_needs_grant_field(self):
        found = self.problems({"guard_rules": [{"match": "x", "action": "deny-without-grant", "reason": "r"}]})
        self.assertTrue(any("grant is required" in p for p in found))

    def test_bad_grant_values(self):
        found = self.problems({"grants": [{"name": "a", "max_minutes": 0}, {"name": "a", "max_minutes": True}]})
        text = "\n".join(found)
        self.assertIn("max_minutes", text)
        self.assertIn("declared twice", text)

    def test_unknown_top_level_key_is_a_warning(self):
        found = self.problems({"my_extra": {"x": 1}})
        self.assertEqual(found, ["warning: unknown top-level key 'my_extra'"])

    def test_wrong_types(self):
        found = self.problems({"repos": {}, "harnesses": {"claude": "yes"}, "competency": {"markers": []}})
        text = "\n".join(found)
        self.assertIn("'repos' must be a list", text)
        self.assertIn("harnesses.claude", text)
        self.assertIn("competency.markers", text)


if __name__ == "__main__":
    unittest.main()
