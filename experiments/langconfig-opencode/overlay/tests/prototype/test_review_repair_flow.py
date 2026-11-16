"""Fixture-only approval, writer, OpenCode review adapter and conditional repair."""
from types import SimpleNamespace

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from langgraph.checkpoint.memory import MemorySaver

from core.workflows import executor as executor_module
from core.workflows.checkpointing import manager
from db import database
from services import event_bus as event_bus_module
from tools import native_tools
from tools.opencode_review import Adapter, review_runtime
from test_opencode_review import Fake


@pytest.mark.asyncio
@pytest.mark.parametrize("needs_repair", [False, True])
async def test_approved_fixture_review_and_conditional_repair(monkeypatch, tmp_path, needs_repair):
    workspace = tmp_path / "fixture"
    workspace.mkdir()
    draft = workspace / "draft.txt"
    actions = []
    checkpointer = MemorySaver()

    class FixtureTool:
        def __init__(self, name):
            self.name = name

        async def ainvoke(self, _params):
            actions.append(self.name)
            draft.write_text("incorrect synthetic draft\n" if self.name == "fixture_write" and needs_repair else "correct synthetic draft\n")
            return draft.read_text()

    class Transport(Fake):
        async def request(self, method, path, body=None):
            if path.endswith("/prompt"):
                text = draft.read_text()
                assert text in ("incorrect synthetic draft\n", "correct synthetic draft\n")
                self.response = ('{"verdict":"needs_changes","findings":[{"description":"incorrect",'
                                 '"path":"draft.txt"}],"summary":"Repair required"}') if text.startswith("incorrect") else (
                                 '{"verdict":"pass","findings":[],"summary":"Correct fixture"}')
            return await super().request(method, path, body)

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

    original_load = native_tools.load_native_tools

    def load(names, *args, **kwargs):
        if names in (["fixture_write"], ["fixture_repair"]):
            return [FixtureTool(names[0])]
        return original_load(names, *args, **kwargs)

    async def validate(*_args):
        pass

    monkeypatch.setattr(native_tools, "load_native_tools", load)
    monkeypatch.setattr(event_bus_module, "get_event_bus", lambda: Bus())
    monkeypatch.setattr(executor_module, "create_execution_callback_handler", lambda **_kwargs: Callback())
    monkeypatch.setattr(executor_module, "get_store", lambda: None)
    monkeypatch.setattr(manager, "get_checkpointer", lambda: checkpointer)
    monkeypatch.setattr(database, "SessionLocal", DB)
    executor = executor_module.SimpleWorkflowExecutor()
    monkeypatch.setattr(executor, "_validate_and_init_tools", validate)
    monkeypatch.setattr(executor, "_persist_task_hitl_state", lambda *_args: None)
    tool = lambda node_id, tool_id, params: {"id": node_id, "type": "TOOL_NODE", "config": {"tool_type": "mcp", "tool_id": tool_id, "tool_params": params}}
    review = lambda node_id: tool(node_id, "opencode_review", {"attempt_id": node_id, "instruction": "Review synthetic draft: {{previous_output}}"})
    edge = lambda source, target, **data: {"source": source, "target": target, "data": data}
    workflow = SimpleNamespace(id=2, name="fixture-cycle", strategy_type=None, configuration={
        "nodes": [
            {"id": "start", "type": "START_NODE"}, {"id": "approval", "type": "APPROVAL_NODE"},
            tool("write", "fixture_write", {}), review("review"),
            {"id": "route", "type": "CONDITIONAL_NODE", "config": {"condition": "'needs_changes' in state.get('last_tool_output', '')", "routing_map": {"true": "repair", "false": "pass"}}},
            tool("repair", "fixture_repair", {}), review("rereview"), {"id": "end", "type": "END_NODE"},
        ],
        "edges": [edge("start", "approval"), edge("approval", "write"), edge("write", "review"),
                  edge("review", "route"), edge("route", "repair", label="repair"), edge("route", "end", label="pass"),
                  edge("repair", "rereview"), edge("rereview", "end")],
    })
    transport = Transport(workspace)
    adapter = Adapter(transport, workspace, tmp_path / "attempts.sqlite")
    with review_runtime(adapter):
        paused = await executor.execute_workflow(workflow, {}, None, 1)
        assert paused["status"] == "awaiting_approval"
        assert not draft.exists()
        result = await executor.execute_workflow(workflow, {"resume_command": {"decision": "approve"}}, None, 1)
    assert "error" not in result
    assert draft.read_text() == "correct synthetic draft\n"
    assert actions == (["fixture_write", "fixture_repair"] if needs_repair else ["fixture_write"])
    assert len([call for call in transport.calls if call[1].endswith("/prompt")]) == (2 if needs_repair else 1)
