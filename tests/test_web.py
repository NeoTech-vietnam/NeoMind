"""Tests for `langflow web` against a temporary project with script-only workflows (no agent calls).

Run with the langflow tool's Python (no pytest needed):
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest discover -s tests -v
"""
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
import urllib.parse
import urllib.request
from pathlib import Path

from langflow import project as projmod
from langflow import web

PY = sys.executable.replace("\\", "/")
WORKFLOW = f'''"""Test flow: a script, a gate, a script that fails until a flag file exists, a written file."""
from langflow import current, gate, script, write

META = {{"description": "web test flow"}}
REQUIRED = ["topic"]
MEMORY_SERIES = "{{topic}}"


def steps(args):
    flag = str(current().state_dir / "flag.txt")
    return [
        script("prep", ["{PY}", "-c", "print('prep for ' + {{!r}})".format(args.get("topic", "?"))]),
        gate("ok", "Go on with {{topic}}?"),
        script("finish", ["{PY}", "-c",
                          "import os,sys; print('finish'); sys.exit(0 if os.path.exists(%r) else 3)" % flag]),
        write("out", lambda s, run: current().state_dir / "out" / f"{{run}}.txt", lambda s: "ok\\n"),
    ]
'''
BROKEN = '"""broken"""\nraise RuntimeError("boom")\n'
SLOW = f'''"""Test flow: one script step that sleeps (to cancel it while it runs)."""
from langflow import script

META = {{"description": "slow flow"}}


def steps(args):
    return [script("nap", ["{PY}", "-c", "import time; time.sleep(60)"])]
'''
CONFIG = '[project]\nname = "web test"\napprover = "tester"\n'


class WebTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="langflow_web_test_"))
        (cls.tmp / ".langflow" / "workflows").mkdir(parents=True)
        (cls.tmp / ".langflow" / "config.toml").write_text(CONFIG, encoding="utf-8")
        (cls.tmp / ".langflow" / "workflows" / "flow.py").write_text(WORKFLOW, encoding="utf-8")
        (cls.tmp / ".langflow" / "workflows" / "broken.py").write_text(BROKEN, encoding="utf-8")
        (cls.tmp / ".langflow" / "workflows" / "slow.py").write_text(SLOW, encoding="utf-8")
        cls.old_cwd = os.getcwd()
        os.chdir(cls.tmp)
        projmod.set_current(projmod.load(cls.tmp))
        cls.server, cls.token = web.serve(0, quiet=True)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        os.chdir(cls.old_cwd)
        try:
            from langflow import memory
            if memory._STORE is not None:
                memory._STORE.conn.close()
                memory._STORE = None
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- helpers
    def call(self, method, path, body=None, token=True, channel=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Langflow-Token"] = self.token if token is True else token
        if channel:
            headers["X-Langflow-Channel"] = channel
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def wait(self, run, statuses, timeout=60):
        t0 = time.time()
        while time.time() - t0 < timeout:
            code, st = self.call("GET", f"/api/runs/{run}")
            if code == 200 and st["status"] in statuses and not st["busy"]:
                return st
            time.sleep(0.2)
        self.fail(f"{run} did not reach {statuses}: {st}")

    def start(self, run, topic="tea"):
        code, out = self.call("POST", "/api/runs", {"workflow": "flow", "run": run, "args": {"topic": topic}})
        self.assertEqual(code, 200, out)
        return out["started"]

    # -- tests
    def test_auth(self):
        self.assertEqual(self.call("GET", "/api/project", token=False)[0], 401)
        self.assertEqual(self.call("GET", "/api/runs", token="wrong")[0], 401)
        self.assertEqual(self.call("POST", "/api/runs", {"workflow": "flow", "run": "x"}, token=False)[0], 401)
        self.assertFalse((self.tmp / ".langflow" / "state" / "runs" / "x.json").exists())

    def test_project_workflows_graph(self):
        code, p = self.call("GET", "/api/project")
        self.assertEqual(code, 200)
        self.assertEqual((p["name"], p["approver"], p["allow_agent_approval"]), ("web test", "tester", False))
        code, wfs = self.call("GET", "/api/workflows")
        names = {w["name"]: w for w in wfs}
        self.assertEqual(names["flow"]["required"], ["topic"])
        self.assertEqual(names["flow"]["description"], "web test flow")
        self.assertIn("error", names["broken"])
        code, g = self.call("GET", "/api/workflows/flow/graph")
        self.assertEqual(code, 200)
        self.assertEqual([n["id"] for n in g["nodes"]], ["__start__", "prep", "ok", "finish", "out", "__end__"])
        self.assertTrue(any(e["source"] == "ok" and e["conditional"] for e in g["edges"]))
        self.assertEqual(self.call("GET", "/api/workflows/nope/graph")[0], 404)
        self.assertEqual(self.call("GET", "/api/workflows/..%2Fx/graph")[0], 400)
        self.assertEqual(self.call("GET", "/api/nothing")[0], 404)

    def test_full_path_approve_continue(self):
        run = self.start("t-approve-{date}")
        self.assertRegex(run, r"^t-approve-\d{8}$")
        self.assertEqual(self.call("POST", "/api/runs", {"workflow": "flow", "run": run, "args": {"topic": "x"}})[0],
                         409)
        st = self.wait(run, {"waiting"})
        self.assertEqual((st["gate"], st["question"]), ("ok", "Go on with tea?"))
        self.assertEqual(st["states"]["ok"], "waiting")
        self.assertEqual(st["states"]["prep"], "done")
        runs = self.call("GET", "/api/runs")[1]
        self.assertIn(run, [r["run"] for r in runs])
        # continue at a gate -> 409; wrong confirm -> 400; bad decision -> 400
        self.assertEqual(self.call("POST", f"/api/runs/{run}/continue", {})[0], 409)
        self.assertEqual(self.call("POST", f"/api/runs/{run}/answer", {"decision": "approve", "confirm": "no"})[0], 400)
        self.assertEqual(self.call("POST", f"/api/runs/{run}/answer", {"decision": "maybe", "confirm": run})[0], 400)
        # two answers at once: exactly one accepted, the other 409
        results = []
        body = {"decision": "approve", "note": "fine by me", "confirm": run}
        ts = [threading.Thread(target=lambda: results.append(self.call("POST", f"/api/runs/{run}/answer", body)))
              for _ in range(2)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sorted(c for c, _ in results), [200, 409], results)
        ok = next(o for c, o in results if c == 200)
        self.assertEqual(ok["by"], f"web:{web.getpass.getuser()}")
        st = self.wait(run, {"failed"})               # finish fails until the flag exists
        self.assertEqual(st["step"], "finish")
        self.assertEqual(st["job"]["action"], "answer")
        self.assertEqual(st["job"]["state"], "failed")
        gate_ev = [h for h in st["history"] if h.get("step") == "ok" and h.get("event") == "approve"]
        self.assertEqual(gate_ev[0]["by"], f"web:{web.getpass.getuser()}")
        self.assertEqual(gate_ev[0]["note"], "fine by me")
        self.assertEqual(self.call("POST", f"/api/runs/{run}/answer", body)[0], 409)    # not waiting any more
        (self.tmp / ".langflow" / "state" / "flag.txt").write_text("1")
        try:
            code, out = self.call("POST", f"/api/runs/{run}/continue", {})
            self.assertEqual(code, 200, out)
            st = self.wait(run, {"done"})
        finally:
            (self.tmp / ".langflow" / "state" / "flag.txt").unlink()
        self.assertEqual(st["states"]["out"], "done")
        self.assertEqual(self.call("POST", f"/api/runs/{run}/continue", {})[0], 409)    # done: nothing to continue
        # memory: the gate note is in run and series memory
        code, m = self.call("GET", f"/api/runs/{run}/memory")
        self.assertEqual(code, 200)
        self.assertIn(f"gate:ok:{run}", m["run"])
        self.assertTrue(any(e["key"] == f"gate:ok:{run}" for e in m["series"]))
        # log: whole log, then nothing new from the returned offset
        code, lg = self.call("GET", f"/api/runs/{run}/log?offset=0")
        self.assertTrue(any("prep for tea" in line for line in lg["lines"]), lg)
        self.assertEqual(self.call("GET", f"/api/runs/{run}/log?offset={lg['offset']}")[1]["lines"], [])
        self.assertEqual(self.call("GET", f"/api/runs/{run}/log?offset=x")[0], 400)
        self.assertEqual(self.call("GET", f"/api/runs/{run}/transcript?step=prep")[0], 404)

    def test_reject_from_panel(self):
        run = self.start("t-reject")
        self.wait(run, {"waiting"})
        code, out = self.call("POST", f"/api/runs/{run}/answer", {"decision": "reject", "confirm": run},
                              channel="panel")
        self.assertEqual(code, 200, out)
        st = self.wait(run, {"rejected"})
        ev = [h for h in st["history"] if h.get("event") == "reject"]
        self.assertEqual(ev[0]["by"], f"panel:{web.getpass.getuser()}")
        self.assertEqual(st["states"]["ok"], "rejected")
        self.assertEqual(self.call("POST", f"/api/runs/{run}/answer", {"decision": "approve", "confirm": run},
                                   channel="cli")[0], 400)

    def test_start_errors(self):
        self.assertEqual(self.call("POST", "/api/runs", {"workflow": "flow", "run": "t-miss", "args": {}})[0], 400)
        self.assertFalse((self.tmp / ".langflow" / "state" / "runs" / "t-miss.json").exists())
        self.assertEqual(self.call("POST", "/api/runs", {"workflow": "flow", "run": "../evil",
                                                         "args": {"topic": "x"}})[0], 400)
        self.assertEqual(self.call("POST", "/api/runs", {"workflow": "nope", "run": "t-x"})[0], 404)
        self.assertEqual(self.call("POST", "/api/runs", {"workflow": "flow"})[0], 400)
        self.assertEqual(self.call("GET", "/api/runs/none")[0], 404)

    def test_static(self):
        code, html = self.call("GET", "/", token=False)
        self.assertEqual(code, 200)
        old = web.WEBUI
        ui = self.tmp / "webui"
        (ui / "assets").mkdir(parents=True)
        (ui / "index.html").write_text("<html><head><!-- LANGFLOW_CONFIG --></head><body></body></html>", "utf-8")
        (ui / "assets" / "a.js").write_text("console.log(1)", "utf-8")
        web.WEBUI = ui
        try:
            code, html = self.call("GET", "/", token=False)
            self.assertIn(f'<meta name="langflow-token" content="{self.token}">'.encode(), html)
            code, html = self.call("GET", "/runs/abc", token=False)          # client-side route
            self.assertIn(b"langflow-token", html)
            self.assertEqual(self.call("GET", "/assets/a.js", token=False)[0], 200)
            self.assertEqual(self.call("GET", "/assets/none.js", token=False)[0], 404)
            self.assertIn(self.call("GET", "/..%2F.langflow%2Fconfig.toml", token=False)[0], (403, 404))
        finally:
            web.WEBUI = old


    # -- phase 2: stats, outputs, files, cancel, memory edit, propose, schedules
    def fake_run(self, run, **st):
        """A status file written directly (no workflow, no checkpoint)."""
        d = self.tmp / ".langflow" / "state" / "runs"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{run}.json").write_text(json.dumps({"run": run, **st}), encoding="utf-8")

    def test_stats(self):
        u1 = {"input_tokens": 100, "output_tokens": 50, "cache_read_tokens": 10, "cache_write_tokens": 0,
              "reasoning_tokens": 5, "cost_usd": 0.5, "cost_source": "agent"}
        u2 = {**u1, "input_tokens": 300, "cost_usd": 1.5}
        hist = lambda u, verdict: [  # noqa: E731
            {"time": "2026-11-17 10:00:00", "step": None, "kind": "run", "event": "start"},
            {"time": "2026-11-17 10:00:00", "step": "draft", "kind": "ai", "event": "start"},
            {"time": "2026-11-17 10:00:30", "step": "draft", "kind": "ai", "event": "check failed", "attempt": 1},
            {"time": "2026-11-17 10:00:40", "step": "draft", "kind": "ai", "event": "retry", "attempt": 1, "wait": 15},
            {"time": "2026-11-17 10:01:00", "step": "draft", "kind": "ai", "event": "done", "seconds": 60, "usage": u},
            {"time": "2026-11-17 10:01:00", "step": "lint", "kind": "script", "event": "start"},
            {"time": "2026-11-17 10:01:04", "step": "lint", "kind": "script", "event": "done"},
            {"time": "2026-11-17 10:01:05", "step": "w[0]", "kind": "ai", "event": "done", "seconds": 4},
            {"time": "2026-11-17 10:02:00", "step": "review", "kind": "gate", "event": verdict, "by": "web:x"},
            {"time": "2026-11-17 10:02:00", "step": None, "kind": "run", "event": "done"}]
        self.fake_run("s-1", workflow="statwf", status="done", series="a", started="2026-11-17 10:00:00",
                      history=hist(u1, "approve"))
        self.fake_run("s-2", workflow="statwf", status="done", series="a", started="2026-11-17 10:00:00",
                      history=hist(u2, "reject"),
                      totals={"input_tokens": 300, "output_tokens": 50, "cache_read_tokens": 10,
                              "cache_write_tokens": 0, "cost_usd": 1.5, "ai_seconds": 60, "steps": 1})
        self.fake_run("s-3", workflow="statwf", status="failed", series="b", started="2026-11-17 11:00:00",
                      history=[])
        code, out = self.call("GET", "/api/stats?workflow=statwf")
        self.assertEqual(code, 200, out)
        [w] = out["workflows"]
        self.assertEqual((w["workflow"], w["runs"], w["by_status"]), ("statwf", 3, {"done": 2, "failed": 1}))
        self.assertEqual(w["median_seconds"], 120)
        self.assertEqual(w["total_cost_usd"], 2.0)
        self.assertEqual(w["total_tokens"], 160 + 360)
        self.assertEqual((w["guardrail_rounds"], w["transient_retries"]), (2, 2))
        self.assertEqual(w["gates"], [{"gate": "review", "approve": 1, "reject": 1, "reject_rate": 0.5}])
        self.assertEqual([(s["series"], s["runs"]) for s in w["series"]], [("a", 2), ("b", 1)])
        steps = {s["step"]: s for s in w["steps"]}
        self.assertEqual(set(steps), {"draft", "lint", "w_worker"})
        self.assertEqual((steps["draft"]["runs"], steps["draft"]["median_seconds"], steps["draft"]["median_tokens"],
                          steps["draft"]["total_cost_usd"], steps["draft"]["guardrail_rounds"]), (2, 60, 260, 2.0, 2))
        self.assertEqual((steps["lint"]["kind"], steps["lint"]["median_seconds"]), ("script", 4))
        self.assertEqual(steps["w_worker"]["kind"], "worker")
        # all workflows; run list carries totals (computed for old runs, from the status file otherwise)
        names = [w["workflow"] for w in self.call("GET", "/api/stats")[1]["workflows"]]
        self.assertIn("statwf", names)
        runs = {r["run"]: r for r in self.call("GET", "/api/runs")[1]}
        self.assertEqual(runs["s-1"]["totals"]["cost_usd"], 0.5)
        self.assertEqual(runs["s-2"]["totals"]["cost_usd"], 1.5)
        self.assertEqual(self.call("GET", "/api/stats?workflow=../x")[0], 400)
        # run view: totals, gate_files, usage per step
        code, r = self.call("GET", "/api/runs/s-1")
        self.assertEqual((r["totals"]["input_tokens"], r["gate_files"]), (100, []))
        self.assertEqual(r["info"]["draft"]["usage"]["cost_usd"], 0.5)

    def test_outputs_and_file(self):
        root = self.tmp
        (root / "docs").mkdir(exist_ok=True)
        (root / "docs" / "brief.md").write_bytes(b"# Brief\nhello\n")
        (root / "docs" / "data.json").write_text('{"a": 1}', encoding="utf-8")
        (root / "docs" / "bad.json").write_text('{"a": ', encoding="utf-8")
        (root / "docs" / "blob.bin").write_bytes(b"\x00\x01\x02abc")
        (root / "docs" / "big.txt").write_text("x" * (web.MAX_FILE + 10), encoding="utf-8")
        (root / ".env").write_text("SECRET=1", encoding="utf-8")
        (root / ".git").mkdir(exist_ok=True)
        (root / ".git" / "config").write_text("[core]", encoding="utf-8")
        outside = Path(tempfile.mkdtemp(prefix="langflow_outside_"))
        (outside / "x.md").write_text("no", encoding="utf-8")
        try:
            self.fake_run("o-1", workflow="flow", status="waiting", gate="review", step="review",
                          gate_files=[str(root / "docs" / "brief.md"), "docs/data.json"],
                          history=[{"time": "2026-11-17 10:00:00", "step": "out", "kind": "write", "event": "done",
                                    "path": str(root / "docs" / "gone.md")},
                                   {"time": "2026-11-17 10:00:01", "step": "out2", "kind": "write", "event": "done",
                                    "path": str(root / "docs" / "brief.md")}])
            code, outs = self.call("GET", "/api/runs/o-1/outputs")
            self.assertEqual(code, 200, outs)
            by = {o["rel"]: o for o in outs}
            self.assertEqual(set(by), {"docs/gone.md", "docs/brief.md", "docs/data.json"})
            self.assertEqual((by["docs/brief.md"]["step"], by["docs/brief.md"]["kind"], by["docs/brief.md"]["exists"]),
                             ("review", "markdown", True))
            self.assertEqual((by["docs/gone.md"]["exists"], by["docs/gone.md"]["size"]), (False, None))
            self.assertEqual(by["docs/data.json"]["kind"], "json")
            self.assertEqual(self.call("GET", "/api/runs/none/outputs")[0], 404)

            def get(p):
                return self.call("GET", "/api/file?path=" + urllib.parse.quote(str(p)))
            code, f = get("docs/brief.md")
            self.assertEqual(code, 200, f)
            self.assertEqual((f["kind"], f["text"], f["truncated"], f["rel"]),
                             ("markdown", "# Brief\nhello\n", False, "docs/brief.md"))
            self.assertEqual(get(root / "docs" / "data.json")[1]["kind"], "json")
            self.assertEqual(get("docs/bad.json")[1]["kind"], "text")
            code, f = get("docs/blob.bin")
            self.assertEqual((f["kind"], f["text"]), ("binary", ""))
            code, f = get("docs/big.txt")
            self.assertEqual((f["truncated"], len(f["text"]), f["size"]), (True, web.MAX_FILE, web.MAX_FILE + 10))
            self.assertEqual(get(".langflow/state/runs/o-1.json")[1]["kind"], "json")     # state dir
            self.assertEqual(get(outside / "x.md")[0], 403)
            self.assertEqual(get("../" + outside.name + "/x.md")[0], 403)
            self.assertEqual(get(".env")[0], 403)
            self.assertEqual(get(".git/config")[0], 403)
            self.assertEqual(get("//server/share/x.md")[0], 403)
            self.assertEqual(get("docs/none.md")[0], 404)
            self.assertEqual(get("docs")[0], 400)
            self.assertEqual(self.call("GET", "/api/file")[0], 400)
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_cancel(self):
        self.fake_run("c-done", workflow="flow", status="done", history=[])
        self.assertEqual(self.call("POST", "/api/runs/c-done/cancel", {})[0], 409)
        self.assertEqual(self.call("POST", "/api/runs/c-none/cancel", {})[0], 404)
        if not hasattr(web.engine, "request_cancel"):
            self.skipTest("engine.request_cancel not available yet")
        run = self.start("t-cancel")
        self.wait(run, {"waiting"})
        code, out = self.call("POST", f"/api/runs/{run}/cancel", {}, channel="panel")
        self.assertEqual(code, 200, out)
        self.assertEqual((out["accepted"], out["by"]), (True, f"panel:{web.getpass.getuser()}"))
        st = self.wait(run, {"cancelled"}, timeout=20)
        self.assertEqual(self.call("POST", f"/api/runs/{run}/cancel", {})[0], 409)
        self.assertTrue(any(h.get("event") == "cancelled" for h in st["history"]))
        # a running script step started from the web: the job ends as cancelled, not crashed
        code, out = self.call("POST", "/api/runs", {"workflow": "slow", "run": "t-cancel-run", "args": {}})
        self.assertEqual(code, 200, out)
        t0 = time.time()
        while time.time() - t0 < 20:
            st = self.call("GET", "/api/runs/t-cancel-run")[1]
            if st.get("step") == "nap" and st.get("status") == "running":
                break
            time.sleep(0.2)
        code, out = self.call("POST", "/api/runs/t-cancel-run/cancel", {})
        self.assertEqual((code, out.get("result")), (200, "requested"), out)
        t0 = time.time()
        st = self.wait("t-cancel-run", {"cancelled"}, timeout=30)
        self.assertLess(time.time() - t0, 20)
        self.assertEqual(st["job"]["state"], "cancelled", st["job"])

    def test_run_memory_edit(self):
        run = self.start("t-mem", topic="memtopic")
        self.wait(run, {"waiting"})
        put = lambda k, t: self.call("PUT", f"/api/runs/{run}/memory/{urllib.parse.quote(k, safe='')}",  # noqa: E731
                                     {"text": t})
        code, out = put("fact:a", "first")
        self.assertEqual(code, 200, out)
        self.assertEqual((out["entry"]["text"], out["entry"]["edited_by"]), ("first", f"web:{web.getpass.getuser()}"))
        self.assertEqual(put("fact:a", "second")[0], 200)
        self.assertEqual(put("k/slash", "temp")[0], 200)
        self.assertEqual(put("fact:a", "")[0], 400)
        m = self.call("GET", f"/api/runs/{run}/memory")[1]["run"]
        self.assertEqual((m["fact:a"]["text"], m["k/slash"]["text"]), ("second", "temp"))
        code, out = self.call("DELETE", f"/api/runs/{run}/memory/k%2Fslash")
        self.assertEqual(code, 200, out)
        self.assertEqual(self.call("DELETE", f"/api/runs/{run}/memory/k%2Fslash")[0], 404)
        self.assertNotIn("k/slash", self.call("GET", f"/api/runs/{run}/memory")[1]["run"])
        st = self.call("GET", f"/api/runs/{run}")[1]
        self.assertEqual(st["status"], "waiting")
        self.assertEqual([h["event"] for h in st["history"] if h.get("kind") == "memory"],
                         ["edited", "edited", "edited", "deleted"])
        # the gate still works after the edits, and the memory survives the resume
        code, out = self.call("POST", f"/api/runs/{run}/answer", {"decision": "approve", "note": "ok", "confirm": run})
        self.assertEqual(code, 200, out)
        st = self.wait(run, {"failed"})
        self.assertEqual((st["states"]["ok"], st["step"]), ("done", "finish"))
        m = self.call("GET", f"/api/runs/{run}/memory")[1]
        self.assertEqual(m["run"]["fact:a"]["text"], "second")
        self.assertIn(f"gate:ok:{run}", m["run"])
        # a running run (here: a status file only) is refused
        self.fake_run("m-running", workflow="flow", status="running", history=[])
        self.assertEqual(self.call("PUT", "/api/runs/m-running/memory/x", {"text": "y"})[0], 409)
        self.fake_run("m-running2", workflow="flow", status="running", pid=os.getpid(), history=[])
        self.assertEqual(self.call("PUT", "/api/runs/m-running2/memory/x", {"text": "y"})[0], 409)
        # series memory of the same run
        key = f"gate:ok:{run}"
        body = {"workflow": "flow", "series": "memtopic", "key": key, "text": "edited by hand"}
        code, out = self.call("PUT", "/api/memory/series", body)
        self.assertEqual(code, 200, out)
        self.assertEqual((out["entry"]["text"], out["entry"]["run"]), ("edited by hand", run))
        series = {e["key"]: e for e in self.call("GET", f"/api/runs/{run}/memory")[1]["series"]}
        self.assertEqual(series[key]["text"], "edited by hand")
        self.assertEqual(self.call("PUT", "/api/memory/series", {**body, "series": "nope"})[0], 404)
        self.assertEqual(self.call("PUT", "/api/memory/series", {**body, "text": ""})[0], 400)
        self.assertEqual(self.call("PUT", "/api/memory/series", {**body, "workflow": "../x"})[0], 400)
        self.assertEqual(self.call("DELETE", "/api/memory/series", body)[0], 200)
        self.assertEqual(self.call("DELETE", "/api/memory/series", body)[0], 404)
        self.assertNotIn(key, {e["key"] for e in self.call("GET", f"/api/runs/{run}/memory")[1]["series"]})

    def test_propose(self):
        code, info = self.call("GET", "/api/memory/propose")
        self.assertEqual((code, info["enabled"]), (200, False))
        entries = [{"key": "k1", "text": "fact | with pipe\nline 2", "scope": "series", "run": "r1", "step": "s1"}]
        self.assertEqual(self.call("POST", "/api/memory/propose", {"entries": entries, "fields": {}})[0], 400)
        cfg = projmod.current().cfg
        cfg["memory"] = {"propose": {
            "command": [PY, "-c", "import sys; print(open(sys.argv[1], encoding='utf-8').read()); print('G=' + "
                                  "sys.argv[2]); sys.exit(int(sys.argv[3]))", "{text_file}", "{group}", "{code}"],
            "fields": ["group", "code"], "description": "test propose"}}
        try:
            code, info = self.call("GET", "/api/memory/propose")
            self.assertEqual(info, {"enabled": True, "fields": ["group", "code"], "description": "test propose"})
            code, out = self.call("POST", "/api/memory/propose",
                                  {"entries": entries, "fields": {"group": "clca-lessons", "code": "0"}})
            self.assertEqual(code, 200, out)
            self.assertTrue(out["ok"], out)
            self.assertIn("| k1 | fact \\| with pipe line 2 | langflow run r1 · step s1 · series |", out["output"])
            self.assertIn("G=clca-lessons", out["output"])
            code, out = self.call("POST", "/api/memory/propose",
                                  {"entries": entries, "fields": {"group": "g", "code": "3"}})
            self.assertEqual((code, out["ok"], out["exit"]), (200, False, 3))
            bad = [{"entries": entries, "fields": {"group": "g"}},                      # missing field
                   {"entries": entries, "fields": {"group": "--apply", "code": "0"}},   # looks like an option
                   {"entries": entries, "fields": {"group": "g", "code": "0", "x": "1"}},
                   {"entries": [], "fields": {"group": "g", "code": "0"}},
                   {"entries": [{"key": "k"}], "fields": {"group": "g", "code": "0"}}]
            for b in bad:
                self.assertEqual(self.call("POST", "/api/memory/propose", b)[0], 400, b)
            self.assertTrue((self.tmp / ".langflow" / "state" / "propose.log").exists())
        finally:
            cfg.pop("memory", None)

    def test_schedules(self):
        calls = []

        class Fake:
            class ScheduleError(Exception):
                pass

            @staticmethod
            def list_tasks(project):
                calls.append(("list",))
                return [{"name": "daily", "time": "08:00"}]

            @staticmethod
            def add_task(project, name, at, days, args):
                calls.append(("add", name, at, days, args))
                return None

            @staticmethod
            def remove_task(project, name):
                calls.append(("remove", name))
                if name == "gone":
                    raise Fake.ScheduleError("no task gone")

        old = web.schedule_module
        web.schedule_module = lambda: Fake
        try:
            self.assertEqual(self.call("GET", "/api/schedules")[1], [{"name": "daily", "time": "08:00"}])
            body = {"name": "daily", "time": "08:00", "days": "mon-fri",
                    "args": ["start", "flow", "daily-{date}", "topic=tea"]}
            code, out = self.call("POST", "/api/schedules", body)
            self.assertEqual(code, 200, out)
            self.assertEqual(calls[-1], ("add", "daily", "08:00", "MON-FRI", body["args"]))
            for b in ({**body, "time": "8:00"}, {**body, "time": "25:00"}, {**body, "days": "SOMETIMES"},
                      {**body, "args": ["start", "flow", "x & del *"]}, {**body, "args": ["start", '"q"']},
                      {**body, "args": ["start", "100%"]}, {**body, "args": ["approve", "x"]},
                      {**body, "args": []}, {**body, "name": "../x"}):
                self.assertEqual(self.call("POST", "/api/schedules", b)[0], 400, b)
            self.assertEqual(self.call("DELETE", "/api/schedules/daily")[0], 200)
            self.assertEqual(calls[-1], ("remove", "daily"))
            self.assertEqual(self.call("DELETE", "/api/schedules/gone")[0], 400)
        finally:
            web.schedule_module = old
        self.assertEqual(self.call("PATCH", "/api/schedules", {})[0], 405)

    def test_methods_need_token(self):
        self.assertEqual(self.call("PUT", "/api/memory/series", {}, token=False)[0], 401)
        self.assertEqual(self.call("DELETE", "/api/schedules/x", token=False)[0], 401)
        self.assertEqual(self.call("PUT", "/api/nothing", {})[0], 404)


class Helpers(unittest.TestCase):
    def test_file_kind(self):
        self.assertEqual(web.file_kind(Path("a.MD")), "markdown")
        self.assertEqual(web.file_kind(Path("a.json"), b"{"), "json")
        self.assertEqual(web.file_kind(Path("a.docx")), "binary")
        self.assertEqual(web.file_kind(Path("a.txt"), "tiếng việ".encode()[:-1]), "text")    # cut character
        self.assertEqual(web.file_kind(Path("a.dat"), b"ab\x00c"), "binary")

    def test_propose_rows_and_command(self):
        rows = web.propose_rows([{"key": "a", "text": "x|y"}, {"text": "z", "run": "r"}], "| {key} | {text} | {nope} |")
        self.assertEqual(rows, "| a | x\\|y | {nope} |\n|  | z | {nope} |\n")
        self.assertEqual(web.fill_command(["/bin/x", "--g", "{group}"], {"group": "G"}), ["/bin/x", "--g", "G"])
        with self.assertRaises(web.ApiError):
            web.fill_command(["/bin/x", "{other}"], {"group": "G"})


class TranscriptReaders(unittest.TestCase):
    def test_readers(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            c = tmp / "c.jsonl"
            c.write_text("\n".join(json.dumps(e) for e in [
                {"type": "user", "message": {"role": "user", "content": "do it"}},
                {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": ""},
                                                              {"type": "tool_use", "name": "Read",
                                                               "input": {"file_path": "a.py"}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "content": "text of a"}]}},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput",
                                                               "input": {"x": 1}}]}},
                {"type": "attachment"}]), encoding="utf-8")
            ev = web.claude_events(c)
            self.assertEqual([(e["role"], e["kind"]) for e in ev],
                             [("user", "text"), ("assistant", "tool_use"), ("tool", "tool_result"),
                              ("assistant", "answer")])
            self.assertEqual(ev[1]["text"], "Read file_path=a.py")
            x = tmp / "x.jsonl"
            x.write_text("\n".join(json.dumps(e) for e in [
                {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": []}},
                {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                      "content": [{"type": "input_text", "text": "# AGENTS.md instructions x"}]}},
                {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                      "content": [{"type": "input_text", "text": "list 3"}]}},
                {"type": "response_item", "payload": {"type": "function_call", "name": "shell",
                                                      "arguments": "{\"command\": \"ls\"}"}},
                {"type": "response_item", "payload": {"type": "function_call_output", "output": "a b"}},
                {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                                                      "content": [{"type": "output_text", "text": "{}"}]}}]),
                encoding="utf-8")
            self.assertEqual([(e["role"], e["kind"], e["text"]) for e in web.codex_events(x)],
                             [("user", "text", "list 3"), ("assistant", "tool_use", "shell command=ls"),
                              ("tool", "tool_result", "a b"), ("assistant", "text", "{}")])
            o = tmp / "o.json"
            o.write_text(json.dumps({"session": {}, "messages": [
                {"type": "user", "text": "look"},
                {"type": "assistant", "content": [
                    {"type": "tool", "name": "read", "state": {"input": {"path": "x"},
                                                               "content": [{"type": "text", "text": "body"}]}},
                    {"type": "text", "text": "{\"a\":1}"}]},
                {"type": "idle"}]}), encoding="utf-8")
            self.assertEqual([(e["role"], e["kind"], e["text"]) for e in web.opencode_events(o)],
                             [("user", "text", "look"), ("assistant", "tool_use", "read path=x"),
                              ("tool", "tool_result", "body"), ("assistant", "text", "{\"a\":1}")])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ApiOnlyProcess(unittest.TestCase):
    def test_first_line_and_stdin_watch(self):
        exe = shutil.which("langflow")
        if not exe:
            self.skipTest("langflow not on PATH")
        tmp = Path(tempfile.mkdtemp())
        try:
            (tmp / ".langflow").mkdir()
            (tmp / ".langflow" / "config.toml").write_text(CONFIG, encoding="utf-8")
            p = subprocess.Popen([exe, "web", "--api-only", "--port", "0", "--stdin-watch", "--quiet"], cwd=tmp,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            line = p.stdout.readline()
            self.assertTrue(line.startswith("LANGFLOW_WEB "), line)
            info = json.loads(line[len("LANGFLOW_WEB "):])
            req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/api/project",
                                         headers={"X-Langflow-Token": info["token"]})
            with urllib.request.urlopen(req, timeout=10) as r:
                self.assertEqual(json.loads(r.read())["name"], "web test")
            with self.assertRaises(urllib.error.HTTPError) as cm:      # api-only serves no HTML
                urllib.request.urlopen(f"http://127.0.0.1:{info['port']}/", timeout=10)
            self.assertEqual(cm.exception.code, 404)
            p.stdin.close()
            self.assertEqual(p.wait(timeout=15), 0)
            p.stdout.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
