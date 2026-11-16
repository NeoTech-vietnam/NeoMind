"""Exercise the native Responses wire in a loopback-only network namespace."""
import os
import json
import secrets
import signal
import subprocess
import tempfile
from pathlib import Path

from fake_acceptance import CODE_ROOT, PYTHON, ROOT, Worker, get_line, require


def main():
    require(os.environ.get('FIXTURE_NETNS') == '1', 'loopback-only network namespace required')
    runs = ROOT / 'runs'
    runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='luna-wire-fake-', dir=runs))
    (run / 'upstream-mode').write_text('ok')
    upstream = subprocess.Popen([PYTHON, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        port = int(get_line(upstream))
        worker = Worker(run / 'worker', port, luna_test=True)
        sid = worker.session('luna-fake', cap=5)
        worker.prompt(sid, 'msg_' + secrets.token_hex(12))
        worker.wait(sid)
        trace = [json.loads(line) for line in worker.trace.read_text().splitlines()]
        require(any(item.get('event') == 'luna-request-checked' for item in trace), 'native fake Responses request did not pass Luna body guard')
        require(worker.reservations() == 1, 'native fake request did not reserve exactly once')
        posts = [json.loads(line) for line in (run / 'upstream.jsonl').read_text().splitlines()]
        require(len(posts) == 1 and posts[0].get('path') == '/v1/responses', 'unexpected fake upstream request count or path')
        print('PASS fake Responses request: body cap and high reasoning verified; one reservation and loopback POST; no live inference', flush=True)
    finally:
        if worker:
            worker.close()
        os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)


if __name__ == '__main__':
    main()
