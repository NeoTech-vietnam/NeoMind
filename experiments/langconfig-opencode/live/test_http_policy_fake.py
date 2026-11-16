"""Real HTTP route, trusted process policy and owned OpenCode over loopback."""
import asyncio
import os
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from langchain_core.callbacks import BaseCallbackHandler

from api.workflows import execution
from core.workflows import executor as executor_module
from core.workflows.checkpointing import cancellation
from db import database
from fake_acceptance import CODE_ROOT, ROOT, Worker, get_line, require
from models.core import Task
from models.workflow import WorkflowProfile
from services import event_bus as event_bus_module
from tools.fixture_review_runtime import install_fixture_factory
from tools.opencode_http import LoopbackTransport
from tools.opencode_review import Adapter
import quota


async def run_http(worker, run, workspace):
    records, policy_calls = {}, []
    workflow = SimpleNamespace(id=2, name='fixture', strategy_type=None, configuration={
        'nodes': [{'id': 'start', 'type': 'START_NODE'},
                  {'id': 'review', 'type': 'TOOL_NODE', 'config': {'tool_type': 'mcp', 'tool_id': 'opencode_review',
                     'tool_params': {'attempt_id': 'review-1', 'instruction': 'Review synthetic fixture'}}},
                  {'id': 'end', 'type': 'END_NODE'}],
        'edges': [{'source': 'start', 'target': 'review'}, {'source': 'review', 'target': 'end'}]})

    class Query:
        def __init__(self, kind): self.kind = kind
        def filter(self, *_args): return self
        def first(self): return records.get('task') if self.kind is Task else workflow if self.kind is WorkflowProfile else None
        def all(self): return []

    class DB:
        def query(self, kind): return Query(kind)
        def add(self, task):
            task.id = 1
            task.created_at = task.updated_at = datetime.now(timezone.utc)
            records['task'] = task
        def refresh(self, _task): pass
        def commit(self): pass
        def close(self): pass

    class Registry:
        async def register_task(self, _task_id): return None
        async def unregister_task(self, _task_id): pass
        async def is_cancelled(self, _task_id): return False

    class Bus:
        async def publish(self, *_args): pass

    class Callback(BaseCallbackHandler):
        async def flush_pending_persists(self, **_kwargs): pass
        def get_collected_artifacts(self): return []

    async def validate(*_args): pass
    transport = LoopbackTransport(worker.origin, 'opencode', worker.password)
    original = transport.request

    async def request(method, path, body=None):
        if method == 'POST' and path.endswith('/prompt'):
            await asyncio.to_thread(worker.preflight, str(CODE_ROOT / 'guard'))
        response = await original(method, path, body)
        if method == 'POST' and path == '/api/session':
            quota.bind(str(worker.db), response['data']['id'], 'http-policy-fake', 5)
        return response

    transport.request = request
    model = {'providerID': 'fixture', 'id': 'fake-review', 'variant': 'high'}
    adapter = Adapter(transport, workspace, run / 'attempts.sqlite', fixture_root=workspace, model=model)

    def factory(task_id, workflow_id, project_id):
        policy_calls.append((task_id, workflow_id, project_id))
        return adapter if (task_id, workflow_id, project_id) == (1, 2, None) else None

    db = DB()
    app = FastAPI()
    app.include_router(execution.router)
    app.dependency_overrides[execution.get_db] = lambda: db
    with patch.object(database, 'SessionLocal', lambda: db), patch.object(cancellation, 'get_cancellation_registry', Registry), \
         patch.object(event_bus_module, 'get_event_bus', lambda: Bus()), patch.object(executor_module, 'get_store', lambda: None), \
         patch.object(executor_module, 'create_execution_callback_handler', lambda **_kwargs: Callback()), \
         patch.object(executor_module.SimpleWorkflowExecutor, '_validate_and_init_tools', validate), install_fixture_factory(factory):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            admitted = await client.post('/api/orchestration/execute', json={'workflow_id': 2, 'input_data': {'query': 'Synthetic fixture'}})
            require(admitted.status_code == 200, 'HTTP admission failed')
            status = await client.get('/api/orchestration/tasks/1')
            require(status.status_code == 200 and status.json()['status'] == 'completed', 'HTTP task failed')
    row = adapter._row('review-1')
    require(row and row['stage'] == 'completed' and policy_calls == [(1, 2, None)], 'trusted policy did not bind exact task')
    return adapter


async def main():
    require(os.environ.get('FIXTURE_NETNS') == '1', 'network namespace required')
    run = Path(tempfile.mkdtemp(prefix='http-policy-fake-', dir=ROOT / 'runs'))
    workspace = run / 'fixture'; workspace.mkdir()
    (run / 'upstream-mode').write_text('ok')
    upstream = subprocess.Popen([sys.executable, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        worker = Worker(run / 'worker', int(get_line(upstream)), workspace=workspace)
        quota.start_workflow(str(worker.db), 'http-policy-fake', 5)
        await run_http(worker, run, workspace)
        require(worker.reservations() == 1 and len((run / 'upstream.jsonl').read_text().splitlines()) == 1, 'unexpected fake request count')
        print('PASS HTTP → trusted process fixture policy → real loopback OpenCode → fake upstream; 1 fake POST/reservation, 0 live requests', flush=True)
    finally:
        if worker: worker.close()
        if upstream.poll() is None: os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)


if __name__ == '__main__':
    asyncio.run(main())
