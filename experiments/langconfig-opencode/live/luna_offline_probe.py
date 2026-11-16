"""Inspect request metadata only while an isolated network and guard deny dispatch."""
import json
import os
import secrets
import tempfile
from pathlib import Path

from fake_acceptance import ROOT, Worker, require


def main():
    runs = ROOT / 'runs'
    runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='luna-offline-probe-', dir=runs))
    workspace = run / 'fixture'
    workspace.mkdir()
    worker = None
    try:
        worker = Worker(run / 'worker', None, workspace=workspace, account_db=os.environ.get('OPENCODE_ACCOUNT_DB'), probe_luna=True)
        integration = worker.request('GET', '/api/integration/openai')['data']
        require(any(c.get('type') == 'credential' and not c.get('status') for c in integration.get('connections', [])), 'OpenAI account unavailable')
        sid = worker.session('luna-offline-probe', cap=5)
        worker.prompt(sid, 'msg_' + secrets.token_hex(12))
        worker.wait(sid)
        events = [json.loads(line) for line in worker.trace.read_text().splitlines()]
        denied = [event for event in events if event.get('event') == 'luna-probe-denied']
        require(len(denied) == 1, 'expected exactly one denied probe request')
        require(worker.reservations() == 0, 'offline probe must not reserve or dispatch')
        print(json.dumps({'status': 'offline-denied', 'requestMetadata': denied[0], 'reservations': 0, 'network': 'separate loopback-only namespace', 'artifacts': str(run)}), flush=True)
    finally:
        if worker:
            worker.close()


if __name__ == '__main__':
    main()
