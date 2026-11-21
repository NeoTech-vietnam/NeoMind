"""Tests for role and skill bindings per step (phase 2b): engine (prompt, start event, layout, preflight, continue
drift), the Claude / Codex adapters' command line (the CLI is not run: `stream` is replaced), the CLI `check`,
and the web catalog and bindings endpoints. No agent is called.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_bindings -v
"""
import io
import json
import os
import shutil
import sys
import tempfile
import threading
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
FLOW = f'''"""Binding test flow."""
from langflow import ai, gate

SCHEMA = {SCHEMA!r}


def steps(args):
    return [
        ai("draft", "Write about {{topic}}", SCHEMA, agent="fake", role="writer", skills=["style"]),
        gate("look", "Look?"),
        ai("review", "Review it", SCHEMA, agent="fake", role="checker"),
        ai("plain", "No binding", SCHEMA, agent="fake"),
    ]
'''
BROKEN = FLOW.replace('role="checker"', 'role="ghost"')
NATIVE = FLOW.replace('agent="fake", role="writer"', 'agent="claude", role="writer", tools=None')
CONFIG = '[project]\nname = "bindings test"\napprover = "tester"\n\n[retry]\nattempts = 0\n'
WRITER = "---\nname: writer\ndescription: Writes.\ntools: Read, Write\nmodel: opus\n---\nYou write well.\n"
CHECKER = "---\nname: checker\ndescription: Checks.\n---\nCheck everything.\n"
STYLE = "---\nname: Style guide\ndescription: House style.\n---\nUse short sentences.\n"


