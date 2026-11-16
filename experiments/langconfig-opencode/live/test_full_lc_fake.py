"""Replay the HTTP/approval/review/repair cycle with loopback-only fake inference."""
import asyncio
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from fake_acceptance import CODE_ROOT, ROOT, MODEL, Worker, get_line, require
from live_full_lc import execute_cycle
import quota


async def main():
    require(os.environ.get('FIXTURE_NETNS') == '1', 'network namespace required')
    run = Path(tempfile.mkdtemp(prefix='lc-cycle-fake-', dir=ROOT / 'runs'))
    workspace = run / 'fixture'; workspace.mkdir()
    (run / 'upstream-mode').write_text('cycle')
    upstream = subprocess.Popen([sys.executable, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        worker = Worker(run / 'worker', int(get_line(upstream)), workspace=workspace)
        quota.start_workflow(str(worker.db), 'lc-cycle-fake', 5)
        result = await execute_cycle(worker, 'lc-cycle-fake', workspace, run, MODEL)
        require(result['initialReview']['verdict'] == 'needs_changes' and result['finalReview']['verdict'] == 'pass', 'unexpected fake verdicts')
        require(worker.reservations() == 2 and len((run / 'upstream.jsonl').read_text().splitlines()) == 2, 'unexpected fake request count')
        print('PASS ASGI → approval → synthetic writer → review → repair → rereview; 2 fake POSTs, 2 fake reservations, 0 live requests', flush=True)
    finally:
        if worker: worker.close()
        if upstream.poll() is None: os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)


if __name__ == '__main__':
    asyncio.run(main())
