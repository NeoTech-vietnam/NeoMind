"""Boundary proofs only: the separate fixture stores do not form one authority."""

import multiprocessing
import os
import json
import unittest
import uuid

import psycopg

import authorization_fixture as auth
import langgraph_fixture as graph
import postgres_prototype as jobs
import test_postgres as cluster
import transactional_authority_fixture as sink


def crash_sink(dsn, binding, before):
    def crash():
        os._exit(61)
    sink.effect(dsn, sink.TrustedPrincipal('alice'), binding, 'job', 'worker', 1,
                'effect-key', {'value': 1}, before_commit=crash if before else None)
    os._exit(62)


class ChainBoundaryProof(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cluster.PostgreSQLTests.setUpClass()
        cls.dsn = cluster.PostgreSQLTests.dsn

    @classmethod
    def tearDownClass(cls):
        cluster.PostgreSQLTests.tearDownClass()

    def setUp(self):
        with psycopg.connect(self.dsn) as db:
            db.execute('''DROP TABLE IF EXISTS tx_effect, tx_job, tx_approval, tx_grant, tx_policy,
                auth_receipts, auth_requests, auth_grants, jobs, receipts, approvals CASCADE''')
        jobs.initialize(self.dsn)
        auth.initialize(self.dsn)
        sink.initialize(self.dsn)
        self.thread = str(uuid.uuid4())
        checkpoint = graph.pause(self.dsn, self.thread, 'task')
        self.binding = dict(project='project', task='task', graph_version='v1', graph_hash='graph-hash',
                            checkpoint=checkpoint, interrupt=json.loads(checkpoint)['interrupt_id'], action_hash='action-hash',
                            scope='write', policy_version='v1')
        self.principal = auth.TrustedPrincipal('alice')
        auth.grant(self.dsn, 'project', 'alice', 'write', 'v1')
        auth.create_request(self.dsn, 'auth-request', self.binding)
        self.auth_receipt = auth.decide(self.dsn, self.principal, 'auth-request', self.binding, 'approve', 'auth-key')
        # The other stores are seeded separately, NOT atomically derived from this receipt.
        jobs.create_approval(self.dsn, 'a', 'task', checkpoint)
        self.job_receipt = jobs.decide(self.dsn, 'a', 'task', checkpoint, 1, 'approve', 'job-key')
        self.job = jobs.claim(self.dsn, 'worker', 60)
        sink.seed(self.dsn, sink.TrustedPrincipal('alice'), self.binding)

    def test_matched_receipts_can_resume_but_are_not_authority_link(self):
        auth.validate(self.dsn, self.auth_receipt['id'], 'auth-request', self.binding)
        self.assertEqual(self.job_receipt['checkpoint'], self.binding['checkpoint'])
        result = graph.resume(self.dsn, self.thread, 'task', 'a', self.job['id'], 'worker', self.job['epoch'])
        self.assertEqual(result['result'], 'approve')
        # The job's foreign key names the independent job receipt, not auth_receipt.
        self.assertEqual(self.job['receipt_id'], self.job_receipt['id'])
        self.assertNotEqual(self.job['receipt_id'], self.auth_receipt['id'])

    def test_auth_mismatch_is_rejected_without_resuming(self):
        with self.assertRaises(auth.Denied):
            auth.validate(self.dsn, self.auth_receipt['id'], 'auth-request',
                          dict(self.binding, action_hash='different'))
        with graph.PostgresSaver.from_conn_string(self.dsn) as saver:
            current = graph.graph(saver).get_state(graph.config(self.thread))
            self.assertEqual(graph.identity(current, self.thread, 'task'), self.binding['checkpoint'])

    def test_revocation_does_not_propagate_to_independent_job_or_sink(self):
        auth.invalidate(self.dsn, 'auth-request')
        with self.assertRaises(auth.Denied):
            auth.validate(self.dsn, self.auth_receipt['id'], 'auth-request', self.binding)
        # Deliberately demonstrate the blocker with DB-only effects on disposable data.
        result = graph.resume(self.dsn, self.thread, 'task', 'a', self.job['id'], 'worker', self.job['epoch'])
        self.assertEqual(result['result'], 'approve')
        receipt = sink.effect(self.dsn, sink.TrustedPrincipal('alice'), self.binding, 'job', 'worker', 1,
                              'effect-key', {'value': 1})
        self.assertIsNotNone(receipt['id'])

    def test_sink_crash_boundary_requires_reconciliation_not_blind_replay(self):
        ctx = multiprocessing.get_context('spawn')
        for before, exitcode, expected in ((True, 61, 0), (False, 62, 1)):
            with self.subTest(before=before):
                worker = ctx.Process(target=crash_sink, args=(self.dsn, self.binding, before))
                worker.start()
                worker.join(20)
                if worker.is_alive():
                    worker.terminate()
                    worker.join()
                    self.fail('Sink process timed out')
                self.assertEqual(worker.exitcode, exitcode)
                # After losing the worker, status is unknown until an independent read.
                outcome = 'unknown'
                self.assertEqual(outcome, 'unknown')
                with psycopg.connect(self.dsn) as db:
                    count = db.execute('SELECT count(*) FROM tx_effect').fetchone()[0]
                self.assertEqual(count, expected)
                # No effect is dispatched again by this proof.


if __name__ == '__main__':
    unittest.main()
