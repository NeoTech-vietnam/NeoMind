"""HTTP to real workflow executor and review tool, with fake storage and adapter."""
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from langchain_core.callbacks import BaseCallbackHandler

from api.workflows import execution
from core.workflows import executor as executor_module
from core.workflows.checkpointing import cancellation
from db import database
from models.core import Task
from models.workflow import WorkflowProfile
from services import event_bus as event_bus_module
from tools.fixture_review_runtime import install_fixture_factory
from tools.opencode_http import LoopbackTransport
from tools.opencode_review import Adapter
from test_opencode_review import Fake


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_http_review_workflow_reports_real_outcome(monkeypatch, tmp_path, fail):
    events = []
    workflow = SimpleNamespace(id=2, name="fixture", strategy_type=None, configuration={
        "nodes": [
            {"id": "start", "type": "START_NODE"},
            {"id": "review", "type": "TOOL_NODE", "config": {
                "tool_type": "mcp", "tool_id": "opencode_review",
                "tool_params": {"attempt_id": "fixture-1", "instruction": "Review synthetic fixture"},
            }},
            {"id": "end", "type": "END_NODE"},
        ],
        "edges": [{"source": "start", "target": "review"}, {"source": "review", "target": "end"}],
    })
    records = {}

    class Query:
        def __init__(self, model):
            self.model = model

        def filter(self, *_args):
            return self

        def first(self):
            return records.get("task") if self.model is Task else workflow if self.model is WorkflowProfile else None

        def all(self):
            return []

    class DB:
        def query(self, model):
            return Query(model)

        def add(self, task):
            task.id = 1
            task.created_at = task.updated_at = datetime.now(timezone.utc)
            records["task"] = task

        def refresh(self, _task):
            pass

        def commit(self):
            pass

        def close(self):
            pass

    class Registry:
        async def register_task(self, _task_id):
            return None

        async def unregister_task(self, _task_id):
            pass

        async def is_cancelled(self, _task_id):
            return False

    class Bus:
        async def publish(self, _channel, event):
            events.append(event)

    class Callback(BaseCallbackHandler):
        async def flush_pending_persists(self, **_kwargs):
            pass

        def get_collected_artifacts(self):
            return []

    async def validate(*_args):
        pass

    executor = executor_module.SimpleWorkflowExecutor()
    db = DB()
    monkeypatch.setattr(database, "SessionLocal", lambda: db)
    monkeypatch.setattr(cancellation, "get_cancellation_registry", Registry)
    monkeypatch.setattr(execution, "get_executor", lambda: executor)
    monkeypatch.setattr(executor, "_validate_and_init_tools", validate)
    monkeypatch.setattr(event_bus_module, "get_event_bus", lambda: Bus())
    monkeypatch.setattr(executor_module, "create_execution_callback_handler", lambda **_kwargs: Callback())
    monkeypatch.setattr(executor_module, "get_store", lambda: None)
    app = FastAPI()
    app.include_router(execution.router)
    app.dependency_overrides[execution.get_db] = lambda: db
    workspace = tmp_path / "fixture"
    workspace.mkdir()
    transport = Fake(workspace)
    if fail:
        transport.response = "invalid JSON"
    policy_calls = []
    fixture_model = {"providerID": "fixture", "id": "fake-review", "variant": "high"}
    loopback = LoopbackTransport('http://127.0.0.1:1234', 'fixture', 'dummy')

    async def request(method, path, body=None):
        response = await transport.request(method, path, body)
        if path == '/api/session' or (path.startswith('/api/session/') and all(x not in path for x in ('/prompt', '/wait', '/message?', '/interrupt'))):
            response['data']['model'] = fixture_model
        if '/message?' in path:
            for message in response['data']:
                if message.get('type') == 'assistant':
                    message['model'] = fixture_model
        return response

    loopback.request = request
    adapter = Adapter(loopback, workspace, tmp_path / "attempts.sqlite", model=fixture_model)

    def factory(task_id, workflow_id, project_id):
        policy_calls.append((task_id, workflow_id, project_id))
        return adapter if (task_id, workflow_id, project_id) == (1, 2, None) else None

    binding_context = install_fixture_factory(factory)
    with binding_context:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            response = await client.post("/api/orchestration/execute", json={"workflow_id": 2, "input_data": {"query": "Synthetic"}})
            assert response.status_code == 200
            status = await client.get("/api/orchestration/tasks/1")
    assert policy_calls == [(1, 2, None)]
    prompts = [body for _, path, body in transport.calls if path.endswith("/prompt")]
    assert len(prompts) == 1 and "Review synthetic fixture" in prompts[0]["text"]
    assert status.status_code == 200
    data = status.json()
    if fail:
        assert data["status"] == "failed"
        assert "invalid review JSON or schema" in data["error_message"]
        assert any(event["type"] == "complete" and event["data"]["status"] == "error" for event in events)
    else:
        assert data["status"] == "completed"
        assert any(event["type"] == "complete" and event["data"]["status"] == "completed" for event in events)
