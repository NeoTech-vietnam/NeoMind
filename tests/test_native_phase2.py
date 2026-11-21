"""Tests for native skills and roles, phase 2 (plan langflow-native-skills-plan.md): skill_mode "system" / "native"
with native_fallback, retry_mode "resume", their precedence, the Claude and Codex argv, the after-call skill check
(skills_loaded), the engine's native fallback and resume paths, `langflow check` and the web bindings fields. No
agent is called: the CLI adapters run with `stream` replaced, and the engine with an in-process fake agent.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_native_phase2 -v
"""
import io
import json
import os
import shutil
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
FLOW = f'''"""Native phase 2 test flow (agent "claude" / "codex" are replaced by a fake in the tests)."""
from langflow import ai, gate

SCHEMA = {SCHEMA!r}
ROUNDS = {{"n": 0}}


def fail_once(result):
    ROUNDS["n"] += 1
    return (ROUNDS["n"] % 2 == 0, "FEEDBACK-MARK: say more")


def steps(args):
    agent = args.get("agent", "claude")
    return [
        ai("draft", "Write about {{topic}}", SCHEMA, agent=agent, role="writer", skills=["style", "humanizer"],
           check=fail_once if args.get("fail") else None, retries=1),
        gate("look", "Look?"),
    ]
'''
CONFIG = '[project]\nname = "native2 test"\napprover = "tester"\n\n[retry]\nattempts = 0\n'
WRITER = "---\nname: writer\ndescription: Writes.\ntools: Read, Write\n---\nYou write well. ROLE-TEXT\n"
STYLE = "---\nname: Style guide\ndescription: House style.\n---\n\nUse short sentences. STYLE-TEXT\n"
HUMAN_A = "---\nname: humanizer\n---\nAgents copy. HUMAN-A\n"
HUMAN_C = "---\nname: humanizer\n---\nClaude copy. HUMAN-C\n"


