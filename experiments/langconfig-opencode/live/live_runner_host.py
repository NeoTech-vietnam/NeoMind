"""One experimental read-only runner; live or independently isolated fake upstream."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from fake_acceptance import ROOT, CODE_ROOT, MODEL, PERMISSIONS, Worker, get_line, session_model_matches
from live_models import live_model
from runtime_paths import verify_live_budget
import quota
import runner_turn


def main():
    mode, workspace_arg, workflow, logical_id = sys.argv[1:]
    workspace = Path(workspace_arg).resolve(strict=True)
    if not workspace.is_relative_to(ROOT):
        raise ValueError('fixture workspace required')
    if mode not in ('fake', 'fake-router', 'live'):
        raise ValueError('invalid mode')
    prefix = 'neo-' if mode == 'live' else 'fake-'
    if not workflow.startswith(prefix) or str(uuid.UUID(workflow[len(prefix):])) != workflow[len(prefix):] or str(uuid.UUID(logical_id)) != logical_id:
        raise ValueError('invalid workflow or logical session identity')
    model = live_model(os.environ.get('LIVE_MODEL_ID')) if mode == 'live' else ({'providerID': 'fixture', 'id': 'router-free'} if mode == 'fake-router' else MODEL)
    if mode == 'live':
        if model != {'providerID': 'openrouter', 'id': 'openrouter/free'} or os.environ.get('NEOMIND_LIVE_AUTHORIZED') != 'f21c6cfacd571ede17407ad839d5ada908f2ced3':
            raise ValueError('live model not authorized')
        if (ROOT / 'LIVE_PAUSED').exists() or (CODE_ROOT / 'LIVE_PAUSED').exists():
            raise ValueError('live evaluation paused')
        metadata = json.loads((ROOT / 'live-attempts' / f'{workflow}.json').read_text())
        if metadata.get('workflow') != workflow or metadata.get('model') != model:
            raise ValueError('workflow metadata mismatch')
        budget = verify_live_budget(ROOT, os.environ.get('LIVE_BUDGET_PATH'))
    else:
        subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True, stdout=subprocess.DEVNULL)
        budget = None
    runs = ROOT / 'runs'
    runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='neomind-runner-', dir=runs))
    upstream = None
    worker = None
    try:
        if mode != 'live':
            (run / 'upstream-mode').write_text('ok')
            upstream = subprocess.Popen([sys.executable, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            port = int(get_line(upstream))
            worker = Worker(run / 'worker', port, workspace=workspace, cap=10, router_test=mode == 'fake-router')
            budget = worker.db
        else:
            worker = Worker(run / 'worker', None, workspace=workspace, live_db=budget, live_model_id=os.environ['LIVE_MODEL_ID'], account_db=os.environ.get('OPENCODE_ACCOUNT_DB'))
        quota.start_workflow(str(budget), workflow, 10)
        sid = worker.session(workflow, model=model, cap=10, logical_id=logical_id)
        worker.preflight(str(CODE_ROOT / 'guard'))
        print(json.dumps({'ready': True, 'artifact': str(run), 'session': sid}), flush=True)
        for line in sys.stdin:
            command = {}
            try:
                command = json.loads(line)
                if command.get('operation') != 'turn':
                    raise ValueError('unsupported operation')
                before = worker.request('GET', f'/api/session/{sid}')['data']
                if (not session_model_matches(before.get('model'), model) or before.get('agent') != 'build' or before.get('permissions') != PERMISSIONS
                        or Path(before['location']['directory']).resolve() != workspace or before.get('parentID')
                        or before.get('metadata', {}).get('neomindSession') != logical_id or before.get('metadata', {}).get('workflow') != workflow):
                    raise ValueError('session not verified')
                worker.preflight(str(CODE_ROOT / 'guard'))
                if worker.request('GET', f'/api/experimental/session/{sid}/instructions/entries').get('data') != []:
                    raise ValueError('unexpected instruction entries')
                texts = runner_turn.execute(worker, run, workflow, logical_id, sid, model, command['id'], command['prompt'])
                print(json.dumps({'id': command['id'], 'messages': texts}), flush=True)
            except Exception as exc:
                print(json.dumps({'id': command.get('id'), 'error': type(exc).__name__}), flush=True)
                break
    finally:
        if worker:
            worker.close()
        if upstream:
            if upstream.poll() is None:
                os.killpg(upstream.pid, signal.SIGTERM)
            upstream.wait(timeout=10)


if __name__ == '__main__':
    main()
