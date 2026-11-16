"""Fenced PostgreSQL fixture against a private disposable cluster."""

import multiprocessing
import os
import unittest

import psycopg

import fenced_sink_fixture as sink
import postgres_prototype as app
import test_postgres as cluster


def crash_effect(dsn, job, before):
    callback = (lambda: os._exit(41)) if before else None
    sink.apply(dsn, job['id'], job['owner'], job['epoch'], 'key', b'payload', before_commit=callback)
    os._exit(42)


def concurrent_effect(dsn, job, barrier, queue):
    barrier.wait(timeout=15)
    receipt = sink.apply(dsn, job['id'], job['owner'], job['epoch'], 'key', b'payload')
    queue.put(str(receipt['id']))


class FencedSinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS fixture_effects, jobs, receipts, approvals CASCADE')
        app.initialize(self.dsn)
        sink.initialize(self.dsn)
        app.create_approval(self.dsn, 'a', 'task', 'checkpoint')
        app.decide(self.dsn, 'a', 'task', 'checkpoint', 1, 'approve', 'request')
        self.job = app.claim(self.dsn, 'old', 60)

    def effect(self, job=None, key='key', payload=b'payload'):
        job = self.job if job is None else job
        return sink.apply(self.dsn, job['id'], job['owner'], job['epoch'], key, payload)

    def count(self):
        with psycopg.connect(self.dsn) as db:
            return db.execute('SELECT count(*) FROM fixture_effects').fetchone()[0]

    def crash(self, before, expected):
        worker = multiprocessing.get_context('spawn').Process(target=crash_effect, args=(self.dsn, self.job, before))
        worker.start()
        worker.join(20)
        if worker.is_alive():
            worker.terminate()
            worker.join()
            self.fail('Effect worker timed out')
        self.assertEqual(worker.exitcode, expected)

    def test_idempotency_and_payload_conflict(self):
        first = self.effect()
        self.assertEqual(self.effect()['id'], first['id'])
        with self.assertRaises(sink.SinkConflict):
            self.effect(payload=b'different')
        self.assertEqual(self.count(), 1)

    def test_concurrent_duplicate_returns_same_receipt(self):
        ctx = multiprocessing.get_context('spawn')
        barrier, queue = ctx.Barrier(2), ctx.Queue()
        workers = [ctx.Process(target=concurrent_effect, args=(self.dsn, self.job, barrier, queue)) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
            if worker.is_alive():
                worker.terminate()
                worker.join()
                self.fail('Effect worker timed out')
            self.assertEqual(worker.exitcode, 0)
        self.assertEqual(queue.get(timeout=5), queue.get(timeout=5))
        self.assertEqual(self.count(), 1)

    def test_takeover_blocks_stale_worker_even_for_duplicate(self):
        receipt = self.effect()
        with psycopg.connect(self.dsn) as db:
            db.execute("UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = %s", (self.job['id'],))
        new_job = app.claim(self.dsn, 'new', 60)
        self.assertGreater(new_job['epoch'], self.job['epoch'])
        with self.assertRaises(sink.SinkConflict):
            self.effect()
        with self.assertRaises(sink.SinkConflict):
            self.effect(key='new-key')
        self.assertEqual(self.effect(job=new_job)['id'], receipt['id'])
        self.assertEqual(self.count(), 1)

    def test_process_crash_before_effect_commit_rolls_back(self):
        self.crash(True, 41)
        self.assertEqual(self.count(), 0)
        self.effect()
        self.assertEqual(self.count(), 1)

    def test_process_crash_after_effect_commit_retry_returns_receipt(self):
        self.crash(False, 42)
        with psycopg.connect(self.dsn) as db:
            committed = db.execute('SELECT id FROM fixture_effects').fetchone()[0]
        self.assertEqual(self.effect()['id'], committed)
        self.assertEqual(self.count(), 1)


if __name__ == '__main__':
    unittest.main()
