import multiprocessing
import os
import unittest
import uuid

import psycopg

import langgraph_fixture as lg
import test_postgres as cluster
import unified_fixture as u


def resume_worker(dsn, thread, binding, receipt, job, point, entered, release, queue):
    def before():
        if point == 'before':
            os._exit(71)
        if point == 'hold':
            entered.set()
            if not release.wait(20):
                raise RuntimeError('Timed out')
    def after():
        if point == 'after':
            os._exit(72)
    def completed():
        if point == 'after_graph':
            os._exit(73)
    try:
        result = u.resume(dsn, thread, binding, receipt, job['id'], 'worker', job['epoch'],
                          before_effect_commit=before, after_effect=after, before_completion=completed)
        queue.put(('ok', result['result']))
    except u.Denied:
        queue.put(('denied', None))


def resume_with_lost_lock(dsn, thread, binding, receipt, job, ready, release, queue, bind_sink=False):
    def admitted(pid):
        queue.put(pid)
        ready.set()
        if not release.wait(20):
            raise RuntimeError('Test barrier timeout')
    try:
        u.resume(dsn, thread, binding, receipt, job['id'], 'worker', job['epoch'], after_admission=admitted, bind_sink=bind_sink)
    except psycopg.Error:
        queue.put('lock_session_lost')
    else:
        queue.put('unexpected_success')


def resume_with_lost_sink_transaction(dsn, thread, binding, receipt, job, entered, release, queue):
    def admitted(pid):
        queue.put(pid)
    def before_commit():
        entered.set()
        if not release.wait(20):
            raise RuntimeError('Test barrier timeout')
    try:
        u.resume(dsn, thread, binding, receipt, job['id'], 'worker', job['epoch'],
                 after_admission=admitted, before_effect_commit=before_commit, bind_sink=True)
    except psycopg.Error:
        queue.put('lock_session_lost')
    else:
        queue.put('unexpected_success')


class UnifiedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS unified_completion, unified_effect, unified_job, unified_receipt, unified_request, unified_grant, unified_policy CASCADE')
        self.thread = str(uuid.uuid4())
        checkpoint = lg.pause(self.dsn, self.thread, 'task')
        self.binding = dict(project='project', task='task', scope='write', checkpoint=checkpoint,
                            graph_hash='fixture-graph', action_hash='fixture-action', policy_version='v1')
        u.setup(self.dsn, self.binding)
        self.receipt, job_id = u.decide(self.dsn, u.TrustedPrincipal('alice'), self.binding, 'approve')
        self.job = u.claim(self.dsn, job_id, 'worker')
        self.ctx = multiprocessing.get_context('spawn')

    def resume(self, binding=None, receipt=None, job=None, owner='worker', epoch=None):
        job = self.job if job is None else job
        return u.resume(self.dsn, self.thread, self.binding if binding is None else binding,
                        self.receipt if receipt is None else receipt, job['id'], owner,
                        job['epoch'] if epoch is None else epoch)

    def count(self):
        with psycopg.connect(self.dsn) as db:
            return db.execute('SELECT count(*) FROM unified_effect').fetchone()[0]

    def worker(self, point):
        entered, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        p = self.ctx.Process(target=resume_worker, args=(self.dsn, self.thread, self.binding, self.receipt,
                                                         self.job, point, entered, release, queue))
        p.start()
        self.addCleanup(self.stop, p)
        return p, entered, release, queue

    @staticmethod
    def stop(p):
        if p.is_alive():
            p.terminate()
        p.join(10)

    def join(self, p, code=0):
        p.join(25)
        self.assertFalse(p.is_alive())
        self.assertEqual(p.exitcode, code)

    def test_decision_resume_effect_and_revoke_after(self):
        self.assertEqual(self.resume()['result'], 'approve')
        self.assertEqual(self.count(), 1)
        u.revoke(self.dsn, 'project')
        with self.assertRaises(u.Denied):
            u.effect(self.dsn, self.binding, self.receipt, self.job['id'], 'worker', self.job['epoch'])
        self.assertEqual(self.count(), 1)
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'observed_complete')

    def test_revoke_before_and_stale_bindings(self):
        for binding in (dict(self.binding, task='other'), dict(self.binding, checkpoint='stale')):
            with self.assertRaises(u.Denied):
                self.resume(binding=binding)
        for kwargs in ({'receipt': uuid.uuid4()}, {'owner': 'old'}, {'epoch': self.job['epoch'] + 1}):
            with self.assertRaises(u.Denied):
                self.resume(**kwargs)
        u.revoke(self.dsn, 'project')
        with self.assertRaises(u.Denied):
            self.resume()
        self.assertEqual(self.count(), 0)

    def test_revoke_after_admission_denies_effect_and_never_replays(self):
        u.admission(self.dsn, self.binding, self.receipt, self.job['id'], 'worker', self.job['epoch'])
        u.revoke(self.dsn, 'project')
        with self.assertRaises(u.Denied):
            u.effect(self.dsn, self.binding, self.receipt, self.job['id'], 'worker', self.job['epoch'])
        self.assertEqual(self.count(), 0)
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'unknown')
        with self.assertRaises(u.Denied):
            self.resume()

    def test_effect_retry_returns_same_fixture_receipt(self):
        u.admission(self.dsn, self.binding, self.receipt, self.job['id'], 'worker', self.job['epoch'])
        first = u.effect(self.dsn, self.binding, self.receipt, self.job['id'], 'worker', self.job['epoch'])
        second = u.effect(self.dsn, self.binding, self.receipt, self.job['id'], 'worker', self.job['epoch'])
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(self.count(), 1)

    def test_lost_advisory_session_does_not_stop_the_worker(self):
        ready, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        worker = self.ctx.Process(target=resume_with_lost_lock, args=(self.dsn, self.thread, self.binding,
                                  self.receipt, self.job, ready, release, queue))
        worker.start()
        self.addCleanup(self.stop, worker)
        self.assertTrue(ready.wait(15))
        pid = queue.get(timeout=5)
        with psycopg.connect(self.dsn, autocommit=True) as db:
            self.assertTrue(db.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
        release.set()
        self.join(worker)
        self.assertEqual(queue.get(timeout=5), 'lock_session_lost')
        # A lost DB lock is not a process-stop proof: the synthetic effect still ran.
        self.assertEqual(self.count(), 1)

    def test_database_sink_on_lost_lock_session_cannot_commit(self):
        ready, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        worker = self.ctx.Process(target=resume_with_lost_lock, args=(self.dsn, self.thread, self.binding,
                                  self.receipt, self.job, ready, release, queue, True))
        worker.start()
        self.addCleanup(self.stop, worker)
        self.assertTrue(ready.wait(15))
        pid = queue.get(timeout=5)
        with psycopg.connect(self.dsn, autocommit=True) as db:
            self.assertTrue(db.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
        release.set()
        self.join(worker)
        self.assertEqual(queue.get(timeout=5), 'lock_session_lost')
        self.assertEqual(self.count(), 0)
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'unknown')
        with self.assertRaises(u.Denied):
            self.resume()

    def test_database_sink_on_lock_session_completes(self):
        result = u.resume(self.dsn, self.thread, self.binding, self.receipt, self.job['id'],
                          'worker', self.job['epoch'], bind_sink=True)
        self.assertEqual(result['result'], 'approve')
        self.assertEqual(self.count(), 1)
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'observed_complete')

    def test_changed_checkpoint_after_completion_is_unknown(self):
        self.resume()
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'observed_complete')
        with lg.PostgresSaver.from_conn_string(self.dsn) as saver:
            lg.graph(saver).update_state(lg.config(self.thread), {'result': 'approve'}, as_node='gate')
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'unknown')

    def test_connection_loss_before_sink_commit_rolls_back(self):
        entered, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        worker = self.ctx.Process(target=resume_with_lost_sink_transaction, args=(self.dsn, self.thread,
                                  self.binding, self.receipt, self.job, entered, release, queue))
        worker.start()
        self.addCleanup(self.stop, worker)
        self.assertTrue(entered.wait(15))
        pid = queue.get(timeout=5)
        with psycopg.connect(self.dsn, autocommit=True) as db:
            self.assertTrue(db.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
        release.set()
        self.join(worker)
        self.assertEqual(queue.get(timeout=5), 'lock_session_lost')
        self.assertEqual(self.count(), 0)
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'unknown')

    def test_database_sink_rechecks_revoke_after_admission(self):
        with self.assertRaises(u.Denied):
            u.resume(self.dsn, self.thread, self.binding, self.receipt, self.job['id'],
                     'worker', self.job['epoch'], bind_sink=True,
                     after_admission=lambda _pid: u.revoke(self.dsn, 'project'))
        self.assertEqual(self.count(), 0)
        self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'unknown')

    def test_competing_resume_cooperative_lock(self):
        p, entered, release, queue = self.worker('hold')
        self.assertTrue(entered.wait(15))
        with self.assertRaises(u.Denied):
            self.resume()
        release.set()
        self.join(p)
        self.assertEqual(queue.get(timeout=5), ('ok', 'approve'))
        self.assertEqual(self.count(), 1)

    def test_crash_before_and_after_effect_are_unknown_not_replayed(self):
        for point, code, expected in (('before', 71, 0), ('after', 72, 1), ('after_graph', 73, 1)):
            with self.subTest(point=point):
                if point != 'before':
                    # Use a fresh task/thread and authority, not a retry of the uncertain run.
                    self.setUp()
                p, entered, release, queue = self.worker(point)
                self.join(p, code)
                self.assertEqual(self.count(), expected)
                self.assertEqual(u.reconcile(self.dsn, self.thread, self.binding, self.receipt), 'unknown')
                with self.assertRaises(u.Denied):
                    self.resume()
                self.assertEqual(self.count(), expected)


if __name__ == '__main__':
    unittest.main()
