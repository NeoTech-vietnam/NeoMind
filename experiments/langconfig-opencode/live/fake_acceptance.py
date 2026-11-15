"""OpenCode 2.2.7 fake-only acceptance; run through run-fake.sh."""
import base64
import json
import os
import re
import secrets
import select
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from pathlib import Path

import quota
from runtime_paths import require_data_root, verify_live_budget
from live_models import live_model

CODE_ROOT = Path(__file__).resolve().parent
ROOT = require_data_root()
PYTHON = sys.executable
OPENCODE = os.environ.get('OPENCODE_BIN') or shutil.which('opencode')
MODEL = {'providerID': 'fixture', 'id': 'fake-review', 'variant': 'high'}
LIVE_MODEL = {'providerID': 'opencode', 'id': 'deepseek-v4.1-flash-free', 'variant': 'high'}
PERMISSIONS = [{'action': '*', 'resource': '*', 'effect': 'deny'}]


def require(value, message):
    if not value:
        raise AssertionError(message)


def session_model_matches(actual, expected):
    if expected in ({'providerID': 'openrouter', 'id': 'openrouter/free'}, {'providerID': 'fixture', 'id': 'router-free'}):
        return actual in (expected, {**expected, 'variant': 'default'})
    return actual == expected


def get_line(proc, timeout=30):
    ready, _, _ = select.select([proc.stdout], [], [], timeout)
    if not ready:
        raise RuntimeError('owned process startup timed out')
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError('owned process exited during startup')
    return line.strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('redirect denied')


