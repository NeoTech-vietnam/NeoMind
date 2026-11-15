"""Replay the live LC graph with OpenCode and an isolated fake upstream only."""
import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from fake_acceptance import CODE_ROOT, ROOT, MODEL, Worker, get_line, require
from live_lc import REQUEST_CAP, execute_graph
import quota


async def main():
    require(os.environ.get('FIXTURE_NETNS') == '1', 'network namespace required')
    run = Path(tempfile.mkdtemp(prefix='lc-fake-', dir=ROOT / 'runs'))
    workspace = run / 'fixture'; workspace.mkdir()
    fixture = workspace / 'source.txt'
    fixture.write_text('SOURCE: Retention is 30 days; releases need two reviewers.\nDRAFT: Retention is 90 days; releases need one reviewer.\n')
    (run / 'upstream-mode').write_text('ok')
    upstream = subprocess.Popen([sys.executable, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        zai_test = os.environ.get('TEST_ZAI_BODY') == '1'
        worker = Worker(run / 'worker', int(get_line(upstream)), workspace=workspace, zai_test=zai_test)
        quota.start_workflow(str(worker.db), 'lc-fake', REQUEST_CAP)
        result = await execute_graph(worker, 'lc-fake', workspace, run, MODEL, fixture)
        require(result['verdict'] == 'needs_changes' and result['summary'] == 'Synthetic fake review', 'unexpected fake result')
        require(worker.reservations() == 1 and len((run / 'upstream.jsonl').read_text().splitlines()) == 1, 'request count mismatch')
        if zai_test:
            require(json.loads((run / 'upstream.jsonl').read_text())['model'] == 'glm-5.3-flash', 'fake Zai model mismatch')
            require('paid-request-checked' in worker.trace.read_text(), 'Zai body guard not exercised')
        user = next(message for message in worker.timeline(result['session_id']) if message.get('type') == 'user')
        (run / 'user-message.json').write_text(json.dumps(user, indent=2))
        prompt = user['text']
        require(all(line in prompt for line in fixture.read_text().splitlines()), f'LangConfig read_file output missing; inspect {run}')
        print(json.dumps({'status': 'PASS', 'graph': 'read_file -> opencode_review', 'fakePosts': 1, 'fakeReservations': 1, 'liveRequests': 0, 'artifacts': str(run)}))
    finally:
        if worker: worker.close()
        if upstream.poll() is None: os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)


if __name__ == '__main__':
    asyncio.run(main())
