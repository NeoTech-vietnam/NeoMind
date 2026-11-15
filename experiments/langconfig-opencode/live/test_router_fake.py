"""Actual OpenCode server with a separately named fake native OpenRouter upstream."""
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from fake_acceptance import CODE_ROOT, ROOT, Worker, get_line, require

def main():
    require(os.environ.get('FIXTURE_NETNS') == '1', 'network namespace required')
    runs = ROOT / 'runs'; runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='router-fake-', dir=runs))
    (run / 'upstream-mode').write_text('ok')
    upstream = subprocess.Popen([sys.executable, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        port = int(get_line(upstream))
        worker = Worker(run / 'worker', port, router_test=True)
        sid = worker.session('router-fake')
        worker.prompt(sid, 'msg_' + secrets.token_hex(12))
        result = worker.wait(sid)
        reply = [m for m in worker.timeline(sid) if m.get('type') == 'assistant'][-1]
        trace = [json.loads(line) for line in worker.trace.read_text().splitlines()]
        posts = [json.loads(line) for line in (run / 'upstream.jsonl').read_text().splitlines()]
        require(result.get('outcome') == 'succeeded', 'router fake session failed')
        require(len(posts) == 1 and posts[0]['model'] == 'openrouter/free' and worker.reservations() == 1, 'router dispatch mismatch')
        require(sum(x.get('event') == 'reserved' for x in trace) == 1, 'missing guard reservation')
        require(any(x.get('event') == 'router-default-normalized' for x in trace), 'normalization not exercised')
        require(all('variant' not in x for x in trace if x.get('event') == 'reserved'), 'outbound variant not absent')
        print(json.dumps({'status': 'PASS', 'physicalFakePosts': len(posts), 'reservations': worker.reservations(), 'sessionModel': result.get('model'), 'assistantModel': reply.get('model'), 'artifacts': str(run)}))
    finally:
        if worker: worker.close()
        if upstream.poll() is None: os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)

if __name__ == '__main__':
    main()
