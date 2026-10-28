"""Checks of the project-owned text templates: skills, agents, memory files and the two entry files."""

import json
import re
import unittest
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = KIT_ROOT / "template"
ENGINE = KIT_ROOT / "engine"

SKILLS = TEMPLATE / ".claude" / "skills"
AGENTS = TEMPLATE / ".claude" / "agents"
MEMORY = TEMPLATE / ".claude" / "memory"
ENTRY_FILES = [TEMPLATE / "CLAUDE.md", TEMPLATE / "AGENTS.md"]
VENDORED_JSON = SKILLS / "VENDORED.json"

# Skills the kit writes. Every other skill folder is vendored: copied from another author and listed in VENDORED.json.
KIT_SKILLS = ["catchup", "comprehension-gate", "handoff", "kb", "meeting-recap", "open-in-vscode"]
KIT_AGENTS = [
    "chart-builder", "email-writer", "english-coach", "gate-quiz", "governance-auditor", "kb-curator", "kb-lookup",
    "report-reviewer", "report-writer", "reviewer", "test-data-analyst", "test-plan-reviewer",
]
AGENT_MODELS = {
    "reviewer": "sonnet", "gate-quiz": "sonnet", "kb-lookup": "haiku", "kb-curator": "haiku",
    "governance-auditor": "sonnet", "chart-builder": "haiku", "test-data-analyst": "sonnet",
    "test-plan-reviewer": "sonnet", "report-writer": "sonnet", "report-reviewer": "opus",
    "email-writer": "sonnet", "english-coach": "haiku",
}
TIER_OF_MODEL = {"opus": "H", "sonnet": "M", "haiku": "L"}
VENDORED_NOTE = "source not recorded; check before external release"

# Commands the text names before the engine has the file. Remove an entry when the file lands in engine/.
NOT_YET_BUILT: set = set()

BANNED = []
ALLOWED_NON_ASCII = set("─┐┘│▼▶→←≤≥×·")

MAX_WORDS_SKILL = 900
MAX_WORDS_AGENT = 600
MAX_WORDS_RULES = 1400


def vendored_entries():
    return json.loads(VENDORED_JSON.read_text(encoding="utf-8"))["skills"]


def vendored_names():
    return {entry["name"] for entry in vendored_entries()}


def vendored_files():
    """Every file of every vendored skill folder, plus VENDORED.json itself."""
    files = [VENDORED_JSON]
    for name in sorted(vendored_names()):
        files += sorted(p for p in (SKILLS / name).rglob("*") if p.is_file())
    return files


def text_files():
    """The files the kit writes. Vendored skills are checked apart (VendoredTest)."""
    skip = set(vendored_files())
    files = []
    for folder in (SKILLS, AGENTS, MEMORY):
        files += sorted(p for p in folder.rglob("*") if p.is_file() and p not in skip)
    return files + ENTRY_FILES


def read(path):
    return path.read_text(encoding="utf-8")


def read_lf(path):
    return read(path).replace("\r\n", "\n")


def frontmatter(text):
    """Return the key/value pairs of the leading `---` block, or None."""
    match = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not match:
        return None
    data = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep:
            data[key.strip()] = value.strip()
    return data


def words(path):
    return len(read(path).split())


class SkillTest(unittest.TestCase):
    def test_skills_exist(self):
        names = sorted(p.name for p in SKILLS.iterdir() if p.is_dir())
        self.assertEqual(names, sorted(KIT_SKILLS + sorted(vendored_names())))
        self.assertEqual(set(KIT_SKILLS) & vendored_names(), set(), "a skill is both kit-written and vendored")

    def test_frontmatter(self):
        for folder in sorted(SKILLS / name for name in KIT_SKILLS):
            with self.subTest(skill=folder.name):
                skill = folder / "SKILL.md"
                self.assertTrue(skill.is_file())
                meta = frontmatter(read(skill))
                self.assertIsNotNone(meta, "no frontmatter")
                self.assertEqual(meta.get("name"), folder.name)
                self.assertTrue(meta.get("description"))

    def test_word_limit(self):
        for skill in sorted(SKILLS / name / "SKILL.md" for name in KIT_SKILLS):
            with self.subTest(skill=skill.parent.name):
                count = words(skill)
                print(f"words {skill.relative_to(TEMPLATE)}: {count}")
                self.assertLessEqual(count, MAX_WORDS_SKILL)


