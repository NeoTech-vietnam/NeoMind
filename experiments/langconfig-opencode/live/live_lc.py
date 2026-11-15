"""Explicitly gated live LC TOOL_NODE fixture; never reads or copies credentials."""
import asyncio
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path
from typing import TypedDict

from fake_acceptance import ROOT, CODE_ROOT, Worker
from live_models import live_model
import quota
from runtime_paths import verify_live_budget

from langgraph.graph import StateGraph, START, END
from core.workflows import nodes
from tools.opencode_review import Adapter, review_runtime

class State(TypedDict, total=False):
    task_id: int
    tool_result: object
    last_tool_output: str
    current_directive: str
    handoff_summary: str
    messages: list
    execution_failed: bool

class LiveTransport:
    """The separately guarded experiment; the packaged fixture HTTP lock stays untouched."""
    def __init__(self, worker, workflow):
        self.worker, self.workflow = worker, workflow
        self.bound = set()

    async def request(self, method, path, body=None):
        if method not in ('GET', 'POST'):
            raise ValueError('unsupported operation')
        if method == 'POST' and path.endswith('/prompt'):
            sid = path.split('/')[3]
            if sid not in self.bound:
                raise ValueError('unbound session')
            await asyncio.to_thread(self.worker.preflight, str(CODE_ROOT / 'guard'))
            entries = await asyncio.to_thread(self.worker.request, 'GET', f'/api/experimental/session/{sid}/instructions/entries')
            if entries.get('data') != []:
                raise ValueError('unexpected session instruction entries')
        response = await asyncio.to_thread(self.worker.request, method, path, body, 180)
        if method == 'POST' and path == '/api/session':
            sid = response['data']['id']
            quota.bind(str(self.worker.db), sid, self.workflow, 10)
            self.bound.add(sid)
        return response

async def main():
    if os.environ.get('NEOMIND_LIVE_AUTHORIZED') != 'f21c6cfacd571ede17407ad839d5ada908f2ced3':
        raise RuntimeError('live authorization gate is closed')
    if (ROOT / 'LIVE_PAUSED').exists() or (CODE_ROOT / 'LIVE_PAUSED').exists():
        raise RuntimeError('live evaluation is paused')
    model = live_model(os.environ.get('LIVE_MODEL_ID'))
    if model != {'providerID': 'openrouter', 'id': 'openrouter/free'}:
        raise RuntimeError('explicit OpenRouter free router selection required')
    workflow = os.environ.get('LIVE_WORKFLOW_ID', '')
    try:
        if not workflow.startswith('lc-') or str(uuid.UUID(workflow[3:])) != workflow[3:]:
            raise ValueError('bad workflow ID')
        metadata = json.loads((ROOT / 'live-attempts' / f'{workflow}.json').read_text())
        if metadata.get('workflow') != workflow or metadata.get('model') != model:
            raise ValueError('attempt metadata mismatch')
    except (ValueError, OSError, TypeError) as exc:
        raise RuntimeError('new workflow attempt metadata required') from exc
    budget = verify_live_budget(ROOT, os.environ.get('LIVE_BUDGET_PATH'))
    run = Path(tempfile.mkdtemp(prefix='live-lc-', dir=ROOT / 'runs'))
    workspace = run / 'fixture'
    workspace.mkdir()
    fixture = workspace / 'source.txt'
    fixture.write_text('SOURCE DOCUMENT\nThe audit log retention period is 30 days. Production releases require approval from two reviewers.\n\nDRAFT TO REVIEW\nThe audit log retention period is 90 days. Production releases require approval from one reviewer.\n')
    worker = None
    try:
        worker = Worker(run / 'worker', None, workspace=workspace, live_db=budget, live_model_id=os.environ['LIVE_MODEL_ID'], account_db=os.environ.get('OPENCODE_ACCOUNT_DB'))
        quota.start_workflow(str(budget), workflow, 10)
        adapter = Adapter(LiveTransport(worker, workflow), workspace, run / 'attempts.sqlite', fixture_root=workspace, model=model)
        async def no_events(*args, **kwargs):
            pass
        nodes._emit_node_event = no_events
        async def read(state):
            return await nodes.execute_tool_node(state, {}, {'node_id': 'read', 'tool_type': 'mcp', 'tool_id': 'read_file', 'tool_params': {'file_path': str(fixture)}})
        async def review(state):
            return await nodes.execute_tool_node(state, {}, {'node_id': 'review', 'tool_type': 'mcp', 'tool_id': 'opencode_review', 'tool_params': {'attempt_id': 'lc-live-1', 'instruction': 'Compare the draft with the source and report unsupported or contradictory claims.\n{{previous_output}}'}})
        graph = StateGraph(State)
        graph.add_node('read', read)
        graph.add_node('review', review)
        graph.add_edge(START, 'read')
        graph.add_edge('read', 'review')
        graph.add_edge('review', END)
        with review_runtime(adapter):
            result = await graph.compile().ainvoke({'task_id': 0})
        if result.get('execution_failed'):
            raise RuntimeError('LC TOOL_NODE did not complete')
        review_result = json.loads(result['tool_result'])
        (run / 'review.json').write_text(json.dumps(review_result, indent=2))
        print(json.dumps({'status': 'completed', 'result': review_result, 'artifacts': str(run)}), flush=True)
    finally:
        if worker:
            worker.close()
    # Keep the scope alive until its owner has observed completion and stops it.
    print('LIVE_HOST_DONE', flush=True)
    threading.Event().wait(300)

if __name__ == '__main__':
    asyncio.run(main())
