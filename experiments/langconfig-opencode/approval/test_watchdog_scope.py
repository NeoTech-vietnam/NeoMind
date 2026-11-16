"""PostgreSQL loss manually relayed to an owned Linux systemd worker fixture."""
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import unittest

import psycopg
import test_postgres as cluster


class WatchdogScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def test_session_loss_relayed_to_owned_scope(self):
        if os.name != 'posix' or not Path('/run/systemd/system').exists():
            self.fail('This fixture requires Linux user-systemd')
        script = Path(__file__).with_name('watchdog-fixture.mjs').resolve()
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR') if key in os.environ}
        process = subprocess.Popen(['node', str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=env)
        unit = None
        try:
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not start')
            event = json.loads(process.stdout.readline())
            unit = event['unit']
            self.assertEqual(event['event'], 'ready')
            self.assertRegex(unit, r'^neomind-run-[a-f0-9-]+\.scope$')
            with psycopg.connect(self.dsn, autocommit=True) as owner:
                owner.execute('SELECT pg_advisory_lock(137701)')
                pid = owner.info.backend_pid
                with psycopg.connect(self.dsn, autocommit=True) as killer:
                    self.assertTrue(killer.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
                with self.assertRaises(psycopg.Error):
                    owner.execute('SELECT 1')
            process.stdin.write('authority_lost\n')
            process.stdin.flush()
            process.stdin.close()
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not report a stop')
            stopped = json.loads(process.stdout.readline())
            self.assertEqual(stopped, {'event': 'stopped', 'activeBeforeStop': True, 'stopVerified': True})
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            if unit and re.fullmatch(r'neomind-run-[a-f0-9-]+\.scope', unit):
                # Only the scope allocated by this fixture may be stopped on failure.
                subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=30)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()

    def test_monitor_detects_session_loss_and_requests_scope_stop(self):
        script = Path(__file__).with_name('auto-watchdog-fixture.mjs').resolve()
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR') if key in os.environ}
        env.update(FIXTURE_DSN=self.dsn, FIXTURE_PYTHON=sys.executable)
        process = subprocess.Popen(['node', str(script)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=env)
        unit = None
        try:
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not start')
            event = json.loads(process.stdout.readline())
            unit = event['unit']
            self.assertEqual(event['event'], 'ready')
            self.assertRegex(unit, r'^neomind-run-[a-f0-9-]+\.scope$')
            with psycopg.connect(self.dsn, autocommit=True) as killer:
                self.assertTrue(killer.execute('SELECT pg_terminate_backend(%s)', (event['pid'],)).fetchone()[0])
            # No authority-loss message is sent by this test: the monitor must detect it.
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not report a stop')
            self.assertEqual(json.loads(process.stdout.readline()),
                             {'event': 'stopped', 'activeBeforeStop': True, 'stopVerified': True,
                              'reason': 'session_lost'})
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            if unit and re.fullmatch(r'neomind-run-[a-f0-9-]+\.scope', unit):
                subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=30)
            for stream in (process.stdout, process.stderr):
                if stream:
                    stream.close()

    def test_monitor_crash_is_not_treated_as_a_healthy_authority(self):
        script = Path(__file__).with_name('auto-watchdog-fixture.mjs').resolve()
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR') if key in os.environ}
        env.update(FIXTURE_DSN=self.dsn, FIXTURE_PYTHON=sys.executable, FIXTURE_ALLOW_MONITOR_CRASH='1')
        process = subprocess.Popen(['node', str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=env)
        unit = None
        try:
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not start')
            event = json.loads(process.stdout.readline())
            unit = event['unit']
            self.assertRegex(unit, r'^neomind-run-[a-f0-9-]+\.scope$')
            process.stdin.write('crash_monitor\n')
            process.stdin.flush()
            process.stdin.close()
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not report a stop')
            self.assertEqual(json.loads(process.stdout.readline()),
                             {'event': 'stopped', 'activeBeforeStop': True, 'stopVerified': True,
                              'reason': 'monitor_unavailable'})
            self.assertEqual(process.wait(timeout=10), 1)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            if unit and re.fullmatch(r'neomind-run-[a-f0-9-]+\.scope', unit):
                subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=30)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()

    def test_stalled_monitor_times_out_and_stops_scope(self):
        script = Path(__file__).with_name('auto-watchdog-fixture.mjs').resolve()
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR') if key in os.environ}
        env.update(FIXTURE_DSN=self.dsn, FIXTURE_PYTHON=sys.executable, FIXTURE_ALLOW_MONITOR_CRASH='1')
        process = subprocess.Popen(['node', str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=env)
        unit = None
        try:
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not start')
            event = json.loads(process.stdout.readline())
            unit = event['unit']
            self.assertRegex(unit, r'^neomind-run-[a-f0-9-]+\.scope$')
            process.stdin.write('stall_monitor\n')
            process.stdin.flush()
            process.stdin.close()
            ready, _, _ = select.select([process.stdout], [], [], 20)
            self.assertTrue(ready, 'Supervisor did not report a stop')
            self.assertEqual(json.loads(process.stdout.readline()),
                             {'event': 'stopped', 'activeBeforeStop': True, 'stopVerified': True,
                              'reason': 'heartbeat_timeout'})
            self.assertEqual(process.wait(timeout=10), 1)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            if unit and re.fullmatch(r'neomind-run-[a-f0-9-]+\.scope', unit):
                subprocess.run(['systemctl', '--user', 'stop', unit], capture_output=True, timeout=30)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream:
                    stream.close()


if __name__ == '__main__':
    unittest.main()
