"""Tests for the token-cost design rules: `langflow guide`, the cost warnings of `langflow check`
(design.cost_warnings), the langflow-design skill written by `langflow init`, and the design-guide line of the
SessionStart hook (skipped inside a workflow step). No agent is called.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_design -v
"""
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from langflow import catalog, cli, design, guard
from langflow import project as projmod
from langflow.agents import base

SCHEMA = {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}
CONFIG = '[project]\nname = "design test"\napprover = "tester"\n\n[agents.claude]\ndefault_effort = "high"\n'
COSTLY = f'''"""Costly flow: every pattern the guide warns about."""
from langflow import ai, fanout

SCHEMA = {SCHEMA!r}


def ok(answer):
    return True, ""


def worker(item, i):
    return ai(f"write[{{i}}]", "Write item.", SCHEMA, tools=["Read", "Grep"], check=ok, retries=3,
              retry_mode="fresh")


def free_worker(item, i):
    return ai(f"free[{{i}}]", "Write item.", SCHEMA, model="opus")


def steps(args):
    return [
        ai("plan", "Plan.", SCHEMA, effort="max"),
        fanout("write", lambda s: ["a", "b"], worker),
        fanout("free", lambda s: ["a"], free_worker),
    ]
'''
LEAN = f'''"""Lean flow: prepared input, no tools, medium workers, resume retries. About USD 0.1 per item."""
from langflow import ai, fanout

SCHEMA = {SCHEMA!r}


def ok(answer):
    return True, ""


def worker(item, i):
    return ai(f"write[{{i}}]", "Write item from the excerpt above.", SCHEMA, tools=[], effort="medium", check=ok)


def steps(args):
    return [ai("plan", "Plan.", SCHEMA, tools=[]), fanout("write", lambda s: ["a", "b"], worker)]
'''


def put(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class DesignTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_design_test_"))
        put(self.tmp / ".langflow" / "config.toml", CONFIG)
        put(self.tmp / ".langflow" / "workflows" / "costly.py", COSTLY)
        put(self.tmp / ".langflow" / "workflows" / "lean.py", LEAN)
        self.old_cwd = os.getcwd()
        os.chdir(self.tmp)
        projmod.set_current(projmod.load(self.tmp))

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def check(self, wf, pairs=()):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.cmd_check(wf, list(pairs))
        return code, out.getvalue()

    def test_guide_command(self):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch("sys.argv", ["langflow", "guide"]):
            cli.main()
        text = out.getvalue()
        self.assertIn("Designing a langflow workflow that spends few tokens", text)
        self.assertIn("## Checklist before the first real run", text)

    def test_costly_workflow_warnings(self):
        code, text = self.check("costly")
        self.assertEqual(code, 0)                  # cost warnings never fail the check
        self.assertIn("effort max: keep xhigh / max", text)
        self.assertIn("guardrail retries start a new session", text)
        self.assertIn("retries=3", text)
        self.assertIn("fan-out workers may use Grep", text)
        self.assertIn("fan-out workers at effort high", text)        # from [agents.claude] default_effort
        self.assertIn("fan-out workers run with the CLI's default tools", text)
        self.assertIn("fan-out workers on opus", text)
        self.assertIn("cost warning(s): see `langflow guide`", text)

    def test_run_args_change_the_warnings(self):
        _, text = self.check("costly", ["effort.write=medium", "retry_mode.write=resume"])
        self.assertNotIn("fan-out workers at effort", text.split("free[*]")[0])
        self.assertNotIn("guardrail retries start a new session", text)

    def test_lean_workflow_has_no_warning(self):
        code, text = self.check("lean")
        self.assertEqual(code, 0)
        self.assertNotIn("cost:", text)
        self.assertIn("retry_mode resume", text.splitlines()[0])

    def test_row_carries_cost(self):
        rows = cli.step_rows("costly", cli.load_workflow("costly").steps({}), {})
        r = {x["step"]: x for x in rows}
        self.assertEqual(r["write"]["cost"]["tools"], ["Read", "Grep"])
        self.assertTrue(r["write"]["cost"]["guardrail"])
        self.assertEqual(r["plan"]["cost"]["effort"], "max")
        self.assertEqual(design.cost_warnings(projmod.current(), {"step": "x"}, {}), [])

    def test_default_retry_mode_is_resume(self):
        rows = cli.step_rows("lean", cli.load_workflow("lean").steps({}), {})
        m = catalog.modes(projmod.current(), rows[0]["effective"], "claude")
        self.assertEqual((m["retry_mode"], m["from"]["retry_mode"]), ("resume", "default"))
        self.assertNotIn("note", catalog.modes(projmod.current(), rows[0]["effective"], "other"))

    def test_init_writes_the_skill(self):
        new = self.tmp / "fresh"
        new.mkdir()
        os.chdir(new)
        out = io.StringIO()
        with redirect_stdout(out):
            cli.cmd_init()
        for folder in (".claude/skills", ".agents/skills"):
            skill = new / folder / "langflow-design" / "SKILL.md"
            self.assertTrue(skill.exists())
            self.assertIn("langflow guide", skill.read_text(encoding="utf-8"))
        put(new / ".claude/skills/langflow-design/SKILL.md", "edited by hand")
        out = io.StringIO()
        with redirect_stdout(out):
            cli.cmd_init()
        self.assertIn("differs from langflow's copy", out.getvalue())
        self.assertEqual((new / ".claude/skills/langflow-design/SKILL.md").read_text(encoding="utf-8"),
                         "edited by hand")

    def session_start(self, env):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.dict(os.environ, env, clear=False):
            if "LANGFLOW_STEP" not in env:
                os.environ.pop("LANGFLOW_STEP", None)
            guard.handle({"hook_event_name": "SessionStart", "cwd": str(self.tmp)})
        return out.getvalue()

    def test_session_start_points_to_the_guide(self):
        text = self.session_start({})
        ctx = json.loads(text)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("read the design guide: `langflow guide`", ctx)
        self.assertEqual(self.session_start({"LANGFLOW_STEP": "1"}), "")   # a workflow step pays for no extra line

    def test_agent_env_marks_a_step(self):
        self.assertEqual(base.clean_env()["LANGFLOW_STEP"], "1")


if __name__ == "__main__":
    unittest.main()
