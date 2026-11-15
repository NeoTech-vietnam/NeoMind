"""Private owned OpenCode preflight only; no prompts or credential values."""
import json
import os
import tempfile
import threading
from pathlib import Path
from fake_acceptance import ROOT, Worker, PERMISSIONS, session_model_matches
from runtime_paths import verify_live_budget

def main():
    budget = verify_live_budget(ROOT, os.environ.get('LIVE_BUDGET_PATH'))
    run = Path(tempfile.mkdtemp(prefix='router-probe-', dir=ROOT / 'runs'))
    workspace = run / 'fixture'; workspace.mkdir()
    worker = None
    succeeded = False
    try:
        worker = Worker(run / 'worker', None, workspace=workspace, live_db=budget,
                        live_model_id='openrouter/openrouter/free', account_db=os.environ.get('OPENCODE_ACCOUNT_DB'))
        integration = worker.request('GET', '/api/integration/openrouter')['data']
        usable = any(c.get('type') == 'credential' and not c.get('status') for c in integration.get('connections', []))
        if not usable:
            raise ValueError('OpenRouter account not available in this worker')
        session = worker.request('POST', '/api/session', {'title': 'Fixture review', 'agent': 'build', 'model': worker.model,
            'location': {'directory': str(workspace)}, 'permissions': PERMISSIONS, 'metadata': {'probe': 'synthetic-no-prompt'}})['data']
        if not session_model_matches(session.get('model'), worker.model):
            sid = session['id']
            worker.request('POST', f'/api/session/{sid}/model', {'model': worker.model})
            session = worker.request('GET', f'/api/session/{sid}')['data']
        if not session_model_matches(session.get('model'), worker.model) or session.get('permissions') != PERMISSIONS or session.get('location', {}).get('directory') != str(workspace):
            observed = session.get('model', {})
            raise ValueError(f'probe session after explicit model switch: {observed.get("providerID")}/{observed.get("id")} variant={observed.get("variant")!r}')
        print(json.dumps({'status': 'preflight-ok', 'accountAvailable': True, 'sessionModel': session['model'], 'catalogVariants': [], 'artifacts': str(run), 'inference': 0}), flush=True)
        succeeded = True
    except Exception as exc:
        print(json.dumps({'status': 'preflight-failed', 'error': type(exc).__name__, 'reason': str(exc)[:200], 'artifacts': str(run), 'inference': 0}), flush=True)
    finally:
        if worker: worker.close()
    print('PROBE_DONE' if succeeded else 'PROBE_FAILED', flush=True)
    threading.Event().wait(300)

if __name__ == '__main__':
    main()
