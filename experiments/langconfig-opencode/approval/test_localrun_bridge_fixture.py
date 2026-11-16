"""Fixture authority and PostgresSaver to real LocalRun, with synthetic fake runners."""
import os
from pathlib import Path
import json
import re
import select
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock
import uuid

import psycopg

import langgraph_fixture as lg
import localrun_bridge_fixture as bridge
import test_postgres as cluster
import unified_fixture as authority

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'broker'))
import create_fixture
from durable_localrun_client import DurableLocalRunFixtureClient


class LocalRunBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn
        cls.temp = tempfile.TemporaryDirectory(prefix='neomind-bridge-')
        cls.source = str(create_fixture.create(Path(cls.temp.name) / 'source'))

    @classmethod
    def tearDownClass(cls):
        try:
            cls.temp.cleanup()
        finally:
            cluster.PostgreSQLTests.tearDownClass()

    def prepare(self, runner, *, writer=False, evidence=None):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS unified_completion, unified_effect, unified_job, unified_receipt, unified_request, unified_grant, unified_policy CASCADE')
        thread = str(uuid.uuid4())
        request = {'version': 1, 'taskId': 'fixture-task', 'prompt': 'synthetic fixture writer' if writer else 'synthetic fixture only',
                   'binding': {'runner': runner, 'provider': 'fixture', 'model': 'fake-write' if writer else 'fake-readonly', 'reasoning': 'high'}}
        if evidence is not None:
            request['evidence'] = evidence
        binding = dict(project='fixture', task='fixture-task', scope='write' if writer else 'read',
                       checkpoint=lg.pause(self.dsn, thread, 'fixture-task'), graph_hash='fixture-graph',
                       action_hash=authority.digest(request), policy_version='v1')
        authority.setup(self.dsn, binding)
        receipt, job_id = authority.decide(self.dsn, authority.TrustedPrincipal('alice'), binding, 'approve')
        job = authority.claim(self.dsn, job_id, 'worker')
        directory = tempfile.TemporaryDirectory(prefix='neomind-bridge-case-')
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        client = DurableLocalRunFixtureClient(runner, self.source, str(root / 'admission.sqlite'),
                                              test_counter=str(root / 'counter'), test_tmpdir=str(root))
        self.addCleanup(client.close)
        return thread, binding, receipt, job, request, client, root / 'counter'

    def call(self, values, *, request=None, binding=None, after_dispatch=None):
        thread, expected, receipt, job, original, client, _ = values
        return bridge.resume(self.dsn, thread, expected if binding is None else binding, receipt, job,
                             original if request is None else request, client, after_dispatch=after_dispatch)

    def test_authorized_checkpoint_reaches_localrun_for_each_fake_runner(self):
        for runner in ('codex', 'claude-code', 'opencode'):
            with self.subTest(runner=runner):
                values = self.prepare(runner)
                self.assertEqual(self.call(values)['status'], 'completed')
                self.assertEqual(values[-1].read_text(), 'dispatch\n')
                self.assertEqual(authority.reconcile(self.dsn, values[0], values[1], values[2]), 'observed_complete')
                self.assertEqual(self.call(values), {'status': 'unknown'})
                self.assertEqual(values[-1].read_text(), 'dispatch\n')

    def test_mismatched_request_checkpoint_and_revocation_never_dispatch(self):
        values = self.prepare('codex')
        self.assertEqual(self.call(values, request={**values[4], 'prompt': 'different'}), {'status': 'denied'})
        self.assertEqual(self.call(values, binding={**values[1], 'checkpoint': 'stale'}), {'status': 'unknown'})
        authority.revoke(self.dsn, 'fixture')
        self.assertEqual(self.call(values), {'status': 'unknown'})
        self.assertFalse(values[-1].exists())
        self.assertIsNone(values[5].host)

    def test_lost_result_after_localrun_stays_unknown_without_replay(self):
        values = self.prepare('codex')
        def lose_response():
            raise RuntimeError('simulated lost response')
        self.assertEqual(self.call(values, after_dispatch=lose_response), {'status': 'unknown'})
        self.assertEqual(values[-1].read_text(), 'dispatch\n')
        self.assertEqual(authority.reconcile(self.dsn, values[0], values[1], values[2]), 'unknown')
        self.assertEqual(self.call(values), {'status': 'unknown'})
        self.assertEqual(values[-1].read_text(), 'dispatch\n')

    def test_revoke_after_marker_before_writer_prevents_dispatch(self):
        values = self.prepare('codex', writer=True)
        thread, binding, receipt, job, request, client, counter = values
        client.execute = Mock(wraps=client.execute)
        result = bridge.resume(self.dsn, thread, binding, receipt, job, request, client,
                               before_dispatch=lambda: authority.revoke(self.dsn, 'fixture'))
        self.assertEqual(result, {'status': 'unknown'})
        client.execute.assert_not_called()
        self.assertFalse(counter.exists())
        self.assertIsNone(client.host)
        self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
        self.assertFalse(counter.exists())

    def test_checkpoint_changes_after_marker_prevent_writer_dispatch(self):
        values = self.prepare('codex', writer=True)
        thread, binding, receipt, job, request, client, counter = values
        client.execute = Mock(wraps=client.execute)
        def replace_checkpoint():
            with lg.PostgresSaver.from_conn_string(self.dsn) as saver:
                lg.graph(saver).update_state(lg.config(thread), {'task_id': 'fixture-task'}, as_node='gate')
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client,
                                       before_dispatch=replace_checkpoint), {'status': 'unknown'})
        client.execute.assert_not_called()
        self.assertFalse(counter.exists())
        self.assertIsNone(client.host)
        self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
        self.assertFalse(counter.exists())

    def test_revoke_after_validation_can_still_dispatch_read_only_fixture(self):
        values = self.prepare('codex')
        thread, binding, receipt, job, request, client, counter = values
        # The synthetic hook exposes the remaining check-to-dispatch race.
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client,
                                       after_validation=lambda: authority.revoke(self.dsn, 'fixture')), {'status': 'unknown'})
        self.assertEqual(counter.read_text(), 'dispatch\n')
        self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
        self.assertEqual(counter.read_text(), 'dispatch\n')

    def test_checkpoint_changed_in_saver_does_not_dispatch(self):
        values = self.prepare('codex')
        with lg.PostgresSaver.from_conn_string(self.dsn) as saver:
            lg.graph(saver).update_state(lg.config(values[0]), {'task_id': 'fixture-task'}, as_node='gate')
        self.assertEqual(self.call(values), {'status': 'unknown'})
        self.assertFalse(values[-1].exists())
        self.assertIsNone(values[5].host)
        self.assertEqual(authority.reconcile(self.dsn, values[0], values[1], values[2]), 'unknown')

    def test_writer_stop_unconfirmed_quarantines_and_bridge_does_not_replay(self):
        values = self.prepare('codex', writer=True)
        root = values[-1].parent
        script = Path(__file__).with_name('writer-bridge-fixture.mjs')
        class WriterClient:
            calls = 0
            result = None
            def execute(inner, request):
                self.assertEqual(request, values[4])
                inner.calls += 1
                env = {'PATH': '/usr/bin:/bin', 'HOME': '/dev/null', 'LANG': 'C.UTF-8',
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                       'GIT_TERMINAL_PROMPT': '0', 'GIT_ALLOW_PROTOCOL': 'file'}
                result = subprocess.run(['node', str(script), self.source, str(root)], env=env,
                                        capture_output=True, text=True, timeout=40, check=True)
                inner.result = json.loads(result.stdout)
                return inner.result
        writer = WriterClient()
        thread, binding, receipt, job, request = values[:5]
        def invoke():
            return bridge.resume(self.dsn, thread, binding, receipt, job, request, writer)
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job,
                                       {**request, 'prompt': 'different writer'}, writer), {'status': 'denied'})
        self.assertEqual(writer.calls, 0)
        self.assertEqual(invoke(), {'status': 'unknown'})
        self.assertTrue(writer.result['quarantined'])
        self.assertTrue(writer.result['unresolved'])
        self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')
        with sqlite3.connect(root / 'coordination.sqlite') as db:
            self.assertEqual(db.execute('SELECT quarantined FROM workspace_writer').fetchall(), [(1,)])
        self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
        self.assertEqual(invoke(), {'status': 'unknown'})
        self.assertEqual(writer.calls, 1)
        restarted = WriterClient()
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, restarted), {'status': 'unknown'})
        self.assertEqual(restarted.calls, 0)
        self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')

    def test_journal_evidence_bound_before_authority_and_rechecked_for_writer(self):
        for scenario in ('unconfirmed_stop', 'stale_baseline', 'crash', 'revoked'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix='neomind-bound-writer-') as directory:
                root = Path(directory)
                script = Path(__file__).with_name('writer-bridge-fixture.mjs')
                env = {'PATH': '/usr/bin:/bin', 'HOME': '/dev/null', 'LANG': 'C.UTF-8',
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                       'GIT_TERMINAL_PROMPT': '0', 'GIT_ALLOW_PROTOCOL': 'file'}
                process = subprocess.Popen(['node', str(script), self.source, str(root), '--bound'], env=env,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 20)[0], 'writer fixture did not become ready')
                    ready = json.loads(process.stdout.readline())
                    self.assertEqual(ready['event'], 'ready')
                    evidence = ready['evidence']
                    self.assertEqual(set(evidence), {'runId', 'attemptId', 'planHash', 'approvalHash', 'workspace',
                                                     'fence', 'baselineHash', 'journalHash'})
                    values = self.prepare('codex', writer=True, evidence=evidence)
                    thread, binding, receipt, job, request = values[:5]
                    class BoundClient:
                        calls = 0
                        result = None
                        def execute(inner, actual):
                            inner.calls += 1
                            process.stdin.write(json.dumps({'evidence': actual['evidence'], 'crashAfterDispatch': scenario == 'crash'}) + '\n')
                            process.stdin.flush()
                            self.assertTrue(select.select([process.stdout], [], [], 20)[0], 'writer fixture did not respond')
                            line = process.stdout.readline()
                            inner.result = json.loads(line) if line else {'ok': False, 'error': 'host_lost'}
                            return inner.result
                    client = BoundClient()
                    # A node-selected fence cannot change the authority-bound request.
                    altered = {**request, 'evidence': {**evidence, 'fence': evidence['fence'] + 1}}
                    self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, altered, client), {'status': 'denied'})
                    self.assertEqual(client.calls, 0)
                    if scenario == 'stale_baseline':
                        (Path(evidence['workspace']) / 'task.txt').write_text('synthetic changed baseline\n')
                    if scenario == 'revoked':
                        authority.revoke(self.dsn, 'fixture')
                    self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
                    if scenario == 'revoked':
                        self.assertEqual(client.calls, 0)
                        process.stdin.close()
                    exit_code = process.wait(timeout=10)
                    self.assertEqual(exit_code, 73 if scenario == 'crash' else 0, process.stderr.read())
                    if scenario == 'revoked':
                        self.assertFalse((root / 'dispatch-count').exists())
                    elif scenario == 'stale_baseline':
                        self.assertEqual(client.result, {'ok': False, 'error': 'binding_changed'})
                        self.assertFalse((root / 'dispatch-count').exists())
                    elif scenario == 'crash':
                        self.assertEqual(client.result, {'ok': False, 'error': 'host_lost'})
                        self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')
                        events = [json.loads(line) for line in (root / 'events').read_text().splitlines()]
                        kinds = [e['type'] for e in events if e['payload'].get('attemptId') == 'write-attempt']
                        self.assertIn('dispatch_intent', kinds)
                        self.assertIn('workspace_dispatch_bound', kinds)
                        self.assertIn('worker_scope_bound', kinds)
                        self.assertNotIn('attempt_finished', kinds)
                        # A dead host cannot itself set quarantine; recovery must retain the lease and reconcile.
                        with sqlite3.connect(root / 'coordination.sqlite') as db:
                            self.assertEqual(db.execute('SELECT quarantined FROM workspace_writer').fetchall(), [(0,)])
                    else:
                        self.assertTrue(client.result['quarantined'])
                        self.assertTrue(client.result['unresolved'])
                        self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')
                        with sqlite3.connect(root / 'coordination.sqlite') as db:
                            self.assertEqual(db.execute('SELECT quarantined FROM workspace_writer').fetchall(), [(1,)])
                    self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
                    self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
                    self.assertEqual(client.calls, 0 if scenario == 'revoked' else 1)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream:
                            stream.close()

    def test_authority_localrun_crash_with_live_systemd_worker(self):
        if sys.platform != 'linux':
            self.skipTest('Fixture requires Linux user-systemd')
        values = self.prepare('codex', writer=True)
        thread, binding, receipt, job, request = values[:5]
        root = values[-1].parent
        script = Path(__file__).with_name('localrun-crash-fixture.mjs')
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS') if key in os.environ}
        env.update(LANG='C.UTF-8', TMPDIR=str(root), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_TERMINAL_PROMPT='0', GIT_ALLOW_PROTOCOL='file')
        node = '/usr/bin/node'
        class CrashClient:
            calls = 0
            exit_code = None
            stderr = ''
            def execute(inner, _request):
                inner.calls += 1
                crash = subprocess.run([node, str(script), 'scope-crash', self.source, str(root)],
                                       env=env, capture_output=True, text=True, timeout=45)
                inner.exit_code, inner.stderr = crash.returncode, crash.stderr
                return {'ok': False, 'error': 'host_lost'}
        client = CrashClient()
        scope_file = root / 'scope.json'
        try:
            self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
            self.assertEqual(client.exit_code, 73, client.stderr)
            identity = json.loads(scope_file.read_text())
            self.assertRegex(identity['unit'], r'^neomind-run-[a-f0-9-]+\.scope$')
            def active_state():
                result = subprocess.run(['systemctl', '--user', 'show', identity['unit'], '--property=ActiveState,ControlGroup'],
                                        env=env, capture_output=True, text=True, timeout=10, check=True)
                return dict(line.split('=', 1) for line in result.stdout.splitlines())
            self.assertEqual(active_state(), {'ActiveState': 'active', 'ControlGroup': identity['controlGroup']})
            blocked_env = {**env, 'PATH': '/nonexistent'}
            blocked = subprocess.run([node, str(script), 'recover', self.source, str(root)], env=blocked_env,
                                     capture_output=True, text=True, timeout=30)
            self.assertEqual(blocked.returncode, 0, blocked.stderr)
            report = json.loads(blocked.stdout)
            self.assertEqual(report['phase'], 'blocked')
            self.assertEqual(report['unresolved'], 1)
            self.assertTrue(report['leaseRetained'])
            self.assertEqual(active_state()['ActiveState'], 'active')
            self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
            self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
            self.assertEqual(client.calls, 1)
            self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')
            recovered = subprocess.run([node, str(script), 'recover-stopped', self.source, str(root)], env=env,
                                       capture_output=True, text=True, timeout=45)
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            self.assertEqual(json.loads(recovered.stdout)['phase'], 'recovering')
            self.assertEqual(active_state()['ActiveState'], 'inactive')
            self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
            self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
            self.assertEqual(client.calls, 1)
            self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')
        finally:
            if scope_file.exists():
                identity = json.loads(scope_file.read_text())
                if re.fullmatch(r'neomind-run-[a-f0-9-]+\.scope', identity.get('unit', '')):
                    subprocess.run(['systemctl', '--user', 'stop', identity['unit']], env=env, capture_output=True, timeout=30)

    def test_watchdog_revoke_while_localrun_writer_is_active(self):
        if sys.platform != 'linux':
            self.skipTest('Fixture requires Linux user-systemd')
        values = self.prepare('codex', writer=True)
        thread, binding, receipt, job, request = values[:5]
        root = values[-1].parent
        host_script = Path(__file__).with_name('localrun-crash-fixture.mjs')
        watchdog_script = Path(__file__).with_name('revoke-watchdog-fixture.mjs')
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS') if key in os.environ}
        env.update(LANG='C.UTF-8', TMPDIR=str(root), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_TERMINAL_PROMPT='0', GIT_ALLOW_PROTOCOL='file', FIXTURE_DSN=self.dsn, FIXTURE_PYTHON=sys.executable)
        node = '/usr/bin/node'
        scope_file = root / 'scope.json'
        class WatchdogClient:
            calls = 0
            failure = None
            def execute(inner, _request):
                inner.calls += 1
                host = None
                watchers = []
                try:
                    host = subprocess.Popen([node, str(host_script), 'scope-hold', self.source, str(root)], env=env,
                                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    self.assertTrue(select.select([host.stdout], [], [], 20)[0], 'writer did not become active')
                    self.assertEqual(json.loads(host.stdout.readline()), {'event': 'writer_active'})
                    identity = json.loads(scope_file.read_text())
                    self.assertRegex(identity['unit'], r'^neomind-run-[a-f0-9-]+\.scope$')
                    def state():
                        p = subprocess.run(['systemctl', '--user', 'show', identity['unit'], '--property=ActiveState,ControlGroup'],
                                           env=env, capture_output=True, text=True, timeout=10, check=True)
                        return dict(line.split('=', 1) for line in p.stdout.splitlines())
                    self.assertEqual(state(), {'ActiveState': 'active', 'ControlGroup': identity['controlGroup']})
                    def start_watchdog(path):
                        watcher = subprocess.Popen([node, str(watchdog_script), str(scope_file)], env={**env, 'PATH': path},
                                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                        watchers.append(watcher)
                        self.assertTrue(select.select([watcher.stdout], [], [], 20)[0], 'watchdog did not start')
                        self.assertEqual(json.loads(watcher.stdout.readline()), {'event': 'ready'})
                        return watcher
                    blocked = start_watchdog('/nonexistent')
                    authority.revoke(self.dsn, 'fixture')
                    self.assertTrue(select.select([blocked.stdout], [], [], 20)[0], 'watchdog did not detect revoke')
                    self.assertEqual(json.loads(blocked.stdout.readline()), {'event': 'stopped', 'reason': 'revoked', 'stopVerified': False})
                    self.assertEqual(blocked.wait(timeout=10), 1)
                    self.assertEqual(state()['ActiveState'], 'active')
                    inspection = subprocess.run([node, str(host_script), 'inspect-held', self.source, str(root)],
                                                env=env, capture_output=True, text=True, timeout=20)
                    self.assertEqual(inspection.returncode, 0, inspection.stderr)
                    self.assertEqual(json.loads(inspection.stdout), {'leaseRetained': True})
                    host.kill()
                    host.wait(timeout=10)
                    recovery = subprocess.run([node, str(host_script), 'recover', self.source, str(root)],
                                              env={**env, 'PATH': '/nonexistent'}, capture_output=True, text=True, timeout=30)
                    self.assertEqual(recovery.returncode, 0, recovery.stderr)
                    self.assertEqual(json.loads(recovery.stdout)['phase'], 'blocked')
                    self.assertEqual(state()['ActiveState'], 'active')
                    stopped = start_watchdog(env['PATH'])
                    self.assertTrue(select.select([stopped.stdout], [], [], 20)[0], 'watchdog did not report stop')
                    self.assertEqual(json.loads(stopped.stdout.readline()), {'event': 'stopped', 'reason': 'revoked', 'stopVerified': True})
                    self.assertEqual(stopped.wait(timeout=10), 0)
                    self.assertEqual(state()['ActiveState'], 'inactive')
                    recovery = subprocess.run([node, str(host_script), 'recover-stopped', self.source, str(root)],
                                              env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(recovery.returncode, 0, recovery.stderr)
                    self.assertEqual(json.loads(recovery.stdout)['phase'], 'recovering')
                except Exception as error:
                    inner.failure = error
                finally:
                    if host:
                        if host.poll() is None:
                            host.kill()
                            host.wait(timeout=10)
                        host.stdout.close()
                        host.stderr.close()
                    for watcher in watchers:
                        if watcher.poll() is None:
                            watcher.terminate()
                            watcher.wait(timeout=10)
                        watcher.stdout.close()
                        watcher.stderr.close()
                    if scope_file.exists():
                        identity = json.loads(scope_file.read_text())
                        if re.fullmatch(r'neomind-run-[a-f0-9-]+\.scope', identity.get('unit', '')):
                            subprocess.run(['systemctl', '--user', 'stop', identity['unit']], env=env, capture_output=True, timeout=30)
                return {'ok': False, 'error': 'revoked'}
        client = WatchdogClient()
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
        if client.failure:
            raise client.failure
        self.assertEqual(authority.reconcile(self.dsn, thread, binding, receipt), 'unknown')
        self.assertEqual(bridge.resume(self.dsn, thread, binding, receipt, job, request, client), {'status': 'unknown'})
        self.assertEqual(client.calls, 1)
        self.assertEqual((root / 'dispatch-count').read_text(), 'dispatch\n')


if __name__ == '__main__':
    unittest.main()
