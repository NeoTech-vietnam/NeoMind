import multiprocessing
import os
import subprocess
import unittest

import psycopg

import test_postgres as cluster
import transactional_authority_fixture as fixture


def effect_worker(dsn, binding, entered, release, queue, crash):
    def locked():
        entered.set()
        if not release.wait(20):
            raise RuntimeError('Test barrier timeout')
    def die():
        os._exit(51)
    try:
        result = fixture.effect(dsn, fixture.TrustedPrincipal('alice'), binding, 'job', 'worker', 1,
                                'key', {'value': 1}, after_lock=locked,
                                before_commit=die if crash else None)
        queue.put(('ok', str(result['id'])))
    except fixture.Denied:
        queue.put(('denied', None))


def revoke_worker(dsn, entered, queue):
    entered.set()
    fixture.revoke(dsn, 'project')
    queue.put('revoked')


def effect_during_db_crash(dsn, binding, entered, release):
    def before_commit():
        entered.set()
        release.wait(20)
    try:
        fixture.effect(dsn, fixture.TrustedPrincipal('alice'), binding, 'job', 'worker', 1,
                       'key', {'value': 1}, before_commit=before_commit)
    except psycopg.Error:
        return
    raise AssertionError('Transaction unexpectedly committed')


class TransactionalAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS tx_effect, tx_job, tx_approval, tx_grant, tx_policy CASCADE')
        fixture.initialize(self.dsn)
        self.binding = dict(project='project', task='task', graph_version='1', graph_hash='graph',
                            checkpoint='cp', interrupt='int', action_hash='action', scope='write', policy_version='v1')
        self.principal = fixture.TrustedPrincipal('alice')
        fixture.seed(self.dsn, self.principal, self.binding)
        self.ctx = multiprocessing.get_context('spawn')

    def effect(self, **kwargs):
        args = dict(dsn=self.dsn, principal=self.principal, binding=self.binding, job_id='job',
                    owner='worker', epoch=1, key='key', payload={'value': 1})
        args.update(kwargs)
        return fixture.effect(**args)

    def count(self):
        with psycopg.connect(self.dsn) as db:
            return db.execute('SELECT count(*) FROM tx_effect').fetchone()[0]

    def start(self, target, args):
        process = self.ctx.Process(target=target, args=args)
        process.start()
        self.addCleanup(self.stop, process)
        return process

    @staticmethod
    def stop(process):
        if process.is_alive():
            process.terminate()
        process.join(10)

    def join(self, process, code=0):
        process.join(20)
        self.assertFalse(process.is_alive(), 'Process timed out')
        self.assertEqual(process.exitcode, code)

    def test_revoke_before_effect_denies(self):
        fixture.revoke(self.dsn, 'project')
        with self.assertRaises(fixture.Denied):
            self.effect()
        self.assertEqual(self.count(), 0)

    def test_effect_locked_before_concurrent_revoke_commits_first(self):
        entered, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        effect = self.start(effect_worker, (self.dsn, self.binding, entered, release, queue, False))
        self.assertTrue(entered.wait(15))
        rev_entered, rev_queue = self.ctx.Event(), self.ctx.Queue()
        revoke = self.start(revoke_worker, (self.dsn, rev_entered, rev_queue))
        self.assertTrue(rev_entered.wait(15))
        release.set()
        self.join(effect)
        self.assertEqual(queue.get(timeout=5)[0], 'ok')
        self.join(revoke)
        self.assertEqual(rev_queue.get(timeout=5), 'revoked')
        self.assertEqual(self.count(), 1)
        with self.assertRaises(fixture.Denied):
            self.effect()
        self.assertEqual(self.count(), 1)

    def test_duplicate_conflict_binding_and_principal(self):
        first = self.effect()
        self.assertEqual(self.effect(payload={'value': 1})['id'], first['id'])
        for kwargs in ({'payload': {'value': 2}}, {'binding': dict(self.binding, action_hash='different')},
                       {'principal': fixture.TrustedPrincipal('mallory')}, {'principal': 'alice'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(fixture.Denied):
                self.effect(**kwargs)
        self.assertEqual(self.count(), 1)

    def test_stale_owner_epoch_and_takeover(self):
        for kwargs in ({'owner': 'other'}, {'epoch': 2}):
            with self.assertRaises(fixture.Denied):
                self.effect(**kwargs)
        with psycopg.connect(self.dsn) as db:
            db.execute("UPDATE tx_job SET lease_until = clock_timestamp() - interval '1 second' WHERE id = 'job'")
        new = fixture.takeover(self.dsn, 'job', 'new')
        self.assertEqual(new['epoch'], 2)
        with self.assertRaises(fixture.Denied):
            self.effect()
        self.effect(owner='new', epoch=2)
        self.assertEqual(self.count(), 1)

    def test_process_death_during_transaction_rolls_back(self):
        entered, release, queue = self.ctx.Event(), self.ctx.Event(), self.ctx.Queue()
        worker = self.start(effect_worker, (self.dsn, self.binding, entered, release, queue, True))
        self.assertTrue(entered.wait(15))
        release.set()
        self.join(worker, 51)
        self.assertEqual(self.count(), 0)
        self.effect()
        self.assertEqual(self.count(), 1)

    def test_database_immediate_stop_rolls_back_uncommitted_effect(self):
        entered, release = self.ctx.Event(), self.ctx.Event()
        worker = self.start(effect_during_db_crash, (self.dsn, self.binding, entered, release))
        self.assertTrue(entered.wait(15))
        owner = cluster.PostgreSQLTests
        subprocess.run([str(cluster.BIN / 'pg_ctl'), '-D', str(owner.data), '-m', 'immediate', '-w', 'stop'],
                       check=True, capture_output=True, text=True, timeout=30)
        try:
            release.set()
            self.join(worker)
        finally:
            subprocess.run([str(cluster.BIN / 'pg_ctl'), '-D', str(owner.data), '-l', str(owner.root / 'server.log'),
                            '-o', f"-k {owner.socket} -p 55439 -c listen_addresses=''", '-w', 'start'],
                           check=True, capture_output=True, text=True, timeout=30)
        self.assertEqual(self.count(), 0)
        self.effect()
        self.assertEqual(self.count(), 1)