class AgentTest(unittest.TestCase):
    def test_agents_exist(self):
        names = sorted(p.stem for p in AGENTS.glob("*.md"))
        self.assertEqual(names, KIT_AGENTS)

    def test_frontmatter(self):
        for agent in sorted(AGENTS.glob("*.md")):
            with self.subTest(agent=agent.stem):
                meta = frontmatter(read(agent))
                self.assertIsNotNone(meta, "no frontmatter")
                self.assertEqual(meta.get("name"), agent.stem)
                for key in ("description", "tools", "model"):
                    self.assertTrue(meta.get(key), f"missing {key}")
                # An unquoted YAML value that holds ": " is a syntax error in Claude Code.
                self.assertNotIn(": ", meta["description"])

    def test_models(self):
        self.assertEqual(sorted(AGENT_MODELS), KIT_AGENTS)
        for name, model in AGENT_MODELS.items():
            with self.subTest(agent=name):
                self.assertEqual(frontmatter(read(AGENTS / f"{name}.md")).get("model"), model)

    def test_read_only_agents_keep_no_write_tool(self):
        read_only = ("governance-auditor", "test-plan-reviewer", "report-reviewer", "email-writer", "english-coach")
        for name in read_only:
            with self.subTest(agent=name):
                tools = {t.strip() for t in frontmatter(read(AGENTS / f"{name}.md"))["tools"].split(",")}
                self.assertEqual(tools & {"Write", "Edit", "MultiEdit", "NotebookEdit"}, set())

    def test_every_agent_has_the_tier_of_its_model(self):
        assign = json.loads(read(TEMPLATE / "kit.json"))["agents"]["assign"]
        self.assertEqual(sorted(assign), KIT_AGENTS)
        for name, model in AGENT_MODELS.items():
            with self.subTest(agent=name):
                self.assertEqual(assign[name], TIER_OF_MODEL[model])

    def test_word_limit(self):
        for agent in sorted(AGENTS.glob("*.md")):
            with self.subTest(agent=agent.stem):
                count = words(agent)
                print(f"words {agent.relative_to(TEMPLATE)}: {count}")
                self.assertLessEqual(count, MAX_WORDS_AGENT)


class VendoredTest(unittest.TestCase):
    """Skills copied from other authors: the kit does not rewrite them, so check the listing, the licence and the names."""

    def test_listing_shape(self):
        data = json.loads(read(VENDORED_JSON))
        self.assertEqual(data["schema"], 1)
        names = [entry["name"] for entry in data["skills"]]
        self.assertEqual(names, sorted(set(names)), "names must be unique and sorted")
        self.assertEqual(len(names), 10)
        for entry in data["skills"]:
            with self.subTest(skill=entry["name"]):
                self.assertEqual(sorted(entry), ["copyright", "license", "name", "note"])
                self.assertIn(entry["license"], ("MIT", "unknown"))

    def test_listing_matches_the_folders(self):
        folders = {p.name for p in SKILLS.iterdir() if p.is_dir()} - set(KIT_SKILLS)
        self.assertEqual(folders, vendored_names())

    def test_each_entry_matches_its_licence_file(self):
        for entry in vendored_entries():
            name = entry["name"]
            with self.subTest(skill=name):
                licence = SKILLS / name / "LICENSE"
                if entry["license"] == "MIT":
                    self.assertTrue(licence.is_file(), "MIT entry without a LICENSE file")
                    text = read_lf(licence)
                    self.assertTrue(text.startswith("MIT License"))
                    self.assertIn(entry["copyright"], text.splitlines())
                    self.assertTrue(entry["copyright"].startswith("Copyright (c)"))
                    self.assertEqual(entry["note"], "")
                else:
                    self.assertFalse(licence.exists(), "a LICENSE file exists but the entry says unknown")
                    self.assertEqual(entry["copyright"], "unknown")
                    self.assertEqual(entry["note"], VENDORED_NOTE)

    def test_each_skill_has_matching_frontmatter(self):
        for name in sorted(vendored_names()):
            with self.subTest(skill=name):
                skill = SKILLS / name / "SKILL.md"
                self.assertTrue(skill.is_file())
                meta = frontmatter(read_lf(skill))
                self.assertIsNotNone(meta, "no frontmatter")
                self.assertEqual(meta.get("name"), name)

    def test_no_project_names(self):
        checked = 0
        for path in vendored_files():
            try:
                text = read(path).lower()
            except UnicodeDecodeError:
                continue  # a binary file holds no readable name
            checked += 1
            for word in BANNED:
                with self.subTest(file=str(path.relative_to(SKILLS)), word=word):
                    self.assertNotIn(word.lower(), text)
        self.assertGreater(checked, 40)


