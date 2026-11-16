"""Real LangConfig graph executor with a strictly local, fake-only broker tool."""
from types import SimpleNamespace

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from langgraph.checkpoint.memory import MemorySaver

from client import FixtureBrokerClient
from core.workflows import executor as executor_module
from core.workflows.checkpointing import manager
from db import database
from services import event_bus as event_bus_module
from tools import native_tools


class Bus:
    async def publish(self, *_args):
        pass


class Callback(BaseCallbackHandler):
    async def flush_pending_persists(self, **_kwargs):
        pass

    def get_collected_artifacts(self):
        return []


class DB:
    def query(self, _model):
        return self

    def filter(self, *_args):
        return self

    def all(self):
        return []

    def close(self):
        pass


def workflow(params):
    def tool(node_id, tool_id, arguments):
        return {"id": node_id, "type": "TOOL_NODE", "config": {
            "tool_type": "mcp", "tool_id": tool_id, "tool_params": arguments}}

    return SimpleNamespace(id=2, name="broker-fixture", strategy_type=None, configuration={
        "nodes": [{"id": "start", "type": "START_NODE"},
                  tool("review", "broker_fixture", params),
                  tool("after", "fixture_after", {}), {"id": "end", "type": "END_NODE"}],
        "edges": [{"source": a, "target": b, "data": {}} for a, b in
                  (("start", "review"), ("review", "after"), ("after", "end"))],
    })


@pytest.mark.asyncio
@pytest.mark.parametrize("runner", ["codex", "claude-code", "opencode"])
@pytest.mark.parametrize("case", ["success", "bad_params", "bad_binding", "broker_closed"])
async def test_real_executor_to_fixture_broker(monkeypatch, runner, case):
    after = []
    responses = []
    request = {"version": 1, "taskId": "fixture-task", "idempotencyKey": "fixture-attempt",
               "access": "read", "prompt": "synthetic fixture only",
               "binding": {"runner": runner, "provider": "fixture", "model": "fake-readonly", "reasoning": "high"}}
    if case == "bad_binding":
        request["binding"]["provider"] = "not-fixture"

    class BrokerTool:
        name = "broker_fixture"

        async def ainvoke(self, params):
            # The graph cannot select a task, binding, prompt, workspace or authority.
            if type(params) is not dict or params != {"fixture": "review"}:
                raise ValueError("fixture context rejected")
            response = client.execute(request)
            responses.append(response)
            expected = {"ok": True, "result": {"runner": runner, "status": "completed", "messages": [f"fixture:{runner}"]}}
            if response != expected:
                raise RuntimeError("fixture broker rejected")
            return response["result"]["messages"][0]

    class AfterTool:
        name = "fixture_after"

        async def ainvoke(self, params):
            if params != {}:
                raise ValueError("fixture context rejected")
            after.append("called")
            return "fixture after"

    def load(names, *_args, **_kwargs):
        if names == ["broker_fixture"]:
            return [BrokerTool()]
        if names == ["fixture_after"]:
            return [AfterTool()]
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
    params = {"fixture": "review", **({"access": "write"} if case == "bad_params" else {})}

    with FixtureBrokerClient() as client:
        if case == "broker_closed":
            client.close()
        result = await executor.execute_workflow(workflow(params), {}, None, 1)

    if case == "success":
        assert "error" not in result
        assert after == ["called"]
        assert responses == [{"ok": True, "result": {"runner": runner, "status": "completed", "messages": [f"fixture:{runner}"]}}]
    else:
        assert result["workflow_status"] == "FAILED"
        assert after == []
        if case == "bad_binding":
            assert responses == [{"ok": False, "error": "invalid_request"}]
        else:
            assert responses == []
