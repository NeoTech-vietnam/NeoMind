"""Run one synthetic graph against private OpenCode 2.2.7 and a loopback fake."""
import argparse
import base64
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent.resolve()
COMMIT = 'eb786cf8efe0b6cc9e45d07362e66da6ec465424'


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def stop(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=10)
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # The leader may have exited while its owned descendants are still running.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=10)


def cleanup(*processes):
    failures = []
    for process in processes:
        try:
            stop(process)
        except Exception as error:
            failures.append(error)
    if failures:
        raise RuntimeError('failed to stop an owned fixture process') from failures[0]


def terminate(signum, frame):
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True, help='new output directory outside all checkouts')
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--opencode', default='opencode')
    args = parser.parse_args()
    if args.work.expanduser().is_symlink():
        parser.error('work must not be a symlink')
    stage, work = args.stage.resolve(strict=True), args.work.expanduser().resolve()
    for root in (REPO, stage):
        if work == root or work.is_relative_to(root) or root.is_relative_to(work):
            parser.error('work must not overlap a checkout')
    if work.exists() or not work.parent.is_dir():
        parser.error('work must be new and its parent must exist')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=stage, text=True).strip()
    if revision != COMMIT:
        parser.error('stage is not the pinned LangConfig revision')
    subprocess.run(['git', 'apply', '--reverse', '--check', str(HERE.parent/'registration.patch')], cwd=stage, check=True)
    for relative in ('backend/tools/opencode_review.py', 'backend/tools/opencode_http.py', 'backend/tools/fixture_request_guard.py'):
        if (stage/relative).read_bytes() != (HERE.parent/'overlay'/relative).read_bytes():
            parser.error(f'staged overlay mismatch: {relative}')
    if Path('/etc/opencode').exists() and any(Path('/etc/opencode').iterdir()):
        parser.error('managed OpenCode configuration present; cannot establish fixture-only config')
    for directory in (work.parent, *work.parent.parents):
        names = ('opencode.json', 'opencode.jsonc', 'AGENTS.md', '.opencode/opencode.json',
                 '.opencode/opencode.jsonc', '.opencode/plugins', '.opencode/skills',
                 '.opencode/agents', '.opencode/commands')
        if any((directory / name).exists() for name in names):
            parser.error(f'ancestor OpenCode config or plugin directory found at {directory}')
    version = subprocess.check_output([args.opencode, '--version'], text=True).strip()
    if version != 'opencode v2.2.7':
        parser.error(f'expected official OpenCode v2.2.7, got {version}')
    work.mkdir(mode=0o700)
    for name in ('home', 'config', 'data', 'cache', 'state', 'workspace', 'tmp'):
        (work / name).mkdir()
    (work / 'workspace/source.txt').write_text('Fixture source\n')
    (work / 'guard').mkdir()
    for name in ('index.js', 'package.json'):
        shutil.copyfile(HERE / 'guard' / name, work / 'guard' / name)
    trace = work / 'guard-trace.jsonl'
    trace.touch()
    password = secrets.token_urlsafe(24)
    server_port, upstream_port = port(), port()
    if server_port == upstream_port:
        raise RuntimeError('port collision; rerun with a new work directory')
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(work / 'home'),
           'XDG_CONFIG_HOME': str(work / 'config'), 'XDG_DATA_HOME': str(work / 'data'),
           'XDG_CACHE_HOME': str(work / 'cache'), 'XDG_STATE_HOME': str(work / 'state'),
           'TMPDIR': str(work / 'tmp'), 'OPENCODE_SERVER_PASSWORD': password,
           'FIXTURE_GUARD_TRACE': str(trace), 'NO_PROXY': '127.0.0.1,localhost'}
    guard = str(work / 'guard')
    config = {'model':'fixture/fake-review', 'compaction':{'auto':False}, 'update':'disable',
              'providers':{'fixture':{'name':'Fake fixture','package':'@opencode/ai/providers/openai-compatible',
                  'settings':{'baseURL':f'http://127.0.0.1:{upstream_port}/v1','apiKey':'fixture-dummy'},
                  'models':{'fake-review':{'name':'Fake Review','limit':{'context':16384,'output':2048},'variants':[{'id':'high'}]}}}},
              'policies':[{'action':'provider.use','resource':'*','effect':'deny'},
                  {'action':'provider.use','resource':'fixture','effect':'allow'},
                  *[{'action':action,'resource':'*','effect':'deny'} for action in ('mcp.use','plugin.use','skill.use')],
                  {'action':'plugin.use','resource':guard,'effect':'allow'}], 'plugins':[guard]}
    config_dir = work / 'config/opencode'
    config_dir.mkdir()
    (config_dir / 'opencode.json').write_text(json.dumps(config))
    with (work / 'npm.log').open('w') as log:
        subprocess.run(['npm','install','--ignore-scripts','--no-audit','--no-fund'], cwd=work/'guard', env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
    upstream = server = None
    previous_term = signal.signal(signal.SIGTERM, terminate)
    try:
        with (work/'upstream.log').open('w') as uplog, (work/'opencode.log').open('w') as serverlog:
            upstream = subprocess.Popen([args.python, str(HERE/'fake_upstream.py'), '--port', str(upstream_port), '--trace', str(work/'upstream-requests.jsonl')], env=env, stdout=uplog, stderr=subprocess.STDOUT, start_new_session=True)
            server = subprocess.Popen([args.opencode,'serve','--hostname','127.0.0.1','--port',str(server_port)], cwd=work/'workspace', env=env, stdout=serverlog, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 60
            opener = build_opener(ProxyHandler({}))
            auth = base64.b64encode(f'opencode:{password}'.encode()).decode()
            request = Request(f'http://127.0.0.1:{server_port}/api/plugin', headers={'Authorization': f'Basic {auth}'})
            while time.monotonic() < deadline:
                if upstream.poll() is not None or server.poll() is not None:
                    raise RuntimeError('fixture process exited before readiness')
                try:
                    with opener.open(request, timeout=1):
                        pass
                except (OSError, URLError):
                    pass
                if '"event":"setup"' in trace.read_text():
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('fixture guard did not load')
            env['PYTHONPATH'] = str(stage/'backend')
            with (work/'e2e.log').open('w') as log:
                subprocess.run([args.python,str(HERE/'e2e.py'),'--work',str(work),'--port',str(server_port)], cwd=work/'workspace', env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=150)
            events = [json.loads(line) for line in trace.read_text().splitlines()]
            requests = [json.loads(line) for line in (work/'upstream-requests.jsonl').read_text().splitlines()]
            if not requests or any(e.get('provider') != 'fixture' or e.get('model') != 'fake-review' or e.get('kind') != 'primary' for e in events if e.get('event') == 'dispatch'):
                raise RuntimeError('unexpected fake dispatch trace')
            if not any(e.get('event') == 'dispatch' for e in events):
                raise RuntimeError('no guard dispatch observed')
            print(f'Fixture graph passed; {len(requests)} fake upstream requests; artifacts: {work}')
    finally:
        try:
            cleanup(server, upstream)
        finally:
            signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    main()
