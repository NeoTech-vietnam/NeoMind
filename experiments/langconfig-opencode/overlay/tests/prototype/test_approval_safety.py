"""Exercise the real approval control node with a LangGraph checkpointer."""
from typing import TypedDict
from types import SimpleNamespace

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from core.workflows import executor as executor_module
from core.workflows import nodes
from core.workflows.executor import SimpleWorkflowExecutor
from core.workflows.checkpointing import manager
from db import database
from services import event_bus as event_bus_module


class State(TypedDict, total=False):
    workflow_status: str
    current_step: str
    workflow_id: int


def test_executor_factory_isolates_workflow_metadata():
    first = executor_module.get_executor()
    second = executor_module.get_executor()
    first._has_approval_node = True
    first.node_metadata["fixture"] = {"label": "first"}
    assert second is not first
    assert second._has_approval_node is False
    assert second.node_metadata == {}


def test_missing_task_cannot_silently_lose_approval_state(monkeypatch):
    class DB:
        def query(self, _model):
            return self

        def filter(self, *_args):
            return self

        def first(self):
            return None

        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "SessionLocal", DB)
    with pytest.raises(RuntimeError, match="task 1 not found"):
        SimpleWorkflowExecutor()._persist_task_hitl_state(1, {"workflow_status": "AWAITING_APPROVAL"})


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["reject", "unexpected"])
async def test_approval_reject_or_invalid_never_runs_write(decision):
    calls = []
    graph = StateGraph(State)
    graph.add_node("approval", SimpleWorkflowExecutor()._create_control_node_executor("approval", "APPROVAL_NODE", {}))

    async def write(_state):
        calls.append("write")
        return {}

    graph.add_node("write", write)
    graph.add_edge(START, "approval")
    graph.add_edge("approval", "write")
    graph.add_edge("write", END)
    compiled = graph.compile(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "fixture"}}
    paused = await compiled.ainvoke({"workflow_id": 1}, config)
    assert paused.get("__interrupt__")
    assert calls == []
    with pytest.raises(RuntimeError):
        await compiled.ainvoke(Command(resume=decision), config)
    assert calls == []


@pytest.mark.asyncio
async def test_approved_resume_runs_write_once():
    calls = []
    graph = StateGraph(State)
    graph.add_node("approval", SimpleWorkflowExecutor()._create_control_node_executor("approval", "APPROVAL_NODE", {}))

    async def write(_state):
        calls.append("write")
        return {}

    graph.add_node("write", write)
    graph.add_edge(START, "approval")
    graph.add_edge("approval", "write")
    graph.add_edge("write", END)
    compiled = graph.compile(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "fixture"}}
    paused = await compiled.ainvoke({"workflow_id": 1}, config)
    assert paused.get("__interrupt__")
    assert calls == []
    await compiled.ainvoke(Command(resume="approve"), config)
    assert calls == ["write"]