class RulesTest(unittest.TestCase):
    def test_eighteen_rules(self):
        ids = re.findall(r"^- \*\*(G\d+)\*\*", read(MEMORY / "RULES.md"), re.M)
        self.assertEqual(ids, [f"G{n}" for n in range(1, 19)])

    def test_each_rule_has_a_why(self):
        text = read(MEMORY / "RULES.md")
        self.assertEqual(text.count("**Why:**"), 18)

    def test_word_limit(self):
        count = words(MEMORY / "RULES.md")
        print(f"words {(MEMORY / 'RULES.md').relative_to(TEMPLATE)}: {count}")
        self.assertLessEqual(count, MAX_WORDS_RULES)

    def test_other_memory_files(self):
        for name in ("MEMORY.md", "workflow.md"):
            with self.subTest(file=name):
                print(f"words .claude/memory/{name}: {words(MEMORY / name)}")
                self.assertTrue(read(MEMORY / name).strip())


class EntryFileTest(unittest.TestCase):
    def test_same_content(self):
        # tests/test_init.py requires the two files to be byte-identical after init.
        self.assertEqual((TEMPLATE / "CLAUDE.md").read_bytes(), (TEMPLATE / "AGENTS.md").read_bytes())
        for path in ENTRY_FILES:
            self.assertIn("Codex", read(path))

    def test_read_first_and_skills(self):
        for path in ENTRY_FILES:
            with self.subTest(file=path.name):
                text = read(path)
                for name in ("RULES.md", "MEMORY.md", "workflow.md", "{{project_name}}", "{{owner}}"):
                    self.assertIn(name, text)
                for skill in ("kb", "comprehension-gate", "catchup", "handoff"):
                    self.assertIn(f"`{skill}`", text)


class ContentTest(unittest.TestCase):
    def test_no_project_names(self):
        for path in text_files():
            text = read(path).lower()
            for word in BANNED:
                with self.subTest(file=path.name, word=word):
                    self.assertNotIn(word.lower(), text)

    def test_ascii_only(self):
        for path in text_files():
            with self.subTest(file=str(path.relative_to(TEMPLATE))):
                bad = sorted({c for c in read(path) if ord(c) > 127 and c not in ALLOWED_NON_ASCII})
                self.assertEqual(bad, [], f"characters outside the allowed set: {bad}")

    def test_placeholders(self):
        allowed = {"project_name", "owner", "owner_id", "lang"}
        for path in text_files():
            with self.subTest(file=str(path.relative_to(TEMPLATE))):
                found = set(re.findall(r"\{\{(\w+)\}\}", read(path)))
                self.assertLessEqual(found, allowed)

    def test_commands_name_existing_files(self):
        pattern = re.compile(r"python \.aikit/([\w./-]+\.py)")
        seen = set()
        for path in text_files():
            for rel in pattern.findall(read(path)):
                seen.add(rel)
                with self.subTest(file=str(path.relative_to(TEMPLATE)), command=rel):
                    self.assertTrue(
                        (ENGINE / rel).is_file() or rel in NOT_YET_BUILT,
                        f"{rel} is not in engine/ and not declared as not yet built",
                    )
        self.assertIn("kb/kb.py", seen)
        self.assertIn("competency/gate.py", seen)


if __name__ == "__main__":
    unittest.main()
