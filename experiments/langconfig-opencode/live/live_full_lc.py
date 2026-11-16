"""Bounded synthetic HTTP/approval/review/repair cycle; not a production server."""
import asyncio
import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from langchain_core.callbacks import BaseCallbackHandler
from langgraph.checkpoint.memory import MemorySaver

from api.hitl import routes as hitl
from api.workflows import execution
from core.workflows import executor as executor_module
from core.workflows.checkpointing import cancellation, manager
from db import database
from fake_acceptance import CODE_ROOT, ROOT, Worker, require
from live_lc import LiveTransport, REQUEST_CAP
from live_models import live_model
from models.core import Task
from models.workflow import WorkflowProfile
from runtime_paths import verify_live_budget
from services import event_bus as event_bus_module
from tools import native_tools
from tools.opencode_review import Adapter, review_runtime
import quota


async def execute_cycle(worker, workflow_id, workspace, run, model):
    """Exercise real HTTP routes and graph executor with controlled fake storage/tools."""
    draft = workspace / 'draft.txt'
    source = 'Audit logs are retained for 30 days. Production releases require two reviewers.'
    wrong = 'Audit logs are retained for 90 days. Production releases require one reviewer.'
    actions, events, records = [], [], {}
    checkpointer = MemorySaver()
    tool_node = lambda node_id, tool_id, params: {'id': node_id, 'type': 'TOOL_NODE', 'config': {'tool_type': 'mcp', 'tool_id': tool_id, 'tool_params': params}}
    review = lambda node_id: tool_node(node_id, 'opencode_review', {'attempt_id': node_id, 'instruction': 'Compare SOURCE with DRAFT. Report every contradiction.\n{{previous_output}}'})
    edge = lambda source_id, target, **data: {'source': source_id, 'target': target, 'data': data}
    graph = {'nodes': [
        {'id': 'start', 'type': 'START_NODE'}, {'id': 'approval', 'type': 'APPROVAL_NODE'},
        tool_node('write', 'fixture_write', {}), review('review'),
        {'id': 'route', 'type': 'CONDITIONAL_NODE', 'config': {'condition': "'needs_changes' in state.get('last_tool_output', '')", 'routing_map': {'true': 'repair', 'false': 'pass'}}},
        tool_node('repair', 'fixture_repair', {}), review('rereview'), {'id': 'end', 'type': 'END_NODE'}],
        'edges': [edge('start', 'approval'), edge('approval', 'write'), edge('write', 'review'), edge('review', 'route'),
                  edge('route', 'repair', label='repair'), edge('route', 'end', label='pass'), edge('repair', 'rereview'), edge('rereview', 'end')]}
    workflow = SimpleNamespace(id=2, name='synthetic-cycle', strategy_type=None, configuration=graph)

    class FixtureTool:
        def __init__(self, name): self.name = name
        async def ainvoke(self, params):
            require(params == {}, 'fixture writer does not accept paths or content')
            if self.name == 'fixture_write':
                require(not draft.exists() and not draft.is_symlink(), 'fixture draft already exists')
                content = wrong
            else:
                require(draft.is_file() and not draft.is_symlink() and draft.read_text() == wrong, 'fixture baseline changed')
                content = source
            draft.write_text(content)
            actions.append(self.name)
            return f'SOURCE DOCUMENT\n{source}\n\nDRAFT TO REVIEW\n{content}'

    class Query:
        def __init__(self, model_type): self.model_type = model_type
        def filter(self, *_args): return self
        def order_by(self, *_args): return self
        def limit(self, *_args): return self
        def first(self): return records.get('task') if self.model_type is Task else workflow if self.model_type is WorkflowProfile else None
        def all(self): return [records['task']] if self.model_type is Task and 'task' in records else []

    class DB:
        def query(self, model_type): return Query(model_type)
        def add(self, task):
            task.id = 1
            task.created_at = task.updated_at = datetime.now(timezone.utc)
            records['task'] = task
        def refresh(self, _task): pass
        def commit(self): pass
        def rollback(self): pass
        def close(self): pass

    class Registry:
        async def register_task(self, _task_id): return None
        async def unregister_task(self, _task_id): pass
        async def is_cancelled(self, _task_id): return False

    class Bus:
        async def publish(self, _channel, event): events.append(event)

    class Callback(BaseCallbackHandler):
        async def flush_pending_persists(self, **_kwargs): pass
        def get_collected_artifacts(self): return []

    async def validate(*_args): pass
    original_load = native_tools.load_native_tools
    def load(names, *args, **kwargs):
        if names in (['fixture_write'], ['fixture_repair']): return [FixtureTool(names[0])]
        return original_load(names, *args, **kwargs)

    adapter = Adapter(LiveTransport(worker, workflow_id), workspace, run / 'attempts.sqlite', fixture_root=workspace, model=model)
    db = DB()
    app = FastAPI()
    app.include_router(execution.router)
    app.include_router(hitl.router)
    app.dependency_overrides[execution.get_db] = lambda: db
    app.dependency_overrides[hitl.get_db] = lambda: db
    with patch.object(database, 'SessionLocal', lambda: db), patch.object(cancellation, 'get_cancellation_registry', Registry), \
         patch.object(manager, 'get_checkpointer', lambda: checkpointer), patch.object(event_bus_module, 'get_event_bus', lambda: Bus()), \
         patch.object(hitl, 'get_event_bus', lambda: Bus()), patch.object(executor_module, 'create_execution_callback_handler', lambda **_kwargs: Callback()), \
         patch.object(executor_module, 'get_store', lambda: None), patch.object(executor_module.SimpleWorkflowExecutor, '_validate_and_init_tools', validate), \
         patch.object(native_tools, 'load_native_tools', load), review_runtime(adapter):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            queued = await client.post('/api/orchestration/execute', json={'workflow_id': 2, 'input_data': {'query': 'Synthetic fixture only'}})
            require(queued.status_code == 200, 'workflow HTTP admission failed')
            paused = await client.get('/api/orchestration/tasks/1')
            require(paused.status_code == 200 and paused.json()['status'] == 'in_progress' and not draft.exists(), 'approval did not pause before write')
            approved = await client.post('/api/hitl/2/approve', json={'approved': True, 'comment': 'Synthetic fixture approved'})
            require(approved.status_code == 200 and approved.json()['status'] == 'approved', 'fixture approval failed')
            final = await client.get('/api/orchestration/tasks/1')
            require(final.status_code == 200 and final.json()['status'] == 'completed', 'HTTP workflow did not complete')
    require(actions == ['fixture_write', 'fixture_repair'] and draft.read_text() == source, 'fixture writer/repair result mismatch')
    first, second = adapter._row('review'), adapter._row('rereview')
    require(first and second and first['terminal'] and second['terminal'], 'review receipts missing')
    result1, result2 = json.loads(first['terminal']), json.loads(second['terminal'])
    require(result1['verdict'] == 'needs_changes' and result2['verdict'] == 'pass', 'review and rereview verdicts incorrect')
    return {'status': 'completed', 'http': 'asgi-in-process', 'approval': 'synthetic', 'actions': actions,
            'initialReview': result1, 'finalReview': result2, 'storage': 'fake-in-memory', 'draft': str(draft)}