def put(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class Fake:
    """An agent that records its calls. loaded: None = it loads every native skill it gets; a list = only those.
    resume_error: the resumed call raises AgentError with this text."""
    calls: list = []
    loaded = None
    resume_error = None

    @classmethod
    def run(cls, project, prompt, schema, model, opts, cwd, timeout, say):
        cls.calls.append({"prompt": prompt, "opts": {k: v for k, v in opts.items() if k != "skills"},
                          "skills": [dict(s) for s in opts.get("skills") or []]})
        if opts.get("resume") and cls.resume_error:
            raise base.AgentError(cls.resume_error)
        native = [s["id"] for s in opts.get("skills") or [] if s.get("via") == "native"]
        out = {"result": {"text": "ok"}, "session": opts.get("resume") or f"sess-{len(cls.calls)}", "hooks": None,
               "usage": base.usage(10, 1), "cost_usd": 0.0, "model_used": model, "role_channel": "fake"}
        if native:
            out["skills_loaded"] = native if cls.loaded is None else [i for i in native if i in cls.loaded]
        return out


class Phase2Project(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_native2_test_"))
        cls.home = Path(tempfile.mkdtemp(prefix="langflow_native2_home_"))
        r = cls.tmp
        put(r / ".langflow" / "config.toml", CONFIG)
        put(r / ".langflow" / "workflows" / "flow.py", FLOW)
        put(r / ".claude" / "agents" / "writer.md", WRITER)
        put(r / ".claude" / "skills" / "style" / "SKILL.md", STYLE)
        put(r / ".agents" / "skills" / "humanizer" / "SKILL.md", HUMAN_A)
        put(r / ".claude" / "skills" / "humanizer" / "SKILL.md", HUMAN_C)
        cls.old_cwd = os.getcwd()
        os.chdir(r)
        projmod.set_current(projmod.load(r))
        cls.home_patch = mock.patch.object(catalog, "_home", lambda: cls.home)
        cls.home_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.home_patch.stop()
        os.chdir(cls.old_cwd)
        shutil.rmtree(cls.tmp, ignore_errors=True)
        shutil.rmtree(cls.home, ignore_errors=True)

    def setUp(self):
        Fake.calls, Fake.loaded, Fake.resume_error = [], None, None
        b = self.tmp / catalog.BINDINGS_FILE
        if b.exists():
            b.unlink()
        shutil.rmtree(self.home, ignore_errors=True)
        self.home.mkdir()
        self.set_config(CONFIG)

    def set_config(self, text):
        put(self.tmp / ".langflow" / "config.toml", text)
        projmod.set_current(projmod.load(self.tmp))

    def run_flow(self, run, args=None, agent="claude"):
        with mock.patch.dict(AGENTS, {agent: Fake.run}):
            run, app, payload = cli.prepare_start("flow", run, {"topic": "pumps", "agent": agent, **(args or {})})
            state, msg = cli.advance(app, run, payload)
        return run, state, msg


# ---------------------------------------------------------------- resolve: via per skill and CLI

class ResolveViaTest(Phase2Project):
    def via(self, agent, mode, fb="system", ids=("style", "humanizer")):
        res = catalog.resolve(projmod.current(), agent, None, list(ids), mode, fb)
        return {s["id"]: s for s in res["skills"]}

    def test_system(self):
        for agent in ("claude", "codex"):
            self.assertEqual({k: v["via"] for k, v in self.via(agent, "system").items()},
                             {"style": "system", "humanizer": "system"})
        s = self.via("opencode", "system")["style"]
        self.assertEqual((s["via"], s["fallback_reason"]), ("inject", "opencode has no system channel for skills"))

    def test_native_claude(self):
        s = self.via("claude", "native")
        # humanizer: Claude loads .claude/skills (another text than the catalog's .agents copy): that file is sent
        self.assertEqual((s["humanizer"]["via"], s["humanizer"]["path"]), ("native", ".claude/skills/humanizer/SKILL.md"))
        self.assertIn("HUMAN-C", s["humanizer"]["text"])
        self.assertEqual(s["humanizer"]["sha256"], catalog.sha256_file(self.tmp / ".claude/skills/humanizer/SKILL.md"))
        self.assertNotIn("cli", catalog.record({"role": None, "skills": [s["humanizer"]]})["skills"][0])
        self.assertEqual(s["style"]["via"], "native")
        # a personal copy wins for Claude: path "~/…" and its text
        put(self.home / ".claude/skills/style/SKILL.md", "---\nname: style\n---\nPersonal style. P-TEXT\n")
        s = self.via("claude", "native")["style"]
        self.assertEqual((s["path"], s["via"]), ("~/.claude/skills/style/SKILL.md", "native"))
        self.assertIn("P-TEXT", s["text"])

    def test_native_fallbacks(self):
        put(self.tmp / ".agents/skills/agents-only/SKILL.md", "---\nname: a\n---\nOnly agents.\n")
        try:
            s = self.via("claude", "native", ids=["agents-only"])["agents-only"]
            self.assertEqual(s["via"], "system")
            self.assertIn("claude does not read .agents/skills/agents-only/SKILL.md", s["fallback_reason"])
            self.assertEqual(self.via("claude", "native", "inject", ["agents-only"])["agents-only"]["via"], "inject")
            with self.assertRaises(catalog.BindingError) as e:
                self.via("claude", "native", "fail", ["agents-only"])
            self.assertIn('native_fallback is "fail"', e.exception.problems[0])
            # codex reads .agents/skills; style lives only in .claude/skills
            s = self.via("codex", "native")
            self.assertEqual((s["humanizer"]["via"], s["style"]["via"]), ("native", "system"))
            # opencode reads every folder: the catalog copy; an unknown CLI cannot load skills (system -> inject)
            self.assertEqual(self.via("opencode", "native")["style"]["via"], "native")
            s = self.via("other", "native")["style"]
            self.assertEqual((s["via"], s["fallback_reason"]), ("inject", "other cannot load skills by itself"))
            notes = catalog.skill_notes("claude", self.via("claude", "native", ids=["agents-only"])["agents-only"],
                                        "native")
            self.assertTrue(any("skill_mode native not possible" in n and "system used" in n for n in notes), notes)
        finally:
            shutil.rmtree(self.tmp / ".agents/skills/agents-only")

    def test_prompt_helpers(self):
        items = [{"id": "a", "path": "a/SKILL.md", "text": "AAA", "via": "inject"},
                 {"id": "b", "path": "b/SKILL.md", "text": "BBB", "via": "system"},
                 {"id": "c", "path": "c/SKILL.md", "text": "CCC", "via": "native"},
                 {"id": "d", "path": "d/SKILL.md", "text": "DDD", "via": "name"}]
        block = catalog.skills_block(items)
        self.assertIn("AAA", block)
        self.assertIn("Use the skill d", block)
        self.assertNotIn("BBB", block)
        self.assertNotIn("CCC", block)
        t = catalog.system_text({"id": "w", "path": "w.md", "instructions": "ROLE"}, [items[1]])
        self.assertLess(t.index("ROLE"), t.index("BBB"))
        self.assertEqual(catalog.system_text(None, []), "")


# ---------------------------------------------------------------- modes: precedence and values

class ModesTest(Phase2Project):
    def test_precedence(self):
        self.set_config(CONFIG + '\n[catalog]\nskill_mode = "system"\nretry_mode = "resume"\nnative_fallback = "inject"\n')
        p = projmod.current()
        role = {"id": "writer", "native": True}
        m = catalog.modes(p, catalog.effective({"role": "writer"}), "claude", role)
        self.assertEqual((m["skill_mode"], m["retry_mode"], m["native_fallback"]), ("system", "resume", "inject"))
        self.assertEqual(m["from"]["skill_mode"], "config")
        code = {"role": "writer", "skill_mode": "native", "retry_mode": "fresh"}
        m = catalog.modes(p, catalog.effective(code), "claude", role)
        self.assertEqual((m["skill_mode"], m["from"]["skill_mode"], m["retry_mode"]), ("native", "code", "fresh"))
        over = {"skill_mode": "inject", "native_fallback": "fail"}
        m = catalog.modes(p, catalog.effective(code, over), "claude", role)
        self.assertEqual((m["skill_mode"], m["from"]["skill_mode"], m["native_fallback"]), ("inject", "bindings", "fail"))
        args = {"skill_mode.draft": "system", "retry_mode.*": "resume", "native_fallback.draft": "system"}
        m = catalog.modes(p, catalog.effective(code, over, args, "draft"), "claude", role)
        self.assertEqual((m["skill_mode"], m["from"]["skill_mode"], m["retry_mode"], m["from"]["retry_mode"]),
                         ("system", "run", "resume", "run"))
        self.assertEqual(catalog.skill_modes(p, catalog.effective(code, over, args, "draft")), ("system", "system"))
        # resume needs a resumable CLI
        m = catalog.modes(p, catalog.effective({"role": "writer"}), "other", role)
        self.assertEqual(m["retry_mode"], "fresh")
        self.assertIn("other cannot resume a session", m["note"])

    def test_values(self):
        self.assertEqual(catalog.check_values({"skill_mode": "native", "native_fallback": "fail",
                                               "retry_mode": "resume"}),
                         {"skill_mode": "native", "native_fallback": "fail", "retry_mode": "resume"})
        for k, v in (("skill_mode", "magic"), ("native_fallback", "native"), ("retry_mode", "again")):
            with self.assertRaises(ValueError):
                catalog.check_values({k: v})
            with self.assertRaises(ValueError):
                engine.ai("x", "p", SCHEMA, **{k: v})
        with self.assertRaises(ValueError):
            catalog.effective({}, None, {"skill_mode.draft": "nope"}, "draft")
        self.set_config(CONFIG + '\n[catalog]\nskill_mode = "x"\nretry_mode = 3\n')
        self.assertEqual(catalog.config_modes(projmod.current()), {})
        catalog.set_binding(projmod.current(), "flow", "draft", {"skill_mode": "native", "retry_mode": "resume"})
        self.assertIn('skill_mode = "native"\nretry_mode = "resume"\n',
                      (self.tmp / catalog.BINDINGS_FILE).read_text(encoding="utf-8"))
        # ai() carries the keys for walk / check / web
        st = engine.ai("x", "p", SCHEMA, skill_mode="system", retry_mode="resume")
        self.assertEqual(st[1].langflow_step["skill_mode"], "system")
        self.assertEqual(catalog.step_rows("wf", [st])[0]["effective"]["retry_mode"], "resume")


# ---------------------------------------------------------------- engine: prompt, native fallback, resume

class EngineTest(Phase2Project):
    def starts(self, run):
        return [h for h in engine.read_status(run)["history"] if h.get("step") == "draft"]

    def test_inject_system_native_prompts(self):
        self.run_flow("e-1")
        p = Fake.calls[0]["prompt"]
        self.assertIn("HUMAN-A", p)                                   # inject: the catalog copy in the prompt
        self.assertIn("STYLE-TEXT", p)
        self.assertTrue(p.endswith(catalog.CONTRACT))
        Fake.calls = []
        self.run_flow("e-2", {"skill_mode.draft": "system"})
        c = Fake.calls[0]
        self.assertNotIn("STYLE-TEXT", c["prompt"])
        self.assertTrue(c["prompt"].startswith("Write about pumps"))
        self.assertTrue(c["prompt"].endswith(catalog.CONTRACT))
        self.assertEqual({s["id"]: s["via"] for s in c["skills"]}, {"style": "system", "humanizer": "system"})
        self.assertEqual(c["opts"]["skill_mode"], "system")
        Fake.calls = []
        run, state, _ = self.run_flow("e-3", {"skill_mode.draft": "native"})
        self.assertEqual(state, "waiting")
        c = Fake.calls[0]
        self.assertNotIn("HUMAN", c["prompt"])
        self.assertEqual({s["id"]: s["via"] for s in c["skills"]}, {"style": "native", "humanizer": "native"})
        h = self.starts(run)
        start = next(x for x in h if x["event"] == "start")
        self.assertEqual(start["skill_mode"], "native")
        self.assertEqual([s["via"] for s in start["binding"]["skills"]], ["native", "native"])
        done = next(x for x in h if x["event"] == "done")
        self.assertEqual(done["skills_loaded"], ["style", "humanizer"])
        self.assertEqual(done["attempts"], 1)

    def test_native_fallback(self):
        Fake.loaded = ["style"]                                       # humanizer does not load
        run, state, _ = self.run_flow("e-4", {"skill_mode.draft": "native"})
        self.assertEqual(state, "waiting")
        self.assertEqual(len(Fake.calls), 2)
        second = Fake.calls[1]
        self.assertEqual({s["id"]: s["via"] for s in second["skills"]}, {"style": "native", "humanizer": "system"})
        self.assertNotIn("HUMAN", second["prompt"])                   # system: not in the prompt either
        h = self.starts(run)
        fb = next(x for x in h if x["event"] == "native fallback")
        self.assertEqual((fb["skills"], fb["via"]), (["humanizer"], "system"))
        self.assertEqual({s["id"]: s["via"] for s in fb["binding"]["skills"]}, {"style": "native", "humanizer": "system"})
        _, info = view.step_states(engine.read_status(run))
        self.assertEqual(info["draft"]["native_fallback"], ["humanizer"])
        self.assertIn("humanizer [system]", view.binding_label(info["draft"]))
        # inject fallback puts the text into the prompt
        Fake.calls = []
        self.run_flow("e-5", {"skill_mode.draft": "native", "native_fallback.draft": "inject"})
        self.assertIn("HUMAN-C", Fake.calls[1]["prompt"])              # the copy Claude would have loaded
        # fail: the step fails
        Fake.calls = []
        run, state, msg = self.run_flow("e-6", {"skill_mode.draft": "native", "native_fallback.draft": "fail"})
        self.assertEqual(state, "failed")
        self.assertIn("native skill humanizer did not load (native_fallback = fail)", engine.read_status(run)["error"])
        self.assertEqual(len(Fake.calls), 1)

    def test_resume_retry(self):
        run, state, _ = self.run_flow("e-7", {"fail": "1", "retry_mode.draft": "resume", "skill_mode.draft": "system"})
        self.assertEqual(state, "waiting")
        first, retry = Fake.calls
        self.assertIsNone(first["opts"].get("resume"))
        self.assertEqual(retry["opts"]["resume"], "sess-1")
        self.assertTrue(retry["prompt"].startswith("Your previous answer failed these deterministic checks"))
        self.assertIn("FEEDBACK-MARK", retry["prompt"])
        self.assertTrue(retry["prompt"].endswith(catalog.CONTRACT))
        self.assertNotIn("Write about pumps", retry["prompt"])
        self.assertNotIn("Previous answer:", retry["prompt"])
        h = self.starts(run)
        self.assertTrue(next(x for x in h if x["event"] == "check failed")["resumed"])
        done = next(x for x in h if x["event"] == "done")
        self.assertEqual((done["resumes"], done["attempts"], done["session"]), (1, 2, "sess-1"))
        self.assertEqual(next(x for x in h if x["event"] == "start")["retry_mode"], "resume")

    def test_resume_failure_falls_back_to_fresh(self):
        Fake.resume_error = "No conversation found with session ID: sess-1"
        run, state, _ = self.run_flow("e-8", {"fail": "1", "retry_mode.draft": "resume"})
        self.assertEqual(state, "waiting")
        self.assertEqual(len(Fake.calls), 3)
        fresh = Fake.calls[2]
        self.assertIsNone(fresh["opts"].get("resume"))
        self.assertTrue(fresh["prompt"].startswith("Skills for this step"))
        self.assertIn("Previous answer:", fresh["prompt"])
        self.assertTrue(fresh["prompt"].endswith(catalog.CONTRACT))
        h = self.starts(run)
        self.assertIn("No conversation found", next(x for x in h if x["event"] == "resume failed")["error"])
        self.assertNotIn("resumes", next(x for x in h if x["event"] == "done"))
        log = engine.log_path(run).read_text(encoding="utf-8")
        self.assertIn("resume failed, fresh retry", log)

    def test_session_totals_become_per_call(self):
        """Claude reports total_cost_usd and Codex turn.completed.usage for the whole session: after a resume the
        engine keeps only the new call's part (cost_scope / usage_scope "session")."""
        totals = iter([(base.usage(100, 10, 50, 5), 0.01), (base.usage(150, 30, 120, 9), 0.016)])

        def agent(project, prompt, schema, model, opts, cwd, timeout, say):
            use, cost = next(totals)
            return {"result": {"text": "ok"}, "session": "S", "hooks": None, "usage": use, "cost_usd": cost,
                    "cost_scope": "session", "usage_scope": "session"}
        with mock.patch.dict(AGENTS, {"claude": agent}):
            run, app, payload = cli.prepare_start("flow", "e-14", {"topic": "x", "fail": "1",
                                                                   "retry_mode.draft": "resume"})
            self.assertEqual(cli.advance(app, run, payload)[0], "waiting")
        done = next(x for x in self.starts(run) if x["event"] == "done")
        u = done["usage"]
        self.assertEqual((u["input_tokens"], u["output_tokens"], u["cache_read_tokens"], u["cache_write_tokens"]),
                         (150, 30, 120, 9))
        self.assertAlmostEqual(u["cost_usd"], 0.016)
        log = engine.log_path(run).read_text(encoding="utf-8")
        self.assertIn("call 2 (resumed): input 50, output 20, cache read 70, cache write 4, $0.0060", log)

    def test_resume_retry_default(self):
        # resume is the default since 2026-11-18 (DESIGN.md rule 5); fresh stays available per step / run / config
        self.run_flow("e-9", {"fail": "1"})
        self.assertEqual(Fake.calls[1]["opts"].get("resume"), "sess-1")
        self.assertNotIn("Previous answer:", Fake.calls[1]["prompt"])

    def test_fresh_retry_on_request(self):
        self.run_flow("e-9b", {"fail": "1", "retry_mode.draft": "fresh"})
        self.assertIsNone(Fake.calls[1]["opts"].get("resume"))
        self.assertIn("Previous answer:", Fake.calls[1]["prompt"])

    def test_native_check_skipped_on_resume(self):
        # a resumed call reports nothing loaded: the first call's load counts, no fallback
        calls = []

        def agent(project, prompt, schema, model, opts, cwd, timeout, say):
            calls.append(opts.get("resume"))
            out = Fake.run(project, prompt, schema, model, opts, cwd, timeout, say)
            if opts.get("resume"):
                out["skills_loaded"] = []
            else:
                out["skills_loaded"] = [s["id"] for s in opts["skills"] if s.get("via") == "native"]
            return out
        with mock.patch.dict(AGENTS, {"claude": agent}):
            run, app, payload = cli.prepare_start("flow", "e-10", {"topic": "x", "fail": "1",
                                                                   "retry_mode.draft": "resume",
                                                                   "skill_mode.draft": "native"})
            state, _ = cli.advance(app, run, payload)
        self.assertEqual(state, "waiting")
        self.assertEqual(calls, [None, "sess-1"])

    def test_codex_and_opencode_modes(self):
        run, state, _ = self.run_flow("e-11", {"skill_mode.draft": "system"}, agent="opencode")
        c = Fake.calls[0]
        self.assertIn("STYLE-TEXT", c["prompt"])                     # opencode: no system channel -> inject
        self.assertEqual({s["via"] for s in c["skills"]}, {"inject"})
        Fake.calls = []
        run, state, _ = self.run_flow("e-12", {"fail": "1", "retry_mode.draft": "resume"}, agent="opencode")
        self.assertEqual(Fake.calls[1]["opts"].get("resume"), "sess-1")   # opencode resumes too (S-H)
        Fake.calls = []
        self.run_flow("e-13", {"fail": "1", "retry_mode.draft": "resume"}, agent="codex")
        self.assertEqual(Fake.calls[1]["opts"]["resume"], "sess-1")


# ---------------------------------------------------------------- Claude argv and check

class ClaudeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_native2_claude_"))
        self.p = projmod.Project(self.tmp, {})
        self.seen = {}
        self.events = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_stream(self, args, prompt, cwd, env, timeout, handle):
        self.seen.update(args=args, prompt=prompt)
        for e in self.events:
            handle(e)
        handle({"type": "result", "structured_output": {"text": "x"}, "session_id": "S1", "usage": {}})
        return 0, ""

    def claude(self, opts, project=None):
        with mock.patch.object(claude_adapter, "stream", self.fake_stream), \
                mock.patch.object(claude_adapter.shutil, "which", lambda n: "claude.exe"), \
                mock.patch.object(claude_adapter, "git_bash", lambda s: "bash.exe"), \
                mock.patch.object(claude_adapter.Path, "home", lambda: self.tmp / "home"):
            out = claude_adapter.run(project or self.p, "PROMPT", SCHEMA, None, opts, self.tmp, 60, lambda t: None)
        return self.seen["args"], self.seen["prompt"], out

    def role(self, native=True):
        return {"id": "writer", "name": "writer", "source": "claude" if native else "langflow",
                "path": ".claude/agents/writer.md", "sha256": "0" * 64, "native": native, "model": None,
                "effort": None, "tools": None, "instructions": "ROLE-TEXT"}

    def skill(self, sid, via, text=None):
        return {"id": sid, "name": sid, "path": f".claude/skills/{sid}/SKILL.md", "sha256": "0" * 64,
                "text": text or f"---\nname: {sid}\n---\n\nBody of {sid} SKILL-{sid.upper()}\nmore\n", "files": [],
                "via": via}

    def transcript(self, lines):
        d = self.tmp / "home" / ".claude" / "projects" / __import__("re").sub(r"[^A-Za-z0-9]", "-", str(self.tmp))
        d.mkdir(parents=True, exist_ok=True)
        (d / "S1.jsonl").write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")

    def test_system_file_role_then_skills(self):
        run_dir = self.tmp / "runs" / "r"
        args, prompt, out = self.claude({"role": self.role(), "role_mode": "append", "run_dir": str(run_dir),
                                         "step": "draft", "skills": [self.skill("a", "system"),
                                                                     self.skill("b", "inject")]})
        f = Path(args[args.index("--append-system-prompt-file") + 1])
        t = f.read_text(encoding="utf-8")
        self.assertLess(t.index("ROLE-TEXT"), t.index("SKILL-A"))
        self.assertNotIn("SKILL-B", t)                                   # inject skills are in the prompt already
        self.assertEqual(prompt, "PROMPT")
        self.assertEqual((out["role_channel"], out["skill_channel"]), ("append-file", "system-file"))
        # automatic role mode + system skills: the role goes into the same file (not on the command line)
        args, _, out = self.claude({"role": self.role(False), "run_dir": str(run_dir), "step": "draft",
                                    "skills": [self.skill("a", "system")]})
        self.assertNotIn("--append-system-prompt", args)
        self.assertIn("ROLE-TEXT", Path(args[args.index("--append-system-prompt-file") + 1]).read_text(encoding="utf-8"))
        # no role: skills only; role "prompt": role before the prompt, skills in the file
        args, prompt, out = self.claude({"role": self.role(), "role_mode": "prompt", "run_dir": str(run_dir),
                                         "step": "draft", "skills": [self.skill("a", "system")]})
        self.assertTrue(prompt.startswith("Role for this step: writer"))
        t = Path(args[args.index("--append-system-prompt-file") + 1]).read_text(encoding="utf-8")
        self.assertNotIn("ROLE-TEXT", t)
        self.assertIn("SKILL-A", t)
        # role_mode agent: the agent copy, plus the system file for the skills
        args, _, out = self.claude({"role": self.role(), "role_mode": "agent", "run_dir": str(run_dir),
                                    "step": "draft", "skills": [self.skill("a", "system")]})
        self.assertEqual(args[args.index("--agent") + 1], "lf-writer")
        self.assertIn("SKILL-A", Path(args[args.index("--append-system-prompt-file") + 1]).read_text(encoding="utf-8"))
        self.assertTrue(all(len(a) <= 2000 for a in args if not a.startswith("{")))

    def test_native_preload(self):
        """[agents.claude] native_skills = "preload" (not the default: Claude Code 2.1.312 does not preload skills
        for the main-thread agent in -p, test C4)."""
        pre = projmod.Project(self.tmp, {"agents": {"claude": {"native_skills": "preload"}}})
        run_dir = self.tmp / "runs" / "r"
        self.transcript([{"type": "user", "message": {"role": "user", "content": [
            {"type": "text", "text": "Base directory for this skill...\n\nBody of a SKILL-A\nmore"}]}}])
        args, prompt, out = self.claude({"run_dir": str(run_dir), "step": "verify[2]", "tools": ["Read"],
                                         "skills": [self.skill("a", "native"), self.skill("b", "native")]}, pre)
        name = args[args.index("--agent") + 1]
        self.assertEqual(name, "lf-verify-2")
        spec = json.loads(Path(args[args.index("--agents") + 1]).read_text(encoding="utf-8"))[name]
        self.assertEqual((spec["prompt"], spec["skills"]), ("", ["a", "b"]))
        self.assertNotIn("tools", spec)
        self.assertEqual(args[args.index("--allowedTools") + 1], "Read,Skill(a),Skill(b)")
        self.assertEqual(prompt, "PROMPT")
        self.assertEqual((out["skill_channel"], out["skills_loaded"]), ("native-preload", ["a"]))
        # role agent + native: one agent, the role's prompt and the skills
        args, _, out = self.claude({"role": self.role(), "role_mode": "agent", "run_dir": str(run_dir),
                                    "step": "draft", "skills": [self.skill("a", "native")]}, pre)
        spec = json.loads(Path(args[args.index("--agents") + 1]).read_text(encoding="utf-8"))["lf-writer"]
        self.assertEqual((spec["prompt"], spec["skills"]), ("ROLE-TEXT", ["a"]))
        self.assertEqual(args.count("--agent"), 1)
        # role append + native: the empty-prompt agent and the role's system file
        args, _, out = self.claude({"role": self.role(), "role_mode": "append", "run_dir": str(run_dir),
                                    "step": "draft", "skills": [self.skill("a", "native")]}, pre)
        self.assertEqual(args[args.index("--agent") + 1], "lf-draft")
        self.assertIn("ROLE-TEXT", Path(args[args.index("--append-system-prompt-file") + 1]).read_text(encoding="utf-8"))

    def test_native_tool(self):
        p = self.p                                                      # the default: native_skills = "tool"
        self.events = [{"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Skill", "input": {"skill": "b"}}]}}]
        args, prompt, out = self.claude({"skills": [self.skill("a", "native"), self.skill("b", "native")]}, p)
        self.assertNotIn("--agent", args)
        self.assertTrue(prompt.startswith("Before you start, load each of these skills with the Skill tool"))
        self.assertTrue(prompt.endswith("PROMPT"))
        self.assertEqual(args[args.index("--allowedTools") + 1], "Skill(a),Skill(b)")
        self.assertEqual((out["skill_channel"], out["skills_loaded"]), ("native-tool", ["b"]))
        self.assertEqual(out["cost_scope"], "session")
        # under role_mode agent with a limited tool list, Skill stays in it (agent copy and --tools)
        run_dir = self.tmp / "runs" / "r"
        args, _, _ = self.claude({"role": self.role(), "role_mode": "agent", "run_dir": str(run_dir), "step": "d",
                                  "tools": ["Read"], "sandbox": "read-only", "skills": [self.skill("a", "native")]})
        self.assertEqual(args[args.index("--tools") + 1], "Read,Skill,StructuredOutput")
        spec = json.loads(Path(args[args.index("--agents") + 1]).read_text(encoding="utf-8"))["lf-writer"]
        self.assertEqual(spec["tools"], ["Read", "Skill", "StructuredOutput"])
        self.assertNotIn("skills", spec)

    def test_resume_argv(self):
        run_dir = self.tmp / "runs" / "r"
        args1, _, _ = self.claude({"role": self.role(), "role_mode": "append", "run_dir": str(run_dir), "step": "d",
                                   "tools": ["Read"], "skills": [self.skill("a", "system")]})
        args2, prompt, out = self.claude({"role": self.role(), "role_mode": "append", "run_dir": str(run_dir),
                                          "step": "d", "tools": ["Read"], "skills": [self.skill("a", "system")],
                                          "resume": "S1"})
        self.assertEqual(args2[args2.index("--resume") + 1], "S1")
        rest = [a for a in args2 if a not in ("--resume", "S1")]
        self.assertEqual(rest, args1)                                   # the same flags (cache prefix)
        self.assertEqual(prompt, "PROMPT")
        _, prompt, _ = self.claude({"skills": [self.skill("a", "native")], "resume": "S1"})
        self.assertEqual(prompt, "PROMPT")                              # no skill line on resume

    def test_probe_and_loaded(self):
        self.assertEqual(claude_adapter.probe_text("---\nname: x\n---\n\n\n  First line here.  \nSecond\n"),
                         "First line here.")
        items = [self.skill("a", "native"), self.skill("b", "native")]
        f = self.tmp / "t.jsonl"
        f.write_text(json.dumps({"message": {"content": [{"type": "tool_use", "name": "Skill",
                                                          "input": {"skill": "b"}}]}}) + "\nnot json\n",
                     encoding="utf-8")
        self.assertEqual(claude_adapter.loaded_skills(items, f), ["b"])
        self.assertEqual(claude_adapter.loaded_skills(items, None, {"a"}), ["a"])
        self.assertEqual(claude_adapter.loaded_skills(items, self.tmp / "missing.jsonl"), [])


