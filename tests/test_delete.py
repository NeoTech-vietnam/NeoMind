"""Deleting and pruning runs (engine.delete_run / prune_runs, `langflow rm` / `prune`, web DELETE /api/runs/<run> and
POST /api/runs/prune). Script-only flows, no agent.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest discover -s tests -v
"""
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from langflow import cli, engine, web
from langflow import project as projmod

FLOW = '''"""Delete test flow."""
from langflow import current, gate, write


def steps(args):
    return [
        write("first", lambda s, run: current().root / "out" / f"{run}.txt", lambda s: "kept\\n"),
        gate("look", "Look?"),
        write("second", lambda s, run: current().root / "out" / f"{run}-2.txt", lambda s: "two\\n"),
    ]
'''
CONFIG = '''[project]
name = "delete test"
approver = "tester"
'''


class DeleteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_delete_test_"))
        (self.tmp / ".langflow" / "workflows").mkdir(parents=True)
        (self.tmp / ".langflow" / "config.toml").write_text(CONFIG, encoding="utf-8")
        (self.tmp / ".langflow" / "workflows" / "flow.py").write_text(FLOW, encoding="utf-8")
        self.old_cwd = os.getcwd()
        os.chdir(self.tmp)
        projmod.set_current(projmod.load(self.tmp))

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def to_gate(self, run):
        run, app, payload = cli.prepare_start("flow", run, {})
        state, _ = cli.advance(app, run, payload)
        app.checkpointer.conn.close()
        self.assertEqual(state, "waiting")
        return run

    def checkpoints(self, run):
        conn = sqlite3.connect(projmod.current().state_dir / "checkpoints.sqlite")
        try:
            return conn.execute("SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?", (run,)).fetchone()[0]
        finally:
            conn.close()

    def set_status(self, run, **fields):
        p = engine.status_path(run)
        st = json.loads(p.read_text(encoding="utf-8"))
        st.update(fields)
        p.write_text(json.dumps(st), encoding="utf-8")

    def test_waiting_needs_force_and_outputs_stay(self):
        run = self.to_gate("d-1")
        (projmod.current().runs_dir / run).mkdir(exist_ok=True)
        (projmod.current().runs_dir / run / "draft.system.md").write_text("x", encoding="utf-8")
        self.assertGreater(self.checkpoints(run), 0)
        with self.assertRaises(engine.RunBusy) as e:
            engine.delete_run(run)
        self.assertIn("use force", str(e.exception))
        res = engine.delete_run(run, force=True, by="tester")
        self.assertEqual(res["run"], run)
        self.assertGreater(res["checkpoints"], 0)
        self.assertEqual(self.checkpoints(run), 0)
        for f in (engine.status_path(run), engine.log_path(run), engine.page_path(run),
                  projmod.current().runs_dir / run):
            self.assertFalse(f.exists(), f)
        self.assertTrue((self.tmp / "out" / f"{run}.txt").exists(), "an output must stay")
        self.assertIn(f"out/{run}.txt", res["kept_outputs"])
        log = (projmod.current().state_dir / "deleted.log").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(log[-1])["run"], run)
        self.assertEqual(json.loads(log[-1])["by"], "tester")
        with self.assertRaises(LookupError):
            engine.delete_run(run)

    def test_running_is_refused_and_dead_process_is_not(self):
        run = self.to_gate("d-2")
        self.set_status(run, status="running", pid=os.getpid())
        with self.assertRaises(engine.RunBusy):
            engine.delete_run(run, force=True)
        self.set_status(run, status="running", pid=999999)          # a crashed run: its process is gone
        engine.delete_run(run)
        self.assertFalse(engine.status_path(run).exists())

    def test_bad_names(self):
        for bad in ("../x", "a/b", "a\\b", "..", ""):
            with self.assertRaises(ValueError):
                engine.delete_run(bad)

    def test_prune(self):
        for r in ("p-1", "p-2", "p-3"):
            self.to_gate(r)
            self.set_status(r, status="done")
        self.set_status("p-1", updated="2000-01-01 00:00:00")
        self.set_status("p-2", updated="2000-01-02 00:00:00")
        self.to_gate("p-4")                                           # waiting: not pruned by default
        cand = [r["run"] for r in engine.prune_candidates(days=30)]
        self.assertEqual(sorted(cand), ["p-1", "p-2"])
        self.assertEqual([r["run"] for r in engine.prune_candidates(keep=3)], ["p-1"])   # newest 3: p-4 p-3 p-2
        res = engine.prune_runs(days=30, dry_run=True)
        self.assertEqual(res["deleted"], [])
        self.assertTrue(engine.status_path("p-1").exists())
        res = engine.prune_runs(days=30)
        self.assertEqual(sorted(d["run"] for d in res["deleted"]), ["p-1", "p-2"])
        self.assertEqual(sorted(r["run"] for r in engine.list_runs()), ["p-3", "p-4"])
        res = engine.prune_runs(statuses=["waiting"])
        self.assertEqual([d["run"] for d in res["deleted"]], ["p-4"])  # asked for: deleted with force

    def test_cli_rm_and_prune(self):
        self.to_gate("c-1")
        self.set_status("c-1", status="done")
        with self.assertRaises(SystemExit):
            cli.cmd_rm(["c-1"])                                       # not a console and no --yes
        self.assertTrue(engine.status_path("c-1").exists())
        cli.cmd_prune([])                                             # lists only
        self.assertTrue(engine.status_path("c-1").exists())
        cli.cmd_rm(["c-1", "--yes"])
        self.assertFalse(engine.status_path("c-1").exists())

    def test_web(self):
        api = web.Api()
        api.user = "tester"
        self.to_gate("w-1")
        self.to_gate("w-2")
        self.set_status("w-2", status="done", updated="2000-01-01 00:00:00")
        with self.assertRaises(web.ApiError) as e:
            api.route("DELETE", ["runs", "w-1"], {}, {}, "web")
        self.assertEqual(e.exception.status, 409)
        res = api.route("DELETE", ["runs", "w-1"], {"force": ["1"]}, {}, "web")
        self.assertEqual(res["run"], "w-1")
        with self.assertRaises(web.ApiError) as e:
            api.route("DELETE", ["runs", "w-1"], {}, {}, "web")
        self.assertEqual(e.exception.status, 404)
        res = api.route("POST", ["runs", "prune"], {}, {"days": 30, "dry_run": True}, "web")
        self.assertEqual([c["run"] for c in res["candidates"]], ["w-2"])
        self.assertTrue(engine.status_path("w-2").exists())
        res = api.route("POST", ["runs", "prune"], {}, {"days": 30}, "web")
        self.assertEqual([d["run"] for d in res["deleted"]], ["w-2"])
        with self.assertRaises(web.ApiError) as e:
            api.route("POST", ["runs", "prune"], {}, {"days": -1}, "web")
        self.assertEqual(e.exception.status, 400)
        log = (projmod.current().state_dir / "deleted.log").read_text(encoding="utf-8")
        self.assertIn('"by": "web:tester"', log)


if __name__ == "__main__":
    unittest.main()
