"""Tests for langflow.catalog (skills, roles, bindings, preflight, prompt) on temporary project folders.
No agent calls. Run with the langflow tool's Python (no pytest needed):
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_catalog -v
"""
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from langflow import catalog as cat
from langflow.project import Project

SKILL = "---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\nDo the {name} thing.\n"
CLAUDE_ROLE = ("---\nname: report-writer\ndescription: Writes reports.\ntools: Read, Grep, Bash\nmodel: opus\n---\n\n"
               "You write project reports.\n")
CODEX_ROLE = ('name = "report-writer"\ndescription = "Writes reports (codex)."\nmodel = "gpt-6-luna"\n'
              "model_reasoning_effort = \"low\"\ndeveloper_instructions = '''\nYou write project reports, codex.\n'''\n")
LANGFLOW_ROLE = "---\nname: checker\ndescription: Checks.\n---\nCheck everything twice.\n"


def put(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def link_dir(link: Path, target: Path) -> bool:
    """A directory symlink, or a junction on Windows without symlink rights; False when neither works."""
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    if sys.platform == "win32":
        try:
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
            return True
        except (OSError, ImportError, AttributeError):
            pass
    return False


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_catalog_test_"))
        self.root = self.tmp / "proj"
        put(self.root / ".langflow" / "config.toml", '[project]\nname = "t"\n')
        self.p = Project(self.root, {})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def skill(self, folder: str, sid: str, name=None, desc="d", extra: dict | None = None):
        d = self.root / folder / sid
        put(d / "SKILL.md", SKILL.format(name=name or sid, desc=desc))
        for k, v in (extra or {}).items():
            put(d / k, v)
        return d


class FrontmatterTest(unittest.TestCase):
    def test_yaml_and_fallback(self):
        text = ("\ufeff---\nname: x\ndescription: \"A: quoted\"\ntools: [Read, Grep]\nlist:\n  - a\n  - b\n"
                "block: |\n  line 1\n  line 2\nfolded: >\n  one\n  two\nmodel: inherit\n---\nBody\n")
        meta, body = cat.frontmatter(text)
        self.assertEqual(meta["name"], "x")
        self.assertEqual(meta["description"], "A: quoted")
        self.assertEqual(body, "Body\n")
        mini = cat._mini_yaml(cat._FM_RE.match(text).group(1))
        self.assertEqual(mini["name"], "x")
        self.assertEqual(mini["description"], "A: quoted")
        self.assertEqual(mini["tools"], ["Read", "Grep"])
        self.assertEqual(mini["list"], ["a", "b"])
        self.assertEqual(mini["block"], "line 1\nline 2")
        self.assertEqual(mini["folded"], "one two")
        with mock.patch.dict(sys.modules, {"yaml": None}):
            meta2, body2 = cat.frontmatter(text)
        self.assertEqual(meta2["tools"], ["Read", "Grep"])
        self.assertEqual(body2, "Body\n")

    def test_no_or_bad_frontmatter(self):
        self.assertEqual(cat.frontmatter("# Title\n"), ({}, "# Title\n"))
        meta, body = cat.frontmatter("---\n- a list\n---\nB")
        self.assertEqual((meta, body), ({}, "B"))


class SkillsTest(Base):
    def test_priority_shadowed_companions(self):
        self.skill(".claude/skills", "asd-ste100", desc="claude copy", extra={"references/rules.md": "r"})
        self.skill(".agents/skills", "asd-ste100", desc="agents copy")
        self.skill(".claude/skills", "humanizer", name="Humanizer", extra={"examples/a.md": "a", "README.md": "x"})
        self.skill(".langflow/skills", "local", desc="local one")
        put(self.root / ".claude/skills/not-a-skill/README.md", "no SKILL.md")
        put(self.root / ".claude/skills/bad id/SKILL.md", SKILL.format(name="b", desc="d"))
        entries, warn = cat.scan_skills(self.p)
        by = {e["id"]: e for e in entries}
        self.assertEqual(sorted(by), ["asd-ste100", "humanizer", "local"])
        a = by["asd-ste100"]
        self.assertEqual((a["source"], a["path"], a["description"]), ("agents", ".agents/skills/asd-ste100/SKILL.md",
                                                                      "agents copy"))
        self.assertEqual([s["source"] for s in a["shadowed"]], ["claude"])
        self.assertEqual(a["sha256"], cat.sha256_file(self.root / a["path"]))
        self.assertEqual(a["files"], [])
        self.assertEqual(by["humanizer"]["name"], "Humanizer")
        self.assertEqual(by["humanizer"]["files"], [".claude/skills/humanizer/README.md",
                                                    ".claude/skills/humanizer/examples/a.md"])
        self.assertEqual(by["local"]["source"], "langflow")
        self.assertTrue(any("bad id" in w for w in warn))
        one = cat.skill(self.p, "humanizer")
        self.assertIn("Do the Humanizer thing.", one["text"])
        self.assertIsNone(cat.skill(self.p, "nope"))
        self.assertIsNone(cat.skill(self.p, "../x"))

    def test_config_dirs(self):
        self.skill("tools/skills", "extra")
        self.skill(".claude/skills", "extra", desc="wins")
        outside = self.tmp / "outside"
        (outside / "s").mkdir(parents=True)
        p = Project(self.root, {"catalog": {"skill_dirs": ["tools/skills", str(outside), "../outside"]}})
        entries, warn = cat.scan_skills(p)
        e = next(x for x in entries if x["id"] == "extra")
        self.assertEqual((e["source"], e["description"]), ("claude", "wins"))
        self.assertEqual(e["shadowed"][0]["source"], "config")
        self.assertEqual(len([w for w in warn if "outside the project" in w]), 2)

    def test_link_escape_skipped(self):
        outside = self.tmp / "outside" / "evil"
        put(outside / "SKILL.md", SKILL.format(name="evil", desc="d"))
        if not link_dir(self.root / ".claude/skills/evil", outside):
            self.skipTest("no symlink or junction support")
        self.skill(".claude/skills", "good")
        entries, warn = cat.scan_skills(self.p)
        self.assertEqual([e["id"] for e in entries], ["good"])
        self.assertTrue(any("outside the project" in w for w in warn))

    def test_link_inside_allowed(self):
        target = self.skill(".claude/skills", "shared")
        if not link_dir(self.root / ".agents/skills/shared", target):
            self.skipTest("no symlink or junction support")
        e = cat.skill(self.p, "shared", text=False)
        self.assertEqual(e["source"], "agents")
        self.assertEqual(e["shadowed"][0]["sha256"], e["sha256"])


class RolesTest(Base):
    def setUp(self):
        super().setUp()
        put(self.root / ".claude/agents/report-writer.md", CLAUDE_ROLE)
        put(self.root / ".codex/agents/report-writer.toml", CODEX_ROLE)
        put(self.root / ".langflow/agents/checker.md", LANGFLOW_ROLE)
        put(self.root / ".claude/agents/_tiers.json", "{}")
        put(self.root / ".codex/agents/broken.toml", "name = \n")

    def test_scan(self):
        entries, warn = cat.scan_roles(self.p)
        by = {e["id"]: e for e in entries}
        self.assertEqual(sorted(by), ["checker", "report-writer"])
        rw = by["report-writer"]
        self.assertEqual(sorted(rw["sources"]), ["claude", "codex"])
        self.assertEqual(rw["sources"]["claude"]["tools"], ["Read", "Grep", "Bash"])
        self.assertEqual(rw["sources"]["codex"]["effort"], "low")
        self.assertNotIn("instructions", rw["sources"]["claude"])
        self.assertTrue(any("broken.toml" in w for w in warn))
        full = cat.role(self.p, "report-writer")
        self.assertIn("You write project reports, codex.", full["sources"]["codex"]["instructions"])
        self.assertTrue(full["sources"]["claude"]["text"].startswith("---"))

    def test_resolve_per_cli(self):
        r = cat.resolve(self.p, "claude", "report-writer", [])["role"]
        self.assertEqual((r["source"], r["native"], r["model"], r["tools"]), ("claude", True, "opus",
                                                                              ["Read", "Grep", "Bash"]))
        r = cat.resolve(self.p, "codex", "report-writer", None)["role"]
        self.assertEqual((r["source"], r["native"], r["model"], r["effort"]), ("codex", True, "gpt-6-luna", "low"))
        self.assertEqual(r["instructions"], "You write project reports, codex.")
        r = cat.resolve(self.p, "opencode", "report-writer", None)["role"]
        self.assertEqual((r["source"], r["native"], r["model"], r["tools"]), ("claude", False, None, None))
        self.assertEqual(r["instructions"], "You write project reports.")
        r = cat.resolve(self.p, "claude", "checker", None)["role"]
        self.assertEqual((r["source"], r["native"]), ("langflow", False))


class BindingsTest(Base):
    FILE = ("# my bindings\n\n# draft uses the writer\n[client_report.draft]\nrole = \"report-writer\"  # keep\n"
            "skills = [\"asd-ste100\"]\n\n# review comment\n[client_report.review]\nrole = \"report-reviewer\"\n\n"
            "[other.x]\nskills_add = [\"humanizer\"]\n")

    def test_read_and_bad(self):
        put(self.root / cat.BINDINGS_FILE, self.FILE)
        b = cat.read_bindings(self.p)
        self.assertEqual(b["client_report"]["draft"], {"role": "report-writer", "skills": ["asd-ste100"]})
        self.assertEqual(b["other"]["x"], {"skills_add": ["humanizer"]})
        put(self.root / cat.BINDINGS_FILE, "[a.b]\nmodel = \"x\"\n")
        with self.assertRaises(ValueError):
            cat.read_bindings(self.p)
        put(self.root / cat.BINDINGS_FILE, "[a.b\n")
        with self.assertRaises(ValueError):
            cat.read_bindings(self.p)

    def test_set_keeps_comments(self):
        f = self.root / cat.BINDINGS_FILE
        put(f, self.FILE)
        cat.set_binding(self.p, "client_report", "draft", {"role": "", "skills": ["humanizer", "humanizer"]})
        t = f.read_text(encoding="utf-8")
        self.assertIn("# my bindings", t)
        self.assertIn("# draft uses the writer", t)
        self.assertIn("# review comment\n[client_report.review]", t)
        b = cat.read_bindings(self.p)
        self.assertEqual(b["client_report"]["draft"], {"role": "", "skills": ["humanizer"]})
        self.assertEqual(b["client_report"]["review"], {"role": "report-reviewer"})
        cat.set_binding(self.p, "client_report", "review", None)
        t = f.read_text(encoding="utf-8")
        self.assertNotIn("report-reviewer", t)
        self.assertIn("[other.x]", t)
        self.assertEqual(sorted(cat.read_bindings(self.p)["client_report"]), ["draft"])
        cat.set_binding(self.p, "new_wf", "fan", {"skills_add": ["a"]})
        cat.set_binding(self.p, "new_wf", "odd.step name", {"role": "r"})
        b = cat.read_bindings(self.p)
        self.assertEqual(b["new_wf"], {"fan": {"skills_add": ["a"]}, "odd.step name": {"role": "r"}})
        cat.set_binding(self.p, "other", "x", {})
        self.assertNotIn("other", cat.read_bindings(self.p))
        with self.assertRaises(ValueError):
            cat.set_binding(self.p, "w", "s", {"model": "x"})
        with self.assertRaises(ValueError):
            cat.set_binding(self.p, "w", "s", {"skills": ["../x"]})

    def test_clean_rewrite_fallback(self):
        f = self.root / cat.BINDINGS_FILE
        put(f, "[client_report]\ndraft.role = \"a\"\n")       # dotted keys: the line edit cannot place the table
        cat.set_binding(self.p, "client_report", "draft", {"role": "b"})
        self.assertEqual(cat.read_bindings(self.p), {"client_report": {"draft": {"role": "b"}}})
        self.assertTrue(f.read_text(encoding="utf-8").startswith("# Step bindings"))

    def test_precedence(self):
        code = {"role": "w", "skills": ["a", "b"]}
        self.assertEqual(cat.effective(code)["from"], {"role": "code", "skills": "code"})
        e = cat.effective(code, {"skills": ["c"], "skills_add": ["a"]})
        self.assertEqual((e["role"], e["skills"], e["from"]["skills"]), ("w", ["c", "a"], "bindings"))
        e = cat.effective(code, {"role": ""})
        self.assertIsNone(e["role"])
        e = cat.effective(code, {"role": "x"}, {"role.draft": "y", "skills.draft": "+c,a"}, "draft")
        self.assertEqual((e["role"], e["skills"], e["from"]), ("y", ["a", "b", "c"], {"role": "run", "skills": "run"}))
        e = cat.effective(code, None, {"role.fan": "", "skills.*": ""}, "fan[3]")
        self.assertEqual((e["role"], e["skills"]), (None, []))
        e = cat.effective(code, None, {"skills.draft": "x, y"}, "draft")
        self.assertEqual(e["skills"], ["x", "y"])
        b = {"wf": {"fan": {"role": "r"}}}
        self.assertEqual(cat.override_for(b, "wf", "fan[2]"), {"role": "r"})
        self.assertIsNone(cat.override_for(b, "wf", "other"))


def fake_ai(name, agent="claude", role=None, skills=None):
    def node(state, config):
        return {}
    node.langflow_step = {"agent": agent, "role": role, "skills": skills or []}
    return name, node, "ai"


class PreflightTest(Base):
    def setUp(self):
        super().setUp()
        put(self.root / ".claude/agents/report-writer.md", CLAUDE_ROLE)
        self.skill(".claude/skills", "asd-ste100", extra={"references/r.md": "r"})
        self.skill(".agents/skills", "humanizer")

    def steps(self):
        def worker(item, i):
            return fake_ai(f"fan[{i}]")
        worker.langflow_step = {"agent": "codex", "role": None, "skills": ["humanizer"]}
        return [
            fake_ai("draft", role="report-writer", skills=["asd-ste100"]),
            ("s", None, "script"),
            ("route", None, "route", {"a": [fake_ai("r1", role="ghost")], "b": fake_ai("r2", skills=["nope"])}),
            ("par", None, "parallel", [fake_ai("p1", agent="opencode", role="report-writer"), [fake_ai("p2")]]),
            ("lp", None, "loop", ([fake_ai("l1", skills=["humanizer"])], 3)),
            ("fan", None, "fanout", (worker, 5)),
        ]

    def test_walk_usage_preflight_catalog(self):
        names = [n for n, _ in cat.walk(self.steps())]
        self.assertEqual(names, ["draft", "r1", "r2", "p1", "p2", "l1", "fan"])
        rows = cat.step_rows("wf", self.steps(), {"wf": {"r2": {"skills": []}}}, {"role.p2": "report-writer"})
        by = {r["step"]: r for r in rows}
        self.assertEqual(by["r2"]["effective"]["skills"], [])
        self.assertEqual(by["p2"]["effective"]["role"], "report-writer")
        problems = cat.preflight(self.p, rows)
        self.assertEqual(problems, ["wf.r1: role ghost: no .claude/agents/ghost.md, .codex/agents/ghost.toml or "
                                    ".langflow/agents/ghost.md"])
        use = cat.usage(rows)
        self.assertEqual(use["roles"]["report-writer"], [{"workflow": "wf", "step": s} for s in ("draft", "p1", "p2")])
        self.assertEqual([r["step"] for r in use["skills"]["humanizer"]], ["l1", "fan"])
        c = cat.catalog(self.p, rows)
        ghost = next(r for r in c["roles"] if r["id"] == "ghost")
        self.assertTrue(ghost["missing"])
        asd = next(s for s in c["skills"] if s["id"] == "asd-ste100")
        self.assertEqual(asd["used_by"], [{"workflow": "wf", "step": "draft"}])

    def test_resolve_errors_collected(self):
        with self.assertRaises(cat.BindingError) as cm:
            cat.resolve(self.p, "claude", "ghost", ["asd-ste100", "nope", "../x"])
        self.assertEqual(len(cm.exception.problems), 3)

    def test_record_and_changes(self):
        res = cat.resolve(self.p, "claude", "report-writer", ["asd-ste100", "humanizer", "asd-ste100"])
        self.assertEqual([s["id"] for s in res["skills"]], ["asd-ste100", "humanizer"])
        rec = cat.record(res)
        self.assertEqual(set(rec["role"]), {"id", "source", "path", "sha256", "native"})
        self.assertNotIn("text", rec["skills"][0])
        self.assertEqual(cat.changes(self.p, rec), [])
        put(self.root / ".claude/skills/asd-ste100/SKILL.md", "changed\n")
        (self.root / ".claude/agents/report-writer.md").unlink()
        self.assertEqual(cat.changes(self.p, rec), [
            "role report-writer missing (.claude/agents/report-writer.md)",
            "skill asd-ste100 changed (.claude/skills/asd-ste100/SKILL.md)"])
        self.assertIsNone(cat.record({"role": None, "skills": []}))
        self.assertEqual(cat.changes(self.p, None), [])


class PromptTest(Base):
    def test_compose(self):
        put(self.root / ".langflow/agents/checker.md", LANGFLOW_ROLE)
        self.skill(".claude/skills", "asd-ste100", name="ASD-STE100", extra={"references/r.md": "r"})
        res = cat.resolve(self.p, "codex", "checker", ["asd-ste100"])
        out = cat.compose("Write the report.", res)
        self.assertTrue(out.startswith("Role for this step: checker (.langflow/agents/checker.md)."))
        self.assertIn("Check everything twice.", out)
        self.assertIn("Skills for this step (follow them):\n\n### ASD-STE100 (.claude/skills/asd-ste100/SKILL.md)",
                      out)
        self.assertIn("Companion files (read only if needed): .claude/skills/asd-ste100/references/r.md", out)
        self.assertTrue(out.endswith("\n---\n\nWrite the report."))
        self.assertLess(out.index("Role for"), out.index("Skills for"))
        no_role = cat.compose("P", res, with_role=False)
        self.assertNotIn("Role for", no_role)
        named = cat.compose("P", res, mode="name")
        self.assertIn("- Use the skill asd-ste100 (.claude/skills/asd-ste100/SKILL.md).", named)
        self.assertNotIn("Do the", named)
        self.assertEqual(cat.compose("P", {"role": None, "skills": []}), "P")
        self.assertEqual(cat.compose("P", None), "P")

    def test_skill_mode(self):
        self.assertEqual(cat.skill_mode(Project(self.root, {"catalog": {"skill_mode": "name"}})), "name")
        self.assertEqual(cat.skill_mode(Project(self.root, {"catalog": {"skill_mode": "bogus"}})), "inject")
        self.assertEqual(cat.skill_mode(self.p), "inject")


if __name__ == "__main__":
    unittest.main()