async def main():
    if os.environ.get('NEOMIND_LIVE_AUTHORIZED') != 'f21c6cfacd571ede17407ad839d5ada908f2ced3': raise RuntimeError('live authorization gate is closed')
    if (ROOT / 'LIVE_PAUSED').exists() or (CODE_ROOT / 'LIVE_PAUSED').exists(): raise RuntimeError('live evaluation is paused')
    model = live_model(os.environ.get('LIVE_MODEL_ID'))
    if model != {'providerID': 'openai', 'id': 'gpt-6-luna', 'variant': 'high'}: raise RuntimeError('exact Luna high required')
    workflow = os.environ.get('LIVE_WORKFLOW_ID', '')
    if not workflow.startswith('lc-') or str(uuid.UUID(workflow[3:])) != workflow[3:]: raise RuntimeError('invalid workflow ID')
    metadata = json.loads((ROOT / 'live-attempts' / f'{workflow}.json').read_text())
    if (metadata.get('workflow') != workflow or metadata.get('model') != model or metadata.get('requestCap') != REQUEST_CAP
            or metadata.get('fixtureCase') != 'contradictory' or metadata.get('maxOutputTokens') != 8192 or metadata.get('experimentMode') != 'fixture-cycle'):
        raise RuntimeError('fixture-cycle attempt metadata mismatch')
    budget = verify_live_budget(ROOT, os.environ.get('LIVE_BUDGET_PATH'))
    run = Path(tempfile.mkdtemp(prefix='live-lc-cycle-', dir=ROOT / 'runs'))
    workspace = run / 'fixture'; workspace.mkdir()
    worker = None
    try:
        worker = Worker(run / 'worker', None, workspace=workspace, live_db=budget, live_model_id='openai/gpt-6-luna', account_db=os.environ.get('OPENCODE_ACCOUNT_DB'))
        quota.start_workflow(str(budget), workflow, REQUEST_CAP)
        result = await execute_cycle(worker, workflow, workspace, run, model)
        (run / 'cycle.json').write_text(json.dumps(result, indent=2))
        print(json.dumps({'status': 'completed', 'result': result, 'artifacts': str(run)}), flush=True)
    finally:
        if worker: worker.close()
    print('LIVE_HOST_DONE', flush=True)
    threading.Event().wait(300)


if __name__ == '__main__':
    asyncio.run(main())
