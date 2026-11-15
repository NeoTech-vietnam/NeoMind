"""Metadata-only signed-out private worker probe. Never submits a prompt."""
import base64
import json
import os
import re
import secrets
import signal
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from fake_acceptance import ROOT, OPENCODE, get_line

def main():
    if os.environ.get('FIXTURE_NETNS') != '1':
        raise RuntimeError('isolated network namespace required')
    runs = ROOT / 'runs'
    runs.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='auth-probe-', dir=runs))
    for name in ['home', 'workspace', 'config/opencode', 'data', 'cache', 'tmp', 'runtime']:
        (root / name).mkdir(parents=True)
    config = {'model': 'opencode/deepseek-v4.1-flash-free', 'update': 'disable', 'compaction': {'auto': False},
              'policies': [{'action': 'provider.use', 'resource': '*', 'effect': 'deny'}, {'action': 'provider.use', 'resource': 'opencode', 'effect': 'allow'},
                           {'action': 'mcp.use', 'resource': '*', 'effect': 'deny'}, {'action': 'plugin.use', 'resource': '*', 'effect': 'deny'}]}
    (root / 'config/opencode/opencode.json').write_text(json.dumps(config))
    password = secrets.token_hex(24)
    env = {'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'),
           'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'TMPDIR': str(root / 'tmp'),
           'OPENCODE_SERVER_USERNAME': 'opencode', 'OPENCODE_SERVER_PASSWORD': password,
           'OPENCODE_DISABLE_PROJECT_CONFIG': '1', 'OPENCODE_DISABLE_EXTERNAL_SKILLS': '1', 'PATH': '/usr/bin:/bin'}
    stderr = (root / 'worker.stderr').open('wb')
    proc = subprocess.Popen([OPENCODE, 'serve', '--hostname', '127.0.0.1', '--port', '0'], cwd=root / 'workspace', env=env,
                            stdout=subprocess.PIPE, stderr=stderr, text=True, start_new_session=True)
    try:
        match = re.search(r'http://127\.0\.0\.1:\d+', get_line(proc))
        if not match:
            raise ValueError('unexpected origin')
        auth = 'Basic ' + base64.b64encode(f'opencode:{password}'.encode()).decode()
        req = urllib.request.Request(match.group() + '/api/model', headers={'Authorization': auth})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=30) as response:
            data = json.load(response)['data']
        wanted = [m for m in data if m.get('providerID') == 'opencode' and m.get('id') == 'deepseek-v4.1-flash-free']
        result = {'private_signed_out': True, 'external_network_disabled': True, 'prompts': 0,
                  'target_present': bool(wanted), 'target_enabled': bool(wanted and wanted[0].get('enabled')),
                  'high_variant_present': bool(wanted and any(v.get('id') == 'high' for v in wanted[0].get('variants', []))),
                  'cost': wanted[0].get('cost') if wanted else None}
        (root / 'result.json').write_text(json.dumps(result))
        print(json.dumps(result))
        print('Artifacts:', root)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=10)
        stderr.close()

if __name__ == '__main__':
    main()
