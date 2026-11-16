"""Starts only a new disposable local PostgreSQL cluster; never connects to defaults."""

import multiprocessing
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

import psycopg
import postgres_prototype as p


BIN = Path('/home/hieu-tran/.local/share/langconfig-eval-20261114/env/bin')


def compete(dsn, barrier, queue, decision, key):
    barrier.wait(timeout=15)
    try:
        result = p.decide(dsn, 'a', 'task', 'checkpoint', 1, decision, key)
        queue.put(('ok', str(result['id'])))
    except p.Conflict:
        queue.put(('conflict', None))


def die_before_commit(dsn):
    p.decide(dsn, 'a', 'task', 'checkpoint', 1, 'approve', 'key', before_commit=lambda: os._exit(23))


def die_after_commit(dsn):
    p.decide(dsn, 'a', 'task', 'checkpoint', 1, 'approve', 'key')
    os._exit(24)


def compete_claim(dsn, barrier, queue, owner):
    barrier.wait(timeout=15)
    job = p.claim(dsn, owner, 30)
    queue.put(job is not None)


class PostgreSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # A unique private socket directory makes the port namespace independent.
        cls.tmp = tempfile.TemporaryDirectory(prefix='approval-postgres-', dir='/dev/shm')
        cls.root = Path(cls.tmp.name)
        cls.data = cls.root / 'data'
        cls.socket = cls.root / 'socket'
        cls.socket.mkdir(mode=0o700)
        cls.started = False
        try:
            subprocess.run([str(BIN / 'initdb'), '-D', str(cls.data), '-A', 'trust', '-U', 'fixture',
                            '--no-instructions'], check=True, text=True, timeout=30)
            subprocess.run([str(BIN / 'pg_ctl'), '-D', str(cls.data), '-l', str(cls.root / 'server.log'),
                            '-o', f"-k {cls.socket} -p 55439 -c listen_addresses=''", '-w', 'start'],
                           check=True, capture_output=True, text=True, timeout=30)
            cls.started = True
            cls.dsn = f'host={cls.socket} port=55439 dbname=postgres user=fixture connect_timeout=5'
        except BaseException:
            # A failed pg_ctl can still have started this newly initialized cluster.
            if (cls.data / 'postmaster.pid').exists():
                subprocess.run([str(BIN / 'pg_ctl'), '-D', str(cls.data), '-m', 'immediate', '-w', 'stop'],
                               capture_output=True, text=True, timeout=30, check=True)
            cls.tmp.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        if cls.started:
            subprocess.run([str(BIN / 'pg_ctl'), '-D', str(cls.data), '-m', 'fast', '-w', 'stop'],
                           check=True, capture_output=True, text=True, timeout=30)
        cls.tmp.cleanup()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS jobs, receipts, approvals CASCADE')
        p.initialize(self.dsn)
        p.create_approval(self.dsn, 'a', 'task', 'checkpoint')

    def race(self, inputs):
        ctx = multiprocessing.get_context('spawn')
        barrier, queue = ctx.Barrier(2), ctx.Queue()
        workers = [ctx.Process(target=compete, args=(self.dsn, barrier, queue, *item)) for item in inputs]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
            if worker.is_alive():
                worker.terminate()
                worker.join()
                self.fail('Race worker timed out')
            self.assertEqual(worker.exitcode, 0)
        return [queue.get(timeout=5) for _ in workers]

    def test_multiprocess_approve_reject_race(self):
        result = self.race([('approve', 'one'), ('reject', 'two')])
        self.assertEqual(sorted(x[0] for x in result), ['conflict', 'ok'])
        state = p.snapshot(self.dsn)
        self.assertEqual((len(state['receipts']), len(state['jobs'])), (1, 1))
        self.assertEqual(state['jobs'][0]['receipt_id'], state['receipts'][0]['id'])

    def test_multiprocess_idempotency(self):
        result = self.race([('approve', 'key'), ('approve', 'key')])
        self.assertEqual(result[0], result[1])
        self.assertEqual(result[0][0], 'ok')
        self.assertEqual(len(p.snapshot(self.dsn)['jobs']), 1)
        with self.assertRaises(p.Conflict):
            p.decide(self.dsn, 'a', 'task', 'checkpoint', 1, 'reject', 'key')

    def test_stale_reject_and_job(self):
        with self.assertRaises(p.Conflict):
            p.decide(self.dsn, 'a', 'task', 'old', 1, 'approve', 'key')
        receipt = p.decide(self.dsn, 'a', 'task', 'checkpoint', 1, 'reject', 'key')
        self.assertEqual(receipt['decision'], 'reject')
        self.assertEqual(p.snapshot(self.dsn)['jobs'][0]['receipt_id'], receipt['id'])

    def test_process_death_rolls_back_atomic_outbox(self):
        ctx = multiprocessing.get_context('spawn')
        worker = ctx.Process(target=die_before_commit, args=(self.dsn,))
        worker.start()
        worker.join(20)
        self.assertFalse(worker.is_alive())
        self.assertEqual(worker.exitcode, 23)
        state = p.snapshot(self.dsn)
        self.assertEqual(state['approvals'][0]['status'], 'pending')
        self.assertEqual((state['receipts'], state['jobs']), ([], []))
        p.decide(self.dsn, 'a', 'task', 'checkpoint', 1, 'approve', 'key')
        self.assertIsNotNone(p.claim(self.dsn, 'recovery', 10))

    def test_lease_takeover_fences_old_worker(self):
        p.decide(self.dsn, 'a', 'task', 'checkpoint', 1, 'approve', 'key')
        first = p.claim(self.dsn, 'old', 0.1)
        self.assertIsNone(p.claim(self.dsn, 'new', 5))
        time.sleep(0.2)
        second = p.claim(self.dsn, 'new', 5)
        self.assertGreater(second['epoch'], first['epoch'])
        self.assertFalse(p.finish(self.dsn, first['id'], 'old', first['epoch']))
        self.assertTrue(p.finish(self.dsn, second['id'], 'new', second['epoch']))

    def test_process_death_after_commit_and_multiprocess_claim(self):
        ctx = multiprocessing.get_context('spawn')
        worker = ctx.Process(target=die_after_commit, args=(self.dsn,))
        worker.start()
        worker.join(20)
        self.assertFalse(worker.is_alive())
        self.assertEqual(worker.exitcode, 24)
        receipt = p.decide(self.dsn, 'a', 'task', 'checkpoint', 1, 'approve', 'key')
        self.assertEqual(p.snapshot(self.dsn)['jobs'][0]['receipt_id'], receipt['id'])
        barrier, queue = ctx.Barrier(2), ctx.Queue()
        workers = [ctx.Process(target=compete_claim, args=(self.dsn, barrier, queue, owner))
                   for owner in ('one', 'two')]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
            if worker.is_alive():
                worker.terminate()
                worker.join()
                self.fail('Claim worker timed out')
            self.assertEqual(worker.exitcode, 0)
        self.assertEqual(sorted(queue.get(timeout=5) for _ in workers), [False, True])


if __name__ == '__main__':
    unittest.main()