@pytest.mark.asyncio
async def test_missing_interrupt_fails_closed(monkeypatch):
    monkeypatch.setattr(executor_module, "INTERRUPT_AVAILABLE", False)
    approval = SimpleWorkflowExecutor()._create_control_node_executor("approval", "APPROVAL_NODE", {})
    with pytest.raises(RuntimeError, match="interrupt is unavailable"):
        await approval({})


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["no_checkpoint", "pause", "invalid_resume", "unsolicited_resume"])
async def test_full_executor_requires_checkpoint_and_pauses(monkeypatch, case):
    events, calls, persisted = [], [], []

    class Bus:
        async def publish(self, _channel, event):
            events.append(event)

    class Callback(BaseCallbackHandler):
        async def flush_pending_persists(self, **_kwargs):
            pass

    executor = SimpleWorkflowExecutor()

    async def validate(*_args):
        pass

    async def build(_workflow):
        executor._has_approval_node = True
        graph = StateGraph(State)
        graph.add_node("approval", executor._create_control_node_executor("approval", "APPROVAL_NODE", {}))

        async def write(_state):
            calls.append("write")
            return {}

        graph.add_node("write", write)
        graph.add_edge(START, "approval")
        graph.add_edge("approval", "write")
        graph.add_edge("write", END)
        return graph

    monkeypatch.setattr(event_bus_module, "get_event_bus", lambda: Bus())
    monkeypatch.setattr(executor_module, "create_execution_callback_handler", lambda **_kwargs: Callback())
    monkeypatch.setattr(executor_module, "get_store", lambda: None)
    monkeypatch.setattr(manager, "get_checkpointer", lambda: None if case == "no_checkpoint" else MemorySaver())
    monkeypatch.setattr(executor, "_validate_and_init_tools", validate)
    monkeypatch.setattr(executor, "_build_graph_from_workflow", build)
    monkeypatch.setattr(executor, "_persist_task_hitl_state", lambda _task_id, state: persisted.append(state))
    workflow = SimpleNamespace(id=2, name="fixture", configuration={"nodes": []}, strategy_type=None)
    input_data = ({"resume_command": {"decision": "invalid"}} if case == "invalid_resume" else
                  {"resume_command": {"decision": "approve"}} if case == "unsolicited_resume" else {})
    result = await executor.execute_workflow(workflow, input_data, None, 1)
    assert calls == []
    if case == "pause":
        assert result["status"] == "awaiting_approval"
        assert persisted[0]["workflow_status"] == "AWAITING_APPROVAL"
        assert any(event["type"] == "approval_required" for event in events)
    elif case == "no_checkpoint":
        assert result["workflow_status"] == "FAILED"
        assert "no checkpointer" in result["error"]
    elif case == "invalid_resume":
        assert result["workflow_status"] == "FAILED"
        assert "Invalid approval decision" in result["error"]
    else:
        assert result.get("workflow_status") == "FAILED" or result.get("status") == "awaiting_approval"
    assert not any(event["type"] == "complete" and event["data"]["status"] == "completed" for event in events)


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["approve", "reject"])
async def test_built_workflow_approval_and_fixture_write(monkeypatch, tmp_path, decision):
    """Run the real workflow builder and executor, replacing only the tool and services."""
    events = []
    writes = []
    target = tmp_path / "synthetic-draft.txt"
    checkpointer = MemorySaver()

    class Bus:
        async def publish(self, _channel, event):
            events.append(event)

    class Callback(BaseCallbackHandler):
        async def flush_pending_persists(self, **_kwargs):
            pass

        def get_collected_artifacts(self):
            return []

    class Query:
        def filter(self, *_args):
            return self

        def all(self):
            return []

    class DB:
        def query(self, _model):
            return Query()

        def close(self):
            pass

    async def validate(*_args):
        pass

    async def write_tool(**_kwargs):
        writes.append("write")
        target.write_text("Synthetic draft\n", encoding="utf-8")
        return {"tool_result": "written"}

    monkeypatch.setattr(event_bus_module, "get_event_bus", lambda: Bus())
    monkeypatch.setattr(executor_module, "create_execution_callback_handler", lambda **_kwargs: Callback())
    monkeypatch.setattr(executor_module, "get_store", lambda: None)
    monkeypatch.setattr(manager, "get_checkpointer", lambda: checkpointer)
    monkeypatch.setattr(database, "SessionLocal", DB)
    monkeypatch.setattr(nodes, "execute_tool_node", write_tool)
    executor = SimpleWorkflowExecutor()
    monkeypatch.setattr(executor, "_validate_and_init_tools", validate)
    monkeypatch.setattr(executor, "_persist_task_hitl_state", lambda *_args: None)
    config = {
        "nodes": [
            {"id": "start", "type": "START_NODE"},
            {"id": "approval", "type": "APPROVAL_NODE"},
            {"id": "write", "type": "TOOL_NODE", "config": {"tool_type": "mcp", "tool_id": "synthetic_write"}},
            {"id": "end", "type": "END_NODE"},
        ],
        "edges": [{"source": "start", "target": "approval"}, {"source": "approval", "target": "write"}, {"source": "write", "target": "end"}],
    }
    workflow = SimpleNamespace(id=2, name="fixture", configuration=config, strategy_type=None)
    paused = await executor.execute_workflow(workflow, {}, None, 1)
    assert paused["status"] == "awaiting_approval"
    assert not target.exists()
    resumed = await executor.execute_workflow(workflow, {"resume_command": {"decision": decision}}, None, 1)
    if decision == "reject":
        assert resumed["workflow_status"] == "FAILED"
        assert not target.exists()
    else:
        assert "error" not in resumed
        assert target.read_text(encoding="utf-8") == "Synthetic draft\n"
        assert writes == ["write"]
