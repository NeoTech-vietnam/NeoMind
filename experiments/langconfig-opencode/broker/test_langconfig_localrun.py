"""LangConfig executor to an owned LocalRun host, with a fixed synthetic grant."""
import os

import pytest
from langgraph.checkpoint.memory import MemorySaver

from core.workflows import executor as executor_module
from core.workflows.checkpointing import manager
from db import database
from services import event_bus as event_bus_module
from tools import native_tools
from durable_localrun_client import DurableLocalRunFixtureClient
from test_langconfig_graph import Bus, Callback, DB, workflow


@pytest.mark.asyncio
@pytest.mark.parametrize("runner", ["codex", "claude-code", "opencode"])
@pytest.mark.parametrize("case", ["success", "task", "binding", "runner", "provider", "params"])
async def test_graph_to_owned_localrun(monkeypatch, tmp_path, runner, case):
    source = os.environ.get("SYNTHETIC_BASE_REPO", "")
    if not os.path.isabs(source):
        pytest.fail("SYNTHETIC_BASE_REPO must name the existing synthetic fixture")
    request = {"version": 1, "taskId": "fixture-task", "prompt": "synthetic fixture only",
               "binding": {"runner": runner, "provider": "fixture", "model": "fake-readonly", "reasoning": "high"}}
    bad = {**request, "taskId": "other-task"} if case == "task" else (
        {**request, "binding": {**request["binding"], "model": "other"}} if case == "binding" else (
        {**request, "binding": {**request["binding"], "runner": "opencode" if runner != "opencode" else "codex"}} if case == "runner" else (
        {**request, "binding": {**request["binding"], "provider": "other"}} if case == "provider" else request)))
    after, responses = [], []

    class Tool:
        name = "broker_fixture"

        async def ainvoke(self, params):
            if type(params) is not dict or params != {"fixture": "review"}:
                raise ValueError("fixture context rejected")
            response = client.execute(bad)
            responses.append(response)
            expected = {"ok": True, "runner": runner, "message": f"fixture:{runner}",
                        "proof": {"intentBeforeDispatch": True, "receipt": "accepted", "fakeStop": True, "dispatches": 1}}
            if response != expected:
                raise RuntimeError("fixture grant or lifecycle rejected")
            return response["message"]

    class After:
        name = "fixture_after"

        async def ainvoke(self, params):
            if params != {}:
                raise ValueError("fixture context rejected")
            after.append("called")
            return "fixture after"

    def load(names, *_args, **_kwargs):
        if names == ["broker_fixture"]:
            return [Tool()]
        if names == ["fixture_after"]:
            return [After()]
        raise ValueError("unknown fixture tool")

    async def validate(*_args):
        pass

    monkeypatch.setattr(native_tools, "load_native_tools", load)
    monkeypatch.setattr(event_bus_module, "get_event_bus", lambda: Bus())
    monkeypatch.setattr(executor_module, "create_execution_callback_handler", lambda **_kwargs: Callback())
    monkeypatch.setattr(executor_module, "get_store", lambda: None)
    monkeypatch.setattr(manager, "get_checkpointer", lambda: MemorySaver())
    monkeypatch.setattr(database, "SessionLocal", DB)
    executor = executor_module.SimpleWorkflowExecutor()
    monkeypatch.setattr(executor, "_validate_and_init_tools", validate)
    params = {"fixture": "review", **({"access": "write"} if case == "params" else {})}
    db = str(tmp_path / "admission.sqlite")
    counter = str(tmp_path / "dispatch-count")
    options = {"test_counter": counter, "test_tmpdir": str(tmp_path)}
    with DurableLocalRunFixtureClient(runner, source, db, **options) as client:
        result = await executor.execute_workflow(workflow(params), {}, None, 1)
        if case == "success":
            assert "error" not in result
            assert after == ["called"]
            assert len(responses) == 1 and responses[0]["proof"]["dispatches"] == 1
            assert client.execute(request) == responses[0]
        else:
            assert result["workflow_status"] == "FAILED"
            assert after == []
            assert responses == ([] if case == "params" else [{"ok": False, "error": "grant_rejected"}])
            # A rejection does not consume the fixed grant; no client-selected binding is admitted.
            accepted = client.execute(request)
            assert accepted["ok"] is True and accepted["proof"]["dispatches"] == 1
        assert client.execute({**request, "prompt": "different synthetic fixture"}) == {"ok": False, "error": "conflict"}
    with DurableLocalRunFixtureClient(runner, source, db, **options) as restarted:
        assert restarted.execute(request)["ok"] is True
        assert restarted.host is None
    assert (tmp_path / "dispatch-count").read_text() == "dispatch\n"