# ---------------------------------------------------------------- Codex argv and check

class CodexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_native2_codex_"))
        self.p = projmod.Project(self.tmp, {})
        self.seen = {}
        d = self.tmp / "npm"
        put(d / "codex.cmd", "@echo off\n")
        put(d / "node_modules/@openai/codex/bin/codex.js", "// js\n")
        put(d / "node.exe", "")
        self.exe = str(d / "codex.cmd")
        self.home = self.tmp / "home"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_codex(self, opts, rollout=None):
        def stream(args, prompt, cwd, env, timeout, handle):
            self.seen.update(args=args, prompt=prompt, cwd=cwd)
            handle({"type": "thread.started", "thread_id": "T1"})
            handle({"type": "item.completed", "item": {"type": "agent_message", "text": '{"text": "x"}'}})
            return 0, ""
        if rollout is not None:
            d = self.home / ".codex" / "sessions" / "2026"
            d.mkdir(parents=True, exist_ok=True)
            (d / "rollout-T1.jsonl").write_text("\n".join(json.dumps(x) for x in rollout), encoding="utf-8")
        with mock.patch.object(codex_adapter, "stream", stream), \
                mock.patch.object(codex_adapter.shutil, "which", lambda n: self.exe if n == "codex" else None), \
                mock.patch.object(codex_adapter.Path, "home", lambda: self.home):
            return codex_adapter.run(self.p, "PROMPT", SCHEMA, None, opts, self.tmp, 60, lambda t: None)

    def role(self):
        return {"id": "writer", "name": "writer", "source": "codex", "path": ".codex/agents/writer.toml",
                "sha256": "0" * 64, "native": True, "model": None, "effort": None, "tools": None,
                "instructions": "ROLE & | < > ^ % \"q\""}

    def skill(self, sid, via, text=None):
        return {"id": sid, "name": sid, "path": f".agents/skills/{sid}/SKILL.md", "sha256": "0" * 64,
                "text": text or f"---\nname: {sid}\n---\nBody {sid} SKILL-{sid.upper()}\n", "files": [], "via": via}

    def dev(self):
        a = self.seen["args"]
        i = next(i for i, x in enumerate(a) if x.startswith("developer_instructions="))
        return tomllib.loads(a[i])["developer_instructions"]

    def test_system_in_developer_instructions(self):
        out = self.run_codex({"role": self.role(), "role_mode": "append", "skills": [self.skill("a", "system")]})
        d = self.dev()
        self.assertLess(d.index("ROLE &"), d.index("SKILL-A"))
        self.assertEqual(self.seen["prompt"], "PROMPT")
        self.assertEqual((out["role_channel"], out["skill_channel"]), ("developer_instructions", "developer_instructions"))
        # role "prompt" (automatic): role before the prompt, skills still in developer_instructions
        out = self.run_codex({"role": self.role(), "skills": [self.skill("a", "system")]})
        self.assertNotIn("ROLE &", self.dev())
        self.assertTrue(self.seen["prompt"].startswith("Role for this step: writer"))
        self.assertEqual((out["role_channel"], out["skill_channel"]), ("prompt", "developer_instructions"))
        # too long for the command line: skills (and role) before the prompt, through the shim
        out = self.run_codex({"role": self.role(), "role_mode": "append",
                              "skills": [self.skill("a", "system", "z" * 40000)]})
        self.assertEqual(self.seen["args"][0], self.exe)
        self.assertTrue(self.seen["prompt"].startswith("Role for this step: writer"))
        self.assertIn("zzzz", self.seen["prompt"])
        self.assertEqual((out["role_channel"], out["skill_channel"]), ("prompt", "prompt"))

    def test_native_mention_and_check(self):
        put(self.tmp / ".agents/skills/a/SKILL.md", "x")
        rollout = [{"type": "response_item", "payload": {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "<skill>\n<name>a</name>\nBody a SKILL-A\n</skill>"}]}}]
        out = self.run_codex({"skills": [self.skill("a", "native"), self.skill("b", "native")]}, rollout)
        first = self.seen["prompt"].split("\n")[0]
        path = (self.tmp / ".agents/skills/a/SKILL.md").resolve().as_posix()
        self.assertEqual(first, f"Load these skills before you start: [$a]({path}), [$b]("
                                f"{(self.tmp / '.agents/skills/b/SKILL.md').resolve().as_posix()})")
        self.assertTrue(self.seen["prompt"].endswith("PROMPT"))
        self.assertEqual((out["skill_channel"], out["skills_loaded"]), ("native-mention", ["a"]))
        self.assertEqual(self.seen["args"][0], self.exe)                # no developer text: the shim, stdin only

    def test_resume_argv(self):
        out = self.run_codex({"role": self.role(), "role_mode": "append", "resume": "T0", "effort": "low",
                              "sandbox": "read-only", "skills": [self.skill("a", "native")]})
        a = self.seen["args"]
        self.assertEqual(a[2:5], ["exec", "resume", "T0"])
        self.assertNotIn("-s", a)
        self.assertNotIn("-C", a)
        self.assertIn('sandbox_mode="read-only"', a)
        self.assertIn('model_reasoning_effort="low"', a)
        self.assertIn("ROLE &", self.dev())                             # developer_instructions sent again
        self.assertEqual(a[-1], "-")
        self.assertEqual(self.seen["prompt"], "PROMPT")                 # feedback only: no role, no mention line
        self.assertEqual(self.seen["cwd"], self.tmp)
        self.assertEqual(out["usage_scope"], "session")


