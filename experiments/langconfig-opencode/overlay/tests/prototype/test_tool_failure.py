"""A tool failure must stop the real workflow executor's graph node."""
import pytest
from typing import TypedDict
from types import SimpleNamespace

from langchain_core.callbacks import BaseCallbackHandler
from langgraph.graph import END, START, StateGraph

from core.workflows import nodes
from core.workflows import executor as executor_module
from core.workflows.executor import SimpleWorkflowExecutor
from services import event_bus as event_bus_module


@pytest.mark.asyncio
async def test_tool_failure_stops_execution(monkeypatch):
    async def fail(**_kwargs):
        return {"execution_failed": True, "tool_error": "fixture failure"}

    monkeypatch.setattr(nodes, "execute_tool_node", fail)
    execute = SimpleWorkflowExecutor._create_tool_node_executor(None, "review", {})
    with pytest.raises(RuntimeError, match="Tool node review failed: fixture failure"):
        await execute({})


@pytest.mark.asyncio
async def test_tool_success_preserves_result(monkeypatch):
    async def succeed(**_kwargs):
        return {"tool_result": "fixture result"}

    monkeypatch.setattr(nodes, "execute_tool_node", succeed)
    execute = SimpleWorkflowExecutor._create_tool_node_executor(None, "review", {})
    assert await execute({}) == {"current_step": "review", "tool_result": "fixture result"}


@pytest.mark.asyncio
async def test_failed_tool_blocks_following_node(monkeypatch):
    async def fail(**_kwargs):
        return {"execution_failed": True, "tool_error": "fixture failure"}

    monkeypatch.setattr(nodes, "execute_tool_node", fail)
    calls = []

    class State(TypedDict, total=False):
        current_step: str

    async def side_effect(_state):
        calls.append("called")
        return {}

    graph = StateGraph(State)
    graph.add_node("review", SimpleWorkflowExecutor._create_tool_node_executor(None, "review", {}))
    graph.add_node("write", side_effect)
    graph.add_edge(START, "review")
    graph.add_edge("review", "write")
    graph.add_edge("write", END)
    with pytest.raises(RuntimeError, match="fixture failure"):
        await graph.compile().ainvoke({})
    assert calls == []


@pytest.mark.asyncio
async def test_full_executor_reports_tool_failure(monkeypatch):
    events = []
    calls = []

    class Bus:
        async def publish(self, _channel, event):
            events.append(event)

    async def fail(**_kwargs):
        return {"execution_failed": True, "tool_error": "fixture failure"}

    async def validate(*_args):
        pass

    async def build(_workflow):
        class State(TypedDict, total=False):
            current_step: str

        async def side_effect(_state):
            calls.append("called")
            return {}

        graph = StateGraph(State)
        graph.add_node("review", executor._create_tool_node_executor("review", {}))
        graph.add_node("write", side_effect)
        graph.add_edge(START, "review")
        graph.add_edge("review", "write")
        graph.add_edge("write", END)
        return graph

    executor = SimpleWorkflowExecutor()
    monkeypatch.setattr(nodes, "execute_tool_node", fail)
    monkeypatch.setattr(event_bus_module, "get_event_bus", lambda: Bus())
    monkeypatch.setattr(executor_module, "create_execution_callback_handler", lambda **_kwargs: BaseCallbackHandler())
    monkeypatch.setattr(executor_module, "get_store", lambda: None)
    monkeypatch.setattr(executor, "_validate_and_init_tools", validate)
    monkeypatch.setattr(executor, "_build_graph_from_workflow", build)
    workflow = SimpleNamespace(id=2, name="fixture", configuration={"nodes": []}, strategy_type=None)
    result = await executor.execute_workflow(workflow, {}, None, 1)
    assert result["workflow_status"] == "FAILED"
    assert "fixture failure" in result["error"]
    assert calls == []
    assert any(event["type"] == "complete" and event["data"]["status"] == "error" for event in events)
    assert not any(event["type"] == "complete" and event["data"]["status"] == "completed" for event in events)
