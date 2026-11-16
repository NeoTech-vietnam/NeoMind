"""Real PostgreSQL saver, fake graph, disposable cluster and spawned processes."""

import multiprocessing
import os
import json
import unittest
import uuid

import psycopg
from langgraph.checkpoint.postgres import PostgresSaver

import langgraph_fixture as fixture
import postgres_prototype as app
import test_postgres as cluster


def run_pause(dsn, thread, queue, die):
    value = fixture.pause(dsn, thread, 'task')
    if die:
        os._exit(31)
    queue.put(value)


def run_resume(dsn, thread, job, queue, die):
    result = fixture.resume(dsn, thread, 'task', 'a', job['id'], job['owner'], job['epoch'])
    if die:
        os._exit(32)
    queue.put(result)


def locked_resume(dsn, thread, job, entered, release, queue):
    def admitted():
        entered.set()
        if not release.wait(20):
            raise RuntimeError('Test timed out waiting to release lock')
    def action():
        with psycopg.connect(dsn) as db:
            db.execute('UPDATE fixture_counter SET count = count + 1')
    try:
        result = fixture.resume(dsn, thread, 'task', 'a', job['id'], job['owner'], job['epoch'],
                                after_admission=admitted, on_action=action)
        queue.put(('ok', result['result']))
    except fixture.Mismatch:
        queue.put(('mismatch', None))


class LangGraphPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS jobs, receipts, approvals CASCADE')
        app.initialize(self.dsn)
        self.thread = str(uuid.uuid4())
        self.ctx = multiprocessing.get_context('spawn')

    def process(self, target, *args, exitcode=0):
        worker = self.ctx.Process(target=target, args=args)
        worker.start()
        worker.join(30)
        if worker.is_alive():
            worker.terminate()
            worker.join()
            self.fail('Fixture process timed out')
        self.assertEqual(worker.exitcode, exitcode)

    def pause(self):
        queue = self.ctx.Queue()
        self.process(run_pause, self.dsn, self.thread, queue, False)
        return queue.get(timeout=5)

    def receipt_and_job(self, checkpoint, decision='approve'):
        fixture.register(self.dsn, 'a', 'task', checkpoint)
        receipt = app.decide(self.dsn, 'a', 'task', checkpoint, 1, decision, 'key')
        job = app.claim(self.dsn, 'worker', 60)
        return receipt, job

    def test_pause_process_restart_resume_and_reject(self):
        checkpoint = self.pause()
        receipt, job = self.receipt_and_job(checkpoint, 'reject')
        self.assertEqual(receipt['checkpoint'], checkpoint)
        queue = self.ctx.Queue()
        self.process(run_resume, self.dsn, self.thread, job, queue, False)
        self.assertEqual(queue.get(timeout=5)['result'], 'reject')
        self.assertTrue(app.finish(self.dsn, job['id'], 'worker', job['epoch']))

    def test_checkpoint_without_receipt_after_process_death(self):
        queue = self.ctx.Queue()
        self.process(run_pause, self.dsn, self.thread, queue, True, exitcode=31)
        with PostgresSaver.from_conn_string(self.dsn) as saver:
            snapshot = fixture.graph(saver).get_state(fixture.config(self.thread))
            checkpoint = fixture.identity(snapshot, self.thread, 'task')
        self.assertEqual(app.snapshot(self.dsn)['receipts'], [])
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'task', 'a', uuid.uuid4(), 'worker', 1)
        _, job = self.receipt_and_job(checkpoint)
        self.assertEqual(fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], 'worker', job['epoch'])['result'], 'approve')

    def test_wrong_checkpoint_and_thread_fail_closed(self):
        checkpoint = self.pause()
        _, job = self.receipt_and_job(checkpoint + 'wrong')
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], 'worker', job['epoch'])
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, str(uuid.uuid4()), 'task', 'a', job['id'], 'worker', job['epoch'])
        with PostgresSaver.from_conn_string(self.dsn) as saver:
            self.assertEqual(fixture.identity(fixture.graph(saver).get_state(fixture.config(self.thread)),
                                              self.thread, 'task'), checkpoint)

    def test_wrong_interrupt_identity_and_task_fail_closed(self):
        checkpoint = self.pause()
        invalid = json.loads(checkpoint)
        invalid['interrupt_id'] = 'stale-interrupt'
        _, job = self.receipt_and_job(json.dumps(invalid, sort_keys=True, separators=(',', ':')))
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], 'worker', job['epoch'])
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'other-task', 'a', job['id'], 'worker', job['epoch'])
        with PostgresSaver.from_conn_string(self.dsn) as saver:
            self.assertEqual(fixture.identity(fixture.graph(saver).get_state(fixture.config(self.thread)),
                                              self.thread, 'task'), checkpoint)

    def test_crash_after_resume_does_not_replay_consumed_interrupt(self):
        checkpoint = self.pause()
        _, job = self.receipt_and_job(checkpoint)
        queue = self.ctx.Queue()
        self.process(run_resume, self.dsn, self.thread, job, queue, True, exitcode=32)
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], 'worker', job['epoch'])
        with PostgresSaver.from_conn_string(self.dsn) as saver:
            snapshot = fixture.graph(saver).get_state(fixture.config(self.thread))
            self.assertEqual(snapshot.values['result'], 'approve')
            self.assertFalse(snapshot.next)
        self.assertEqual(app.snapshot(self.dsn)['jobs'][0]['status'], 'running')

    def start_holder(self, job):
        entered, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        with psycopg.connect(self.dsn) as db:
            db.execute('CREATE TABLE IF NOT EXISTS fixture_counter (count INTEGER NOT NULL)')
            db.execute('TRUNCATE fixture_counter')
            db.execute('INSERT INTO fixture_counter VALUES (0)')
        worker = self.ctx.Process(target=locked_resume,
                                  args=(self.dsn, self.thread, job, entered, release, queue))
        worker.start()
        self.addCleanup(self.stop_worker, worker)
        self.assertTrue(entered.wait(15), 'Holder failed to acquire lock')
        return worker, release, queue

    @staticmethod
    def stop_worker(worker):
        if worker.is_alive():
            worker.terminate()
        worker.join(10)

    def test_competing_processes_only_one_action(self):
        _, job = self.receipt_and_job(self.pause())
        holder, release, queue = self.start_holder(job)
        entered2, release2, queue2 = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        release2.set()
        self.process(locked_resume, self.dsn, self.thread, job, entered2, release2, queue2)
        self.assertEqual(queue2.get(timeout=5)[0], 'mismatch')
        self.assertFalse(entered2.is_set())
        release.set()
        holder.join(20)
        self.assertEqual(holder.exitcode, 0)
        self.assertEqual(queue.get(timeout=5), ('ok', 'approve'))
        with psycopg.connect(self.dsn) as db:
            self.assertEqual(db.execute('SELECT count FROM fixture_counter').fetchone()[0], 1)
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], 'worker', job['epoch'])

    def test_process_death_releases_session_lock(self):
        _, job = self.receipt_and_job(self.pause())
        holder, _, _ = self.start_holder(job)
        holder.terminate()
        holder.join(20)
        self.assertIsNotNone(holder.exitcode)
        queue = self.ctx.Queue()
        self.process(run_resume, self.dsn, self.thread, job, queue, False)
        self.assertEqual(queue.get(timeout=5)['result'], 'approve')

    def test_admission_rejects_wrong_owner_epoch_and_expired_lease(self):
        _, job = self.receipt_and_job(self.pause())
        for owner, epoch in (('wrong', job['epoch']), ('worker', job['epoch'] + 1)):
            with self.assertRaises(fixture.Mismatch):
                fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], owner, epoch)
        with psycopg.connect(self.dsn) as db:
            db.execute("UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = %s", (job['id'],))
        with self.assertRaises(fixture.Mismatch):
            fixture.resume(self.dsn, self.thread, 'task', 'a', job['id'], 'worker', job['epoch'])
        with PostgresSaver.from_conn_string(self.dsn) as saver:
            fixture.identity(fixture.graph(saver).get_state(fixture.config(self.thread)), self.thread, 'task')


if __name__ == '__main__':
    unittest.main()