# ---------------------------------------------------------------- langflow check, web

class CheckAndWebTest(Phase2Project):
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

    def test_check_lines(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.cmd_check("flow", ["agent=codex", "skill_mode.draft=native",
                                                    "retry_mode.draft=resume"]), 0)
        text = out.getvalue()
        self.assertIn("(skill_mode inject, role_mode auto, retry_mode resume, contract on)", text)
        self.assertIn("skills style, humanizer (code, native run)", text)
        self.assertIn("(retry resume, run)", text)
        self.assertIn("skill style [system .claude/skills/style/SKILL.md #", text)
        self.assertIn("skill humanizer [native .agents/skills/humanizer/SKILL.md #", text)
        self.assertIn("warning: style: skill_mode native not possible (codex does not read "
                      ".claude/skills/style/SKILL.md and has no .agents/skills/<id> copy); system used", text)
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.cmd_check("flow", ["agent=codex", "skill_mode.draft=native",
                                                    "native_fallback.draft=fail"]), 1)
        self.assertIn('flow.draft: skill style: not native', out.getvalue())
        with self.assertRaises(SystemExit):           # a fail fallback refuses the start (preflight)
            cli.prepare_start("flow", "w-1", {"topic": "x", "agent": "codex", "skill_mode.draft": "native",
                                              "native_fallback.draft": "fail"})

    def test_web_bindings(self):
        code, body = self.api("PUT", "/api/workflows/flow/bindings/draft", {"skill_mode": "native",
                                                                             "retry_mode": "resume"})
        self.assertEqual(code, 200, body)
        s = body["steps"][0]
        self.assertEqual(s["override"], {"skill_mode": "native", "retry_mode": "resume"})
        self.assertEqual((s["modes"]["skill_mode"], s["modes"]["from"]["skill_mode"], s["modes"]["retry_mode"]),
                         ("native", "bindings", "resume"))
        det = {d["id"]: d for d in s["effective"]["skills_detail"]}
        self.assertEqual((det["humanizer"]["via"], det["humanizer"]["path"]),
                         ("native", ".claude/skills/humanizer/SKILL.md"))
        self.assertEqual(body["defaults"]["skill_mode"], "inject")
        self.assertEqual(self.api("PUT", "/api/workflows/flow/bindings/draft", {"skill_mode": "magic"})[0], 400)
        code, body = self.api("GET", "/api/catalog")
        self.assertEqual((body["native_fallback"], body["retry_mode"]), ("system", "resume"))


if __name__ == "__main__":
    unittest.main()
