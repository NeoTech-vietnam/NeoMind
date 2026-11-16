import pytest
from types import SimpleNamespace

from core.workflows.safe_condition import ConditionError, evaluate_condition
from core.workflows.executor import SimpleWorkflowExecutor


def test_supported_conditions_use_only_plain_state():
    state = {"last_tool_output": '{"verdict":"needs_changes"}', "count": 2, "items": [1, 2]}
    assert evaluate_condition("'needs_changes' in state.get('last_tool_output', '')", state)
    assert evaluate_condition("state.get('count', 0) >= 2 and len(state.get('items', [])) == 2", state)
    assert not evaluate_condition("state.get('missing') is not None", state)
    assert evaluate_condition("iteration >= max_iterations", {"iteration": 2, "max_iterations": 2})


@pytest.mark.parametrize("expression", [
    "().__class__.__base__.__subclasses__()", "__import__('os')", "state.clear()",
    "state['secret']", "state.get('x').__class__", "[x for x in state.get('x')]",
])
def test_expressions_cannot_escape(expression):
    with pytest.raises(ConditionError):
        evaluate_condition(expression, {"x": []})


def test_state_objects_cannot_execute_magic_methods():
    class Trap:
        def __eq__(self, _other):
            raise AssertionError("must not execute")

    with pytest.raises(ConditionError):
        evaluate_condition("state.get('x') == 1", {"x": Trap()})


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,key", [("CONDITIONAL_NODE", "condition"), ("LOOP_NODE", "exit_condition")])
async def test_routing_rejects_unsafe_expression_without_fallback(kind, key):
    node = SimpleWorkflowExecutor()._create_control_node_executor(
        "route", kind, {"config": {key: "().__class__.__base__.__subclasses__()"}}
    )
    with pytest.raises(RuntimeError, match="routing failed"):
        await node({})


@pytest.mark.asyncio
async def test_missing_conditional_branch_is_not_silently_completed():
    workflow = SimpleNamespace(name="fixture", configuration={
        "nodes": [{"id": "start", "type": "START_NODE"},
                  {"id": "route", "type": "CONDITIONAL_NODE", "config": {"condition": "True", "routing_map": {"true": "missing"}}},
                  {"id": "end", "type": "END_NODE"}],
        "edges": [{"source": "start", "target": "route"},
                  {"source": "route", "target": "end", "data": {"label": "other"}}],
    })
    graph = await SimpleWorkflowExecutor()._build_graph_from_workflow(workflow)
    with pytest.raises(ValueError, match="No conditional route"):
        await graph.compile().ainvoke({})
