"""Tests for parallel joins and fan-out concurrency: every step after a join runs once, whatever the branch lengths
(the join is a deferred node), and `concurrency` caps how many fan-out workers run at the same time.
No agent is called: steps are scripts that append their name to a trace file.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_parallel -v
"""
import os
import shutil
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from langflow import cli, engine
from langflow import project as projmod

PY = sys.executable.replace("\\", "/")

FLOWS = {
    # one branch of 1 step, one of 3: before the fix the join and `after` ran twice
    "uneven": '''
def steps(args):
    return [parallel("p", [t("a"), [t("b1"), t("b2"), t("b3")]]), t("after")]
''',
    # a parallel inside a branch of another parallel
    "nested": '''
def steps(args):
    return [parallel("outer", [t("a"), [t("b0"), parallel("inner", [t("x"), [t("y1"), t("y2")]]), t("b9")]]),
            t("after")]
''',
    # a route inside a branch: the branch length depends on the label
    "routed": '''
def steps(args):
    return [parallel("p", [t("a"), [route("r", lambda s: "long", {"long": [t("l1"), t("l2")], "short": [t("s1")]})]]),
            t("after")]
''',
    # a gate after the join: asked once
    "gated": '''
def steps(args):
    return [parallel("p", [t("a"), [t("b1"), t("b2")]]), gate("ok", "Go on?"), t("after")]
''',
    # fan-out of 6 workers that record how many run at the same time
    "fan": '''
def worker(item, i):
    return script(f"w[{i}]", [PY, "-c", WORK, str(i)])

def steps(args):
    return [fanout("f", lambda s: list(range(6)), worker), t("after")]
''',
}

HEADER = f'''"""Parallel test flow."""
from langflow import fanout, gate, parallel, route, script

PY = "{PY}"
TRACE = "trace.txt"
# a worker: count itself in, record the peak, wait, count itself out (a lock dir keeps the counter consistent)
WORK = """
import os, sys, time
def locked(fn):
    while True:
        try:
            os.mkdir("lock.d"); break
        except FileExistsError:
            time.sleep(0.01)
    try:
        return fn()
    finally:
        os.rmdir("lock.d")
def bump(d):
    now = int(open("live.txt").read() or 0) if os.path.exists("live.txt") else 0
    now += d
    open("live.txt", "w").write(str(now))
    peak = int(open("peak.txt").read() or 0) if os.path.exists("peak.txt") else 0
    open("peak.txt", "w").write(str(max(peak, now)))
locked(lambda: bump(1))
time.sleep(0.5)
locked(lambda: bump(-1))
open("trace.txt", "a").write("w" + sys.argv[1] + chr(10))
"""


def t(name):
    return script(name, [PY, "-c", f"open({{TRACE!r}}, 'a').write({{name!r}} + chr(10))"])
'''


class ParallelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_parallel_test_"))
        wf = cls.tmp / ".langflow" / "workflows"
        wf.mkdir(parents=True)
        (cls.tmp / ".langflow" / "config.toml").write_text(
            '[project]\nname = "parallel test"\napprover = "tester"\n', encoding="utf-8")
        for name, body in FLOWS.items():
            (wf / f"{name}.py").write_text(HEADER + body, encoding="utf-8")
        cls.old_cwd = os.getcwd()
        os.chdir(cls.tmp)
        projmod.set_current(projmod.load(cls.tmp))

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls.old_cwd)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        for f in ("trace.txt", "live.txt", "peak.txt"):
            (self.tmp / f).unlink(missing_ok=True)

    def run_flow(self, workflow, run, args=None):
        run, app, payload = cli.prepare_start(workflow, run, args or {})
        return run, app, cli.advance(app, run, payload)

    def trace(self) -> list[str]:
        p = self.tmp / "trace.txt"
        return p.read_text(encoding="utf-8").split() if p.exists() else []

    def assert_once(self, expected):
        got = Counter(self.trace())
        self.assertEqual(got, Counter(expected), f"trace: {self.trace()}")
        self.assertEqual(self.trace()[-1], "after")

    def test_uneven_branches(self):
        _, _, (state, msg) = self.run_flow("uneven", "un-1")
        self.assertEqual(state, "done", msg)
        self.assert_once(["a", "b1", "b2", "b3", "after"])

    def test_nested_parallel(self):
        _, _, (state, msg) = self.run_flow("nested", "ne-1")
        self.assertEqual(state, "done", msg)
        self.assert_once(["a", "b0", "x", "y1", "y2", "b9", "after"])
        tr = self.trace()
        self.assertLess(max(tr.index("x"), tr.index("y2")), tr.index("b9"))

    def test_route_in_branch(self):
        _, _, (state, msg) = self.run_flow("routed", "ro-1")
        self.assertEqual(state, "done", msg)
        self.assert_once(["a", "l1", "l2", "after"])

    def test_gate_after_join(self):
        run, _, (state, msg) = self.run_flow("gated", "ga-1")
        self.assertEqual(state, "waiting", msg)
        self.assertEqual(engine.read_status(run).get("gate"), "ok")
        engine.write_status(run, answering={"gate": "ok", "by": "tester"})
        state, msg = cli.answer_gate(run, "approve", None, "tester", claimed=True)
        self.assertEqual(state, "done", msg)
        self.assert_once(["a", "b1", "b2", "after"])
        asked = [h for h in engine.read_status(run).get("history", []) if h.get("step") == "ok" and h.get("kind") == "gate"]
        self.assertEqual(len(asked), 1, asked)

    def test_layout_hides_branch_markers(self):
        g = cli.layout_of("nested", {"_run": "RUN", "_workflow": "nested"})
        ids = {n["id"] for n in g["nodes"]}
        self.assertFalse([n for n in ids if "_branch" in n], ids)
        edges = {(e["source"], e["target"]) for e in g["edges"]}
        self.assertFalse([e for e in edges if "_branch" in e[0] or "_branch" in e[1]], edges)
        for edge in [("a", "outer_join"), ("b9", "outer_join"), ("x", "inner_join"), ("y2", "inner_join"),
                     ("inner_join", "b9"), ("outer_join", "after")]:
            self.assertIn(edge, edges)

    def peak(self) -> int:
        return int((self.tmp / "peak.txt").read_text(encoding="utf-8"))

    def test_fanout_no_limit(self):
        _, _, (state, msg) = self.run_flow("fan", "fa-1")
        self.assertEqual(state, "done", msg)
        self.assertEqual(Counter(self.trace()), Counter([f"w{i}" for i in range(6)] + ["after"]))
        self.assertGreater(self.peak(), 2)

    def test_fanout_concurrency_arg(self):
        run, _, (state, msg) = self.run_flow("fan", "fa-2", {"concurrency": "2"})
        self.assertEqual(state, "done", msg)
        self.assertEqual(len(self.trace()), 7)
        self.assertLessEqual(self.peak(), 2)

    def test_concurrency_from_config(self):
        self.assertEqual(cli.concurrency_of({}), None)
        cfg = projmod.current().cfg
        cfg["run"] = {"max_concurrency": 3}
        try:
            self.assertEqual(cli.concurrency_of({}), 3)
            self.assertEqual(cli.concurrency_of({"concurrency": "1"}), 1)     # the run arg wins
            cfg["run"] = {"max_concurrency": 0}
            self.assertEqual(cli.concurrency_of({}), None)                    # 0 = no limit
        finally:
            cfg.pop("run", None)

    def test_bad_concurrency_refused(self):
        for bad in ("0", "-1", "two"):
            with self.assertRaises(SystemExit):
                cli.prepare_start("fan", f"bad-{bad}", {"concurrency": bad})


if __name__ == "__main__":
    unittest.main()
