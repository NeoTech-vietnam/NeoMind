"""Tests for native skills and roles, phase 1 (plan langflow-native-skills-plan.md): the step contract, role tools
never widening step tools (F8), per-CLI skill copies (cli_skill) with `langflow check` warnings (F2), and role_mode
(append | agent | prompt) with its precedence and the Claude / Codex channels. No agent is called: the CLI adapters
run with `stream` replaced, and the engine with an in-process fake agent.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_native -v
"""
import io
import json
import os
import shutil
import subprocess
import tempfile
import threading
import tomllib
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from langflow import catalog, cli, engine, view, web
from langflow import project as projmod
from langflow.agents import AGENTS, base
from langflow.agents import claude as claude_adapter
from langflow.agents import codex as codex_adapter

SCHEMA = {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}
FLOW = f'''"""Native phase 1 test flow."""
from langflow import ai, gate

SCHEMA = {SCHEMA!r}
ROUNDS = {{"n": 0}}


def fail_once(result):
    ROUNDS["n"] += 1
    return (ROUNDS["n"] > 1, "FEEDBACK-MARK: say more")


def steps(args):
    return [
        ai("draft", "Write about {{topic}}", SCHEMA, agent="fake", role="writer", skills=["style"],
           memory=["run"], check=fail_once, retries=1),
        ai("quiet", "Quiet step", SCHEMA, agent="fake", role="writer", contract=False),
        ai("plain", "No binding", SCHEMA, agent="fake"),
        ai("coded", "Coded mode", SCHEMA, agent="fake", role="writer", role_mode="agent"),
        gate("look", "Look?"),
    ]
'''
CLAUDE_FLOW = f'''"""Claude role flow (the fake runs in place of claude)."""
from langflow import ai, gate

SCHEMA = {SCHEMA!r}


def steps(args):
    return [
        ai("own", "Own tools", SCHEMA, agent="claude", role="writer", tools=["Read", "Grep"]),
        ai("none", "No tools", SCHEMA, agent="claude", role="writer"),
        ai("rw", "Write allowed", SCHEMA, agent="claude", role="writer", sandbox="workspace-write"),
        ai("skills", "Skill copies", SCHEMA, agent="claude", skills=["humanizer", "only-agents"]),
        gate("look", "Look?"),
    ]
'''
CONFIG = '[project]\nname = "native test"\napprover = "tester"\n\n[retry]\nattempts = 0\n'
WRITER = "---\nname: writer\ndescription: Writes.\ntools: Read, Write, Edit, Bash, Grep\nmodel: opus\n---\nYou write well.\n"
STYLE = "---\nname: Style guide\ndescription: House style.\n---\nUse short sentences.\n"
HUMAN_A = "---\nname: humanizer\n---\nAgents copy.\n"
HUMAN_C = "---\nname: humanizer\n---\nClaude copy.\n"