def put(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class Fake:
    calls: list = []

    @classmethod
    def run(cls, project, prompt, schema, model, opts, cwd, timeout, say):
        cls.calls.append({"prompt": prompt, "model": model, "opts": opts})
        return {"result": {"text": "ok"}, "session": "s", "hooks": None, "usage": base.usage(10, 1),
                "cost_usd": 0.0, "model_used": model}


class BindingEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_bindings_test_"))
        r = cls.tmp
        put(r / ".langflow" / "config.toml", CONFIG)
        put(r / ".langflow" / "workflows" / "flow.py", FLOW)
        put(r / ".langflow" / "workflows" / "broken.py", BROKEN)
        put(r / ".langflow" / "workflows" / "native.py", NATIVE)
        put(r / ".claude" / "agents" / "writer.md", WRITER)
        put(r / ".langflow" / "agents" / "checker.md", CHECKER)
        put(r / ".claude" / "skills" / "style" / "SKILL.md", STYLE)
        put(r / ".claude" / "skills" / "style" / "examples" / "a.md", "example")
        put(r / ".agents" / "skills" / "extra" / "SKILL.md", "---\nname: extra\n---\nExtra rule.\n")
        cls.old_cwd = os.getcwd()
        os.chdir(r)
        projmod.set_current(projmod.load(r))
        AGENTS["fake"] = Fake.run
        cls.server, cls.token = web.serve(0, quiet=True)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        AGENTS.pop("fake", None)
        os.chdir(cls.old_cwd)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        Fake.calls = []
        b = self.tmp / catalog.BINDINGS_FILE
        if b.exists():
            b.unlink()

    def run_to_gate(self, run, args=None):
        run, app, payload = cli.prepare_start("flow", run, {"topic": "pumps", **(args or {})})
        state, msg = cli.advance(app, run, payload)
        self.assertEqual(state, "waiting", msg)
        return run, app

    def api(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"X-Langflow-Token": self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    # ------------------------------------------------------------ engine

    def test_prompt_event_layout(self):
        run, app = self.run_to_gate("b-1")
        call = Fake.calls[0]
        self.assertTrue(call["prompt"].startswith("Skills for this step (follow them):\n\n### Style guide "
                                                  "(.claude/skills/style/SKILL.md)"))
        self.assertIn("Companion files (read only if needed): .claude/skills/style/examples/a.md", call["prompt"])
        self.assertTrue(call["prompt"].endswith("---\n\nWrite about pumps\n\n---\n\n" + catalog.CONTRACT))
        self.assertNotIn("You write well.", call["prompt"])          # the adapter places the role
        role = call["opts"]["role"]
        self.assertEqual((role["id"], role["source"], role["native"]), ("writer", "claude", False))
        self.assertIsNone(call["model"])                                 # model only from a native role
        st = engine.read_status(run)
        start = next(h for h in st["history"] if h.get("step") == "draft" and h.get("event") == "start")
        self.assertEqual(start["role"], "writer")
        self.assertEqual(start["skills"], ["style"])
        self.assertEqual(start["binding"]["role"]["path"], ".claude/agents/writer.md")
        self.assertEqual(start["binding"]["skills"][0]["sha256"],
                         catalog.sha256_file(self.tmp / ".claude/skills/style/SKILL.md"))
        nodes = {n["id"]: n for n in st["graph"]["nodes"]}
        self.assertEqual((nodes["draft"]["role"], nodes["draft"]["skills"]), ("writer", ["style"]))
        self.assertEqual((nodes["plain"]["role"], nodes["plain"]["skills"]), (None, []))
        self.assertNotIn("role", nodes["look"])
        _, info = view.step_states(st)
        self.assertEqual(info["draft"]["binding"]["role"]["id"], "writer")
        self.assertIn("role writer [prompt] · skills style", view._detail(info["draft"], nodes["draft"]))
        self.assertEqual((start["role_mode"], start["contract"]), ("prompt", True))
        self.assertIn("role checker", view._detail({}, nodes["review"]))
        self.assertIn("role writer · 1 skill", view.mermaid(st["graph"]))
        # answer the gate: review (langflow role, any CLI) and plain (no binding)
        state, msg = cli.answer_gate(run, "approve", None, "tester")
        self.assertEqual(state, "done", msg)
        review, plain = Fake.calls[1], Fake.calls[2]
        self.assertEqual(review["opts"]["role"]["source"], "langflow")
        self.assertEqual(plain["prompt"], "No binding")
        self.assertIsNone(plain["opts"]["role"])
        self.assertNotIn("binding", next(h for h in engine.read_status(run)["history"]
                                         if h.get("step") == "plain" and h.get("event") == "start"))

    def test_native_role_model_and_tools(self):
        with mock.patch.dict(AGENTS, {"claude": Fake.run}):
            run, app, payload = cli.prepare_start("native", "n-1", {"topic": "x"})
            self.assertEqual(cli.advance(app, run, payload)[0], "waiting")
            call = Fake.calls[0]
            self.assertTrue(call["opts"]["role"]["native"])
            self.assertEqual(call["model"], "opus")                     # role model under the step's (none)
            # automatic mode is "append" (2026-11-18): the role's tools apply only under role_mode "agent" (F8)
            self.assertIsNone(call["opts"]["tools"])
            self.assertIsNone(call["opts"]["step_tools"])
            self.assertIsNone(call["opts"]["role_mode"])                # automatic: the adapter's old path
            run, app, payload = cli.prepare_start("native", "n-2", {"topic": "x", "model.draft": "haiku"})
            cli.advance(app, run, payload)
            self.assertEqual(Fake.calls[-1]["model"], "haiku")

    def test_missing_after_start_fails_step(self):
        run, _ = self.run_to_gate("b-7")
        f = self.tmp / ".langflow/agents/checker.md"
        f.rename(f.with_suffix(".bak"))
        try:
            state, msg = cli.answer_gate(run, "approve", None, "tester")
            self.assertEqual(state, "failed")
            st = engine.read_status(run)
            self.assertEqual(st["step"], "review")
            self.assertIn("binding: role checker", st["error"])
            f.with_suffix(".bak").rename(f)
            state, msg = cli.continue_run(run)
            self.assertEqual(state, "done", msg)
        finally:
            if f.with_suffix(".bak").exists():
                f.with_suffix(".bak").rename(f)

    def test_overrides_and_preflight(self):
        catalog.set_binding(projmod.current(), "flow", "draft", {"role": "checker", "skills_add": ["extra"]})
        run, _ = self.run_to_gate("b-2", {"skills.draft": "+style"})
        call = Fake.calls[0]
        self.assertEqual(call["opts"]["role"]["id"], "checker")
        self.assertIn("### Style guide", call["prompt"])
        self.assertIn("### extra (.agents/skills/extra/SKILL.md)", call["prompt"])
        st = engine.read_status(run)
        self.assertEqual({n["id"]: n for n in st["graph"]["nodes"]}["draft"]["role"], "checker")
        # run arg removes the role
        run, _ = self.run_to_gate("b-3", {"role.draft": ""})
        self.assertIsNone(Fake.calls[-1]["opts"]["role"])
        # preflight: a missing role refuses the start, and `langflow check` says so
        with self.assertRaises(SystemExit) as cm:
            cli.prepare_start("broken", "b-4", {"topic": "x"})
        self.assertIn("role ghost", str(cm.exception))
        self.assertFalse(engine.status_path("b-4").exists())
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.cmd_check("broken", ["topic=x"]), 1)
            self.assertEqual(cli.cmd_check("flow", ["topic=x"]), 0)
        self.assertIn("MISSING", out.getvalue())
        self.assertIn("checker [prompt · langflow file] (bindings)", out.getvalue())
        # a run arg naming a missing skill is refused too
        with self.assertRaises(SystemExit):
            cli.prepare_start("flow", "b-5", {"topic": "x", "skills.review": "nope"})

    def test_continue_logs_drift(self):
        run, _ = self.run_to_gate("b-6")
        skill = self.tmp / ".claude/skills/style/SKILL.md"
        old = skill.read_text(encoding="utf-8")
        try:
            skill.write_text(old + "\nNew rule.\n", encoding="utf-8")
            st = engine.read_status(run)
            self.assertEqual(engine.binding_drift(st), {"draft": ["skill style changed (.claude/skills/style/SKILL.md)"]})
            cli.note_binding_drift(run, st)
            st = engine.read_status(run)
            ev = [h for h in st["history"] if h.get("event") == "binding changed"]
            self.assertEqual(ev[0]["step"], "draft")
            _, info = view.step_states(st)
            self.assertIn("changed since run", view._detail(info["draft"]))
            code, body = self.api("GET", f"/api/runs/{run}")
            self.assertEqual(body["info"]["draft"]["binding_changes"],
                             ["skill style changed (.claude/skills/style/SKILL.md)"])
        finally:
            skill.write_text(old, encoding="utf-8")
        code, body = self.api("GET", f"/api/runs/{run}")
        self.assertNotIn("binding_changes", body["info"]["draft"])

    # ------------------------------------------------------------ web

    def test_web_catalog(self):
        code, body = self.api("GET", "/api/catalog")
        self.assertEqual(code, 200)
        skills = {s["id"]: s for s in body["skills"]}
        roles = {r["id"]: r for r in body["roles"]}
        self.assertEqual(skills["style"]["used_by"], [{"workflow": w, "step": "draft"}
                                                      for w in ("broken", "flow", "native")])
        self.assertTrue(roles["ghost"]["missing"])
        self.assertEqual(body["skill_mode"], "inject")
        code, body = self.api("GET", "/api/catalog/skill/style")
        self.assertEqual((code, body["name"]), (200, "Style guide"))
        self.assertIn("Use short sentences.", body["text"])
        self.assertEqual(body["files"], [".claude/skills/style/examples/a.md"])
        code, body = self.api("GET", "/api/catalog/role/writer")
        self.assertIn("You write well.", body["sources"]["claude"]["text"])
        self.assertEqual(len(body["used_by"]), 3)
        self.assertEqual(self.api("GET", "/api/catalog/skill/nope")[0], 404)
        self.assertEqual(self.api("GET", "/api/catalog/role/..%2Fx")[0], 404)

    def test_web_bindings(self):
        code, body = self.api("GET", "/api/workflows/flow/bindings")
        self.assertEqual(code, 200)
        steps = {s["step"]: s for s in body["steps"]}
        self.assertEqual(list(steps), ["draft", "review", "plain"])
        self.assertEqual(steps["draft"]["code"], {"role": "writer", "skills": ["style"]})
        self.assertIsNone(steps["draft"]["override"])
        code, body = self.api("PUT", "/api/workflows/flow/bindings/draft", {"role": None, "skills": ["extra"]})
        self.assertEqual(code, 200, body)
        d = {s["step"]: s for s in body["steps"]}["draft"]
        self.assertEqual(d["override"], {"skills": ["extra"]})
        self.assertEqual(d["effective"]["role"], "writer")
        self.assertEqual(d["effective"]["skills"], ["extra"])
        self.assertEqual(d["effective"]["from"], {"role": "code", "skills": "bindings"})
        self.assertIn("[flow.draft]", (self.tmp / catalog.BINDINGS_FILE).read_text(encoding="utf-8"))
        code, graph = self.api("GET", "/api/workflows/flow/graph")
        self.assertEqual({n["id"]: n for n in graph["nodes"]}["draft"]["skills"], ["extra"])
        self.assertEqual(self.api("PUT", "/api/workflows/flow/bindings/draft", {"skills": ["nope"]})[0], 400)
        self.assertEqual(self.api("PUT", "/api/workflows/flow/bindings/draft", {"model": "x"})[0], 400)
        self.assertEqual(self.api("PUT", "/api/workflows/flow/bindings/look", {"role": ""})[0], 404)
        self.assertEqual(self.api("PUT", "/api/workflows/nowf/bindings/x", {"role": ""})[0], 404)
        code, body = self.api("DELETE", "/api/workflows/flow/bindings/draft")
        self.assertEqual(code, 200)
        self.assertIsNone({s["step"]: s for s in body["steps"]}["draft"]["override"])
        code, body = self.api("GET", "/api/workflows/broken/bindings")
        self.assertEqual({s["step"]: s for s in body["steps"]}["review"]["problems"][0][:10], "role ghost")


class AdapterArgsTest(unittest.TestCase):
    """The command line each adapter builds for a role (the CLI is not started)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_adapter_test_"))
        self.p = projmod.Project(self.tmp, {})
        self.seen = {}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_stream(self, kind):
        def stream(args, prompt, cwd, env, timeout, handle):
            self.seen.update(args=args, prompt=prompt)
            if kind == "claude":
                handle({"type": "result", "structured_output": {"text": "x"}, "session_id": "s", "usage": {}})
            else:
                handle({"type": "thread.started", "thread_id": "t"})
                handle({"type": "item.completed", "item": {"type": "agent_message", "text": '{"text": "x"}'}})
            return 0, ""
        return stream

    def role(self, native, source="claude", instructions="Be careful."):
        return {"id": "writer", "name": "writer-agent", "source": source, "path": f".x/{source}/writer",
                "sha256": "0" * 64, "native": native, "model": None, "effort": None, "tools": None,
                "instructions": instructions}

    def claude(self, role):
        with mock.patch.object(claude_adapter, "stream", self.fake_stream("claude")), \
                mock.patch.object(claude_adapter.shutil, "which", lambda n: "claude.exe"), \
                mock.patch.object(claude_adapter, "git_bash", lambda s: "bash.exe"):
            claude_adapter.run(self.p, "PROMPT", SCHEMA, None, {"role": role}, self.tmp, 60, lambda t: None)
        return self.seen["args"], self.seen["prompt"]

    def test_claude(self):
        args, prompt = self.claude(self.role(True))          # automatic: a native role goes in as system prompt
        self.assertNotIn("--agent", args)
        self.assertIn("Be careful.", args[args.index("--append-system-prompt") + 1])
        self.assertEqual(prompt, "PROMPT")
        args, prompt = self.claude(self.role(False, "langflow"))
        self.assertNotIn("--agent", args)
        self.assertIn("Be careful.", args[args.index("--append-system-prompt") + 1])
        self.assertEqual(prompt, "PROMPT")
        args, prompt = self.claude(self.role(False, "langflow", "x" * (claude_adapter.APPEND_MAX + 1)))
        self.assertNotIn("--append-system-prompt", args)
        self.assertTrue(prompt.startswith("Role for this step: writer"))
        self.assertTrue(prompt.endswith("---\n\nPROMPT"))
        args, prompt = self.claude(None)
        self.assertNotIn("--agent", args)
        self.assertNotIn("--append-system-prompt", args)

    def test_codex(self):
        with mock.patch.object(codex_adapter, "stream", self.fake_stream("codex")), \
                mock.patch.object(codex_adapter.shutil, "which", lambda n: "codex.cmd"):
            codex_adapter.run(self.p, "Skills for this step (follow them):\nS\n---\n\nPROMPT", SCHEMA, None,
                              {"role": self.role(True, "codex")}, self.tmp, 60, lambda t: None)
        prompt = self.seen["prompt"]
        self.assertTrue(prompt.startswith("Role for this step: writer (.x/codex/writer)."))
        self.assertIn("Be careful.\n\nSkills for this step", prompt)
        self.assertNotIn("Be careful.", " ".join(self.seen["args"]))


if __name__ == "__main__":
    unittest.main()