class Worker:
    def __init__(self, root, fake_port, retry=False, cap=20, workspace=None, guard=True, live_db=None, websocket=False, live_model_id=None, account_db=None, router_test=False):
        self.root = root
        require(OPENCODE is not None and Path(OPENCODE).is_absolute(), 'absolute OPENCODE_BIN required')
        self.live = live_db is not None
        self.model = live_model(live_model_id) if self.live else ({'providerID': 'fixture', 'id': 'router-free'} if router_test else MODEL)
        require(not router_test or not self.live, 'router fake cannot use live budget')
        router = self.live and self.model['providerID'] == 'openrouter'
        if router:
            require(account_db is not None and Path(account_db).is_absolute() and Path(account_db).resolve(strict=True).is_file(), 'official account database required')
        else:
            require(account_db is None, 'unexpected account database')
        require(self.live or live_model_id is None, 'fake worker cannot select a live model')
        require(not self.live or (guard and not retry and fake_port is None), 'invalid live configuration')
        for name in ['home', 'config/opencode', 'data', 'cache', 'workspace', 'tmp', 'runtime']:
            (root / name).mkdir(parents=True)
        self.workspace = Path(workspace).resolve(strict=True) if workspace else root / 'workspace'
        require(self.workspace.is_relative_to(ROOT), 'workspace must be inside fixture root')
        self.db = Path(live_db) if self.live else root / 'quota.sqlite'
        if not self.live:
            quota.initialize(str(self.db), cap, workflow_limit=40)
        else:
            verify_live_budget(ROOT, str(self.db))
        self.trace = root / 'trace.jsonl'
        self.password = secrets.token_hex(24)
        plugin = str(CODE_ROOT / 'guard')
        options = {'mode': 'live' if self.live else ('fake-router' if router_test else 'fake'), 'database': str(self.db), 'helper': str(CODE_ROOT / 'quota.py'), 'python': PYTHON,
                   'trace': str(self.trace), 'origin': ('https://openrouter.ai' if router else 'https://opencode.ai') if self.live else f'http://127.0.0.1:{fake_port}', 'home': str(root / 'home'),
                   'tmp': str(root / 'tmp'), 'testRetry': retry, 'providerID': self.model['providerID'], 'modelID': self.model['id']}
        config = {'model': 'fixture/fake-review', 'compaction': {'auto': False}, 'warming': False, 'update': 'disable',
                  'plugins': [{'package': plugin, 'options': options}] if guard else [],
                  'providers': {'fixture': {'name': 'Fake fixture', 'package': '@opencode/ai/providers/openai-compatible',
                    'settings': {'baseURL': f'http://127.0.0.1:{fake_port}/v1', 'apiKey': 'synthetic-dummy', 'cache': {'warming': False}},
                    'models': {'fake-review': {'name': 'Fake Review', 'limit': {'context': 16384, 'output': 2048}, 'variants': [{'id': 'high'}]}}}},
                  'policies': [{'action': 'provider.use', 'resource': '*', 'effect': 'deny'},
                    {'action': 'provider.use', 'resource': 'fixture', 'effect': 'allow'},
                    {'action': 'mcp.use', 'resource': '*', 'effect': 'deny'},
                    {'action': 'plugin.use', 'resource': '*', 'effect': 'deny'},
                    {'action': 'plugin.use', 'resource': plugin, 'effect': 'allow'},
                    {'action': 'skill.use', 'resource': '*', 'effect': 'deny'}]}
        if self.live:
            config['model'] = self.model['providerID'] + '/' + self.model['id']
            config['providers'] = {self.model['providerID']: {'settings': {'transport': 'http', 'cache': {'warming': False}}}}
            if router:
                config['providers']['openrouter']['body'] = {'provider': {'max_price': {'prompt': 0, 'completion': 0}, 'allow_fallbacks': False}}
            config['policies'][1]['resource'] = self.model['providerID']
        elif router_test:
            config['model'] = 'fixture/router-free'
            config['providers']['fixture']['package'] = '@opencode/ai/providers/openrouter'
            config['providers']['fixture']['models'] = {'router-free': {'modelID': 'openrouter/free', 'name': 'Synthetic Router', 'limit': {'context': 16384, 'output': 2048}, 'variants': []}}
            config['providers']['fixture']['body'] = {'provider': {'max_price': {'prompt': 0, 'completion': 0}, 'allow_fallbacks': False}}
        elif websocket:
            config['providers']['fixture']['settings']['transport'] = 'websocket'
        (root / 'config/opencode/opencode.json').write_text(json.dumps(config))
        if workspace is None:
            (self.workspace / 'source.txt').write_text('Synthetic product Alder; retention 30 days.\n')
        env = {'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'),
               'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'TMPDIR': str(root / 'tmp'),
               'OPENCODE_SERVER_USERNAME': 'opencode', 'OPENCODE_SERVER_PASSWORD': self.password,
               'OPENCODE_DISABLE_PROJECT_CONFIG': '1', 'OPENCODE_DISABLE_EXTERNAL_SKILLS': '1',
               'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
        if router:
            env['OPENCODE_DB'] = str(Path(account_db).resolve(strict=True))
        self.stderr = (root / 'worker.stderr').open('wb')
        self.proc = subprocess.Popen([OPENCODE, 'serve', '--hostname', '127.0.0.1', '--port', '0'], cwd=self.workspace, env=env,
                                     stdout=subprocess.PIPE, stderr=self.stderr, text=True, start_new_session=True)
        try:
            line = get_line(self.proc)
            match = re.search(r'http://127\.0\.0\.1:\d+', line)
            require(match, 'unexpected server origin')
            self.origin = match.group()
            self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            self.auth = 'Basic ' + base64.b64encode(f'opencode:{self.password}'.encode()).decode()
            self.preflight(plugin)
        except BaseException:
            self.close()
            raise

    def request(self, method, path, payload=None, timeout=30):
        require(path.startswith('/api/') and not path.startswith('//'), 'invalid path')
        headers = {'Authorization': self.auth}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.origin + path, data=data, headers=headers, method=method)
        with self.opener.open(req, timeout=timeout) as response:
            raw = response.read(2_000_001)
            require(len(raw) <= 2_000_000, 'oversized response')
            return json.loads(raw) if raw else None

    def preflight(self, plugin):
        info = self.request('GET', '/api/info')
        require(info['version'] == '2.2.7' and info['pid'] > 0, 'unsupported server')
        config = self.request('GET', '/api/config')
        (self.root / 'config-sources.json').write_text(json.dumps(config))
        allowed = {str(self.root / 'config/opencode/opencode.json'), str(self.root / 'config/opencode')}
        require(all(e.get('path') in allowed for e in config), 'unexpected config source')
        models = self.request('GET', '/api/model')['data']
        plugins = self.request('GET', '/api/plugin')['data']
        external = [p for p in plugins if p.get('source', {}).get('type') != 'builtin']
        (self.root / 'external-plugins.json').write_text(json.dumps(external))
        require(len(external) == 1 and external[0]['id'] == 'fixture-live-guard' and external[0]['source']['path'] == plugin and external[0]['state']['status'] == 'active', 'guard missing')
        require(not self.request('GET', '/api/mcp')['data'], 'MCP not empty')
        enabled = [m for m in models if m['enabled']]
        (self.root / 'model-summary.json').write_text(json.dumps([{'providerID': m.get('providerID'), 'id': m.get('id'), 'variants': [v.get('id') for v in m.get('variants', [])]} for m in enabled]))
        require(len(enabled) == 1 and (enabled[0]['providerID'], enabled[0]['id']) == (self.model['providerID'], self.model['id']), 'model isolation failed')
        if self.model == {'providerID': 'fixture', 'id': 'router-free'}:
            require(not enabled[0].get('variants'), 'fake router unexpectedly has variants')
        if self.live:
            if self.model['providerID'] == 'openrouter':
                require(not enabled[0].get('variants'), 'router unexpectedly has variants')
            else:
                require(any(v.get('id') == 'high' for v in enabled[0].get('variants', [])), 'high variant unavailable')
            costs = enabled[0].get('cost')
            require(isinstance(costs, list) and len(costs) > 0 and all(c.get('input') == 0 and c.get('output') == 0 and c.get('cache', {}).get('read') == 0 and c.get('cache', {}).get('write') == 0 for c in costs), 'target cost not confirmed free')
        require(self.trace.exists() and '"ready"' in self.trace.read_text(), 'guard not ready')
        (self.root / 'preflight-summary.json').write_text(json.dumps({'version': info['version'], 'config_sources': [e.get('path') for e in config], 'builtin_count': len(plugins)-1, 'external_plugin': external[0]['id'], 'mcp_count': 0, 'enabled_models': [self.model['providerID'] + '/' + self.model['id']]}))

    def session(self, workflow, model=None, cap=20, title='Fixture review', logical_id=None):
        model = model or self.model
        if self.live:
            require(model == self.model and 1 <= cap <= 10, 'invalid live session')
        metadata = {'workflow': workflow}
        if logical_id is not None:
            metadata['neomindSession'] = logical_id
        body = {'agent': 'build', 'model': model, 'location': {'directory': str(self.workspace)}, 'permissions': PERMISSIONS, 'metadata': metadata}
        if title is not None:
            body['title'] = title
        created = self.request('POST', '/api/session', body)['data']
        require(session_model_matches(created.get('model'), model) and created.get('permissions') == PERMISSIONS and created.get('location', {}).get('directory') == str(self.workspace), f'session mismatch: model={created.get("model")}')
        sid = created['id']
        quota.bind(str(self.db), sid, workflow, cap)
        entries = self.request('GET', f'/api/experimental/session/{sid}/instructions/entries')
        require(entries.get('data') == [], 'session instructions not empty')
        return sid

    def prompt(self, sid, msgid):
        return self.request('POST', f'/api/session/{sid}/prompt', {'id': msgid, 'text': 'Review synthetic input: Alder retention 30 days. Return JSON only.'})

    def drop_prompt_response(self, sid, msgid):
        payload = json.dumps({'id': msgid, 'text': 'Review synthetic input; return JSON.'}).encode()
        parsed = urllib.parse.urlsplit(self.origin)
        with socket.create_connection(('127.0.0.1', parsed.port), timeout=5) as sock:
            headers = (f'POST /api/session/{sid}/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {self.auth}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n').encode()
            sock.sendall(headers + payload)

    def wait(self, sid):
        self.request('POST', f'/api/experimental/session/{sid}/wait', {}, timeout=45)
        return self.request('GET', f'/api/session/{sid}')['data']

    def timeline(self, sid):
        result, seen, query = [], set(), '?order=asc'
        for _ in range(100):
            page = self.request('GET', f'/api/session/{sid}/message{query}')
            result.extend(page['data'])
            cursor = page['cursor'].get('next')
            if not cursor:
                return result
            require(cursor not in seen and len(result) <= 10000, 'timeline ambiguous')
            seen.add(cursor)
            query = '?cursor=' + urllib.parse.quote(cursor, safe='')
        raise RuntimeError('timeline overflow')

    def reservations(self):
        with closing(quota.connect(str(self.db))) as db:
            return db.execute('SELECT count(*) FROM reservations').fetchone()[0]

    def close(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=10)
        self.stderr.close()