def put(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class Fake:
    calls: list = []

    @classmethod
    def run(cls, project, prompt, schema, model, opts, cwd, timeout, say):
        cls.calls.append({"prompt": prompt, "model": model, "opts": opts})
        res = {"text": "ok", **({"memory": []} if "memory" in schema.get("properties", {}) else {})}
        return {"result": res, "session": "s", "hooks": None, "usage": base.usage(10, 1), "cost_usd": 0.0,
                "model_used": model, "role_channel": "fake"}


class NativeProject(unittest.TestCase):
    """A temp project with a fake HOME (catalog._home) for personal skill copies."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_native_test_"))
        cls.home = Path(tempfile.mkdtemp(prefix="langflow_native_home_"))
        r = cls.tmp
        put(r / ".langflow" / "config.toml", CONFIG)
        put(r / ".langflow" / "workflows" / "flow.py", FLOW)
        put(r / ".langflow" / "workflows" / "cflow.py", CLAUDE_FLOW)
        put(r / ".claude" / "agents" / "writer.md", WRITER)
        put(r / ".claude" / "skills" / "style" / "SKILL.md", STYLE)
        put(r / ".agents" / "skills" / "humanizer" / "SKILL.md", HUMAN_A)
        put(r / ".claude" / "skills" / "humanizer" / "SKILL.md", HUMAN_C)
        put(r / ".agents" / "skills" / "only-agents" / "SKILL.md", "---\nname: only\n---\nOnly here.\n")
        cls.old_cwd = os.getcwd()
        os.chdir(r)
        projmod.set_current(projmod.load(r))
        AGENTS["fake"] = Fake.run
        cls.home_patch = mock.patch.object(catalog, "_home", lambda: cls.home)
        cls.home_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.home_patch.stop()
        AGENTS.pop("fake", None)
        os.chdir(cls.old_cwd)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.home, ignore_errors=True)

    def setUp(self):
        Fake.calls = []
        b = self.tmp / catalog.BINDINGS_FILE
        if b.exists():
            b.unlink()
        shutil.rmtree(self.home, ignore_errors=True)
        self.home.mkdir()
        self.set_config(CONFIG)

    def set_config(self, text):
        put(self.tmp / ".langflow" / "config.toml", text)
        projmod.set_current(projmod.load(self.tmp))


# ---------------------------------------------------------------- 1. cli_skill (F2)

class CliSkillTest(NativeProject):
    def test_claude_reads_only_claude_skills(self):
        p = projmod.current()
        c = catalog.cli_skill(p, "claude", "humanizer")
        self.assertEqual((c["path"], c["source"]), (".claude/skills/humanizer/SKILL.md", "project"))
        self.assertEqual(c["sha256"], catalog.sha256_file(self.tmp / ".claude/skills/humanizer/SKILL.md"))
        self.assertIsNone(catalog.cli_skill(p, "claude", "only-agents"))       # Claude does not read .agents/skills
        # the catalog's first copy is .agents/skills; the record keeps both
        res = catalog.resolve(p, "claude", None, ["humanizer"])
        s = res["skills"][0]
        self.assertEqual((s["path"], s["via"]), (".agents/skills/humanizer/SKILL.md", "inject"))
        rec = catalog.record(res)["skills"][0]
        self.assertEqual(rec["cli"]["path"], ".claude/skills/humanizer/SKILL.md")
        notes = catalog.skill_notes("claude", s)
        self.assertEqual(len(notes), 1)
        self.assertIn("claude loads .claude/skills/humanizer/SKILL.md #", notes[0])
        self.assertIn("the catalog's first copy (the text langflow sends) is .agents/skills/humanizer", notes[0])
        # skill_mode "name" needs the CLI's own copy
        only = catalog.resolve(p, "claude", None, ["only-agents"], "name")["skills"][0]
        self.assertIsNone(only["cli"])
        self.assertIn("claude does not read .agents/skills/only-agents/SKILL.md",
                      catalog.skill_notes("claude", only, "name")[0])
        self.assertEqual(catalog.skill_notes("claude", only, "inject"), [])

    def test_personal_shadow_wins_for_claude(self):
        put(self.home / ".claude/skills/humanizer/SKILL.md", "---\nname: humanizer\n---\nPersonal.\n")
        p = projmod.current()
        c = catalog.cli_skill(p, "claude", "humanizer")
        self.assertEqual((c["path"], c["source"]), ("~/.claude/skills/humanizer/SKILL.md", "personal"))
        self.assertEqual(c["shadow"][0]["path"], ".claude/skills/humanizer/SKILL.md")
        s = catalog.resolve(p, "claude", None, ["humanizer"])["skills"][0]
        self.assertIn("claude loads the personal copy ~/.claude/skills/humanizer/SKILL.md",
                      catalog.skill_notes("claude", s)[0])
        # a personal copy alone also counts (Claude reads it)
        put(self.home / ".claude/skills/only-agents/SKILL.md", "x")
        self.assertEqual(catalog.cli_skill(p, "claude", "only-agents")["source"], "personal")
        # drift of the personal copy is found (read for its hash only)
        rec = catalog.record(catalog.resolve(p, "claude", None, ["humanizer"]))
        self.assertEqual(catalog.changes(p, rec), [])
        put(self.home / ".claude/skills/humanizer/SKILL.md", "changed")
        self.assertEqual(catalog.changes(p, rec), ["skill humanizer changed (~/.claude/skills/humanizer/SKILL.md, "
                                                   "the copy the CLI loads)"])

    def test_codex_reads_agents_skills_and_lists_shadows(self):
        put(self.home / ".codex/skills/humanizer/SKILL.md", "---\nname: humanizer\n---\nOld codex copy.\n")
        p = projmod.current()
        c = catalog.cli_skill(p, "codex", "humanizer")
        self.assertEqual((c["path"], c["source"]), (".agents/skills/humanizer/SKILL.md", "project"))
        self.assertEqual([s["path"] for s in c["shadow"]], ["~/.codex/skills/humanizer/SKILL.md"])
        s = catalog.resolve(p, "codex", None, ["humanizer"])["skills"][0]
        self.assertNotIn("cli", catalog.record({"role": None, "skills": [s]})["skills"][0])   # same file
        self.assertEqual(catalog.skill_notes("codex", s),
                         [f"humanizer: codex also sees ~/.codex/skills/humanizer/SKILL.md "
                          f"#{c['shadow'][0]['sha256'][:8]} (another text)"])
        self.assertIsNone(catalog.cli_skill(p, "codex", "style"))              # only in .claude/skills

    def test_opencode_uses_catalog_copy(self):
        p = projmod.current()
        for sid, path in (("style", ".claude/skills/style/SKILL.md"), ("humanizer", ".agents/skills/humanizer/SKILL.md")):
            c = catalog.cli_skill(p, "opencode", sid)
            self.assertEqual((c["path"], c["source"], c["shadow"]), (path, "catalog", []))
        self.assertIsNone(catalog.cli_skill(p, "opencode", "nope"))
        self.assertIsNone(catalog.cli_skill(p, "claude", "../x"))


# ---------------------------------------------------------------- 2. modes precedence, values

class ModesTest(NativeProject):
    def role(self, native=True):
        return {"id": "writer", "native": native}

    def test_default_keeps_old_behaviour(self):
        p = projmod.current()
        eff = catalog.effective({"role": "writer"})
        m = catalog.modes(p, eff, "claude", self.role(True))
        self.assertEqual((m["role_mode"], m["explicit"], m["from"]["role_mode"]), ("append", False, "default"))
        self.assertEqual(catalog.modes(p, eff, "claude", self.role(False))["role_mode"], "append")
        self.assertEqual(catalog.modes(p, eff, "codex", self.role(True))["role_mode"], "prompt")
        self.assertEqual(catalog.modes(p, eff, "opencode", self.role(False))["role_mode"], "prompt")
        self.assertEqual(catalog.modes(p, eff, "other", self.role(False))["role_mode"], "prompt")
        self.assertEqual((m["contract"], m["contract_system"], m["from"]["contract"]), (True, False, "default"))
        self.assertIsNone(catalog.modes(p, eff, "claude", None)["role_mode"])     # no role, no mode

    def test_precedence(self):
        p = projmod.current()
        self.set_config(CONFIG + '\n[catalog]\nrole_mode = "prompt"\ncontract = false\n')
        p = projmod.current()
        code = {"role": "writer", "role_mode": "agent"}
        over = {"role_mode": "append", "contract": True}
        args = {"role_mode.draft": "prompt", "contract.draft": "false"}
        self.assertEqual(catalog.modes(p, catalog.effective({"role": "writer"}), "claude", self.role())["from"],
                         {"role_mode": "config", "contract": "config", "skill_mode": "default",
                          "native_fallback": "default", "retry_mode": "default"})            # config > default
        m = catalog.modes(p, catalog.effective(code), "claude", self.role())
        self.assertEqual((m["role_mode"], m["from"]["role_mode"], m["explicit"]), ("agent", "code", True))
        m = catalog.modes(p, catalog.effective(code, over), "claude", self.role())
        self.assertEqual((m["role_mode"], m["from"]["role_mode"], m["contract"]), ("append", "bindings", True))
        m = catalog.modes(p, catalog.effective(code, over, args, "draft"), "claude", self.role())
        self.assertEqual((m["role_mode"], m["from"]["role_mode"]), ("prompt", "run"))
        self.assertEqual((m["contract"], m["from"]["contract"]), (False, "run"))
        # role_mode.* and the fan-out name work like role.<step>
        m = catalog.modes(p, catalog.effective(code, None, {"role_mode.*": "append"}, "w[3]"), "claude", self.role())
        self.assertEqual(m["role_mode"], "append")
        # "" means: not set by the run
        m = catalog.modes(p, catalog.effective(code, None, {"role_mode.draft": ""}, "draft"), "claude", self.role())
        self.assertEqual(m["from"]["role_mode"], "code")

    def test_mode_a_cli_cannot_give(self):
        p = projmod.current()
        eff = catalog.effective({"role": "writer", "role_mode": "agent"})
        m = catalog.modes(p, eff, "claude", self.role(False))
        self.assertEqual(m["role_mode"], "append")
        self.assertIn("needs .claude/agents/writer.md", m["note"])
        self.assertEqual(catalog.modes(p, eff, "codex", self.role(True))["role_mode"], "append")
        eff = catalog.effective({"role": "writer", "role_mode": "append"})
        self.assertEqual(catalog.modes(p, eff, "opencode", self.role(False))["role_mode"], "append")

    def test_bad_values(self):
        with self.assertRaises(ValueError):
            catalog.check_values({"role_mode": "system"})
        with self.assertRaises(ValueError):
            catalog.check_values({"contract": "maybe"})
        self.assertEqual(catalog.check_values({"contract": "off", "role_mode": "agent"}),
                         {"contract": False, "role_mode": "agent"})
        with self.assertRaises(ValueError):
            catalog.effective({"role": "w"}, None, {"role_mode.draft": "native"}, "draft")
        with self.assertRaises(ValueError):
            engine.ai("x", "p", SCHEMA, role_mode="native")
        with self.assertRaises(ValueError):
            catalog._parse('[wf.step]\nrole_mode = "x"\n')
        self.assertEqual(catalog._parse('[wf.step]\nrole_mode = "append"\ncontract = false\n'),
                         {"wf": {"step": {"role_mode": "append", "contract": False}}})
        # a bad config value is ignored (built-in default), not fatal
        self.set_config(CONFIG + '\n[catalog]\nrole_mode = "x"\ncontract = "no"\n')
        self.assertEqual(catalog.config_modes(projmod.current()), {})

    def test_bindings_toml_round_trip(self):
        p = projmod.current()
        catalog.set_binding(p, "flow", "draft", {"role_mode": "append", "contract": False})
        text = (self.tmp / catalog.BINDINGS_FILE).read_text(encoding="utf-8")
        self.assertIn('role_mode = "append"\ncontract = false\n', text)
        self.assertEqual(catalog.read_bindings(p), {"flow": {"draft": {"role_mode": "append", "contract": False}}})


# ---------------------------------------------------------------- 3. prompt build (engine with a fake agent)

class PromptTest(NativeProject):
    def run_flow(self, run, args=None):
        run, app, payload = cli.prepare_start("flow", run, {"topic": "pumps", **(args or {})})
        state, msg = cli.advance(app, run, payload)
        self.assertEqual(state, "waiting", msg)
        return run

    def test_contract_last_after_memory_and_feedback(self):
        run = self.run_flow("p-1")
        first, retry = Fake.calls[0], Fake.calls[1]
        for c in (first, retry):
            self.assertTrue(c["prompt"].endswith("\n\n---\n\n" + catalog.CONTRACT), c["prompt"][-200:])
            self.assertEqual(c["prompt"].count(catalog.CONTRACT), 1)
            self.assertLess(c["prompt"].index("Use short sentences."), c["prompt"].index("Write about pumps"))
            self.assertLess(c["prompt"].index("(empty)"), c["prompt"].index(catalog.CONTRACT))    # memory block
        self.assertLess(retry["prompt"].index("FEEDBACK-MARK"), retry["prompt"].index(catalog.CONTRACT))
        self.assertLess(len(catalog.CONTRACT), 600)
        # contract=False leaves it out; a step without a binding never gets it
        quiet = next(c for c in Fake.calls if c["prompt"].startswith("Quiet step"))
        self.assertEqual(quiet["prompt"], "Quiet step")
        self.assertEqual(next(c for c in Fake.calls if c["prompt"].startswith("No binding"))["prompt"], "No binding")
        st = engine.read_status(run)
        starts = {h["step"]: h for h in st["history"] if h.get("event") == "start"}
        self.assertEqual((starts["draft"]["contract"], starts["quiet"]["contract"]), (True, False))
        self.assertNotIn("contract", starts["plain"])
        self.assertEqual(starts["draft"]["binding"]["skills"][0]["via"], "inject")
        self.assertEqual(starts["draft"]["binding"]["role"]["mode"], "prompt")
        self.assertEqual(starts["coded"]["role_mode"], "prompt")        # fake CLI: agent -> prompt (noted)
        done = next(h for h in st["history"] if h.get("step") == "draft" and h.get("event") == "done")
        self.assertEqual(done["role_channel"], "fake")
        _, info = view.step_states(st)
        self.assertEqual((info["draft"]["role_mode"], info["draft"]["contract"]), ("prompt", True))
        self.assertIn("role writer [prompt]", view._detail(info["draft"]))
        log = engine.log_path(run).read_text(encoding="utf-8")
        self.assertIn("role_mode: fake has no system channel for a role yet; prompt used", log)

    def test_run_args_and_bindings_switch_contract(self):
        catalog.set_binding(projmod.current(), "flow", "quiet", {"contract": True})
        self.run_flow("p-2", {"contract.draft": "false"})
        draft = Fake.calls[0]
        self.assertNotIn(catalog.CONTRACT, draft["prompt"])
        quiet = next(c for c in Fake.calls if c["prompt"].startswith("Quiet step"))
        self.assertEqual(quiet["prompt"], catalog.with_contract("Quiet step"))
        with self.assertRaises(SystemExit):                      # a bad run arg is refused before the start
            cli.prepare_start("flow", "p-3", {"topic": "x", "role_mode.draft": "bogus"})


# ---------------------------------------------------------------- F8: role tools never widen step tools

class RoleToolsTest(NativeProject):
    def test_role_tools_helper(self):
        self.assertEqual(catalog.role_tools(["Read", "Write", "Edit", "Bash(git *)", "Grep"], "read-only"),
                         ["Read", "Grep"])
        self.assertEqual(catalog.role_tools(["Read", "Write"], "workspace-write"), ["Read", "Write"])
        self.assertIsNone(catalog.role_tools(["Write"], "read-only"))
        self.assertIsNone(catalog.role_tools(None, "read-only"))

    def test_engine_applies_role_tools_only_under_agent(self):
        with mock.patch.dict(AGENTS, {"claude": Fake.run}):
            run, app, payload = cli.prepare_start("cflow", "t-1", {})
            self.assertEqual(cli.advance(app, run, payload)[0], "waiting")
            calls = {c["prompt"].split("\n")[0]: c["opts"] for c in Fake.calls}
            self.assertEqual(calls["Own tools"]["tools"], ["Read", "Grep"])          # the step's own, not widened
            self.assertIsNone(calls["No tools"]["tools"])        # automatic = append: role tools not applied
            self.assertIsNone(calls["Write allowed"]["tools"])
            # role_mode agent: role tools when the step has none, minus Write/Edit/Bash under read-only (F8)
            run, app, payload = cli.prepare_start("cflow", "t-3", {"role_mode.*": "agent"})
            Fake.calls = []
            cli.advance(app, run, payload)
            calls = {c["prompt"].split("\n")[0]: c["opts"] for c in Fake.calls}
            self.assertEqual(calls["Own tools"]["tools"], ["Read", "Grep"])
            self.assertEqual(calls["No tools"]["tools"], ["Read", "Grep"])
            self.assertEqual(calls["Write allowed"]["tools"], ["Read", "Write", "Edit", "Bash", "Grep"])
            # role_mode append: the role's tools do not apply at all
            run, app, payload = cli.prepare_start("cflow", "t-2", {"role_mode.*": "append"})
            Fake.calls = []
            cli.advance(app, run, payload)
            calls = {c["prompt"].split("\n")[0]: c["opts"] for c in Fake.calls}
            self.assertIsNone(calls["No tools"]["tools"])
            self.assertEqual(calls["No tools"]["role_mode"], "append")
            self.assertTrue(calls["No tools"]["run_dir"].endswith(os.path.join("runs", "t-2")))


# ---------------------------------------------------------------- 4. Claude argv

class ClaudeArgsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_native_claude_"))
        self.p = projmod.Project(self.tmp, {})
        self.seen = {}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_stream(self, args, prompt, cwd, env, timeout, handle):
        self.seen.update(args=args, prompt=prompt)
        handle({"type": "result", "structured_output": {"text": "x"}, "session_id": "s", "usage": {}})
        return 0, ""

    def role(self, native=True, text="Be careful & <quote> \"x\" | ^ %PATH%"):
        return {"id": "writer", "name": "writer-agent", "source": "claude" if native else "langflow",
                "path": ".claude/agents/writer.md", "sha256": "0" * 64, "native": native, "model": None,
                "effort": None, "tools": None, "instructions": text}

    def claude(self, opts, project=None):
        with mock.patch.object(claude_adapter, "stream", self.fake_stream), \
                mock.patch.object(claude_adapter.shutil, "which", lambda n: "claude.exe"), \
                mock.patch.object(claude_adapter, "git_bash", lambda s: "bash.exe"):
            out = claude_adapter.run(project or self.p, "PROMPT", SCHEMA, None, opts, self.tmp, 60, lambda t: None)
        return self.seen["args"], self.seen["prompt"], out

    def test_append_uses_system_file(self):
        run_dir = self.tmp / "state" / "runs" / "r1"
        args, prompt, out = self.claude({"role": self.role(False, "x" * 40000), "role_mode": "append",
                                         "run_dir": str(run_dir), "step": "verify[2]"})
        f = Path(args[args.index("--append-system-prompt-file") + 1])
        self.assertEqual(f, run_dir / "verify[2].system.md")
        self.assertEqual(f.read_bytes().decode("utf-8"), catalog.role_text(self.role(False, "x" * 40000)))
        self.assertFalse(f.read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertEqual(prompt, "PROMPT")
        self.assertNotIn("--agent", args)
        self.assertNotIn("--append-system-prompt", args)
        self.assertTrue(all(len(a) <= 2000 for a in args if not a.startswith("{")), "no long argv element")
        self.assertEqual(out["role_channel"], "append-file")
        # a native role under append: its text in the file, no --agent
        args, prompt, out = self.claude({"role": self.role(True), "role_mode": "append"})
        f = Path(args[args.index("--append-system-prompt-file") + 1])
        try:
            self.assertIn("Be careful & <quote>", f.read_text(encoding="utf-8"))   # %TEMP% without a run folder
        finally:
            f.unlink()
        self.assertNotIn("--agent", args)

    def test_agent_limits_tools(self):
        args, prompt, out = self.claude({"role": self.role(True), "role_mode": "agent", "tools": ["Read", "Grep",
                                         "Bash(python kb.py *)"], "step_tools": ["Read", "Grep",
                                         "Bash(python kb.py *)"], "sandbox": "read-only"})
        self.assertEqual(args[args.index("--agent") + 1], "lf-writer")       # a copy that keeps StructuredOutput
        agents = json.loads(Path(args[args.index("--agents") + 1]).read_text(encoding="utf-8"))
        self.assertEqual(agents["lf-writer"]["tools"], ["Read", "Grep", "Bash", "StructuredOutput"])
        self.assertEqual(args[args.index("--tools") + 1], "Read,Grep,Bash,StructuredOutput")
        self.assertEqual(args[args.index("--disallowedTools") + 1], "Write,Edit,NotebookEdit")
        self.assertEqual(args[args.index("--allowedTools") + 1], "Read,Grep,Bash(python kb.py *)")
        self.assertNotIn("--append-system-prompt", args)
        self.assertEqual(out["role_channel"], "agent")
        # the automatic mode (role_mode None) with a native role is append: no --agent, no limits needed
        args, _, _ = self.claude({"role": self.role(True), "tools": ["Read"], "sandbox": "read-only"})
        self.assertNotIn("--agent", args)
        self.assertNotIn("--disallowedTools", args)
        # a step that allows Write itself keeps it; workspace-write disallows nothing
        args, _, _ = self.claude({"role": self.role(True), "role_mode": "agent", "tools": ["Read", "Write"],
                                  "step_tools": ["Read", "Write"], "sandbox": "read-only"})
        self.assertEqual(args[args.index("--disallowedTools") + 1], "Edit,NotebookEdit")
        args, _, _ = self.claude({"role": self.role(True), "role_mode": "agent", "sandbox": "workspace-write"})
        self.assertNotIn("--disallowedTools", args)
        self.assertNotIn("--tools", args)
        # [agents.claude] restrict_tools = false turns the limits off
        p = projmod.Project(self.tmp, {"agents": {"claude": {"restrict_tools": False}}})
        args, _, _ = self.claude({"role": self.role(True), "role_mode": "agent", "tools": ["Read"],
                                  "sandbox": "read-only"}, p)
        self.assertNotIn("--tools", args)
        self.assertNotIn("--disallowedTools", args)
        # contract in the agent's system prompt when the engine passes it ([catalog] contract_system = true)
        args, _, _ = self.claude({"role": self.role(True), "role_mode": "agent", "contract": catalog.CONTRACT})
        self.assertEqual(args[args.index("--append-system-prompt") + 1], catalog.CONTRACT)

    def test_prompt_and_automatic(self):
        args, prompt, out = self.claude({"role": self.role(True), "role_mode": "prompt"})
        self.assertNotIn("--agent", args)
        self.assertTrue(prompt.startswith("Role for this step: writer"))
        self.assertTrue(prompt.endswith("PROMPT"))
        self.assertEqual(out["role_channel"], "prompt")
        args, prompt, out = self.claude({"role": self.role(False)})               # automatic, non-native: as before
        self.assertIn("Be careful", args[args.index("--append-system-prompt") + 1])
        self.assertEqual(out["role_channel"], "append")
        args, prompt, out = self.claude({})
        self.assertIsNone(out["role_channel"])


# ---------------------------------------------------------------- Codex: launcher, TOML string, argv

class CodexTest(unittest.TestCase):
    TRICKY = ['plain', 'quote " and \\ backslash', "& | < > ^ % !x! %PATH%", "line1\nline2\r\n\ttab",
              "Tiếng Việt: hiểu đúng yêu cầu", "'''triple''' and \"\"\"three\"\"\"", "ctrl \x01 \x1f \x7f", ""]

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_native_codex_"))
        self.p = projmod.Project(self.tmp, {})
        self.seen = {}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def npm(self, node=True, vendor=True, js=True):
        d = self.tmp / "npm"
        put(d / "codex.cmd", "@echo off\n")
        if js:
            put(d / "node_modules/@openai/codex/bin/codex.js", "// js\n")
        if node:
            put(d / "node.exe", "")
        if vendor:
            put(d / "node_modules/@openai/codex" / codex_adapter.VENDOR_EXE, "")
        return d

    def test_launcher(self):
        d = self.npm()
        self.assertEqual(codex_adapter.launcher(str(d / "codex.cmd")),
                         ([str(d / "node.exe"), str(d / "node_modules/@openai/codex/bin/codex.js")], {}))
        self.assertEqual(codex_adapter.launcher(str(d / "codex.CMD"))[0][0], str(d / "node.exe"))
        (d / "node.exe").unlink()
        with mock.patch.object(codex_adapter.shutil, "which", lambda n: "C:/node/node.exe"):
            self.assertEqual(codex_adapter.launcher(str(d / "codex.cmd"))[0][0], "C:/node/node.exe")
        with mock.patch.object(codex_adapter.shutil, "which", lambda n: None):
            prefix, env = codex_adapter.launcher(str(d / "codex.cmd"))
            self.assertTrue(prefix[0].endswith("codex.exe"))
            self.assertEqual(env["CODEX_MANAGED_BY_NPM"], "1")
            self.assertTrue(env["CODEX_MANAGED_PACKAGE_ROOT"].endswith("codex"))
            shutil.rmtree(d / "node_modules/@openai/codex/node_modules")
            self.assertIsNone(codex_adapter.launcher(str(d / "codex.cmd")))
        self.assertIsNone(codex_adapter.launcher(str(self.tmp / "other" / "codex.cmd")))   # no npm folder
        self.assertEqual(codex_adapter.launcher("/usr/bin/codex"), (["/usr/bin/codex"], {}))
        self.assertIsNone(codex_adapter.launcher(None))

    def test_toml_str_round_trip(self):
        for s in self.TRICKY:
            v = codex_adapter.toml_str(s)
            self.assertEqual(tomllib.loads(f"developer_instructions = {v}\n")["developer_instructions"], s)
            self.assertNotIn("\n", v)
        with self.assertRaises(ValueError):
            codex_adapter.toml_str("lone \ud800 surrogate")

    def test_argv_survives_createprocess_quoting(self):
        """The value goes through list2cmdline (CreateProcess) and back with the MSVC rules unchanged."""
        if os.name != "nt":
            self.skipTest("Windows quoting")
        import ctypes
        from ctypes import wintypes
        CommandLineToArgvW = ctypes.windll.shell32.CommandLineToArgvW
        CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
        CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
        for s in self.TRICKY[:-1]:
            arg = "developer_instructions=" + codex_adapter.toml_str(s)
            line = subprocess.list2cmdline(["node.exe", "codex.js", "exec", "-c", arg])
            n = ctypes.c_int()
            argv = CommandLineToArgvW(line, ctypes.byref(n))
            back = [argv[i] for i in range(n.value)]
            ctypes.windll.kernel32.LocalFree(argv)
            self.assertEqual(back[4], arg)

    def run_codex(self, opts, exe):
        def stream(args, prompt, cwd, env, timeout, handle):
            self.seen.update(args=args, prompt=prompt, env=env)
            handle({"type": "thread.started", "thread_id": "t"})
            handle({"type": "item.completed", "item": {"type": "agent_message", "text": '{"text": "x"}'}})
            return 0, ""
        with mock.patch.object(codex_adapter, "stream", stream), \
                mock.patch.object(codex_adapter.shutil, "which", lambda n: exe if n == "codex" else None):
            return codex_adapter.run(self.p, "PROMPT", SCHEMA, None, opts, self.tmp, 60, lambda t: None)

    def role(self, text="Rule & | < > ^ % \"q\"\nTiếng Việt."):
        return {"id": "writer", "name": "writer", "source": "codex", "path": ".codex/agents/writer.toml",
                "sha256": "0" * 64, "native": True, "model": None, "effort": None, "tools": None, "instructions": text}

    def test_append_through_launcher(self):
        d = self.npm()
        out = self.run_codex({"role": self.role(), "role_mode": "append"}, str(d / "codex.cmd"))
        a = self.seen["args"]
        self.assertEqual(a[:3], [str(d / "node.exe"), str(d / "node_modules/@openai/codex/bin/codex.js"), "exec"])
        self.assertEqual(a[3], "-c")
        v = tomllib.loads(a[4])["developer_instructions"]
        self.assertEqual(v, catalog.role_text(self.role()))
        self.assertEqual(self.seen["prompt"], "PROMPT")
        self.assertEqual(a[-3:], ["-s", "read-only", "-"])
        self.assertEqual(out["role_channel"], "developer_instructions")
        # agent = append for Codex
        self.run_codex({"role": self.role(), "role_mode": "agent"}, str(d / "codex.cmd"))
        self.assertTrue(self.seen["args"][4].startswith("developer_instructions="))

    def test_append_fallbacks(self):
        d = self.npm(node=False, vendor=False)
        with mock.patch.object(codex_adapter.shutil, "which", lambda n: None):
            self.assertIsNone(codex_adapter.launcher(str(d / "codex.cmd")))
        out = self.run_codex({"role": self.role(), "role_mode": "append"}, str(d / "codex.cmd"))
        self.assertEqual(self.seen["args"][:2], [str(d / "codex.cmd"), "exec"])        # stdin only, as before
        self.assertNotIn("-c", self.seen["args"][:3])
        self.assertTrue(self.seen["prompt"].startswith("Role for this step: writer"))
        self.assertEqual(out["role_channel"], "prompt")
        # too long for the command line: before the prompt, through the shim
        d = self.npm()
        out = self.run_codex({"role": self.role("y" * 40000), "role_mode": "append"}, str(d / "codex.cmd"))
        self.assertEqual(self.seen["args"][0], str(d / "codex.cmd"))
        self.assertTrue(self.seen["prompt"].startswith("Role for this step: writer"))
        self.assertEqual(out["role_channel"], "prompt")
        # automatic (None) and prompt: before the prompt, as before
        for mode in (None, "prompt"):
            out = self.run_codex({"role": self.role(), "role_mode": mode}, str(d / "codex.cmd"))
            self.assertEqual(self.seen["args"][0], str(d / "codex.cmd"))
            self.assertEqual(out["role_channel"], "prompt")


# ---------------------------------------------------------------- 9. langflow check, web

class CheckAndWebTest(NativeProject):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.server, cls.token = web.serve(0, quiet=True)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        super().tearDownClass()

    def api(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"X-Langflow-Token": self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_check_output(self):
        put(self.home / ".claude/skills/humanizer/SKILL.md", "personal")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.cmd_check("cflow", []), 0)
        lines = out.getvalue().splitlines()
        sha = {k: catalog.sha256_file(self.tmp / k)[:8] for k in (".agents/skills/humanizer/SKILL.md",
                                                                 ".agents/skills/only-agents/SKILL.md")}
        psha = catalog.sha256_file(self.home / ".claude/skills/humanizer/SKILL.md")[:8]
        self.assertEqual(lines[0], "workflow cflow: 4 ai steps (skill_mode inject, role_mode auto, retry_mode resume, "
                                   "contract on)")
        self.assertTrue(lines[1].startswith("  own                  claude    role writer [append · claude file] (code)"))
        self.assertIn("  none                 claude    role writer [append · claude file] (code)", out.getvalue())
        self.assertIn(f"skill humanizer [inject .agents/skills/humanizer/SKILL.md #{sha['.agents/skills/humanizer/SKILL.md']}; "
                      f"claude loads ~/.claude/skills/humanizer/SKILL.md #{psha}]", out.getvalue())
        self.assertIn(f"skill only-agents [inject .agents/skills/only-agents/SKILL.md "
                      f"#{sha['.agents/skills/only-agents/SKILL.md']}; claude has no copy of its own]", out.getvalue())
        self.assertIn("warning: humanizer: claude loads the personal copy ~/.claude/skills/humanizer/SKILL.md #"
                      f"{psha}, not the project's .claude/skills/humanizer/SKILL.md", out.getvalue())
        self.assertEqual(lines[-1], "OK: every role and skill exists")
        # modes from a run arg and config show in the line and the header
        self.set_config(CONFIG + '\n[catalog]\ncontract = false\n')
        out = io.StringIO()
        with redirect_stdout(out):
            cli.cmd_check("cflow", ["role_mode.own=prompt"])
        self.assertIn("role_mode auto, retry_mode resume, contract off)", out.getvalue())
        self.assertIn("role writer [prompt · claude file] (code, mode run)", out.getvalue())
        self.assertIn("(no step contract)", out.getvalue())

    def test_web_bindings_modes(self):
        code, body = self.api("PUT", "/api/workflows/cflow/bindings/none", {"role_mode": "append", "contract": False})
        self.assertEqual(code, 200, body)
        s = {x["step"]: x for x in body["steps"]}
        self.assertEqual(s["none"]["override"], {"role_mode": "append", "contract": False})
        self.assertEqual((s["none"]["effective"]["role_mode"], s["none"]["effective"]["from"]["role_mode"]),
                         ("append", "bindings"))
        self.assertEqual((s["none"]["modes"]["role_mode"], s["none"]["modes"]["contract"]), ("append", False))
        self.assertEqual(s["own"]["modes"]["from"]["role_mode"], "default")
        det = {d["id"]: d for d in s["skills"]["effective"]["skills_detail"]}
        self.assertEqual(det["humanizer"]["cli"]["path"], ".claude/skills/humanizer/SKILL.md")
        self.assertEqual(det["humanizer"]["via"], "inject")
        self.assertIsNone(det["only-agents"]["cli"])
        self.assertTrue(any("humanizer: claude loads .claude/skills" in w for w in s["skills"]["warnings"]))
        self.assertEqual(body["defaults"], {"role_mode": None, "contract": True, "skill_mode": "inject",
                                            "native_fallback": "system", "retry_mode": "resume"})
        self.assertIn('[cflow.none]\nrole_mode = "append"\ncontract = false',
                      (self.tmp / catalog.BINDINGS_FILE).read_text(encoding="utf-8"))
        self.assertEqual(self.api("PUT", "/api/workflows/cflow/bindings/none", {"role_mode": "native"})[0], 400)
        code, body = self.api("GET", "/api/catalog")
        self.assertEqual((body["role_mode"], body["contract"]), (None, True))


if __name__ == "__main__":
    unittest.main()
