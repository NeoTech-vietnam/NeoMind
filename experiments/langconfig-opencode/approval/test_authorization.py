import multiprocessing
import unittest

import psycopg

import authorization_fixture as auth
import test_postgres as cluster


def race(dsn, binding, barrier, queue, actor, decision, key):
    barrier.wait(timeout=15)
    try:
        receipt = auth.decide(dsn, auth.TrustedPrincipal(actor), 'a', binding, decision, key)
        queue.put(('ok', str(receipt['id'])))
    except auth.Denied:
        queue.put(('denied', None))


class AuthorizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('DROP TABLE IF EXISTS auth_receipts, auth_requests, auth_grants CASCADE')
        auth.initialize(self.dsn)
        self.binding = dict(project='project', task='task', graph_version='v1', graph_hash='graph-v1-hash', checkpoint='cp',
                            interrupt='interrupt', action_hash='action-hash', scope='write', policy_version='v1')
        self.actor = auth.TrustedPrincipal('alice')
        auth.grant(self.dsn, 'project', 'alice', 'write', 'v1')
        auth.create_request(self.dsn, 'a', self.binding)

    def decide(self, decision='approve', key='key', actor=None, binding=None):
        return auth.decide(self.dsn, actor or self.actor, 'a', self.binding if binding is None else binding, decision, key)

    def test_binding_mismatches_are_rejected_at_decide_and_validate(self):
        for field in auth.FIELDS:
            binding = dict(self.binding, **{field: 'different'})
            with self.subTest(field=field), self.assertRaises(auth.Denied):
                self.decide(binding=binding)
        receipt = self.decide()
        self.assertEqual(auth.validate(self.dsn, receipt['id'], 'a', self.binding)['actor'], 'alice')
        for field in auth.FIELDS:
            binding = dict(self.binding, **{field: 'different'})
            with self.subTest(validate=field), self.assertRaises(auth.Denied):
                auth.validate(self.dsn, receipt['id'], 'a', binding)

    def test_idempotency_actor_conflict_and_authorization(self):
        with self.assertRaises(auth.Denied):
            self.decide(actor=auth.TrustedPrincipal('mallory'))
        with self.assertRaises(auth.Denied):
            auth.decide(self.dsn, 'alice', 'a', self.binding, 'approve', 'key')
        receipt = self.decide()
        self.assertEqual(self.decide()['id'], receipt['id'])
        with self.assertRaises(auth.Denied):
            self.decide(decision='reject')
        auth.grant(self.dsn, 'project', 'bob', 'write', 'v1')
        with self.assertRaises(auth.Denied):
            self.decide(actor=auth.TrustedPrincipal('bob'))
        with self.assertRaises(auth.Denied):
            self.decide(key='other')

    def test_invalidation_revocation_and_rejection(self):
        receipt = self.decide()
        with psycopg.connect(self.dsn) as db:
            db.execute("DELETE FROM auth_grants WHERE actor = 'alice'")
        with self.assertRaises(auth.Denied):
            auth.validate(self.dsn, receipt['id'], 'a', self.binding)
        with self.assertRaises(auth.Denied):
            self.decide()
        auth.grant(self.dsn, 'project', 'alice', 'write', 'v1')
        auth.invalidate(self.dsn, 'a')
        with self.assertRaises(auth.Denied):
            self.decide()
        with self.assertRaises(auth.Denied):
            auth.validate(self.dsn, receipt['id'], 'a', self.binding)
        auth.create_request(self.dsn, 'b', self.binding)
        rejected = auth.decide(self.dsn, self.actor, 'b', self.binding, 'reject', 'reject-key')
        with self.assertRaises(auth.Denied):
            auth.validate(self.dsn, rejected['id'], 'b', self.binding)

    def test_competing_decisions_multiprocess(self):
        ctx = multiprocessing.get_context('spawn')
        barrier, queue = ctx.Barrier(2), ctx.Queue()
        workers = [ctx.Process(target=race, args=(self.dsn, self.binding, barrier, queue, 'alice', decision, key))
                   for decision, key in [('approve', 'one'), ('reject', 'two')]]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
            if worker.is_alive():
                worker.terminate()
                worker.join()
                self.fail('Decision process timed out')
            self.assertEqual(worker.exitcode, 0)
        self.assertEqual(sorted(queue.get(timeout=5)[0] for _ in workers), ['denied', 'ok'])
        with psycopg.connect(self.dsn) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM auth_receipts').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
