"""Exercise the orchestration background task and status endpoint without a server."""
from types import SimpleNamespace
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI

from api.workflows import execution
from core.workflows.checkpointing import cancellation
from db import database
from models.core import Task, TaskStatus
from models.workflow import WorkflowProfile


@pytest.mark.asyncio
@pytest.mark.parametrize("result,expected", [
    ({"error": "fixture failure", "workflow_status": "FAILED"}, TaskStatus.FAILED),
    ({"formatted_output": {"formatted_content": "fixture output"}}, TaskStatus.COMPLETED),
    ({"status": "awaiting_approval", "formatted_output": {"formatted_content": "awaiting approval"}}, TaskStatus.IN_PROGRESS),
])
async def test_background_result_visible_through_status(monkeypatch, result, expected):
    task = SimpleNamespace(id=1, project_id=None, created_at=datetime.now(timezone.utc), error_message=None)
    workflow = SimpleNamespace(id=2, name="fixture")

    class Query:
        def __init__(self, model):
            self.model = model

        def filter(self, *_args):
            return self

        def first(self):
            return task if self.model is Task else workflow if self.model is WorkflowProfile else None

        def all(self):
            return []

    class DB:
        def query(self, model):
            return Query(model)

        def commit(self):
            pass

        def close(self):
            pass

    class Registry:
        async def register_task(self, _task_id):
            return None

        async def unregister_task(self, _task_id):
            pass

    class Executor:
        async def execute_workflow(self, **_kwargs):
            return result

    db = DB()
    monkeypatch.setattr(database, "SessionLocal", lambda: db)
    monkeypatch.setattr(cancellation, "get_cancellation_registry", Registry)
    monkeypatch.setattr(execution, "get_executor", Executor)
    await execution.execute_workflow_background(task_id=1, project_id=None, workflow_id=2, input_data={})
    response = await execution.get_task_status(1, db)
    assert response.status == expected
    if expected == TaskStatus.FAILED:
        assert response.error_message == "fixture failure"
        assert response.result == result
    elif expected == TaskStatus.COMPLETED:
        assert response.result["formatted_content"] == "fixture output"
        assert response.completed_at is not None
    else:
        assert response.result["formatted_content"] == "awaiting approval"
        assert response.completed_at is None

    app = FastAPI()
    app.include_router(execution.router)
    app.dependency_overrides[execution.get_db] = lambda: db
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
        http_response = await client.get("/api/orchestration/tasks/1")
    assert http_response.status_code == 200
    assert http_response.json()["status"] == expected.value
    if expected == TaskStatus.FAILED:
        assert http_response.json()["error_message"] == "fixture failure"
        assert http_response.json()["result"] == result