def main():
    # A private network namespace must be provided by run-fake.sh.
    require(os.environ.get('FIXTURE_NETNS') == '1', 'must run in fixture network namespace')
    runs = ROOT / 'runs'
    runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='fake-', dir=runs))
    (run / 'upstream-mode').write_text('ok')
    upstream = subprocess.Popen([PYTHON, str(CODE_ROOT / 'fake_upstream.py'), str(run)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    worker = None
    try:
        port = int(get_line(upstream))
        worker = Worker(run / 'normal', port)
        sid = worker.session('success')
        msgid = 'msg_' + secrets.token_hex(12)
        receipt = worker.prompt(sid, msgid)['data']
        require(receipt['id'] == msgid, 'wrong receipt')
        require(worker.wait(sid).get('outcome') == 'succeeded', 'success session failed')
        messages = worker.timeline(sid)
        require(sum(m.get('id') == msgid for m in messages) == 1, 'prompt count mismatch')
        reply = [m for m in messages if m.get('type') == 'assistant'][-1]
        require(reply.get('model') == MODEL and reply.get('finish') == 'stop', 'reply identity mismatch')
        require(json.loads(next(p['text'] for p in reply['content'] if p['type'] == 'text'))['verdict'] == 'needs_changes', 'fake JSON mismatch')
        require(worker.reservations() == 1, 'wrong quota')
        print('PASS primary success, exact variant, one durable reservation', flush=True)
        title_before = worker.reservations()
        title_posts = len((run / 'upstream.jsonl').read_text().splitlines())
        untitled = worker.session('title', title=None)
        worker.prompt(untitled, 'msg_' + secrets.token_hex(12))
        worker.wait(untitled)
        require('"event":"title"' in worker.trace.read_text().replace(' ', ''), 'title hook was not triggered')
        require(worker.reservations() == title_before + 1 and len((run / 'upstream.jsonl').read_text().splitlines()) == title_posts + 1, 'title caused an extra physical request')
        print('PASS forced title uses static hook result', flush=True)
        before = worker.reservations()
        worker.request('POST', f'/api/session/{sid}/compact', {})
        worker.wait(sid)
        require(worker.reservations() == before and '"compaction"' in worker.trace.read_text(), 'compaction generated a request')
        print('PASS manual compaction short-circuit', flush=True)
        try:
            worker.request('POST', f'/api/session/{sid}/generate', {'prompt': 'Synthetic transient generation'})
        except urllib.error.HTTPError:
            pass
        require(worker.reservations() == before, 'generate bypassed primary-only guard')
        print('PASS transient generate did not reserve primary', flush=True)
        # Persist the prompt intent before closing the connection without reading its receipt.
        sid2 = worker.session('disconnect')
        msg2 = 'msg_' + secrets.token_hex(12)
        journal = sqlite3.connect(run / 'attempt.sqlite')
        journal.execute('CREATE TABLE intents(session TEXT NOT NULL, message TEXT PRIMARY KEY)')
        journal.execute('INSERT INTO intents VALUES(?,?)', (sid2, msg2))
        journal.commit()
        journal.close()
        worker.drop_prompt_response(sid2, msg2)
        found = []
        for _ in range(100):
            found = [m for m in worker.timeline(sid2) if m.get('id') == msg2]
            if found:
                break
            time.sleep(0.05)
        require(len(found) == 1, 'dropped receipt could not be reconciled')
        require(worker.wait(sid2).get('outcome') == 'succeeded', 'reconciled prompt failed')
        require(sum(m.get('id') == msg2 for m in worker.timeline(sid2)) == 1, 'duplicate prompt')
        print('PASS real HTTP disconnect after send: durable id reconciled with no resubmit', flush=True)
        # Missing and wrong variants are denied even if OpenCode accepts the session.
        before_posts = len((run / 'upstream.jsonl').read_text().splitlines())
        for name, variant, provider, model_id in [('missing', None, 'fixture', 'fake-review'), ('wrong', 'low', 'fixture', 'fake-review'), ('wrong-provider', 'high', 'opencode', 'fake-review'), ('wrong-model', 'high', 'fixture', 'not-fake')]:
            model = {'providerID': provider, 'id': model_id}
            if variant:
                model['variant'] = variant
            try:
                other = worker.session(name, model=model)
                worker.prompt(other, 'msg_' + secrets.token_hex(12))
                worker.wait(other)
            except (urllib.error.HTTPError, AssertionError):
                pass
        require(len((run / 'upstream.jsonl').read_text().splitlines()) == before_posts, 'wrong variant reached upstream')
        print('PASS wrong provider, model, missing and wrong variant did not reach upstream', flush=True)
        sid3 = worker.session('capped', cap=1)
        worker.prompt(sid3, 'msg_' + secrets.token_hex(12))
        worker.wait(sid3)
        before_posts = len((run / 'upstream.jsonl').read_text().splitlines())
        worker.prompt(sid3, 'msg_' + secrets.token_hex(12))
        worker.wait(sid3)
        require(len((run / 'upstream.jsonl').read_text().splitlines()) == before_posts, 'workflow cap bypassed')
        print('PASS workflow quota denied before upstream', flush=True)
        sid4 = worker.session('database-failure')
        before_posts = len((run / 'upstream.jsonl').read_text().splitlines())
        worker.db.rename(worker.root / 'quota.offline')
        try:
            worker.prompt(sid4, 'msg_' + secrets.token_hex(12))
            worker.wait(sid4)
        finally:
            (worker.root / 'quota.offline').rename(worker.db)
        require(len((run / 'upstream.jsonl').read_text().splitlines()) == before_posts, 'missing quota database allowed upstream')
        print('PASS missing quota database denied before upstream', flush=True)
        (run / 'upstream-mode').write_text('slow')
        sid5 = worker.session('interrupt')
        before_posts = len((run / 'upstream.jsonl').read_text().splitlines())
        worker.prompt(sid5, 'msg_' + secrets.token_hex(12))
        for _ in range(100):
            if len((run / 'upstream.jsonl').read_text().splitlines()) > before_posts:
                break
            time.sleep(0.05)
        require(len((run / 'upstream.jsonl').read_text().splitlines()) > before_posts, 'slow upstream was not reached')
        interrupted = worker.request('POST', f'/api/session/{sid5}/interrupt?resume=false', {})
        interrupted_session = worker.wait(sid5)
        require(interrupted.get('interrupted') is True, 'active execution not interrupted')
        require(interrupted_session.get('outcome') != 'succeeded', 'interrupted session reported success')
        print('PASS active slow fake request interrupted; session idle', flush=True)
        worker.close()
        worker = None
        (run / 'upstream-mode').write_text('429')
        worker = Worker(run / 'veto', port)
        sid = worker.session('veto')
        before = len((run / 'upstream.jsonl').read_text().splitlines())
        worker.prompt(sid, 'msg_' + secrets.token_hex(12))
        worker.wait(sid)
        count = len((run / 'upstream.jsonl').read_text().splitlines()) - before
        require(count == 1 and worker.reservations() == 1 and '"allowed":false' in worker.trace.read_text().replace(' ', ''), 'retry veto failed')
        print('PASS retry veto: one 429 physical POST', flush=True)
        worker.close()
        worker = None
        worker = Worker(run / 'retry', port, retry=True)
        sid = worker.session('retry')
        before = len((run / 'upstream.jsonl').read_text().splitlines())
        worker.prompt(sid, 'msg_' + secrets.token_hex(12))
        worker.wait(sid)
        count = len((run / 'upstream.jsonl').read_text().splitlines()) - before
        reservations = worker.reservations()
        retry_trace = worker.trace.read_text()
        print(f'RETRY physical_posts={count} reservations={reservations} retry_hook={"retry" in retry_trace}', flush=True)
        require(count == 2 and reservations == count, 'retry bypassed reservation or did not retry')
        print('PASS allowed retry accounted per physical request', flush=True)
        worker.close()
        worker = None
        (run / 'upstream-mode').write_text('ok')
        worker = Worker(run / 'ws-attempt', port, websocket=True)
        sid = worker.session('ws-attempt')
        before = len((run / 'upstream.jsonl').read_text().splitlines())
        worker.prompt(sid, 'msg_' + secrets.token_hex(12))
        worker.wait(sid)
        posts = len((run / 'upstream.jsonl').read_text().splitlines()) - before
        trace = worker.trace.read_text()
        if '"websocket-deny"' in trace:
            require(posts == 0 and worker.reservations() == 0, 'websocket denial leaked to upstream')
            print('PASS forced WebSocket was denied before network', flush=True)
        else:
            require(posts == 1 and worker.reservations() == 1, 'unsupported websocket fallback was not accounted')
            print('OBSERVED forced WebSocket fell back to guarded HTTP; websocket deny hook not exercised', flush=True)
        worker.close()
        worker = None
        try:
            Worker(run / 'missing-guard', port, guard=False)
        except (AssertionError, KeyError):
            print('PASS missing guard prevents admission before prompt', flush=True)
        else:
            raise AssertionError('missing guard worker was accepted')
    finally:
        if worker:
            worker.close()
        if upstream.poll() is None:
            os.killpg(upstream.pid, signal.SIGTERM)
        upstream.wait(timeout=10)
        print('Artifacts:', run, flush=True)


if __name__ == '__main__':
    main()
