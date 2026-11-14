"""Invoke real LangConfig tool nodes against a private fake-only OpenCode server."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from core.workflows import nodes
from tools.opencode_http import LoopbackTransport
from tools.opencode_review import Adapter, review_runtime


class State(TypedDict, total=False):
    task_id: int
    tool_result: object
    last_tool_output: str
    current_directive: str
    handoff_summary: str
    messages: list
    execution_failed: bool


async def main(args):
    async def no_events(*a, **k): pass
    nodes._emit_node_event = no_events
    adapter = Adapter(LoopbackTransport(f'http://127.0.0.1:{args.port}', 'opencode', os.environ['OPENCODE_SERVER_PASSWORD'], 90), args.work / 'workspace', args.work / 'attempts.sqlite', fixture_root=args.work / 'workspace', model={'providerID':'fixture','id':'fake-review','variant':'high'})
    async def read(state):
        return await nodes.execute_tool_node(state, {}, {'node_id':'read','tool_type':'mcp','tool_id':'read_file','tool_params':{'file_path':str(args.work / 'workspace/source.txt')}})
    async def review(state):
        return await nodes.execute_tool_node(state, {}, {'node_id':'review','tool_type':'mcp','tool_id':'opencode_review','tool_params':{'attempt_id':'wire','instruction':'Review this synthetic source: {{previous_output}}'}})
    graph = StateGraph(State)
    graph.add_node('read', read); graph.add_node('review', review)
    graph.add_edge(START, 'read'); graph.add_edge('read', 'review'); graph.add_edge('review', END)
    with review_runtime(adapter):
        result = await graph.compile().ainvoke({'task_id':0})
    if result.get('execution_failed'):
        raise RuntimeError(f"Tool node failed: {result.get('tool_error')}")
    review_result = json.loads(result['tool_result'])
    assert review_result['verdict'] == 'needs_changes'
    assert review_result['findings'][0]['description'] == 'Fixture fake finding'
    print(json.dumps(review_result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    asyncio.run(main(parser.parse_args()))
