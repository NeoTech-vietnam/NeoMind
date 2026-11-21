"""Tests for the gaps closed after phase 2b: fan-out worker bindings (declared, worker attribute, probe) seen by
check / used by / bindings / graph / run info, and a gate answer racing a cancel (run_lock, claim_answer).
No agent is called: ai steps use the in-process fake agent "fake".

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_gaps -v
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path

from langflow import catalog, cli, engine, view, web
from langflow import project as projmod
from langflow.agents import AGENTS, base

SCHEMA = {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}
FANFLOW = f'''"""Fan-out binding test flow."""
from langflow import ai, fanout, gate

SCHEMA = {SCHEMA!r}


def w_declared(item, i):
    return ai(f"fan[{{i}}]", lambda s: f"Item {{s['item']}}", SCHEMA, agent="fake", role="writer")


def w_own(item, i):
    return ai(f"own[{{i}}]", lambda s: "own item", SCHEMA, agent="fake", role="writer")


def w_needs_item(item, i):
    return ai(f"opaque[{{i}}]", "opaque " + item["id"], SCHEMA, agent="fake")


def steps(args):
    return [
        fanout("fan", lambda s: ["a", "b"], w_declared, role="checker", skills=["style"], agent="fake"),
        fanout("own", lambda s: ["a"], w_own),
        fanout("opaque", lambda s: [{{"id": "x"}}], w_needs_item),
        gate("look", "Look?"),
    ]
'''
RACEFLOW = f'''"""Gate / cancel race test flow."""
from langflow import ai, gate

SCHEMA = {SCHEMA!r}


def steps(args):
    return [
        gate("look", "Look?"),
        ai("after", "After the gate", SCHEMA, agent="fake"),
        gate("end", "End?"),
    ]
'''
CONFIG = '[project]\nname = "gaps test"\napprover = "tester"\n\n[retry]\nattempts = 0\n'
WRITER = "---\nname: writer\ndescription: Writes.\n---\nYou write well.\n"
CHECKER = "---\nname: checker\ndescription: Checks.\n---\nCheck everything.\n"
STYLE = "---\nname: Style guide\ndescription: House style.\n---\nUse short sentences.\n"
HOLD = '''import sys, time
sys.path.insert(0, sys.argv[1])
from langflow import engine, project
project.set_current(project.load(sys.argv[2]))
with engine.run_lock(sys.argv[3]):
    print("held", flush=True)
    time.sleep(float(sys.argv[4]))
'''


def put(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class Fake:
    calls: list = []

    @classmethod
    def run(cls, project, prompt, schema, model, opts, cwd, timeout, say):
        cls.calls.append({"prompt": prompt, "opts": opts})
        return {"result": {"text": "ok"}, "session": "s", "hooks": None, "usage": base.usage(10, 1),
                "cost_usd": 0.0, "model_used": model}


class GapsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_gaps_test_"))
        r = cls.tmp
        put(r / ".langflow" / "config.toml", CONFIG)
        put(r / ".langflow" / "workflows" / "fanflow.py", FANFLOW)
        put(r / ".langflow" / "workflows" / "raceflow.py", RACEFLOW)
        put(r / ".claude" / "agents" / "writer.md", WRITER)
        put(r / ".langflow" / "agents" / "checker.md", CHECKER)
        put(r / ".claude" / "skills" / "style" / "SKILL.md", STYLE)
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

    def api(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"X-Langflow-Token": self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def to_gate(self, wf, run, args=None):
        run, app, payload = cli.prepare_start(wf, run, args or {})
        state, msg = cli.advance(app, run, payload)
        self.assertEqual(state, "waiting", msg)
        return run

    def events(self, run, event=None, step=None):
        return [h for h in engine.read_status(run).get("history", [])
                if (event is None or h.get("event") == event) and (step is None or h.get("step") == step)]

    # ------------------------------------------------------------ 1. fan-out worker bindings

    def test_fanout_rows_check_catalog(self):
        args = {"_run": "RUN", "_workflow": "fanflow"}
        rows = {r["step"]: r for r in cli.step_rows("fanflow", cli.load_workflow("fanflow").steps(args), args)}
        self.assertEqual(set(rows), {"fan", "own"})                    # opaque needs a real item: not probed
        self.assertEqual(rows["fan"]["fanout"], "declared")
        self.assertEqual(rows["fan"]["code"], {"role": "checker", "skills": ["style"]})   # declared beats worker's
        self.assertEqual(rows["fan"]["agent"], "fake")
        self.assertEqual(rows["own"]["fanout"], "probe")
        self.assertEqual(rows["own"]["code"], {"role": "writer", "skills": []})
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.cmd_check("fanflow", []), 0)
        self.assertIn("fan[*]", out.getvalue())
        self.assertIn("(fan-out workers, binding declared)", out.getvalue())
        self.assertIn("(fan-out workers, binding probe)", out.getvalue())
        code, body = self.api("GET", "/api/catalog")
        self.assertEqual(code, 200)
        skills = {s["id"]: s for s in body["skills"]}
        roles = {r["id"]: r for r in body["roles"]}
        self.assertIn({"workflow": "fanflow", "step": "fan"}, skills["style"]["used_by"])
        self.assertIn({"workflow": "fanflow", "step": "fan"}, roles["checker"]["used_by"])
        self.assertIn({"workflow": "fanflow", "step": "own"}, roles["writer"]["used_by"])
        code, body = self.api("GET", "/api/workflows/fanflow/bindings")
        self.assertEqual([s["step"] for s in body["steps"]], ["fan", "own"])
        code, graph = self.api("GET", "/api/workflows/fanflow/graph")
        nodes = {n["id"]: n for n in graph["nodes"]}
        self.assertEqual((nodes["fan_worker"]["role"], nodes["fan_worker"]["skills"]), ("checker", ["style"]))
        self.assertEqual(nodes["own_worker"]["role"], "writer")
        self.assertNotIn("role", nodes["opaque_worker"])
        # a worker function carrying langflow_step still works (no probe call then)
        calls = []

        def worker(item, i):
            calls.append(i)
            return ("w[0]", None, "ai")
        worker.langflow_step = {"agent": "codex", "role": None, "skills": ["style"]}
        self.assertEqual(catalog.fanout_meta((worker, 5))["via"], "worker")
        self.assertEqual(calls, [])

    def test_fanout_run_uses_declared_binding(self):
        run = self.to_gate("fanflow", "fan-1")
        fan = [c for c in Fake.calls if "Item " in c["prompt"]]
        self.assertEqual(len(fan), 2)
        for c in fan:
            self.assertEqual(c["opts"]["role"]["id"], "checker")          # declared role replaces the worker's
            self.assertTrue(c["prompt"].startswith("Skills for this step (follow them):"))
        own = next(c for c in Fake.calls if c["prompt"] == catalog.with_contract("own item"))
        self.assertEqual(own["opts"]["role"]["id"], "writer")
        opaque = next(c for c in Fake.calls if c["prompt"] == "opaque x")
        self.assertIsNone(opaque["opts"]["role"])
        st = engine.read_status(run)
        states, info = view.step_states(st)
        self.assertEqual(info["fan_worker"]["role"], "checker")
        self.assertEqual(info["fan_worker"]["skills"], ["style"])
        self.assertEqual(info["fan_worker"]["binding"]["role"]["path"], ".langflow/agents/checker.md")
        self.assertEqual(info["own_worker"]["role"], "writer")
        self.assertNotIn("binding", info["opaque_worker"])
        self.assertIn("role checker", view._detail(info["fan_worker"]))
        # drift of a worker's skill shows on the worker node (web run view and continue's events)
        skill = self.tmp / ".claude/skills/style/SKILL.md"
        old = skill.read_text(encoding="utf-8")
        try:
            skill.write_text(old + "\nNew rule.\n", encoding="utf-8")
            code, body = self.api("GET", f"/api/runs/{run}")
            self.assertEqual(body["info"]["fan_worker"]["binding_changes"],
                             ["skill style changed (.claude/skills/style/SKILL.md)"])
            cli.note_binding_drift(run, engine.read_status(run))
            states2, info2 = view.step_states(engine.read_status(run))
            self.assertEqual(info2["fan_worker"]["binding_changes"],
                             ["skill style changed (.claude/skills/style/SKILL.md)"])
            self.assertEqual(states2["fan_worker"], states["fan_worker"])  # a drift event is not a worker state
        finally:
            skill.write_text(old, encoding="utf-8")
        # bindings.toml (under the fan-out name) still beats the declaration
        catalog.set_binding(projmod.current(), "fanflow", "fan", {"role": ""})
        Fake.calls = []
        self.to_gate("fanflow", "fan-2")
        fan = [c for c in Fake.calls if "Item " in c["prompt"]]
        self.assertTrue(all(c["opts"]["role"] is None for c in fan))
        self.assertTrue(all(c["prompt"].startswith("Skills for this step") for c in fan))

    # ------------------------------------------------------------ 4. gate answer vs cancel

    def test_cancel_first_refuses_answer(self):
        run = self.to_gate("raceflow", "race-1")
        self.assertEqual(engine.request_cancel(run, by="stopper"), "cancelled")
        state, msg = cli.answer_gate(run, "approve", None, "tester")
        self.assertEqual(state, "error")
        self.assertIn("was cancelled by stopper before this answer; the answer was not applied", msg)
        st = engine.read_status(run)
        self.assertEqual(st["status"], "cancelled")
        self.assertEqual(self.events(run, "approve"), [])
        self.assertEqual(Fake.calls, [])
        # continue: the gate waits again (no stored answer leaks through)
        self.assertEqual(cli.continue_run(run)[0], "waiting")
        self.assertEqual(engine.read_status(run)["gate"], "look")
        self.assertEqual(cli.answer_gate(run, "approve", None, "tester")[0], "waiting")
        self.assertEqual(engine.read_status(run)["gate"], "end")
        # web answer after a cancel: 409 with the reason
        self.assertEqual(engine.request_cancel(run, by="stopper"), "cancelled")
        code, body = self.api("POST", f"/api/runs/{run}/answer", {"decision": "approve", "confirm": run})
        self.assertEqual(code, 409)
        self.assertIn("the answer was not applied", json.dumps(body))

    def test_answer_first_then_cancel_stops_before_next_step(self):
        run = self.to_gate("raceflow", "race-2")
        engine.claim_answer(run, "tester")
        with self.assertRaises(engine.GateClosed):
            engine.claim_answer(run, "other")                          # one answer at a time
        self.assertEqual(engine.request_cancel(run, by="stopper"), "requested")
        state, msg = cli.answer_gate(run, "approve", "ok", "tester", claimed=True)
        self.assertEqual(state, "cancelled", msg)
        st = engine.read_status(run)
        self.assertEqual(st["status"], "cancelled")
        self.assertEqual(st["step"], "after")
        self.assertIsNone(st.get("answering"))
        self.assertEqual(len(self.events(run, "approve", "look")), 1)  # the answer is recorded
        self.assertEqual(Fake.calls, [])                               # the next step did not run
        self.assertFalse(engine.cancel_path(run).exists())
        self.assertEqual(cli.continue_run(run)[0], "waiting")
        self.assertEqual(len(Fake.calls), 1)
        self.assertEqual(engine.read_status(run)["gate"], "end")
        # an answer that ends the run, then a cancel: the run is finished, not cancelled
        engine.claim_answer(run, "tester")
        self.assertEqual(engine.request_cancel(run, by="stopper"), "requested")
        self.assertEqual(cli.answer_gate(run, "reject", None, "tester", claimed=True)[0], "rejected")
        self.assertEqual(engine.read_status(run)["status"], "rejected")
        self.assertFalse(engine.cancel_path(run).exists())

    def test_stale_claim_and_release(self):
        run = self.to_gate("raceflow", "race-3")
        engine.write_status(run, answering={"by": "gone", "pid": 999999, "gate": "look", "time": "x"})
        engine.claim_answer(run, "tester")                             # a dead process's claim is replaced
        engine.release_answer(run)
        self.assertIsNone(engine.read_status(run).get("answering"))
        engine.write_status(run, answering={"by": "gone", "pid": 999999, "gate": "look", "time": "x"})
        self.assertEqual(engine.request_cancel(run, by="stopper"), "cancelled")   # stale claim: cancel at once
        self.assertIsNone(engine.read_status(run).get("answering"))

    def test_race_threads(self):
        """Answer and cancel in two threads: exactly one of the two outcomes, never both or neither. Even rounds
        release both at the same instant; odd rounds send the cancel once the answer is claimed (while the graph
        resumes), so both orders are exercised."""
        seen = set()
        for k in range(8):
            Fake.calls = []
            run = self.to_gate("raceflow", f"race-t{k}")
            go, out = threading.Barrier(2), {}

            def answer():
                go.wait()
                out["answer"] = cli.answer_gate(run, "approve", None, "tester")

            def cancel(after_claim=k % 2 == 1):
                go.wait()
                if after_claim:
                    end = time.time() + 5
                    while not engine.read_status(run).get("answering") and time.time() < end:
                        time.sleep(0.001)
                out["cancel"] = engine.request_cancel(run, by="stopper")
            ts = [threading.Thread(target=answer), threading.Thread(target=cancel)]
            [t.start() for t in ts]
            [t.join(30) for t in ts]
            seen.add(out["answer"][0])
            st = engine.read_status(run)
            self.assertEqual(st["status"], "cancelled", (k, out))
            approved = len(self.events(run, "approve", "look"))
            if out["answer"][0] == "error":                            # cancel first
                self.assertEqual((approved, out["cancel"]), (0, "cancelled"), (k, out))
                self.assertEqual(st["step"], "look")
                self.assertEqual(Fake.calls, [])
            elif out["answer"][0] == "cancelled":                      # answer first, cancel while it resumed
                self.assertEqual((approved, out["cancel"]), (1, "requested"), (k, out))
                self.assertEqual(st["step"], "after")
                self.assertEqual(Fake.calls, [])
            else:                                                      # the run reached the next gate first
                self.assertEqual((approved, out["cancel"], out["answer"][0]), (1, "cancelled", "waiting"), (k, out))
                self.assertEqual(st["step"], "end")
            self.assertFalse(engine.cancel_path(run).exists())
        if os.environ.get("LANGFLOW_TEST_VERBOSE"):
            print("race outcomes (answer side):", sorted(seen), file=sys.stderr)

    def test_run_lock_across_processes(self):
        run = self.to_gate("raceflow", "race-4")
        src = str(Path(engine.__file__).resolve().parents[1])
        p = subprocess.Popen([sys.executable, "-c", HOLD, src, str(self.tmp), run, "1.5"], stdout=subprocess.PIPE,
                             text=True)
        try:
            self.assertEqual(p.stdout.readline().strip(), "held")
            t0 = time.time()
            engine.claim_answer(run, "tester")
            self.assertGreater(time.time() - t0, 0.8)                  # waited for the other process
        finally:
            p.wait(15)
            p.stdout.close()
        engine.release_answer(run)


if __name__ == "__main__":
    unittest.main()
