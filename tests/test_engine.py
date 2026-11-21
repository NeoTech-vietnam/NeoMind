"""Tests for the engine features of phase 2: usage and cost, transient retry, cancel, gate files, notify, schedule
helpers. No real agent is called: ai steps use an in-process fake agent registered as "fake".

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest discover -s tests -v
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from langflow import cli, engine, schedule, view
from langflow import project as projmod
from langflow.agents import AGENTS
from langflow.agents import base

PY = sys.executable.replace("\\", "/")
SCHEMA = {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}

FLOW = f'''"""Engine test flow."""
from langflow import ai, current, gate, script, write

REQUIRED = ["topic"]
SCHEMA = {SCHEMA!r}


def steps(args):
    fast = str(current().state_dir / "fast.txt")
    return [
        script("slow", ["{PY}", "-c",
                        "import os,time; time.sleep(0 if os.path.exists(%r) else 60); print('slow done')" % fast]),
        ai("think", "Say something about {{topic}}", SCHEMA, agent="fake", model="fake-model"),
        gate("look", "Read the notes on {{topic}}", show=["notes/{{topic}}.md", "notes/missing.md"]),
        gate("again", lambda s: "Second look", show=lambda s: current().root / "notes" / "b.md"),
        write("out", lambda s, run: current().state_dir / "out" / f"{{run}}.txt", lambda s: "ok\\n"),
    ]
'''
PROBE = '''import json, os, pathlib
p = pathlib.Path("notify_calls.jsonl")
with p.open("a", encoding="utf-8") as f:
    f.write(json.dumps({k: os.environ.get(k) for k in ("LANGFLOW_RUN", "LANGFLOW_GATE", "LANGFLOW_QUESTION",
                        "LANGFLOW_WORKFLOW", "LANGFLOW_PAGE")}) + "\\n")
'''
CONFIG = f'''[project]
name = "engine test"
approver = "tester"

[retry]
attempts = 2
delays = [0]

[pricing."fake-model"]
input = 3.0
output = 15.0
cache_read = 0.3

[notify]
command = ["{PY}", "notify_probe.py", "{{gate}}"]
'''


class Fake:
    """In-process agent: a queue of behaviours (an exception to raise, or a usage dict to answer with)."""
    plan: list = []
    calls = 0

    @classmethod
    def run(cls, project, prompt, schema, model, opts, cwd, timeout, say):
        cls.calls += 1
        what = cls.plan.pop(0) if cls.plan else {"input_tokens": 100, "output_tokens": 10}
        if isinstance(what, Exception):
            raise what
        if what == "hang":
            # like a real adapter: a child process that the cancel watch must kill
            base.stream([PY, "-c", "import time; time.sleep(60)"], "", str(cwd), base.clean_env(), 120,
                        lambda e: None)
        return {"result": {"text": "hi"}, "session": "s1", "hooks": None, "usage": base.usage(**what)
                if isinstance(what, dict) else base.usage(), "cost_usd": None, "model_used": "fake-model"}


def wait_for(cond, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


class EngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_engine_test_"))
        (cls.tmp / ".langflow" / "workflows").mkdir(parents=True)
        (cls.tmp / ".langflow" / "config.toml").write_text(CONFIG, encoding="utf-8")
        (cls.tmp / ".langflow" / "workflows" / "flow.py").write_text(FLOW, encoding="utf-8")
        (cls.tmp / "notify_probe.py").write_text(PROBE, encoding="utf-8")
        (cls.tmp / "notes").mkdir()
        (cls.tmp / "notes" / "pumps.md").write_text("# notes\n", encoding="utf-8")
        cls.old_cwd = os.getcwd()
        os.chdir(cls.tmp)
        projmod.set_current(projmod.load(cls.tmp))
        AGENTS["fake"] = Fake.run

    @classmethod
    def tearDownClass(cls):
        AGENTS.pop("fake", None)
        os.chdir(cls.old_cwd)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        Fake.plan, Fake.calls = [], 0
        fast = projmod.current().state_dir / "fast.txt"
        if fast.exists():
            fast.unlink()

    def start(self, run):
        run, app, payload = cli.prepare_start("flow", run, {"topic": "pumps"})
        box = {}
        t = threading.Thread(target=lambda: box.setdefault("r", cli.advance(app, run, payload)), daemon=True)
        t.start()
        return run, t, box

    def events(self, run, event=None):
        return [h for h in engine.read_status(run).get("history", []) if event is None or h.get("event") == event]

    # ------------------------------------------------------------ cancel, gate files, notify, usage

    def test_cancel_script_then_gates(self):
        run, t, box = self.start("cancel-1")
        self.assertTrue(wait_for(lambda: engine.read_status(run).get("step") == "slow"))
        time.sleep(1.5)
        self.assertEqual(engine.request_cancel(run, by="tester"), "requested")
        t.join(15)
        self.assertFalse(t.is_alive(), "advance did not stop after the cancel")
        self.assertEqual(box["r"][0], "cancelled")
        st = engine.read_status(run)
        self.assertEqual(st["status"], "cancelled")
        self.assertEqual(self.events(run, "cancelled")[-1]["by"], "tester")
        self.assertEqual(self.events(run, "cancelled")[-1]["step"], "slow")
        self.assertFalse(engine.cancel_path(run).exists())
        states, _ = view.step_states(st)
        self.assertEqual(states["slow"], "cancelled")
        with self.assertRaises(ValueError):
            engine.request_cancel(run)

        # continue re-runs the cut step, the ai step spends tokens, the gate shows its files and notifies
        (projmod.current().state_dir / "fast.txt").write_text("x", encoding="utf-8")
        state, msg = cli.continue_run(run)
        self.assertEqual(state, "waiting", msg)
        st = engine.read_status(run)
        root = projmod.current().root.resolve()
        self.assertEqual(st["gate_files"], [str(root / "notes" / "pumps.md"), str(root / "notes" / "missing.md")])
        done = self.events(run, "done")
        think = [h for h in done if h.get("step") == "think"][-1]
        self.assertEqual(think["usage"]["input_tokens"], 100)
        self.assertEqual(think["usage"]["cost_source"], "pricing")
        self.assertAlmostEqual(think["usage"]["cost_usd"], (100 * 3 + 10 * 15) / 1e6, places=9)
        self.assertEqual(think["attempts"], 1)
        self.assertEqual(st["totals"]["steps"], 1)
        self.assertEqual(st["totals"]["output_tokens"], 10)
        _, info = view.step_states(st)
        self.assertEqual(info["think"]["usage"]["input_tokens"], 100)
        calls = [json.loads(x) for x in Path("notify_calls.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(calls[-1]["LANGFLOW_GATE"], "look")
        self.assertEqual(calls[-1]["LANGFLOW_RUN"], run)
        self.assertEqual(calls[-1]["LANGFLOW_WORKFLOW"], "flow")
        n_calls = len(calls)

        # a waiting gate is cancelled at once; continue makes it wait again (and notify again)
        self.assertEqual(engine.request_cancel(run, by="tester"), "cancelled")
        st = engine.read_status(run)
        self.assertEqual(st["status"], "cancelled")
        self.assertIsNone(st.get("gate_files"))
        self.assertEqual(view.step_states(st)[0]["look"], "cancelled")
        state, msg = cli.continue_run(run)
        self.assertEqual(state, "waiting", msg)
        self.assertEqual(len(Path("notify_calls.jsonl").read_text(encoding="utf-8").splitlines()), n_calls + 1)
        self.assertEqual(cli.answer_gate(run, "approve", None, "tester")[0], "waiting")
        st = engine.read_status(run)
        self.assertEqual(st["gate"], "again")
        self.assertEqual(st["gate_files"], [str(root / "notes" / "b.md")])
        self.assertEqual(cli.answer_gate(run, "approve", None, "tester")[0], "done")
        st = engine.read_status(run)
        self.assertEqual(st["status"], "done")
        self.assertIsNone(st.get("gate_files"))
        self.assertIn("Spend:", engine.page_path(run).read_text(encoding="utf-8"))

    def test_transient_retry_then_failure(self):
        (projmod.current().state_dir).mkdir(parents=True, exist_ok=True)
        (projmod.current().state_dir / "fast.txt").write_text("x", encoding="utf-8")
        Fake.plan = [base.AgentError("API Error: 529 overloaded", base.usage(50, 5)),
                     {"input_tokens": 100, "output_tokens": 10}]
        run, t, box = self.start("retry-1")
        t.join(30)
        self.assertEqual(box["r"][0], "waiting")
        retry = self.events(run, "retry")
        self.assertEqual(len(retry), 1)
        self.assertEqual(retry[0]["attempt"], 1)
        self.assertEqual(retry[0]["wait"], 0)
        think = [h for h in self.events(run, "done") if h.get("step") == "think"][-1]
        self.assertEqual(think["attempts"], 2)
        self.assertEqual(think["usage"]["input_tokens"], 150)
        _, info = view.step_states(engine.read_status(run))
        self.assertEqual(info["think"]["retries"], 1)

        # a non-transient error fails the step at once, with its spend
        Fake.plan = [base.AgentError("schema refused", base.usage(7, 1))]
        run, t, box = self.start("retry-2")
        t.join(30)
        self.assertEqual(box["r"][0], "failed")
        failed = self.events(run, "failed")[-1]
        self.assertEqual(failed["usage"]["input_tokens"], 7)
        self.assertEqual(failed["attempts"], 1)
        self.assertEqual(self.events(run, "retry"), [])
        # a failed run can be cancelled (locks released)
        self.assertEqual(engine.request_cancel(run), "cancelled")

        # transient errors beyond [retry] attempts fail the step
        Fake.plan = [base.AgentError("429 Too Many Requests")] * 3
        run, t, box = self.start("retry-3")
        t.join(30)
        self.assertEqual(box["r"][0], "failed")
        self.assertEqual(len(self.events(run, "retry")), 2)

    def test_cancel_while_agent_runs(self):
        (projmod.current().state_dir).mkdir(parents=True, exist_ok=True)
        (projmod.current().state_dir / "fast.txt").write_text("x", encoding="utf-8")
        Fake.plan = ["hang"]
        run, t, box = self.start("cancel-agent")
        self.assertTrue(wait_for(lambda: engine.read_status(run).get("step") == "think"))
        time.sleep(1.5)
        self.assertEqual(engine.request_cancel(run, by="tester"), "requested")
        t.join(15)
        self.assertFalse(t.is_alive())
        self.assertEqual(box["r"][0], "cancelled")
        st = engine.read_status(run)
        self.assertEqual(st["status"], "cancelled")
        self.assertEqual(st["step"], "think")
        self.assertEqual(self.events(run, "cut")[-1]["step"], "think")
        self.assertEqual(view.step_states(st)[0]["think"], "cancelled")

    def test_stop_of_dead_running_run(self):
        engine.write_status("ghost", workflow="flow", status="running", step="slow", pid=999999)
        self.assertEqual(engine.request_cancel("ghost", by="tester"), "cancelled")
        self.assertEqual(engine.read_status("ghost")["status"], "cancelled")


class UnitTest(unittest.TestCase):
    def test_transient(self):
        for text in ("API Error: 529 {\"type\":\"overloaded_error\"}", "rate limit exceeded", "HTTP 503",
                     "429 Too Many Requests", "Request timed out", "ECONNRESET", "connection reset by peer",
                     "Service temporarily unavailable", "status: 502"):
            self.assertTrue(base.is_transient(text), text)
        for text in ("claude returned no structured output: bad schema", "project hooks did not run",
                     "step time limit of 1800 s reached; agent process tree killed", "exit 1", "line 500 of file"):
            self.assertFalse(base.is_transient(text), text)

    def test_usage_mapping(self):
        from langflow.agents import claude, codex, opencode
        self.assertEqual(claude.norm_usage({"input_tokens": 5, "output_tokens": 7, "cache_read_input_tokens": 100,
                                            "cache_creation_input_tokens": 20}),
                         base.usage(5, 7, 100, 20))
        self.assertEqual(codex.norm_usage({"input_tokens": 120, "cached_input_tokens": 100, "output_tokens": 9,
                                           "reasoning_output_tokens": 4}),
                         base.usage(20, 9, 100, 0, 4))
        self.assertEqual(opencode.norm_usage({"input": 3, "output": 4, "reasoning": 1, "cache": {"read": 2,
                                                                                               "write": 1}}),
                         base.usage(3, 4, 2, 1, 1))
        use, cost = opencode.session_usage({"tokens": {}, "cost": 0}, [
            {"id": "u1", "type": "user"},
            {"id": "a1", "type": "assistant", "tokens": {"input": 1, "output": 2}, "cost": 0.5},
            {"id": "a2", "type": "assistant", "tokens": {"input": 3, "output": 4}, "cost": 0.25}], "u1")
        self.assertEqual(use["input_tokens"], 4)
        self.assertEqual(cost, 0.75)

    def test_stream_cancel_and_time_limit(self):
        t0 = time.time()
        base.CTX.cancelled = lambda: time.time() - t0 > 1
        try:
            with self.assertRaises(base.AgentCancelled):
                base.stream([PY, "-c", "import time; time.sleep(60)"], "", None, base.clean_env(), 120,
                            lambda e: None)
        finally:
            base.CTX.cancelled = None
        self.assertLess(time.time() - t0, 15)
        with self.assertRaises(base.AgentError) as cm:
            base.stream([PY, "-c", "import time; time.sleep(60)"], "", None, base.clean_env(), 2, lambda e: None)
        self.assertFalse(base.is_transient(str(cm.exception)))

    def test_schedule_helpers(self):
        self.assertEqual(schedule.norm_days(None), "DAILY")
        self.assertEqual(schedule.norm_days("mon-fri"), "MON-FRI")
        self.assertEqual(schedule.norm_days(["fri", "MON"]), "MON,FRI")
        with self.assertRaises(schedule.ScheduleError):
            schedule.norm_days("MOO")
        self.assertEqual(schedule.norm_time("9:05"), "09:05")
        with self.assertRaises(schedule.ScheduleError):
            schedule.norm_time("25:00")
        with self.assertRaises(schedule.ScheduleError):
            schedule.check_args(["start", "x&y"])

        class P:
            root = Path("C:/proj/my root")
            state_dir = Path("C:/proj/my root/.langflow/state")
        args = ["start", "daily_plan", "daily-{date}", "topic=two words"]
        line = schedule.command_line(P, args)
        self.assertEqual(schedule.parse_args(line), args)
        self.assertIn("1-5", schedule.crontab_line(P, "09:00", "MON-FRI", args))
        self.assertEqual(schedule._days_of({"kind": "MSFT_TaskWeeklyTrigger", "days": 2 | 4 | 8 | 16 | 32}),
                         "MON-FRI")
        self.assertEqual(schedule._days_of({"kind": "MSFT_TaskDailyTrigger"}), "DAILY")


if __name__ == "__main__":
    unittest.main()
