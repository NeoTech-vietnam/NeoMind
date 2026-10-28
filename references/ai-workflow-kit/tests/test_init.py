import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT_ROOT))

import init as kit  # noqa: E402

TEXT_SUFFIXES = {".md", ".json", ".toml", ".txt", ".yml", ".yaml"}


def run(*argv: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            code = kit.main(list(argv))
        except SystemExit as exc:  # argparse errors
            code = exc.code
    return code, out.getvalue()


def snapshot(root: Path, skip_prefix: str | None = None) -> dict[str, str]:
    result = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts:
            continue
        rel = p.relative_to(root).as_posix()
        if skip_prefix and rel.startswith(skip_prefix):
            continue
        result[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result


def template_files() -> list[str]:
    return sorted(p.relative_to(kit.TEMPLATE_SRC).as_posix() for p in kit.TEMPLATE_SRC.rglob("*") if p.is_file())


class KitTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.target = Path(self._tmp.name) / "proj"

    def init(self, *extra: str) -> tuple[int, str]:
        return run("init", "--target", str(self.target), "--name", "Demo Project", "--owner", "Nguyễn Văn Ánh", *extra)


class InitTest(KitTestCase):
    def test_init_creates_engine_manifest_template_and_renders(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)

        engine = self.target / ".aikit"
        for rel in ("__init__.py", "config.py", "kb/__init__.py", "competency/__init__.py", "hooks/__init__.py", "agents/__init__.py"):
            self.assertTrue((engine / rel).is_file(), rel)
        manifest = json.loads((engine / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["kit_version"], (KIT_ROOT / "VERSION").read_text(encoding="utf-8").strip())
        self.assertIn("config.py", manifest["files"])
        self.assertNotIn("manifest.json", manifest["files"])
        for rel, digest in manifest["files"].items():
            self.assertEqual(hashlib.sha256((engine / rel).read_bytes()).hexdigest(), digest, rel)

        for rel in template_files():
            self.assertTrue((self.target / rel).is_file(), rel)
        # Only files the kit wrote are rendered. Vendored files keep their text, which may hold `${{ ... }}`.
        vendored = kit.vendored_skills()
        for p in self.target.rglob("*"):
            rel = p.relative_to(self.target).as_posix()
            if p.is_file() and p.suffix in TEXT_SUFFIXES and not kit.is_vendored(rel, vendored):
                self.assertNotIn("{{", p.read_text(encoding="utf-8"), rel)

        cfg = json.loads((self.target / "kit.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["project"]["name"], "Demo Project")
        self.assertEqual(cfg["project"]["owner"], "Nguyễn Văn Ánh")
        self.assertEqual(cfg["project"]["reviewer"], "Nguyễn Văn Ánh")
        self.assertEqual(cfg["project"]["ui_lang"], "en")
        self.assertEqual(cfg["people"]["default"], "nguyen-van-anh")
        self.assertEqual(cfg["harnesses"], {"claude": True, "codex": True, "antigravity": False})
        self.assertIn("Demo Project", (self.target / "CLAUDE.md").read_text(encoding="utf-8"))
        self.assertEqual((self.target / "CLAUDE.md").read_bytes(), (self.target / "AGENTS.md").read_bytes())

    def test_init_installs_the_hooks_and_writes_the_harness_configs(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        for name in ("hook_paths", "kb_guard", "kb_context", "action_guard", "grant", "antigravity"):
            self.assertTrue((self.target / ".aikit" / "hooks" / f"{name}.py").is_file(), name)
        self.assertTrue((self.target / ".aikit" / "agents" / "sync_agents.py").is_file())
        self.assertIn("created: .claude/settings.json", out)
        self.assertIn("created: .codex/hooks.json", out)
        self.assertFalse((self.target / ".agents").exists())

    def test_vendored_skills_are_copied_byte_for_byte(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        names = kit.vendored_skills()
        self.assertEqual(len(names), 10)
        vendored = [rel for rel in template_files() if kit.is_vendored(rel, names)]
        self.assertIn(kit.VENDORED_FILE, vendored)
        self.assertGreater(len(vendored), 40)
        for rel in vendored:
            with self.subTest(file=rel):
                self.assertEqual((self.target / rel).read_bytes(), (kit.TEMPLATE_SRC / rel).read_bytes())
        self.assertTrue(any(rel.startswith(".claude/skills/humanizer/") for rel in vendored))

    def test_vendored_crlf_and_github_actions_syntax_survive(self):
        # A text copy would turn CRLF into LF, and a render pass could touch `${{ ... }}`. Neither may happen.
        names = kit.vendored_skills()
        crlf = ".claude/skills/humanizer/SKILL.md"
        actions = ".claude/skills/build-iterated-agentic-loop/references/workflow-template.yml"
        for rel in (crlf, actions):
            self.assertTrue(kit.is_vendored(rel, names), rel)
        self.assertIn(b"\r\n", (kit.TEMPLATE_SRC / crlf).read_bytes(), "pick another vendored file with CRLF")
        self.assertIn(b"${{", (kit.TEMPLATE_SRC / actions).read_bytes(), "pick another vendored file with ${{")
        code, out = self.init()
        self.assertEqual(code, 0, out)
        for rel in (crlf, actions):
            with self.subTest(file=rel):
                self.assertEqual((self.target / rel).read_bytes(), (kit.TEMPLATE_SRC / rel).read_bytes())

    def test_is_vendored_covers_only_vendored_folders_and_the_listing(self):
        names = {"alpha"}
        self.assertTrue(kit.is_vendored(".claude/skills/VENDORED.json", names))
        self.assertTrue(kit.is_vendored(".claude/skills/alpha/SKILL.md", names))
        self.assertTrue(kit.is_vendored(".claude/skills/alpha/references/x.md", names))
        self.assertFalse(kit.is_vendored(".claude/skills/beta/SKILL.md", names))
        self.assertFalse(kit.is_vendored(".claude/skills/alpha", names))
        self.assertFalse(kit.is_vendored("docs/.claude/skills/alpha/SKILL.md", names))
        self.assertFalse(kit.is_vendored(".claude/agents/alpha/SKILL.md", names))

    def test_init_does_not_overwrite_an_edited_vendored_file(self):
        target_file = self.target / ".claude" / "skills" / "show-me" / "SKILL.md"
        target_file.parent.mkdir(parents=True)
        target_file.write_text("my own version\n", encoding="utf-8")
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertEqual(target_file.read_text(encoding="utf-8"), "my own version\n")
        self.assertIn("skipped: .claude/skills/show-me/SKILL.md", out)

    def test_template_kit_version_matches_version_file(self):
        template = json.loads((kit.TEMPLATE_SRC / "kit.json").read_text(encoding="utf-8"))
        self.assertEqual(template["kit_version"], (KIT_ROOT / "VERSION").read_text(encoding="utf-8").strip())

    def test_special_characters_keep_kit_json_valid(self):
        code, out = run("init", "--target", str(self.target), "--name", 'My "quoted" \\ name', "--owner", "A B", "--lang", "vi")
        self.assertEqual(code, 0, out)
        cfg = json.loads((self.target / "kit.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["project"]["name"], 'My "quoted" \\ name')
        self.assertEqual(cfg["project"]["ui_lang"], "vi")
        self.assertEqual(run("check", "--target", str(self.target))[0], 0)

    def test_harness_option(self):
        code, out = self.init("--harness", "codex,antigravity")
        self.assertEqual(code, 0, out)
        cfg = json.loads((self.target / "kit.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["harnesses"], {"claude": False, "codex": True, "antigravity": True})

    def test_bad_harness_is_refused_before_writing(self):
        code, out = self.init("--harness", "vim")
        self.assertEqual(code, 2)
        self.assertIn("unknown harness", out)
        self.assertFalse(self.target.exists())

    def test_control_second_init_changes_no_file(self):
        self.assertEqual(self.init()[0], 0)
        before = snapshot(self.target)
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot(self.target), before)
        self.assertIn("skipped: kit.json", out)
        self.assertIn("already installed", out)

    def test_init_does_not_overwrite_existing_project_files(self):
        self.target.mkdir()
        (self.target / "CLAUDE.md").write_text("mine\n", encoding="utf-8")
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertEqual((self.target / "CLAUDE.md").read_text(encoding="utf-8"), "mine\n")
        self.assertIn("skipped: CLAUDE.md", out)


class UpgradeTest(KitTestCase):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.init()[0], 0)
        self.engine = self.target / ".aikit"

    def test_control_upgrade_touches_nothing_outside_engine(self):
        # a project-owned file edited after init must survive
        (self.target / "knowledge" / "kb" / "kb.json").write_text('{"schema_version": 2, "groups": [1]}\n', encoding="utf-8")
        (self.target / "extra.txt").write_text("keep me", encoding="utf-8")
        before = snapshot(self.target, skip_prefix=".aikit/")
        code, out = run("upgrade", "--target", str(self.target))
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot(self.target, skip_prefix=".aikit/"), before)
        self.assertIn("->", out)
        self.assertEqual(run("check", "--target", str(self.target))[0], 0)

    def test_upgrade_never_touches_vendored_skills(self):
        skill = self.target / ".claude" / "skills" / "humanizer" / "SKILL.md"
        listing = self.target / ".claude" / "skills" / "VENDORED.json"
        skill.write_bytes(skill.read_bytes() + b"\r\nlocal note\r\n")
        listing.write_text('{"schema": 1, "skills": []}\n', encoding="utf-8")
        before = snapshot(self.target, skip_prefix=".aikit/")
        code, out = run("upgrade", "--target", str(self.target))
        self.assertEqual(code, 0, out)
        self.assertEqual(snapshot(self.target, skip_prefix=".aikit/"), before)

    def test_upgrade_updates_a_changed_engine_file(self):
        # simulate a newer kit: the manifest still matches the files, so the new kit differs from the install
        stale = self.engine / "config.py"
        stale.write_text("# old engine\n", encoding="utf-8")
        manifest_path = self.engine / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"]["config.py"] = hashlib.sha256(stale.read_bytes()).hexdigest()
        manifest["kit_version"] = "0.0.1"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        code, out = run("upgrade", "--target", str(self.target))
        self.assertEqual(code, 0, out)
        self.assertEqual((self.engine / "config.py").read_bytes(), (kit.ENGINE_SRC / "config.py").read_bytes())
        self.assertIn("0.0.1 -> ", out)
        new_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(new_manifest["kit_version"], kit.kit_version())

    def test_control_upgrade_refuses_local_edits_with_exit_3_and_force_overrides(self):
        edited = self.engine / "config.py"
        edited.write_text(edited.read_text(encoding="utf-8") + "\n# local edit\n", encoding="utf-8")
        (self.engine / "stray.py").write_text("x = 1\n", encoding="utf-8")
        before = snapshot(self.target)

        code, out = run("upgrade", "--target", str(self.target))
        self.assertEqual(code, 3)
        self.assertIn("changed: config.py", out)
        self.assertIn("extra: stray.py", out)
        self.assertEqual(snapshot(self.target), before, "a refused upgrade must change nothing")

        code, out = run("upgrade", "--target", str(self.target), "--force")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.engine / "config.py").read_bytes(), (kit.ENGINE_SRC / "config.py").read_bytes())
        self.assertFalse((self.engine / "stray.py").exists())
        self.assertFalse((self.target / ".aikit.new").exists())
        self.assertEqual(run("check", "--target", str(self.target))[0], 0)

    def test_upgrade_refuses_without_kit_json_or_manifest(self):
        (self.engine / "manifest.json").unlink()
        self.assertEqual(run("upgrade", "--target", str(self.target))[0], 2)
        empty = Path(self._tmp.name) / "empty"
        empty.mkdir()
        self.assertEqual(run("upgrade", "--target", str(empty))[0], 2)


class CheckTest(KitTestCase):
    def test_fresh_init_passes(self):
        self.assertEqual(self.init()[0], 0)
        code, out = run("check", "--target", str(self.target))
        self.assertEqual(code, 0, out)

    def test_control_broken_kit_json_reports_all_four_problems(self):
        self.assertEqual(self.init()[0], 0)
        path = self.target / "kit.json"
        cfg = json.loads(path.read_text(encoding="utf-8"))
        cfg["project"]["ui_lang"] = "xx"
        cfg["guard_rules"] = [
            {"match": "([bad", "action": "ask", "reason": "bad regex"},
            {"match": "ok", "action": "deny-without-grant", "grant": "ghost", "reason": "undeclared grant"},
        ]
        cfg["agents"]["assign"] = {"helper": "Q"}
        path.write_text(json.dumps(cfg), encoding="utf-8")

        code, out = run("check", "--target", str(self.target))
        self.assertEqual(code, 1, out)
        for needle in ("not a valid regex", "not a declared grant", "unknown tier", "ui_lang"):
            self.assertIn(needle, out)
        self.assertEqual(out.count("error:"), 4, out)

    def test_unknown_top_level_key_is_only_a_warning(self):
        self.assertEqual(self.init()[0], 0)
        path = self.target / "kit.json"
        cfg = json.loads(path.read_text(encoding="utf-8"))
        cfg["custom"] = 1
        path.write_text(json.dumps(cfg), encoding="utf-8")
        code, out = run("check", "--target", str(self.target))
        self.assertEqual(code, 0, out)
        self.assertIn("warning: unknown top-level key 'custom'", out)

    def test_manifest_problems_and_missing_folder(self):
        self.assertEqual(self.init()[0], 0)
        (self.target / ".aikit" / "config.py").write_text("changed", encoding="utf-8")
        (self.target / ".aikit" / "kb" / "__init__.py").unlink()
        (self.target / ".aikit" / "extra.py").write_text("", encoding="utf-8")
        (self.target / "knowledge" / ".cache" / ".gitkeep").unlink()
        (self.target / "knowledge" / ".cache").rmdir()
        code, out = run("check", "--target", str(self.target))
        self.assertEqual(code, 1)
        for needle in ("changed: config.py", "missing: kb/__init__.py", "not in manifest: extra.py", "paths.cache"):
            self.assertIn(needle, out)

    def test_missing_manifest_and_missing_kit_json(self):
        self.assertEqual(self.init()[0], 0)
        (self.target / ".aikit" / "manifest.json").unlink()
        self.assertEqual(run("check", "--target", str(self.target))[0], 1)
        empty = Path(self._tmp.name) / "empty"
        empty.mkdir()
        self.assertEqual(run("check", "--target", str(empty))[0], 1)


class ExampleTest(unittest.TestCase):
    def test_example_matches_a_fresh_init(self):
        example = KIT_ROOT / "example"
        # --harness claude: the Codex hook file holds absolute paths of the machine it was made on, so the example has none
        self.assertTrue(example.is_dir(), "run: python init.py init --target example --name 'Example Project' --owner 'Alex Doe' --harness claude")
        with tempfile.TemporaryDirectory() as tmp:
            fresh = Path(tmp) / "example"
            code, out = run("init", "--target", str(fresh), "--name", "Example Project", "--owner", "Alex Doe", "--harness", "claude")
            self.assertEqual(code, 0, out)
            listed = lambda root: sorted(p for p in snapshot(root))
            self.assertEqual(listed(example), listed(fresh))
            # everything except the manifest must match byte for byte as well
            a, b = snapshot(example), snapshot(fresh)
            a.pop(".aikit/manifest.json"), b.pop(".aikit/manifest.json")
            self.assertEqual(a, b)
        self.assertEqual(run("check", "--target", str(example))[0], 0)


class CliTest(unittest.TestCase):
    def test_help_works_for_every_subcommand(self):
        for args in ([], ["init"], ["upgrade"], ["check"]):
            proc = subprocess.run(
                [sys.executable, str(KIT_ROOT / "init.py"), *args, "--help"], capture_output=True, text=True, timeout=60
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("usage:", proc.stdout)

    def test_missing_arguments_exit_2(self):
        proc = subprocess.run([sys.executable, str(KIT_ROOT / "init.py"), "check"], capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
