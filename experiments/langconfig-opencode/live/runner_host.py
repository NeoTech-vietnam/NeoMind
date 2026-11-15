"""Private fake-only OpenCode worker controlled over owned stdio."""
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from fake_acceptance import ROOT, CODE_ROOT, MODEL, Worker, get_line

def main():
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True, stdout=subprocess.DEVNULL)
    workspace = Path(sys.argv[1]).resolve(strict=True)
    if not workspace.is_relative_to(ROOT):
        raise ValueError('fixture workspace required')
    runs = ROOT / 'runs'
    runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='runner-', dir=runs))
    (run / 'upstream-mode').write_text('ok')
    upstream = subprocess.Popen([sys.executable, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        port = int(get_line(upstream))
        worker = Worker(run / 'worker', port, workspace=workspace, cap=10)
        sid = worker.session('runner', cap=10)
        print(json.dumps({'ready': True}), flush=True)
        for line in sys.stdin:
            try:
                command = json.loads(line)
                if command['operation'] == 'turn':
                    before = worker.request('GET', f'/api/session/{sid}')['data']
                    if before.get('model') != MODEL or before.get('permissions') != [{'action': '*', 'resource': '*', 'effect': 'deny'}]:
                        raise ValueError('session no longer verified')
                    msg = 'msg_' + secrets.token_hex(12)
                    worker.request('POST', f'/api/session/{sid}/prompt', {'id': msg, 'text': command['prompt']})
                    session = worker.wait(sid)
                    messages = worker.timeline(sid)
                    positions = [i for i, m in enumerate(messages) if m.get('type') == 'user' and m.get('id') == msg]
                    if session.get('outcome') != 'succeeded' or len(positions) != 1:
                        raise ValueError('turn did not succeed or prompt ambiguous')
                    later = messages[positions[0] + 1:]
                    if any(m.get('type') == 'user' for m in later):
                        raise ValueError('unexpected later prompt')
                    reply = [m for m in later if m.get('type') == 'assistant'][-1]
                    if reply.get('model') != MODEL or reply.get('agent') != 'build' or reply.get('finish') != 'stop' or reply.get('error'):
                        raise ValueError('unverified assistant reply')
                    texts = [p['text'] for p in reply.get('content', []) if p.get('type') == 'text' and p.get('text')]
                    if not texts:
                        raise ValueError('empty response')
                    print(json.dumps({'id': command['id'], 'messages': texts}), flush=True)
                else:
                    raise ValueError('unknown operation')
            except Exception:
                print(json.dumps({'id': command.get('id'), 'error': 'fixture turn failed'}), flush=True)
    finally:
        if worker:
            worker.close()
        if upstream.poll() is None:
            os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)

if __name__ == '__main__':
    main()
